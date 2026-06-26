import 'dotenv/config';
import fs from 'fs';
import path, { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import Handlebars from 'handlebars';
import juice from 'juice';

import { sendEmail } from './utils/email_client.js';
import { sendErrorAlert } from './utils/telegram_client.js';
import { getTodayStamp, formatDisplayDate } from './utils/date_helpers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const TMP_DIR = resolve(__dirname, '../.tmp');

function formatSignalDetails(signal) {
  // Merged signals from workflow_3 store context as signalDetails (camelCase)
  if (signal.signalDetails) return signal.signalDetails;

  // Pipeline signals have a pre-built signal_details string from workflow_4's formatSignalDetails
  if (signal.signal_details) return signal.signal_details;

  // Airtable-loaded signals (standalone runner) pass Signal Details directly
  if (signal.signal_details_raw) return signal.signal_details_raw;

  // Fallback: reconstruct from available fields
  if (signal.type === 'Job Change' && signal.person) {
    return `${signal.person.first_name} ${signal.person.last_name} joined ${signal.company.name} as ${signal.person.title}.`;
  }
  if (signal.type === 'Website Visitor' && signal.person) {
    const name = `${signal.person.first_name || ''} ${signal.person.last_name || ''}`.trim() || 'Unknown';
    return `${name} (${signal.person.title || 'Unknown Title'}) from ${signal.company.name} visited the Starfish website.`;
  }
  if (signal.type === 'Brand Strategy Intent') {
    // BSI details come from signal_details_raw (Airtable) or signal.signalDetails (pipeline) — checked above.
    // signal.person is always null for BSI after the broadcast rewrite, so this is a company-level fallback only.
    return `${signal.company?.name || 'Company'} is actively researching brand strategy online.`;
  }
  if (signal.type === 'News/Press' && signal.article?.title) {
    return signal.article.title + (signal.article.description ? '. ' + signal.article.description : '');
  }
  if (signal.type === 'M&A Activity' && signal.deal) {
    return `${(signal.deal.type || '').replace(/_/g, ' ').toUpperCase()}: ${signal.company.name}` +
      (signal.deal.seller ? ` acquiring ${signal.deal.seller}` : '');
  }
  if (signal.type === 'Rebrand' && signal.rebrand) {
    return `${signal.company?.name || 'Company'} is rebranding` +
      (signal.rebrand.new_name ? ` to ${signal.rebrand.new_name}` : '') +
      (signal.rebrand.summary ? `. ${signal.rebrand.summary}` : '');
  }
  return signal.brief || '(details not available)';
}

function formatContactInfo(signal) {
  if (signal.contact_info_raw) return signal.contact_info_raw.split('\n')[0]; // first line only (Airtable-loaded)
  // Pipeline run — use the string workflow_4 wrote to Airtable directly
  if (signal._contactInfo !== undefined && signal.type !== 'Brand Strategy Intent') return signal._contactInfo;
  if (signal.type === 'Job Change' && signal.person) {
    let info = `${signal.person.first_name} ${signal.person.last_name}, ${signal.person.title}`;
    if (signal.person.linkedin_url) info += ` — ${signal.person.linkedin_url}`;
    return info;
  }
  if (signal.source === 'AudienceLab' && signal.person) {
    const name = `${signal.person.first_name || ''} ${signal.person.last_name || ''}`.trim();
    let info = name ? `${name}, ${signal.person.title || 'Unknown Title'}` : (signal.person.title || '');
    if (signal.person.email)             info += ` — ${signal.person.email}`;
    else if (signal._puppeteer_email)    info += ` — ${signal._puppeteer_email}`;
    else if (signal.person.linkedin_url) info += ` — ${signal.person.linkedin_url}`;
    return info || signal.company.website || 'Contact info not available';
  }
  if (signal.type === 'M&A Activity' && signal.ma_contacts?.length > 0) {
    // Show top contact from the acquirer C-Suite
    const top = signal.ma_contacts[0];
    let info = `${top.name}, ${top.title || 'Unknown Title'}`;
    if (top.email)        info += ` — ${top.email}`;
    else if (top.linkedin_url) info += ` — ${top.linkedin_url}`;
    if (signal.ma_contacts.length > 1) info += ` (+${signal.ma_contacts.length - 1} more)`;
    return info;
  }
  if (signal.type === 'Rebrand') {
    return signal.company?.website || signal.source_url || 'Contact info not available';
  }
  // News/Press and any other type — show enriched email if found, else website
  if (signal._puppeteer_email) return `${signal._puppeteer_email} (via ${signal._puppeteer_source || 'enrichment'})`;
  return signal.company.website || 'Contact info not available';
}

function buildSignalCard(signal) {
  const card = {
    company_name:   signal.company.name,
    signal_type:    signal.type,
    signal_details: formatSignalDetails(signal),
    brief:          signal.brief,
    industry:       signal.company.industry || 'Unknown',
    source_url:     signal.source_url || '#'
  };

  // BSI broadcast contacts — show per-day list instead of single contact
  if (signal.type === 'Brand Strategy Intent') {
    if (signal.bsi_contacts?.length > 0) {
      // Live pipeline run — structured broadcast contacts available
      const sorted = [...signal.bsi_contacts].sort((a, b) => (a.send_day || 5) - (b.send_day || 5));
      card.bsi_broadcast = sorted.map(c => ({
        day:     c.send_day || 5,
        name:    `${c.first_name || ''} ${c.last_name || ''}`.trim() || 'Unknown',
        title:   c.title || 'Unknown Title',
        contact: c.email || c.linkedin_url || '—'
      }));
      card.bsi_broadcast_count = signal.bsi_contacts.length;
      card.contact_info = null;
    } else if (signal.contact_info_raw) {
      // Standalone test runner — loaded from Airtable (one record per contact already)
      card.contact_info = signal.contact_info_raw.split('\n')[0];
    } else {
      // No contacts found in live run — flag clearly
      card.bsi_contact_needed = true;
      card.company_website    = signal.company.website || null;
      card.contact_info       = null;
    }
  } else {
    card.contact_info = formatContactInfo(signal);
  }

  return card;
}

async function sendEmailWorkflow(deduplicatedSignals) {
  const today = getTodayStamp();

  // Step 5.1: Build all cards first, then split into "Ready to Contact" vs "Research Needed".
  // BSI signals where no contacts were found (bsi_contact_needed: true) go into their own
  // section at the bottom — per David's instruction (Option C). All other signals stay in
  // the HIGH / MEDIUM / LOW priority buckets as before.
  const allCards = deduplicatedSignals.map(s => ({ ...buildSignalCard(s), _priority: s.priority }));

  const readyCards          = allCards.filter(c => !c.bsi_contact_needed);
  const researchNeededCards = allCards.filter(c =>  c.bsi_contact_needed);

  const highPriority   = readyCards.filter(c => c._priority === 'HIGH');
  const mediumPriority = readyCards.filter(c => c._priority === 'MEDIUM');
  const lowPriority    = readyCards.filter(c => c._priority === 'LOW');

  console.log(`[Email] Signals — HIGH: ${highPriority.length}, MEDIUM: ${mediumPriority.length}, LOW: ${lowPriority.length}, Research Needed: ${researchNeededCards.length}`);

  // Step 5.2: Load and populate template
  const templatePath = path.join(__dirname, '..', 'templates', 'email_template.html');
  const templateSource = fs.readFileSync(templatePath, 'utf8');
  const template = Handlebars.compile(templateSource);

  const dateFormatted  = formatDisplayDate(new Date());
  const airtableLink   = `https://airtable.com/${process.env.AIRTABLE_BASE_ID}`;

  const templateData = {
    DATE:                    dateFormatted,
    TOTAL_COUNT:             deduplicatedSignals.length,
    HIGH_COUNT:              highPriority.length,
    MEDIUM_COUNT:            mediumPriority.length,
    LOW_COUNT:               lowPriority.length,
    RESEARCH_NEEDED_COUNT:   researchNeededCards.length,
    AIRTABLE_LINK:           airtableLink,
    NO_SIGNALS:              deduplicatedSignals.length === 0,
    HIGH_SIGNALS:            highPriority,
    MEDIUM_SIGNALS:          mediumPriority,
    LOW_SIGNALS:             lowPriority,
    RESEARCH_NEEDED_SIGNALS: researchNeededCards
  };

  const emailHTML = juice(template(templateData)); // inline CSS for Gmail

  // Step 5.3: Determine recipients
  const nodeEnv   = process.env.NODE_ENV || 'development';
  const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const recipients = (nodeEnv === 'production'
    ? (process.env.EMAIL_TO_PRODUCTION || '').split(',').map(e => e.trim()).filter(Boolean)
    : [process.env.EMAIL_TO_TESTING].filter(Boolean)
  ).filter(e => {
    if (EMAIL_REGEX.test(e)) return true;
    console.warn(`[Email] Skipping invalid address: "${e}" — fix EMAIL_TO_${nodeEnv.toUpperCase()} in .env`);
    return false;
  });

  if (recipients.length === 0) {
    console.error(`[Email] No recipients configured for NODE_ENV="${nodeEnv}" — check EMAIL_TO_PRODUCTION / EMAIL_TO_TESTING in .env`);
    return false;
  }

  console.log(`[Email] Recipients (${nodeEnv}): ${recipients.join(', ')}`);

  // Step 5.4: Send
  const subject = `Starfish Signals - ${dateFormatted} - ${deduplicatedSignals.length} New Opportunities`;

  // Try sending with one retry after 30s on failure
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const info = await sendEmail({ to: recipients, subject, html: emailHTML });

      const logEntry = `
[${new Date().toISOString()}] Email Send Log
==========================================
Recipients: ${recipients.join(', ')}
Subject:    ${subject}
Signals:    ${deduplicatedSignals.length} (HIGH: ${highPriority.length}, MEDIUM: ${mediumPriority.length}, LOW: ${lowPriority.length})
Status:     SUCCESS${attempt > 1 ? ' (retry)' : ''}
Message ID: ${info.messageId}
==========================================
`;
      fs.appendFileSync(`${TMP_DIR}/email_log_${today}.txt`, logEntry);
      console.log(`[Email] Sent successfully${attempt > 1 ? ' (on retry)' : ''}`);
      return true;

    } catch (error) {
      if (attempt === 1) {
        console.warn(`[Email] Send failed (attempt 1/2): ${error.message} — retrying in 30s...`);
        await new Promise(r => setTimeout(r, 30000));
        continue;
      }

      console.error('[Email] Send failed after retry:', error.message);

      fs.writeFileSync(`${TMP_DIR}/unsent_email_${today}.html`, emailHTML);

      const logEntry = `
[${new Date().toISOString()}] Email Send Log
==========================================
Recipients: ${recipients.join(', ')}
Subject:    ${subject}
Status:     FAILED (after 2 attempts)
Error:      ${error.message}
Saved HTML: ${TMP_DIR}/unsent_email_${today}.html
==========================================
`;
      fs.appendFileSync(`${TMP_DIR}/email_log_${today}.txt`, logEntry);

      await sendErrorAlert(`Email delivery failed: ${error.message}`);
      return false;
    }
  }
}

