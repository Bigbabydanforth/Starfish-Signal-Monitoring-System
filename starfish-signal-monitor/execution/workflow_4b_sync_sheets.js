/**
 * workflow_4b_sync_sheets.js
 *
 * Runs immediately after Workflow 4 (Save to Airtable).
 * Fetches today's Airtable records and appends them to the Starfish
 * Google Sheet starting at row 5 (below the client's dashboard header).
 *
 * Google Sheet is the client-facing view layer — Airtable remains
 * the source of truth. Failure here is non-critical and never blocks
 * the email workflow.
 *
 * Requires in .env:
 *   GOOGLE_SHEET_ID
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_CLIENT_SECRET
 *   GOOGLE_REFRESH_TOKEN
 */

import 'dotenv/config';
import { fileURLToPath } from 'url';
import { query } from './utils/airtable_client.js';
import { appendRows } from './utils/sheets_client.js';
import { sendErrorAlert } from './utils/telegram_client.js';

// Convert an in-memory signal (from the pipeline) into the same row shape
// that recordToRow() in sheets_client produces from an Airtable record.
// This lets us sync ALL signals (including AudienceLab from the separate base)
// directly from memory without a second Airtable query.
function signalToRow(signal) {
  const revenue = signal.company?.revenue && !isNaN(Number(signal.company.revenue))
    ? `$${Number(signal.company.revenue).toLocaleString()}`
    : '';

  // Build contact info string.
  // For pipeline runs, workflow_4 caches the exact string written to Airtable on
  // signal._contactInfo — use it directly so Sheets and Airtable are always identical.
  // For BSI and standalone runs, fall back to rebuilding from the signal shape.
  let contactInfo = '';
  if (signal._contactInfo !== undefined && signal.type !== 'Brand Strategy Intent') {
    contactInfo = signal._contactInfo;
  } else if (signal.type === 'Brand Strategy Intent' && signal.bsi_contacts?.length > 0) {
    // BSI broadcast contacts — one row per signal, list all contacts with their send day
    contactInfo = signal.bsi_contacts
      .sort((a, b) => (a.send_day || 5) - (b.send_day || 5))
      .map(c => {
        const name = `${c.first_name || ''} ${c.last_name || ''}`.trim();
        let line = `Day ${c.send_day}: ${name}${c.title ? ` (${c.title})` : ''}`;
        if (c.email)        line += ` — ${c.email}`;
        else if (c.linkedin_url) line += ` — ${c.linkedin_url}`;
        return line;
      })
      .join('\n');
  } else if ((signal.type === 'Job Change' || signal.source === 'AudienceLab') && signal.person) {
    const name = `${signal.person.first_name || ''} ${signal.person.last_name || ''}`.trim();
    contactInfo = `Name: ${name}\nTitle: ${signal.person.title || 'Unknown'}`;
    if (signal.person.linkedin_url)  contactInfo += `\nLinkedIn: ${signal.person.linkedin_url}`;
    if (signal.person.email)         contactInfo += `\nEmail: ${signal.person.email}`;
    else if (signal._puppeteer_email) contactInfo += `\nEmail: ${signal._puppeteer_email} (via ${signal._puppeteer_source})`;
    if (signal.person.phone)         contactInfo += `\nPhone: ${signal.person.phone}`;
    if (signal.person.department)    contactInfo += `\nDept: ${signal.person.department}`;
  } else if (signal.type === 'M&A Activity' && signal.ma_contacts?.length > 0) {
    contactInfo = signal.ma_contacts.slice(0, 3)
      .map(c => `${c.name} — ${c.title || 'Unknown Title'}${c.email ? ` | ${c.email}` : ''}`)
      .join('\n');
  } else if (signal._puppeteer_email) {
    contactInfo = `Email: ${signal._puppeteer_email} (via ${signal._puppeteer_source || 'enrichment'})`;
  } else {
    contactInfo = signal.company?.website || 'Contact info not available';
  }

  // Build Signal Details string.
  // In a pipeline run, workflow_4's formatForAirtable() always caches the result on
  // signal.signalDetails before this function runs — use it directly so all consumers
  // (Airtable, Sheets, email) show the exact same string.
  // Only rebuild from scratch as a fallback for standalone Sheets syncs where signals
  // come from Airtable records rather than the in-memory pipeline objects.
  let signalDetails = '';
  if (signal.signalDetails) {
    signalDetails = signal.signalDetails.substring(0, 2000);
  } else if (signal.type === 'Job Change' && signal.person) {
    const fullName = `${signal.person.first_name || ''} ${signal.person.last_name || ''}`.trim();
    signalDetails = `${fullName} joined ${signal.company?.name || ''} as ${signal.person.title || 'Unknown'}.`;
    if (signal.person.job_started_at) signalDetails += ` Started: ${signal.person.job_started_at.split('T')[0]}.`;
  } else if (signal.type === 'Website Visitor') {
    const fullName = signal.person ? `${signal.person.first_name || ''} ${signal.person.last_name || ''}`.trim() : 'Unknown';
    signalDetails = `${fullName} (${signal.person?.title || 'Unknown Title'}) from ${signal.company?.name || ''} visited the Starfish website.`;
    if (signal.company?.industry) signalDetails += ` Industry: ${signal.company.industry}.`;
  } else if (signal.type === 'Brand Strategy Intent') {
    signalDetails = `${signal.company?.name || ''} is actively researching brand strategy online.`;
    if (signal.company?.industry) signalDetails += ` Industry: ${signal.company.industry}.`;
    if (signal.bsi_contacts?.length > 0) signalDetails += ` ${signal.bsi_contacts.length} exec contact(s) identified.`;
  } else if (signal.type === 'News/Press' && signal.article) {
    signalDetails = signal.article.title || '';
    if (signal.article.description) signalDetails += '. ' + signal.article.description;
    if (signal.article.source) signalDetails += ` (${signal.article.source})`;
  } else if (signal.type === 'M&A Activity' && signal.deal?.type) {
    const dealType = signal.deal.type.replace(/_/g, ' ').toUpperCase();
    signalDetails = `${dealType}: ${signal.company?.name || ''}`;
    if (signal.deal.seller) signalDetails += ` acquiring ${signal.deal.seller}`;
    signalDetails += signal.deal.amount ? `. Deal value: $${Number(signal.deal.amount).toLocaleString()}` : '. Deal value: Undisclosed';
  } else if (signal.type === 'Rebrand') {
    signalDetails = `${signal.company?.name || ''} is rebranding${signal.rebrand?.new_name ? ` to ${signal.rebrand.new_name}` : ''}.`;
  }

  return [
    signal.company?.name          || '',
    signalDetails,                        // col 1: Signal Details
    signal.type                   || '',
    contactInfo,                          // col 3: Contact Info
    revenue,
    signal.company?.funding_stage || '',
    signal.company?.industry      || '',
    signal.detected_date          || '',
    signal.priority               || '',
    signal.brief                  || '',
    signal.contact_approach       || '',
    signal.source_url             || '',
    'New',
    new Date().toISOString(),
    new Date().toISOString()
  ];
}

