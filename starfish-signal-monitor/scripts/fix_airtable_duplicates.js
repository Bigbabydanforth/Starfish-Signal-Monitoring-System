/**
 * fix_airtable_duplicates.js
 *
 * Finds Airtable signal records where the same email + send_day combination
 * appears more than once and marks the extras as HubSpot Pushed = true so
 * the push cron never sends them again.
 *
 * Logic:
 *   - Groups all unpushed records by email + send_day
 *   - If a group has more than 1 record, keeps the OLDEST (first detected)
 *     and marks the rest as pushed (suppressed)
 *   - BSI broadcast records with DIFFERENT send_days for the same email are
 *     intentional — they are left untouched
 *
 * Run with:
 *   node --env-file=.env scripts/fix_airtable_duplicates.js             (preview)
 *   node --env-file=.env scripts/fix_airtable_duplicates.js --live      (apply)
 *   node --env-file=.env scripts/fix_airtable_duplicates.js --all       (include already-pushed records too)
 */

import { query, updateRecords } from '../execution/utils/airtable_client.js';

const LIVE    = process.argv.includes('--live');
const ALL     = process.argv.includes('--all'); // also scan already-pushed records

const PLACEHOLDER = 'email_not_unlocked@domain.com';

function extractEmail(contactInfo) {
  if (!contactInfo) return null;
  const m = contactInfo.match(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/);
  return m ? m[0] : null;
}

console.log('────────────────────────────────────────────────────────────');
console.log('FIX AIRTABLE DUPLICATE RECORDS');
console.log(`Scope: ${ALL ? 'ALL records (pushed + unpushed)' : 'Unpushed records only'}`);
console.log(`Mode : ${LIVE ? 'LIVE (will mark duplicates as pushed)' : 'PREVIEW (no changes)'}`);
console.log('────────────────────────────────────────────────────────────\n');

async function run() {
  // Fetch records
  const filter = ALL
    ? 'NOT({Contact Info} = "")'
    : 'OR({HubSpot Pushed}=FALSE(), {HubSpot Pushed}=BLANK())';

  console.log('Fetching records from Airtable...');
  let records;
  try {
    records = await query({
      filterByFormula: filter,
      fields: ['Company Name', 'Signal Type', 'Contact Info', 'Date Detected', 'Send Day', 'HubSpot Pushed'],
      sort: [{ field: 'Date Detected', direction: 'asc' }], // oldest first — keep the earliest
    });
  } catch (err) {
    console.error('Failed to fetch records:', err.message);
    process.exit(1);
  }

  console.log(`Fetched ${records.length} record(s)\n`);

  // Group by email + send_day
  const groups = {}; // key: "email::sendDay" → array of records

  for (const r of records) {
    const email   = extractEmail(r.fields['Contact Info']);
    const sendDay = r.fields['Send Day'] || 1;

    if (!email || email === PLACEHOLDER) continue;

    const key = `${email.toLowerCase()}::${sendDay}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(r);
  }

  // Find groups with more than one record
  const duplicateGroups = Object.entries(groups).filter(([, recs]) => recs.length > 1);

  if (duplicateGroups.length === 0) {
    console.log('No duplicate email + send_day combinations found. Nothing to fix.');
    return;
  }

  console.log(`Found ${duplicateGroups.length} duplicate group(s):\n`);

  const toSuppress = []; // record IDs to mark as HubSpot Pushed = true

  for (const [key, recs] of duplicateGroups) {
    const [email, sendDay] = key.split('::');
    const keeper    = recs[0]; // oldest — already sorted asc by date
    const extras    = recs.slice(1);
    const company   = keeper.fields['Company Name'] || '—';
    const signalType = keeper.fields['Signal Type'] || '—';

    console.log(`  ${email} [day ${sendDay}] — ${company} (${signalType})`);
    console.log(`    KEEP   : ${keeper.id} (${keeper.fields['Date Detected'] || 'no date'})`);
    for (const dup of extras) {
      const pushed = dup.fields['HubSpot Pushed'] ? ' [already pushed]' : '';
      console.log(`    SUPPRESS: ${dup.id} (${dup.fields['Date Detected'] || 'no date'})${pushed}`);
      if (!dup.fields['HubSpot Pushed']) {
        toSuppress.push(dup.id);
      }
    }
    console.log();
  }

  const alreadyPushed = duplicateGroups.reduce((n, [, recs]) =>
    n + recs.slice(1).filter(r => r.fields['HubSpot Pushed']).length, 0);

  console.log('────────────────────────────────────────────────────────────');
  console.log(`Duplicate groups  : ${duplicateGroups.length}`);
  console.log(`Records to suppress: ${toSuppress.length}`);
  if (alreadyPushed > 0)
    console.log(`Already pushed (skipped): ${alreadyPushed}`);

  if (!LIVE) {
    console.log('\nPreview mode — no changes made.');
    console.log('Run with --live to mark duplicates as HubSpot Pushed = true.');
    console.log('────────────────────────────────────────────────────────────');
    return;
  }

  if (toSuppress.length === 0) {
    console.log('\nNothing new to suppress.');
    console.log('────────────────────────────────────────────────────────────');
    return;
  }

  // Mark duplicates as pushed in batches
  console.log(`\nMarking ${toSuppress.length} duplicate record(s) as HubSpot Pushed = true...`);

  const updates = toSuppress.map(id => ({ id, fields: { 'HubSpot Pushed': true } }));

  try {
    await updateRecords(updates);
    console.log(`\n✅ Done — ${toSuppress.length} duplicate record(s) suppressed.`);
  } catch (err) {
    console.error('Error during update:', err.message);
    process.exit(1);
  }

  console.log('────────────────────────────────────────────────────────────');
}

run();