export default sendEmailWorkflow;

// ── Standalone test runner ────────────────────────────────────────────────────
// Run all:               node execution/workflow_5_send_email.js
// Filter by date:        node execution/workflow_5_send_email.js --since 2026-05-25
// Filter date range:     node execution/workflow_5_send_email.js --since 2026-05-25 --until 2026-05-28
// Send to production:    NODE_ENV=production node execution/workflow_5_send_email.js --since 2026-05-25
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  (async () => {
    console.log('\n[Workflow 5 — Standalone Test]');

    // Parse --rows flag (e.g. --rows 53-72)
    const rowsIdx = process.argv.indexOf('--rows');
    let rowFrom = null, rowTo = null;
    if (rowsIdx !== -1) {
      const match = (process.argv[rowsIdx + 1] || '').match(/^(\d+)-(\d+)$/);
      if (match) { rowFrom = parseInt(match[1]); rowTo = parseInt(match[2]); }
    }

    // Parse --since and --until date flags
    const sinceIdx = process.argv.indexOf('--since');
    const untilIdx = process.argv.indexOf('--until');
    const rawSince = sinceIdx !== -1 ? process.argv[sinceIdx + 1] : null;
    const rawUntil = untilIdx !== -1 ? process.argv[untilIdx + 1] : null;

    // Validate date format — must be YYYY-MM-DD with valid calendar values
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    function isValidDate(str) {
      if (!str || !DATE_RE.test(str)) return false;
      const d = new Date(`${str}T00:00:00Z`);
      return !isNaN(d.getTime()) && d.toISOString().startsWith(str);
    }
    if (rawSince && !isValidDate(rawSince)) {
      console.error(`[Workflow 5] ❌ Invalid --since date: "${rawSince}" — must be YYYY-MM-DD`);
      process.exit(1);
    }
    if (rawUntil && !isValidDate(rawUntil)) {
      console.error(`[Workflow 5] ❌ Invalid --until date: "${rawUntil}" — must be YYYY-MM-DD`);
      process.exit(1);
    }
    const sinceDate = rawSince;
    const untilDate = rawUntil;

    // Build Airtable filter formula
    // IS_SAME() is required for date field matching — Airtable's >= / <= operators
    // do not reliably match date fields (confirmed bug, same fix applied in workflow_4b).
    let filterParts = [];
    if (sinceDate && untilDate && sinceDate === untilDate) {
      // Single day — use IS_SAME for exact match
      filterParts.push(`IS_SAME({Date Detected}, '${sinceDate}', 'day')`);
    } else {
      if (sinceDate) filterParts.push(`IS_AFTER({Date Detected}, DATEADD('${sinceDate}', -1, 'day'))`);
      if (untilDate) filterParts.push(`IS_BEFORE({Date Detected}, DATEADD('${untilDate}', 1, 'day'))`);
    }
    const filterByFormula = filterParts.length === 1
      ? filterParts[0]
      : filterParts.length > 1
        ? `AND(${filterParts.join(', ')})`
        : '';

    if (sinceDate || untilDate) {
      console.log(`[Workflow 5] Date filter: ${sinceDate || 'start'} → ${untilDate || 'today'}`);
    }

    // Load signals from Airtable (L3: dynamic import — Airtable only needed in standalone runner)
    const { default: Airtable } = await import('airtable');
    const base  = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);
    const table = process.env.AIRTABLE_TABLE_NAME;
    const selectOptions = filterByFormula
      ? { filterByFormula, sort: [{ field: 'Created At', direction: 'asc' }] }
      : { sort: [{ field: 'Created At', direction: 'asc' }] };
    let records = await base(table).select(selectOptions).all();

    // Slice by row number if --rows was given (1-indexed, matching Airtable's grid view order)
    if (rowFrom !== null && rowTo !== null) {
      records = records.slice(rowFrom - 1, rowTo);
      console.log(`[Workflow 5] Row filter: ${rowFrom}–${rowTo} → ${records.length} records`);
    }

    console.log(`[Workflow 5] Loaded ${records.length} signals from Airtable`);

    if (records.length === 0) {
      console.log('[Workflow 5] No signals found for the given date range — nothing to send');
      process.exit(0);
    }

    // Convert Airtable records to the signal shape that sendEmailWorkflow expects
    const signals = records.map(r => ({
      company:             { name: r.fields['Company Name'] || '', industry: r.fields['Industry'] || '' },
      type:                r.fields['Signal Type']   || 'News/Press',
      priority:            r.fields['Priority']      || 'MEDIUM',
      brief:               r.fields['Brief']         || '',
      source_url:          r.fields['Source URL']    || '#',
      person:              null,
      contact_info_raw:    r.fields['Contact Info']  || '',
      signal_details_raw:  r.fields['Signal Details']|| ''
    }));

    await sendEmailWorkflow(signals);
  })().catch(err => {
    console.error('[Workflow 5] Fatal:', err.message);
    process.exit(1);
  });
}
