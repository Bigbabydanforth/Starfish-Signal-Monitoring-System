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

// ── Verification badge ────────────────────────────────────────────────────────
// Returns 'verified' | 'unverified' | 'no_email'
function getVerifBadge(emailVerification, hasEmail) {
  if (!hasEmail)                                        return 'no_email';
  if (!emailVerification)                               return 'unverified';
  if (emailVerification.valid === true && !emailVerification.flagged) return 'verified';
  return 'unverified';
}

// Internal shape builder — all contact cards share this structure.
function makeCard({ day = null, name, title, contact_str, badge }) {
  return {
    day,
    name:             (name || '').trim() || 'Unknown',
    title:            title || 'Unknown Title',
    contact_str:      contact_str || '—',
    badge_verified:   badge === 'verified',
    badge_unverified: badge === 'unverified',
    badge_no_email:   badge === 'no_email'
  };
}

// Broadcast contact object (signal.bsi_contacts[] or signal.broadcast_contacts[]) → card
function broadcastToCard(c) {
  return makeCard({
    day:         c.send_day || null,
    name:        `${c.first_name || ''} ${c.last_name || ''}`.trim(),
    title:       c.title,
    contact_str: c.email || c.linkedin_url,
    badge:       getVerifBadge(c.emailVerification, !!c.email)
  });
}

// signal.person (Job Change / AudienceLab) → card
function personToCard(signal) {
  const p     = signal.person;
  const email = p.email || signal._puppeteer_email || null;
  return makeCard({
    day:         p.send_day || 1,
    name:        `${p.first_name || ''} ${p.last_name || ''}`.trim(),
    title:       p.title,
    contact_str: email || p.linkedin_url,
    badge:       getVerifBadge(signal.emailVerification, !!email)
  });
}

// M&A acquiring-company C-suite contact → card
function maToCard(c) {
  const badge = !c.email ? 'no_email' : c.email_flagged ? 'unverified' : 'verified';
  return makeCard({ day: null, name: c.name, title: c.title, contact_str: c.email || c.linkedin_url, badge });
}

// News/Press article-named person (fallback when broadcast found nothing) → card
function articlePersonToCard(signal) {
  const p     = signal._article_named_person;
  const email = signal._puppeteer_email || null;
  return makeCard({
    day:         1,
    name:        `${p.firstName || ''} ${p.lastName || ''}`.trim(),
    title:       p.title || 'Executive',
    contact_str: email || signal.company?.website,
    badge:       getVerifBadge(signal.emailVerification, !!email)
  });
}

// Parse a single Airtable Contact Info string + metadata → card
// Handles structured format ("Name: X\nTitle: Y\nEmail: Z") and M&A inline format ("Name — Title | email")
function parseAirtableContact({ contact_info: raw, send_day, email_verified }) {
  if (!raw || raw.startsWith('⚠️ Contact Needed') || raw === 'Contact Needed') return null;
  const lines = raw.split('\n');
  let name, title, emailRaw, linkedin;

  if (lines[0]?.startsWith('Name: ')) {
    // Structured multi-line format
    const get = p => (lines.find(l => l.startsWith(p)) || '').slice(p.length).trim() || null;
    name     = get('Name: ');
    title    = get('Title: ');
    emailRaw = get('Email: ');
    linkedin = get('LinkedIn: ');
  } else if (raw.includes(' — ')) {
    // M&A inline format: "Name — Title | email | linkedin"
    const [namePart, ...rest] = raw.split(' — ');
    name = namePart.trim();
    const parts = rest.join(' — ').split(' | ');
    title    = parts[0]?.trim() || null;
    emailRaw = parts[1]?.trim() || null;
    linkedin = parts[2]?.trim() || null;
  } else {
    return null;
  }

  const email = emailRaw
    ? emailRaw.replace(/\s*\[unverified\].*/, '').replace(/\s*\(via\s[^)]+\)/, '').trim()
    : null;

  // Prefer Airtable's Email Verified field when available; fall back to [unverified] marker in string
  let badge;
  if (email_verified) {
    badge = !email ? 'no_email'
      : (email_verified === 'Verified' || email_verified === 'Likely') ? 'verified'
      : 'unverified';
  } else {
    badge = !email ? 'no_email' : emailRaw?.includes('[unverified]') ? 'unverified' : 'verified';
  }

  return makeCard({ day: send_day || null, name, title, contact_str: email || linkedin, badge });
}

