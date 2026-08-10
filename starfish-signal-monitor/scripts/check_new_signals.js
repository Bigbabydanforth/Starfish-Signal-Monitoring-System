/**
 * scripts/check_new_signals.js
 *
 * Counts unpushed signals EXCLUDING the first 1,000 records ever created.
 * "First 1,000" = oldest 1,000 by Airtable Created Time, pushed or not.
 *
 * Run:
 *   node --env-file=.env scripts/check_new_signals.js
 */

import 'dotenv/config';
import Airtable from 'airtable';

const TABLE     = process.env.AIRTABLE_TABLE_NAME || 'Signals';
const THRESHOLD = 1000;

const PLACEHOLDER = 'email_not_unlocked@domain.com';

function getBase() {
  return new Airtable({ apiKey: process.env.AIRTABLE_API_KEY })
    .base(process.env.AIRTABLE_BASE_ID);
}

function extractEmail(contactInfo) {
  if (!contactInfo) return null;
  const m = contactInfo.match(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/);
  return m ? m[0].toLowerCase() : null;
}

async function run() {
  console.log('Fetching ALL records sorted by creation date (oldest first)...');

  let allRecords;
  try {
    allRecords = await getBase()(TABLE)
      .select({
        sort:   [{ field: 'Date Detected', direction: 'asc' }],
        fields: ['Contact Info', 'Company Name', 'Signal Type', 'HubSpot Pushed', 'Send Day', 'Date Detected'],
      })
      .all();
  } catch (err) {
    console.error('Fetch failed:', err.message);
    process.exit(1);
  }

  console.log(`  Total records in Airtable : ${allRecords.length}`);

  // Skip the first THRESHOLD records regardless of push status
  const newRecords = allRecords.slice(THRESHOLD);
  console.log(`  First ${THRESHOLD} excluded        : ${THRESHOLD}`);
  console.log(`  Remaining (new generation) : ${newRecords.length}\n`);

  // Among remaining — split pushed vs unpushed
  const pushed   = newRecords.filter(r => r.fields['HubSpot Pushed'] === true);
  const unpushed = newRecords.filter(r => r.fields['HubSpot Pushed'] !== true);

  // Deduplicate unpushed by email (same logic as check_unpushed_signals.js)
  const seenEmails      = new Set();
  const seenNoEmailKeys = new Set();
  const dedupedUnpushed = [];
  let droppedDups = 0;

  for (const r of unpushed) {
    const contactInfo   = r.fields['Contact Info'] || '';
    const companyName   = (r.fields['Company Name'] || '').toLowerCase().trim();
    const signalType    = (r.fields['Signal Type']  || '').toLowerCase().trim();
    const isPlaceholder = contactInfo.includes(PLACEHOLDER);
    const email         = isPlaceholder ? null : extractEmail(contactInfo);

    if (email) {
      if (seenEmails.has(email)) { droppedDups++; continue; }
      seenEmails.add(email);
    } else {
      const key = `${companyName}||${signalType}`;
      if (seenNoEmailKeys.has(key)) { droppedDups++; continue; }
      seenNoEmailKeys.add(key);
    }
    dedupedUnpushed.push(r);
  }

  // Categorise
  let withEmail    = 0;
  let withoutEmail = 0;
  let researchNeeded  = 0;
  let contactNeeded   = 0;
  let linkedInOnly    = 0;
  let websiteOnly     = 0;
  let trulyEmpty      = 0;

  const bySignalType = {};

  for (const r of dedupedUnpushed) {
    const contactInfo   = r.fields['Contact Info'] || '';
    const signalType    = r.fields['Signal Type']  || 'Unknown';
    const isPlaceholder = contactInfo.includes(PLACEHOLDER);
    const email         = isPlaceholder ? null : extractEmail(contactInfo);

    if (email) {
      withEmail++;
    } else {
      withoutEmail++;
      if      (/research needed/i.test(contactInfo))  researchNeeded++;
      else if (/contact needed/i.test(contactInfo))   contactNeeded++;
      else if (/linkedin\.com/i.test(contactInfo))    linkedInOnly++;
      else if (/https?:\/\//i.test(contactInfo))      websiteOnly++;
      else                                             trulyEmpty++;
    }

    bySignalType[signalType] = (bySignalType[signalType] || 0) + 1;
  }

  console.log('══════════════════════════════════════════════════════');
  console.log(`NEW SIGNALS (after first ${THRESHOLD}) — SNAPSHOT`);
  console.log('══════════════════════════════════════════════════════');
  console.log(`📦 New records total           : ${newRecords.length}`);
  console.log(`✅ Already pushed to HubSpot   : ${pushed.length}`);
  console.log(`❌ Unpushed (raw)              : ${unpushed.length}`);
  console.log(`🔁 Dropped as duplicates       : ${droppedDups}`);
  console.log(`📋 Unpushed unique             : ${dedupedUnpushed.length}`);

  console.log('\n── Unpushed unique — by contact status ─────────────────');
  console.log(`  ✅ With contact email         : ${withEmail}`);
  console.log(`  ❌ Without contact email      : ${withoutEmail}`);
  console.log(`     🔍 Research Needed         : ${researchNeeded}`);
  console.log(`     ⚠️  Contact Needed          : ${contactNeeded}`);
  console.log(`     🔗 LinkedIn only           : ${linkedInOnly}`);
  console.log(`     🌐 Website only            : ${websiteOnly}`);
  console.log(`     ❌ Truly empty             : ${trulyEmpty}`);

  if (Object.keys(bySignalType).length > 0) {
    console.log('\n── Unpushed unique — by signal type ────────────────────');
    const sorted = Object.entries(bySignalType).sort((a, b) => b[1] - a[1]);
    for (const [type, count] of sorted) {
      console.log(`  ${type.padEnd(35)} : ${count}`);
    }
  }

  console.log('\n══════════════════════════════════════════════════════');
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
