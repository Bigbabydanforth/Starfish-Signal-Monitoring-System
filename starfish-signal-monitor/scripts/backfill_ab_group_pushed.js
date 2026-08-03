/**
 * scripts/backfill_ab_group_pushed.js
 *
 * One-time backfill: sets AB Test Group = "starfish" on all Airtable records
 * that have already been pushed to HubSpot but have no AB Test Group assigned.
 *
 * These signals were pushed before the AB test logic (25/75 split) existed,
 * so they never got a group. We retroactively assign them to "starfish".
 *
 * Only touches: HubSpot Pushed = TRUE AND AB Test Group is blank.
 * Never touches: unpushed records.
 *
 * Run:
 *   node --env-file=.env scripts/backfill_ab_group_pushed.js          (preview)
 *   node --env-file=.env scripts/backfill_ab_group_pushed.js --live   (update Airtable)
 */

import 'dotenv/config';
import { query, updateRecords } from '../execution/utils/airtable_client.js';

const LIVE = process.argv.includes('--live');

async function run() {
  console.log('════════════════════════════════════════════════════════════');
  console.log('BACKFILL AB TEST GROUP → "starfish" (pushed signals only)');
  console.log(`Mode: ${LIVE ? 'LIVE — writing to Airtable' : 'PREVIEW — no writes'}`);
  console.log('════════════════════════════════════════════════════════════\n');

  console.log('Fetching pushed records with no AB Test Group...');
  let records;
  try {
    records = await query({
      filterByFormula: `AND({HubSpot Pushed} = TRUE(), {AB Test Group} = "")`,
      fields: ['Company Name', 'Signal Type', 'AB Test Group'],
    }, 120000);
  } catch (err) {
    console.error('Airtable fetch failed:', err.message);
    process.exit(1);
  }

  console.log(`  Pushed records with no AB group : ${records.length}\n`);

  if (records.length === 0) {
    console.log('Nothing to update — all pushed records already have an AB Test Group.');
    return;
  }

  // Sample
  const sample = records.slice(0, 10);
  console.log('Sample records to be updated:');
  for (const r of sample) {
    const company = (r.fields['Company Name'] || '(no company)').padEnd(30);
    const type    = r.fields['Signal Type'] || '—';
    console.log(`  ${company} | ${type}`);
  }
  if (records.length > 10) console.log(`  ... and ${records.length - 10} more`);
  console.log('');

  if (!LIVE) {
    console.log(`PREVIEW: Would set AB Test Group = "starfish" on ${records.length} records.`);
    console.log('Run with --live to apply.');
    return;
  }

  const updates = records.map(r => ({ id: r.id, fields: { 'AB Test Group': 'starfish' } }));

  console.log(`Setting AB Test Group = "starfish" on ${updates.length} records...`);
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
  console.log(`  Records updated : ${updates.length}`);
  console.log('════════════════════════════════════════════════════════════');
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
