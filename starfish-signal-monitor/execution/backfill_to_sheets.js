/**
 * backfill_to_sheets.js
 *
 * One-time utility: pulls ALL records from Airtable and rewrites the
 * Google Sheet from scratch (rows 5+).  Use this whenever the Sheet is
 * out of sync with Airtable — e.g. after a bulk Airtable import, after
 * signals were saved before Sheets sync was configured, or before sending
 * results to the client.
 *
 * The dashboard header (rows 1–4) is NEVER touched.
 * Airtable is always the source of truth — this script only reads from it.
 *
 * Run:
 *   node execution/backfill_to_sheets.js
 *
 * Optional flags:
 *   --dry-run        Print row count only, do not write to Sheets
 *   --date 2026-06-01  Only sync records on or after this date (YYYY-MM-DD)
 */

import 'dotenv/config';
import { fileURLToPath } from 'url';
import { query } from './utils/airtable_client.js';
import { rewriteAllRows } from './utils/sheets_client.js';

const args      = process.argv.slice(2);
const isDryRun  = args.includes('--dry-run');
const dateIdx   = args.indexOf('--date');
const fromDate  = dateIdx !== -1 ? args[dateIdx + 1] : null;

(async () => {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║       Airtable → Google Sheets Backfill      ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  if (!process.env.GOOGLE_SHEET_ID ||
      !process.env.GOOGLE_CLIENT_ID ||
      !process.env.GOOGLE_CLIENT_SECRET ||
      !process.env.GOOGLE_REFRESH_TOKEN) {
    console.error('[Backfill] ❌ Missing Google Sheets env vars — check .env');
    process.exit(1);
  }

  if (!process.env.AIRTABLE_API_KEY ||
      !process.env.AIRTABLE_BASE_ID ||
      !process.env.AIRTABLE_TABLE_NAME) {
    console.error('[Backfill] ❌ Missing Airtable env vars — check .env');
    process.exit(1);
  }

  // Build Airtable filter
  let filterByFormula;
  if (fromDate) {
    // IS_SAME on 'day' includes the date itself; IS_AFTER is exclusive so we
    // use IS_SAME OR IS_AFTER to include the exact fromDate.
    filterByFormula = `OR(IS_SAME({Date Detected}, '${fromDate}', 'day'), IS_AFTER({Date Detected}, '${fromDate}'))`;
    console.log(`[Backfill] Fetching records on or after ${fromDate}...`);
  } else {
    console.log('[Backfill] Fetching ALL records from Airtable...');
  }

  let records;
  try {
    records = await query({
      ...(filterByFormula ? { filterByFormula } : {}),
      sort: [
        { field: 'Date Detected', direction: 'asc' },
        { field: 'Created At',    direction: 'asc' }
      ]
    }, 120000); // 2-min timeout for large tables
  } catch (err) {
    console.error('[Backfill] ❌ Airtable query failed:', err.message);
    process.exit(1);
  }

  console.log(`[Backfill] Found ${records.length} records in Airtable`);

  if (records.length === 0) {
    console.log('[Backfill] Nothing to write. Exiting.');
    process.exit(0);
  }

  if (isDryRun) {
    console.log('[Backfill] --dry-run flag set — skipping Sheets write.');
    console.log(`[Backfill] Would write ${records.length} rows to Google Sheet.`);
    process.exit(0);
  }

  console.log('[Backfill] Clearing existing data rows (5+) and rewriting...');

  let inserted;
  try {
    inserted = await rewriteAllRows(records);
  } catch (err) {
    console.error('[Backfill] ❌ Google Sheets write failed:', err.message);
    process.exit(1);
  }

  console.log(`\n[Backfill] ✅ Done — ${inserted} rows written to Google Sheet.`);
  console.log('[Backfill] The sheet now matches Airtable exactly.\n');
})();