// ── Build unified contacts array from whatever data the signal has ─────────────
function buildContacts(signal) {
  // 1. BSI broadcast contacts (live pipeline)
  if (signal.bsi_contacts?.length > 0) {
    return [...signal.bsi_contacts]
      .sort((a, b) => (a.send_day || 5) - (b.send_day || 5))
      .map(broadcastToCard);
  }

  // 2. Job Change / AudienceLab — person is Contact #1, broadcast execs follow
  if (signal.person?.first_name && (signal.type === 'Job Change' || signal.source === 'AudienceLab')) {
    const cards = [personToCard(signal)];
    if (signal.broadcast_contacts?.length > 0) {
      const extra = [...signal.broadcast_contacts]
        .sort((a, b) => (a.send_day || 5) - (b.send_day || 5))
        .map(broadcastToCard);
      cards.push(...extra);
    }
    return cards;
  }

  // 3. Non-BSI broadcast contacts (News/Press, Rebrand, WV, etc.)
  if (signal.broadcast_contacts?.length > 0) {
    return [...signal.broadcast_contacts]
      .sort((a, b) => (a.send_day || 5) - (b.send_day || 5))
      .map(broadcastToCard);
  }

  // 4. M&A C-suite contacts
  if (signal.type === 'M&A Activity' && signal.ma_contacts?.length > 0) {
    return signal.ma_contacts.map(maToCard);
  }

  // 5. News/Press article-named person (no broadcast found / ran)
  if (signal._article_named_person) {
    return [articlePersonToCard(signal)];
  }

  // 6. Standalone runner — grouped Airtable contacts (multiple records merged into one signal)
  if (signal._grouped_contacts?.length > 0) {
    return signal._grouped_contacts
      .map(gc => parseAirtableContact(gc))
      .filter(Boolean)
      .sort((a, b) => (a.day ?? 99) - (b.day ?? 99));
  }

  // 7. Standalone runner — single Airtable contact (not a broadcast signal)
  if (signal.contact_info_raw) {
    const c = parseAirtableContact({
      contact_info:   signal.contact_info_raw,
      send_day:       signal._send_day       || null,
      email_verified: signal._email_verified || null
    });
    return c ? [c] : [];
  }

  return [];
}