async function syncToSheets(verifiedSignals) {
  if (!verifiedSignals || verifiedSignals.length === 0) {
    console.log('[Sheets] No signals to sync — skipping');
    return 0;
  }

  if (process.env.SKIP_SHEETS_SYNC === 'true') {
    console.log('[Sheets] SKIP_SHEETS_SYNC=true — skipping Google Sheets sync');
    return 0;
  }

  if (!process.env.GOOGLE_SHEET_ID ||
      !process.env.GOOGLE_CLIENT_ID ||
      !process.env.GOOGLE_CLIENT_SECRET ||
      !process.env.GOOGLE_REFRESH_TOKEN) {
    console.warn('[Sheets] Google Sheets env vars not configured — skipping sync');
    return 0;
  }

  try {
    // Check if AudienceLab is routing to a separate base — if so, sync ALL signals
    // directly from memory so AudienceLab records are included in Google Sheets too.
    const useAlBase = !!(process.env.AUDIENCELAB_AIRTABLE_BASE_ID && process.env.AUDIENCELAB_AIRTABLE_TABLE_NAME);

    let inserted = 0;

    if (useAlBase) {
      // Sync directly from in-memory signals — covers both main + AudienceLab base
      console.log('[Sheets] Syncing from in-memory signals (AudienceLab separate base detected)...');
      const { getAuth, google } = await import('./utils/sheets_client.js');
      const auth   = getAuth();
      const sheets = google.sheets({ version: 'v4', auth });
      const sheetId = process.env.GOOGLE_SHEET_ID;

      // Use the Sheets append API instead of manually computing the next empty row.
      // The old approach fetched column A and counted non-empty cells, but any row with
      // a blank in column A (e.g. missing company name, or a manual edit) would make the
      // count short — causing new rows to overwrite existing data silently.
      // append() finds the true last row of data automatically, immune to column A gaps.
      const DATA_START_ROW = 5;
      const rows = verifiedSignals.map(signalToRow);

      await sheets.spreadsheets.values.append({
        spreadsheetId:    sheetId,
        range:            `Signals!A${DATA_START_ROW}`,
        valueInputOption: 'USER_ENTERED',
        requestBody:      { values: rows }
      });

      inserted = rows.length;
      console.log(`[Sheets] Appended ${inserted} rows (from memory) to Google Sheet`);

    } else {
      // Standard path — query main Airtable base and sync
      const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      const todayRecords = await query({
        filterByFormula: `IS_SAME({Date Detected}, '${todayStr}', 'day')`,
        sort: [{ field: 'Created At', direction: 'asc' }]
      });

      if (todayRecords.length === 0) {
        console.log('[Sheets] No Airtable records for today — skipping');
        return 0;
      }

      inserted = await appendRows(todayRecords);
      console.log(`[Sheets] Appended ${inserted} rows to Google Sheet`);
    }

    return inserted;

  } catch (err) {
    // Non-critical — log and continue. Never throw.
    console.error('[Sheets] Sync failed (non-critical):', err.message);
    await sendErrorAlert(`Google Sheets sync failed: ${err.message}`);
    return 0;
  }
}

