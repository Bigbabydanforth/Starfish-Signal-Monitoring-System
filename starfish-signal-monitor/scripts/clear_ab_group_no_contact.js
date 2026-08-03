/**
 * scripts/clear_ab_group_no_contact.js
 *
 * One-time cleanup: clears AB Test Group on all unpushed Airtable records
 * that have no real contact email (Research Needed, blank, etc.).
 *
 * These records were incorrectly stamped with an AB group during enrichment.
 * AB group should only be assigned once a real contact email exists.
 *
 * Only touches: HubSpot Pushed = FALSE/blank AND no real email AND AB Test Group is set.
 * Never touches: already-pushed records.
 *
 * Run:
 *   node --env-file=.env scripts/clear_ab_group_no_contact.js          (preview)
 *   node --env-file=.env scripts/clear_ab_group_no_contact.js --live   (clear in Airtable)
 */

import 'dotenv/config';
import { query, updateRecords } from '../execution/utils/airtable_client.js';

const LIVE        = process.argv.includes('--live');
const PLACEHOLDER = 'email_not_unlocked@domain.com';

function hasRealEmail(contactInfo) {
  if (!contactInfo || !contactInfo.trim()) return false;
  if (contactInfo.includes(PLACEHOLDER))   return false;
  return /[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/.test(contactInfo);
}

async function run() {
  console.log('════════════════════════════════════════════════════════════');
  console.log('CLEAR AB TEST GROUP — Unpushed records with no contact');
  console.log(`Mode: ${LIVE ? 'LIVE — writing to Airtable' : 'PREVIEW — no writes'}`);
  console.log('════════════════════════════════════════════════════════════\n');

  console.log('Fetching unpushed records with AB Test Group set...');
  let records;
  try {
    records = await query({
      filterByFormula: `AND(
        OR({HubSpot Pushed}=FALSE(), {HubSpot Pushed}=BLANK()),
        NOT({AB Test Group} = "")
      )`,
      fields: ['Company Name', 'Contact Info', 'AB Test Group'],
    }, 120000);
  } catch (err) {
    console.error('Airtable fetch failed:', err.message);
    process.exit(1);
  }

  const toClear = records.filter(r => !hasRealEmail(r.fields['Contact Info'] || ''));

  console.log(`  Unpushed records with AB group set : ${records.length}`);
  console.log(`  Of those — no real contact email   : ${toClear.length}`);
  console.log(`  Will leave untouched               : ${records.length - toClear.length}\n`);

  if (toClear.length === 0) {
    console.log('Nothing to clear — all AB groups are on records with real emails.');
    return;
  }

  const sample = toClear.slice(0, 10);
  console.log('Sample records to be cleared:');
  for (const r of sample) {
    const company = (r.fields['Company Name'] || '(no company)').padEnd(30);
    const group   = r.fields['AB Test Group'];
    const info    = (r.fields['Contact Info'] || '(blank)').split('\n')[0].trim().slice(0, 50);
    console.log(`  ${company} | Was: ${group.padEnd(10)} | ${info}`);
  }
  if (toClear.length > 10) console.log(`  ... and ${toClear.length - 10} more\n`);
  else console.log('');

  if (!LIVE) {
    console.log(`PREVIEW: Would clear AB Test Group on ${toClear.length} records.`);
    console.log('Run with --live to apply.');
    return;
  }

  const updates = toClear.map(r => ({ id: r.id, fields: { 'AB Test Group': null } }));

  console.log(`Clearing AB Test Group on ${updates.length} records...`);
  try {
    await updateRecords(updates);
    console.log(`  ✅ Done.`);
  } catch (err) {
    console.error(`  ❌ Airtable write error: ${err.message}`);
    process.exit(1);
  }

  console.log('\n════════════════════════════════════════════════════════════');
  console.log('RESULTS');
  console.log('════════════════════════════════════════════════════════════');
  console.log(`  Records cleared : ${updates.length}`);
  console.log(`  Records kept    : ${records.length - toClear.length}`);
  console.log('════════════════════════════════════════════════════════════');
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