function buildSignalCard(signal) {
  const contacts = buildContacts(signal);
  const card = {
    company_name:   signal.company.name,
    signal_type:    signal.type,
    signal_details: formatSignalDetails(signal),
    brief:          signal.brief,
    industry:       signal.company.industry || 'Unknown',
    source_url:     signal.source_url || '#'
  };

  if (contacts.length > 0) {
    card.contacts       = contacts;
    card.contacts_count = contacts.length;
  } else {
    card.contact_needed  = true;
    card.company_website = signal._company_website || signal.company?.website || null;
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

  // A card needs research if no contacts were found for the signal
  const needsResearch = c => c.contact_needed;
  const readyCards          = allCards.filter(c => !needsResearch(c));
  const researchNeededCards = allCards.filter(c =>  needsResearch(c));

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
    const envKey = nodeEnv === 'production' ? 'EMAIL_TO_PRODUCTION' : 'EMAIL_TO_TESTING';
    console.error(`[Email] FATAL — No valid recipients for NODE_ENV="${nodeEnv}". Check ${envKey} in .env — email NOT sent.`);
    // Alert immediately so the operator knows this is a config failure, not an SMTP failure.
    // Don't wait for Workflow 6 Telegram monitoring — that could be 30+ minutes later.
    try {
      const { sendErrorAlert } = await import('./utils/telegram_client.js');
      await sendErrorAlert(`🚨 Email NOT sent — no valid recipients. Check ${envKey} in Railway env vars. NODE_ENV=${nodeEnv}`);
    } catch (alertErr) {
      console.error('[Email] Telegram alert also failed:', alertErr.message);
    }
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

    // Also load from AudienceLab base if configured — Website Visitor and BSI signals are
    // saved there separately to avoid hitting the main base record limit. Without this,
    // standalone email re-runs (e.g. node workflow_5_send_email.js --since 2026-07-09)
    // would silently omit all AudienceLab signals.
    const alBaseId    = process.env.AUDIENCELAB_AIRTABLE_BASE_ID;
    const alTableName = process.env.AUDIENCELAB_AIRTABLE_TABLE_NAME;
    if (alBaseId && alTableName) {
      try {
        const alBase    = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(alBaseId);
        const alRecords = await alBase(alTableName).select(selectOptions).all();
        records = [...records, ...alRecords];
        console.log(`[Workflow 5] +${alRecords.length} signals from AudienceLab base`);
      } catch (alErr) {
        console.warn(`[Workflow 5] Could not load AudienceLab base — Website Visitor signals may be missing: ${alErr.message}`);
      }
    }

    // Slice by row number if --rows was given (1-indexed, matching Airtable's grid view order)
    if (rowFrom !== null && rowTo !== null) {
      records = records.slice(rowFrom - 1, rowTo);
      console.log(`[Workflow 5] Row filter: ${rowFrom}–${rowTo} → ${records.length} records`);
    }

    console.log(`[Workflow 5] Loaded ${records.length} signals from Airtable (main + AudienceLab bases)`);

    if (records.length === 0) {
      console.log('[Workflow 5] No signals found for the given date range — nothing to send');
      process.exit(0);
    }

    // Group records by (company + signal type + date) so broadcast contacts for the same
    // company appear under ONE signal card instead of N separate cards.
    const groupMap = new Map();
    for (const r of records) {
      const key = [
        r.fields['Company Name']  || '',
        r.fields['Signal Type']   || '',
        r.fields['Date Detected'] || ''
      ].join('\x00');
      if (!groupMap.has(key)) groupMap.set(key, []);
      groupMap.get(key).push(r);
    }

    const signals = [...groupMap.values()].map(group => {
      const primary = group[0];

      // A signal is "contact needed" if every record in the group has no real contact
      const allContactNeeded = group.every(r => {
        const ci = r.fields['Contact Info'] || '';
        return !ci || ci.startsWith('⚠️ Contact Needed') ||
               ci === 'Contact Needed' || ci === 'Contact info not available';
      });

      // Extract company website from the "⚠️ Contact Needed\nWebsite: …" string
      let companyWebsite = null;
      if (allContactNeeded) {
        const ci = (group.find(r => r.fields['Contact Info'])?.fields['Contact Info']) || '';
        const wl = ci.split('\n').find(l => l.startsWith('Website: '));
        if (wl) companyWebsite = wl.slice('Website: '.length).trim();
      }

      return {
        company:            { name: primary.fields['Company Name'] || '', industry: primary.fields['Industry'] || '' },
        type:               primary.fields['Signal Type']    || 'News/Press',
        priority:           primary.fields['Priority']       || 'MEDIUM',
        brief:              primary.fields['Brief']          || '',
        source_url:         primary.fields['Source URL']     || '#',
        signal_details_raw: primary.fields['Signal Details'] || '',
        _contact_needed:    allContactNeeded,
        _company_website:   companyWebsite,
        // Each contact gets its own entry with the raw string + Airtable structured fields
        _grouped_contacts:  allContactNeeded ? [] : group
          .filter(r => {
            const ci = r.fields['Contact Info'] || '';
            return ci && !ci.startsWith('⚠️ Contact Needed') &&
                   ci !== 'Contact Needed' && ci !== 'Contact info not available';
          })
          .map(r => ({
            contact_info:   r.fields['Contact Info']   || '',
            send_day:       r.fields['Send Day']        || null,
            email_verified: r.fields['Email Verified']  || null
          }))
      };
    });

    await sendEmailWorkflow(signals);
  })().catch(err => {
    console.error('[Workflow 5] Fatal:', err.message);
    process.exit(1);
  });
}