export default syncToSheets;

// ── Standalone runner ─────────────────────────────────────────────────────────
// Run:                node execution/workflow_4b_sync_sheets.js
// Specific date:      node execution/workflow_4b_sync_sheets.js --date 2026-06-05
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  (async () => {
    const dateIdx  = process.argv.indexOf('--date');
    const dateArg  = dateIdx !== -1 ? process.argv[dateIdx + 1] : null;
    const targetDate = dateArg ||
      new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

    console.log(`\n[Sheets Standalone] Syncing records for: ${targetDate}`);

    if (!process.env.GOOGLE_SHEET_ID ||
        !process.env.GOOGLE_CLIENT_ID ||
        !process.env.GOOGLE_CLIENT_SECRET ||
        !process.env.GOOGLE_REFRESH_TOKEN) {
      console.error('[Sheets] Missing Google env vars — check .env');
      process.exit(1);
    }

    let records;
    try {
      records = await query({
        filterByFormula: `IS_SAME({Date Detected}, '${targetDate}', 'day')`,
        sort: [{ field: 'Created At', direction: 'asc' }]
      });
    } catch (err) {
      console.error('[Sheets] Airtable query failed:', err.message);
      process.exit(1);
    }

    console.log(`[Sheets] Found ${records.length} records in Airtable for ${targetDate}`);

    if (records.length === 0) {
      console.log('[Sheets] Nothing to append.');
      process.exit(0);
    }

    try {
      const inserted = await appendRows(records);
      console.log(`[Sheets] Done — ${inserted} rows appended to Google Sheet.\n`);
    } catch (err) {
      console.error('[Sheets] Write failed:', err.message);
      process.exit(1);
    }
  })().catch(err => {
    console.error('[Sheets Standalone] Fatal:', err.message);
    process.exit(1);
  });
}
