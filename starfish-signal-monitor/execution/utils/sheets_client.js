import 'dotenv/config';
import { google } from 'googleapis';

// ── Auth ──────────────────────────────────────────────────────────────────────
// Uses OAuth 2.0 with a refresh token — no service account key needed.
// Requires: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN

function getAuth() {
  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN must be set in .env');
  }

  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });
  return auth;
}

// ── Sheet layout ──────────────────────────────────────────────────────────────
// Headers are pre-built in the sheet at row 4 by the client.
// Data rows start at row 5. We never touch rows 1–4.
//
// Column order (matches client's sheet exactly, left to right):
// Company Name | Signal Details | Signal Type | Contact Info | Company Revenue |
// Company Funding Stage | Industry | Date Detected | Priority | Brief |
// Contact Approach | Source URL | Status | Created At | Last Modified

const DATA_START_ROW = 5;
const SHEET_NAME     = 'Signals';

// ── Format one Airtable record → one Sheet row ────────────────────────────────
function recordToRow(record) {
  const f = record.fields;
  const rawRevenue = Number(f['Company Revenue']);
  const revenue = f['Company Revenue'] && !isNaN(rawRevenue)
    ? `$${rawRevenue.toLocaleString()}`
    : '';

  return [
    f['Company Name']          || '',
    f['Signal Details']        || '',
    f['Signal Type']           || '',
    f['Contact Info']          || '',
    revenue,
    f['Company Funding Stage'] || '',
    f['Industry']              || '',
    f['Date Detected']         || '',
    f['Priority']              || '',
    f['Brief']                 || '',
    f['Contact Approach']      || '',
    f['Source URL']            || '',
    f['Status']                || 'New',
    f['Created At']            || '',
    f['Last Modified']         || ''
  ];
}

// ── Get the next empty data row number ───────────────────────────────────────
// Counts how many data rows already exist (from row 5 down) in column A.
async function getNextEmptyRow(sheets, sheetId) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range:         `${SHEET_NAME}!A${DATA_START_ROW}:A`
  });
  const existingRows = res.data.values || [];
  return DATA_START_ROW + existingRows.length;
}

// ── Append rows to the sheet (used by daily pipeline) ────────────────────────
// Appends new records after the last existing data row, starting at row 5+.
// Never touches the dashboard header rows (1–4).
async function appendRows(records) {
  if (!process.env.GOOGLE_SHEET_ID) {
    throw new Error('GOOGLE_SHEET_ID must be set in .env');
  }

  const auth    = getAuth();
  const sheets  = google.sheets({ version: 'v4', auth });
  const sheetId = process.env.GOOGLE_SHEET_ID;

  const nextRow = await getNextEmptyRow(sheets, sheetId);
  const rows    = records.map(rec => recordToRow(rec));

  await sheets.spreadsheets.values.update({
    spreadsheetId:    sheetId,
    range:            `${SHEET_NAME}!A${nextRow}`,
    valueInputOption: 'USER_ENTERED',
    requestBody:      { values: rows }
  });

  console.log(`[Sheets] Appended ${rows.length} rows starting at row ${nextRow}`);
  return rows.length;
}

// ── Clear data rows and rewrite (used by backfill) ────────────────────────────
// Clears only rows 5 and below — never touches the dashboard layout (rows 1–4).
async function rewriteAllRows(records) {
  if (!process.env.GOOGLE_SHEET_ID) {
    throw new Error('GOOGLE_SHEET_ID must be set in .env');
  }

  const auth    = getAuth();
  const sheets  = google.sheets({ version: 'v4', auth });
  const sheetId = process.env.GOOGLE_SHEET_ID;

  // Clear data area only (rows 5+) — dashboard rows 1–4 are untouched
  await sheets.spreadsheets.values.clear({
    spreadsheetId: sheetId,
    range:         `${SHEET_NAME}!A${DATA_START_ROW}:Z10000`
  });

  const rows = records.map(rec => recordToRow(rec));

  await sheets.spreadsheets.values.update({
    spreadsheetId:    sheetId,
    range:            `${SHEET_NAME}!A${DATA_START_ROW}`,
    valueInputOption: 'USER_ENTERED',
    requestBody:      { values: rows }
  });

  return records.length;
}

export { appendRows, rewriteAllRows, getAuth, google };
