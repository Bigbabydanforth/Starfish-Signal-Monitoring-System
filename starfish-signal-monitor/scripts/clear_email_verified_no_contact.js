/**
 * scripts/clear_email_verified_no_contact.js
 *
 * One-time cleanup: clears the "Email Verified" field on all Airtable records
 * that have no real contact email (Research Needed, Contact Needed, blank, etc.)
 * but were incorrectly stamped with a verification status.
 *
 * A signal has "no contact" if its Contact Info:
 *   - is blank / empty
 *   - contains the placeholder  (email_not_unlocked@domain.com)
 *   - contains "Research Needed" or "Contact Needed"
 *   - has a LinkedIn URL but no @ sign (LinkedIn-only)
 *   - has no @ sign at all (no email)
 *
 * Run:
 *   node --env-file=.env scripts/clear_email_verified_no_contact.js          (preview)
 *   node --env-file=.env scripts/clear_email_verified_no_contact.js --live   (clear in Airtable)
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
  console.log(`CLEAR EMAIL VERIFIED — NO CONTACT RECORDS`);
  console.log(`Mode: ${LIVE ? 'LIVE — writing to Airtable' : 'PREVIEW — no writes'}`);
  console.log('════════════════════════════════════════════════════════════\n');

  console.log('Fetching all records with a non-empty Email Verified field...');
  let records;
  try {
    records = await query({
      filterByFormula: `NOT({Email Verified} = "")`,
      fields: ['Contact Info', 'Company Name', 'Email Verified'],
    }, 120000);
  } catch (err) {
    console.error('Airtable fetch failed:', err.message);
    process.exit(1);
  }

  console.log(`  Records with Email Verified set : ${records.length}`);

  const toClear = records.filter(r => !hasRealEmail(r.fields['Contact Info'] || ''));

  console.log(`  Records with no real email      : ${toClear.length}`);
  console.log(`  Records to leave untouched      : ${records.length - toClear.length}\n`);

  if (toClear.length === 0) {
    console.log('Nothing to clear. All Email Verified values are on records with real emails.');
    return;
  }

  // Show a sample of what will be cleared
  const sample = toClear.slice(0, 10);
  console.log('Sample records to be cleared:');
  for (const r of sample) {
    const company = r.fields['Company Name'] || '(no company)';
    const status  = r.fields['Email Verified'];
    const info    = (r.fields['Contact Info'] || '(blank)').split('\n')[0].trim().slice(0, 60);
    console.log(`  ${company.padEnd(30)} | Was: ${status.padEnd(14)} | Contact: ${info}`);
  }
  if (toClear.length > 10) console.log(`  ... and ${toClear.length - 10} more\n`);
  else console.log('');

  if (!LIVE) {
    console.log(`PREVIEW: Would clear Email Verified on ${toClear.length} records.`);
    console.log('Run with --live to apply.\n');
    return;
  }

  // Clear in batches via updateRecords (handles batching internally)
  console.log(`Clearing Email Verified on ${toClear.length} records...`);
  const updates = toClear.map(r => ({ id: r.id, fields: { 'Email Verified': null } }));

  try {
    await updateRecords(updates);
    console.log(`  ✅ Done — cleared ${updates.length} records.`);
  } catch (err) {
    console.error(`  ❌ Airtable write error: ${err.message}`);
    process.exit(1);
  }

  console.log('\n════════════════════════════════════════════════════════════');
  console.log(`RESULTS`);
  console.log('════════════════════════════════════════════════════════════');
  console.log(`  Records cleared : ${updates.length}`);
  console.log(`  Records kept    : ${records.length - toClear.length}`);
  console.log('════════════════════════════════════════════════════════════');
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
