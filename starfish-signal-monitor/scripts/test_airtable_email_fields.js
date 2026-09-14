/**
 * scripts/test_airtable_email_fields.js
 *
 * Probes Airtable to discover the actual field names used for Email 8-10.
 * Tests each candidate name one at a time and reports which ones exist.
 *
 * Run:
 *   node --env-file=.env scripts/test_airtable_email_fields.js
 */

import 'dotenv/config';
import { query, updateRecords } from '../execution/utils/airtable_client.js';

// All Email 1-10 Subject and Body fields the scripts expect
const ALL_FIELDS = [];
for (let i = 1; i <= 10; i++) {
  ALL_FIELDS.push(`Email ${i} Subject`);
  ALL_FIELDS.push(`Email ${i} Body`);
}

async function tryField(recordId, fieldName) {
  try {
    await updateRecords([{ id: recordId, fields: { [fieldName]: 'TEST' } }]);
    // Clean up immediately
    try { await updateRecords([{ id: recordId, fields: { [fieldName]: null } }]); } catch {}
    return true;
  } catch {
    return false;
  }
}

async function run() {
  console.log('════════════════════════════════════════════════════════════');
  console.log('AIRTABLE FIELD CHECK — Email 1-10 Subject + Body (all 20 fields)');
  console.log('════════════════════════════════════════════════════════════\n');

  console.log('Fetching one pushed Rebrand record...');
  let records;
  try {
    records = await query({
      filterByFormula: `AND({Signal Type} = "Rebrand", {HubSpot Pushed} = TRUE())`,
      fields: ['Company Name'],
      maxRecords: 1,
    }, 30000);
  } catch (err) {
    console.error('Airtable fetch failed:', err.message);
    process.exit(1);
  }

  if (!records?.length) {
    console.log('No pushed Rebrand records found.');
    process.exit(0);
  }

  const record  = records[0];
  const company = record.fields['Company Name'] || '(unknown)';
  console.log(`  Using record: ${record.id} (${company})\n`);

  const missing = [];
  for (const field of ALL_FIELDS) {
    const ok   = await tryField(record.id, field);
    const mark = ok ? '✓' : '✗ MISSING';
    console.log(`  ${mark.padEnd(10)} "${field}"`);
    if (!ok) missing.push(field);
  }

  console.log('');
  if (missing.length === 0) {
    console.log('✓ All 20 fields exist and are writable. Airtable is ready.');
  } else {
    console.log(`✗ ${missing.length} field(s) missing — create these in Airtable as Long text:\n`);
    for (const f of missing) console.log(`  "${f}"`);
  }

  console.log('\n════════════════════════════════════════════════════════════');
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
