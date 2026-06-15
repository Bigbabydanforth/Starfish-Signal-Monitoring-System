# Workflow 4b — Sync to Google Sheets

## Purpose

Runs immediately after Workflow 4 (Save to Airtable). Fetches today's confirmed Airtable records and appends them to the Starfish client-facing Google Sheet.

Google Sheets is the **view layer only** — Airtable remains the single source of truth. Failure in this workflow is non-critical and never blocks Workflow 5 (email).

---

## Trigger

Called by `main.js` after `saveToAirtable()` completes. Not scheduled independently.

---

## Input

- `verifiedSignals` — the array of deduplicated, PDL-verified signal objects passed through the pipeline. Used only to check if the pipeline produced any signals (early exit if empty).
- Airtable — queried fresh for today's records using `Date Detected` field so all fields written by Workflow 4 (email, revenue, contact info) are included.

---

## Process

1. **Guard check** — If `verifiedSignals` is empty or Google Sheets env vars are not configured, log and return `0` without throwing.

2. **Source selection:**
   - **Standard path** (single Airtable base): Queries Airtable with `IS_SAME({Date Detected}, '<today>', 'day')` using Eastern Time (`America/New_York`), sorted by `Created At` ascending. (`IS_SAME` is required — Airtable's `=` operator does not reliably match date fields.)
   - **AudienceLab separate base path** (when `AUDIENCELAB_AIRTABLE_BASE_ID` + `AUDIENCELAB_AIRTABLE_TABLE_NAME` env vars are set): Syncs directly from the in-memory `verifiedSignals` pipeline array via `signalToRow()`. This is the only way to include AudienceLab records in the sheet when they are routed to a separate Airtable base that the standard query can't reach.

3. **Append to Google Sheet** — Uses the Sheets API `values.append()` method with range `Signals!A5`. This automatically finds the true last row of data, making it immune to gaps in column A (e.g. signals with no company name, or manual edits). Never touches rows 1–4 (client's dashboard header area).

   > **Bug fix (2026-06-15):** The previous implementation fetched column A, counted non-empty cells to compute the next empty row, then called `values.update()` at that row number. Any row with a blank in column A (missing company name or manual edit) would make the count short — causing new rows to overwrite existing data silently. Replaced with `values.append()`, which finds the correct insertion point automatically.

4. **Non-critical error handling** — Any error is caught, logged, and a Telegram alert is sent via `sendErrorAlert()`. The function always returns a number (rows inserted, or 0 on failure). Never throws.

---

## Output

Returns the number of rows appended to Google Sheets (integer). `0` on skip or failure.

---

## Google Sheet Layout

| Rows | Content |
|------|---------|
| 1–4  | Client dashboard header — never touched by code |
| 5+   | Signal data rows — appended here |

**Column order (A → O):**
Company Name | Signal Details | Signal Type | Contact Info | Company Revenue | Company Funding Stage | Industry | Date Detected | Priority | Brief | Contact Approach | Source URL | Status | Created At | Last Modified

---

## Authentication

Uses OAuth 2.0 with a refresh token (no service account key required).

**Required `.env` variables:**
```
GOOGLE_SHEET_ID
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_REFRESH_TOKEN
```

---

## Key Design Decisions

- **Airtable is re-queried** (standard path) so that all enrichment fields saved by Workflow 4 (email, revenue, contact info) are included in the sheet data.
- **In-memory sync** (AudienceLab separate base path) is used when `AUDIENCELAB_AIRTABLE_BASE_ID` is configured, because AudienceLab records live in a separate Airtable base that the standard `IS_SAME` query cannot reach. `signalToRow()` produces the same column layout as `recordToRow()` so the sheet format is always consistent.
- **`values.append()` over `values.update()`** — append finds the true last data row automatically; update required manual row counting from column A, which silently overwrites existing data when any row has a blank company name.
- **Eastern Time date** (`toLocaleDateString('en-CA', { timeZone: 'America/New_York' })`) prevents UTC/EST boundary mismatches on the `Date Detected` filter.
- **Non-critical by design** — Google Sheets is a convenience layer for the client. If it fails, the client still receives their email and Airtable is fully intact.

---

## Related Files

- `execution/workflow_4b_sync_sheets.js` — implementation
- `execution/utils/sheets_client.js` — Google Sheets API client (`appendRows`, `rewriteAllRows`)
- `execution/backfill_to_sheets.js` — one-time backfill script for historical records
