/**
 * delete_today_sheets.js
 *
 * Deletes all rows from the Google Sheet where "Date Detected" (column H) = 2026-07-15.
 * Data rows start at row 5. Rows 1–4 (dashboard header) are never touched.
 *
 * Run with:  node --env-file=.env scripts/delete_today_sheets.js
 *            node --env-file=.env scripts/delete_today_sheets.js --live
 */

import 'dotenv/config';
import { google } from 'googleapis';

const LIVE        = process.argv.includes('--live');
const TARGET_DATE = '2026-07-15';
const SHEET_NAME  = 'Signals';
const DATA_START_ROW = 5;   // row index (1-based); rows 1–4 are dashboard header
const DATE_COL_INDEX = 7;   // column H (0-based) = Date Detected

console.log('────────────────────────────────────────────────────────────');
console.log(`DELETE TODAY'S ROWS — Google Sheet — Date Detected = ${TARGET_DATE}`);
console.log(`Mode: ${LIVE ? 'LIVE (will delete rows)' : 'PREVIEW (no changes)'}`);
console.log('────────────────────────────────────────────────────────────\n');

function getAuth() {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return auth;
}

async function run() {
  if (!process.env.GOOGLE_SHEET_ID || !process.env.GOOGLE_CLIENT_ID ||
      !process.env.GOOGLE_CLIENT_SECRET || !process.env.GOOGLE_REFRESH_TOKEN) {
    console.error('Missing Google env vars — check .env');
    process.exit(1);
  }

  const auth    = getAuth();
  const sheets  = google.sheets({ version: 'v4', auth });
  const sheetId = process.env.GOOGLE_SHEET_ID;

  // ── Step 1: Read all data rows ──────────────────────────────────────────────
  console.log('Reading rows from Google Sheet...');
  let rows;
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range:         `${SHEET_NAME}!A${DATA_START_ROW}:O`
    });
    rows = res.data.values || [];
  } catch (err) {
    console.error('Failed to read sheet:', err.message);
    process.exit(1);
  }

  console.log(`Total data rows in sheet: ${rows.length}`);

  // ── Step 2: Find rows matching today's date ─────────────────────────────────
  // rowIndex here is the 0-based offset from DATA_START_ROW.
  // Actual sheet row number = DATA_START_ROW + rowIndex (1-based).
  const matchingSheetRows = [];
  for (let i = 0; i < rows.length; i++) {
    const dateCell = (rows[i][DATE_COL_INDEX] || '').trim();
    if (dateCell === TARGET_DATE) {
      matchingSheetRows.push({
        sheetRowNumber: DATA_START_ROW + i,  // 1-based row number in sheet
        company: rows[i][0] || '(no name)',
        signalType: rows[i][2] || '',
        dateDetected: dateCell
      });
    }
  }

  if (matchingSheetRows.length === 0) {
    console.log(`\nNo rows found with Date Detected = ${TARGET_DATE}. Nothing to delete.`);
    return;
  }

  console.log(`\nFound ${matchingSheetRows.length} row(s) from today:\n`);
  for (const r of matchingSheetRows) {
    console.log(`  Row ${r.sheetRowNumber}: ${r.company} [${r.signalType}] — ${r.dateDetected}`);
  }

  if (!LIVE) {
    console.log('\nPreview mode — no rows deleted.');
    console.log('Run with --live to delete these rows.');
    return;
  }

  // ── Step 3: Get the numeric sheet tab ID (gid) ─────────────────────────────
  // deleteDimension requires the numeric sheetId (gid), not the sheet name.
  let tabId;
  try {
    const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
    const tab  = meta.data.sheets.find(s => s.properties.title === SHEET_NAME);
    if (!tab) {
      console.error(`Sheet tab "${SHEET_NAME}" not found in the spreadsheet.`);
      process.exit(1);
    }
    tabId = tab.properties.sheetId;
  } catch (err) {
    console.error('Failed to get sheet metadata:', err.message);
    process.exit(1);
  }

  // ── Step 4: Delete ALL rows in a single batchUpdate call ──────────────────
  // One batchUpdate = 1 API write request, no matter how many rows.
  // Requests inside batchUpdate are applied sequentially, so sort descending
  // so higher row indexes are deleted first — prevents index shifting from
  // affecting rows we haven't deleted yet within the same batch.
  const sortedDesc = [...matchingSheetRows].sort((a, b) => b.sheetRowNumber - a.sheetRowNumber);

  const requests = sortedDesc.map(r => ({
    deleteDimension: {
      range: {
        sheetId:    tabId,
        dimension:  'ROWS',
        startIndex: r.sheetRowNumber - 1,   // 0-based, inclusive
        endIndex:   r.sheetRowNumber         // 0-based, exclusive
      }
    }
  }));

  console.log(`\nSending 1 batchUpdate with ${requests.length} delete requests...`);
  try {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: { requests }
    });
    console.log(`\n✅ Done — ${requests.length} row(s) removed from Google Sheet.`);
  } catch (err) {
    console.error(`\n❌ batchUpdate failed: ${err.message}`);
    process.exit(1);
  }
}

run();
