/**
 * delete_today_signals.js
 *
 * Deletes all Airtable signal records where "Date Detected" = today (2026-07-15).
 * Run with:  node --env-file=.env scripts/delete_today_signals.js
 *
 * Preview mode (default): lists matching records, does NOT delete.
 * Live mode:              node --env-file=.env scripts/delete_today_signals.js --live
 */

import { query, deleteRecords } from '../execution/utils/airtable_client.js';

const LIVE = process.argv.includes('--live');
const TARGET_DATE = '2026-07-15'; // July 15, 2026

console.log('────────────────────────────────────────────────────────────');
console.log(`DELETE TODAY'S SIGNALS — Date Detected = ${TARGET_DATE}`);
console.log(`Mode: ${LIVE ? 'LIVE (will delete)' : 'PREVIEW (no changes)'}`);
console.log('────────────────────────────────────────────────────────────\n');

async function run() {
  // Pull all records where Date Detected is today
  console.log(`Fetching records with Date Detected = ${TARGET_DATE}...`);
  let records;
  try {
    records = await query({
      filterByFormula: `IS_SAME({Date Detected}, '${TARGET_DATE}', 'day')`,
      fields: ['Company Name', 'Signal Type', 'Date Detected', 'Status']
    });
  } catch (err) {
    console.error('Failed to query Airtable:', err.message);
    process.exit(1);
  }

  if (records.length === 0) {
    console.log('No records found for today. Nothing to delete.');
    return;
  }

  console.log(`Found ${records.length} record(s) from today:\n`);

  // Group by Signal Type for a clean preview
  const grouped = {};
  for (const r of records) {
    const type = r.fields['Signal Type'] || 'Unknown';
    if (!grouped[type]) grouped[type] = [];
    grouped[type].push({
      id: r.id,
      company: r.fields['Company Name'] || '(no name)',
      status: r.fields['Status'] || ''
    });
  }

  for (const [type, items] of Object.entries(grouped)) {
    console.log(`  ${type} (${items.length})`);
    for (const item of items) {
      console.log(`    • ${item.company}${item.status ? ` [${item.status}]` : ''} — ${item.id}`);
    }
  }

  console.log(`\nTotal: ${records.length} records`);

  if (!LIVE) {
    console.log('\nPreview mode — no records deleted.');
    console.log('Run with --live to delete these records.');
    return;
  }

  // Delete in batches of 10 (handled inside deleteRecords)
  console.log('\nDeleting...');
  const ids = records.map(r => r.id);
  try {
    await deleteRecords(ids);
    console.log(`\n✅ Done — ${ids.length} record(s) deleted from Airtable.`);
  } catch (err) {
    console.error('Error during deletion:', err.message);
    process.exit(1);
  }
}

run();
