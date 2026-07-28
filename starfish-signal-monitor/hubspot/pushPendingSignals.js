/**
 * hubspot/pushPendingSignals.js
 *
 * Reads all Airtable signal records where HubSpot Pushed = false,
 * pushes each one to HubSpot via pushSignalToHubSpot(), then marks
 * HubSpot Pushed = true on success.
 *
 * Called by the 6 AM cron in main.js on Tuesday, Wednesday, Thursday:
 *   - Tuesday  6 AM → pushes Monday's signals
 *   - Wednesday 6 AM → pushes Wednesday's signals (pipeline ran at 5 AM same day)
 *   - Thursday  6 AM → pushes Thursday's signals (pipeline ran at 5 AM same day)
 *
 * AUTO_PUSH_TO_HUBSPOT env var must be 'true' for live pushes.
 * When not set, runs in dry-run mode — logs intent but makes no API calls.
 *
 * ENV VARS:
 *   HUBSPOT_PRIVATE_APP_TOKEN  — required for live pushes
 *   AIRTABLE_API_KEY           — required
 *   AIRTABLE_BASE_ID           — required
 *   AIRTABLE_TABLE_NAME        — defaults to 'Signals'
 *   AUTO_PUSH_TO_HUBSPOT       — must be 'true' for live mode
 */

import 'dotenv/config';
import Airtable from 'airtable';
import { pushSignalToHubSpot } from './pushSignalToHubSpot.js';

const TABLE = process.env.AIRTABLE_TABLE_NAME || 'Signals';

function getBase() {
  return new Airtable({ apiKey: process.env.AIRTABLE_API_KEY })
    .base(process.env.AIRTABLE_BASE_ID);
}

// Parse the Contact Info text block from Airtable into a contact object.
// Format: "Name: Jane Smith\nTitle: CMO\nEmail: jane@example.com\nLinkedIn: ..."
function parseContactInfo(contactInfo) {
  if (!contactInfo) return {};

  const lines = contactInfo.split('\n').map(l => l.trim()).filter(Boolean);
  let name = null, title = null, email = null, linkedin = null;

  for (const line of lines) {
    if (!email && /[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/.test(line)) {
      const m = line.match(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/);
      if (m) { email = m[0]; continue; }
    }
    if (!linkedin && /linkedin\.com/i.test(line)) {
      const urlMatch = line.match(/(https?:\/\/(?:www\.)?linkedin\.com\/\S+|(?:www\.)?linkedin\.com\/\S+)/i);
      if (urlMatch) {
        linkedin = urlMatch[0].startsWith('http') ? urlMatch[0] : 'https://' + urlMatch[0];
      }
      continue;
    }
    if (!name && !line.startsWith('⚠️') && !line.startsWith('Website:')) {
      name = line; continue;
    }
    if (name && !title && !line.startsWith('Website:') && !line.startsWith('http') && !line.includes('@')) {
      title = line;
    }
  }

  const parts = (name || '').trim().split(/\s+/);
  return {
    name:         name     || '',
    first_name:   parts[0] || '',
    last_name:    parts.length > 1 ? parts.slice(1).join(' ') : '',
    title:        title    || '',
    email:        email    || '',
    linkedin_url: linkedin || '',
  };
}

// Map an Airtable record into the signal shape pushSignalToHubSpot expects.
function mapRecord(record) {
  return {
    id:              record.id,
    signal_type:     record.get('Signal Type')      || '',
    type:            record.get('Signal Type')      || '',
    company_name:    record.get('Company Name')     || '',
    company: {
      name:          record.get('Company Name')     || '',
      industry:      record.get('Industry')         || '',
      revenue:       record.get('Company Revenue')  || null,
      employee_count:record.get('Employee Count')   || null,
      website:       record.get('Company Website')  || null,
    },
    industry:        record.get('Industry')         || '',
    priority:        record.get('Priority')         || 'MEDIUM',
    brief:           record.get('Brief')            || '',
    source:          record.get('Source')           || '',
    source_url:      record.get('Source URL')       || '',
    date_detected:   record.get('Date Detected')    || '',
    bespoke:         record.get('Bespoke') === true,
    bespoke_reason:  record.get('Bespoke Reason')   || '',
    acquired_company:record.get('Acquired Company') || null,
    deal: record.get('Acquired Company')
      ? { type: 'acquires', seller: record.get('Acquired Company'), amount: null }
      : null,
    contact_info:    record.get('Contact Info')     || '',
    send_day:        record.get('Send Day')         || 1,
    ab_test_group:   record.get('AB Test Group')    || 'starfish',
    email_source:    record.get('Email Source')     || 'Apollo',
    // Claude email fields — already generated; pass through for Airtable backfill reference
    email_1_subject: record.get('Email 1 Subject')  || null,
    email_1_body:    record.get('Email 1 Body')     || null,
    email_2_body:    record.get('Email 2 Body')     || null,
    email_3_body:    record.get('Email 3 Body')     || null,
    email_4_body:    record.get('Email 4 Body')     || null,
    email_5_body:    record.get('Email 5 Body')     || null,
    email_6_body:    record.get('Email 6 Body')     || null,
    email_7_body:    record.get('Email 7 Body')     || null,
    claude_generated:record.get('Claude Generated') === true,
  };
}

// Mark a record as pushed in Airtable — non-fatal if it fails.
async function markPushed(recordId) {
  try {
    await getBase()(TABLE).update(recordId, { 'HubSpot Pushed': true });
  } catch (err) {
    console.warn(`  [Push] ⚠️  Could not mark record ${recordId} as pushed: ${err.message}`);
  }
}

/**
 * Fetch all unpushed signals from Airtable and push them to HubSpot.
 *
 * @param {object}  [options]
 * @param {boolean} [options.dryRun=false] — log intent but make no HubSpot API calls
 * @returns {Promise<{ pushed: number, failed: number, skipped: number, dryRun: boolean }>}
 *   Never throws.
 */
export async function pushPendingSignals({ dryRun = false } = {}) {
  console.log('[HubSpot Push] ══════════════════════════════════════════');
  console.log(`[HubSpot Push] Push pending signals — mode: ${dryRun ? 'DRY-RUN' : 'LIVE'}`);

  let pushed  = 0;
  let failed  = 0;
  let skipped = 0;

  // Only push signals from the last 7 days — prevents mass-pushing thousands of old records.
  // Monday pipeline runs → Tuesday 6AM cron pushes Monday's signals (within the 7-day window).
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - 7);
  const cutoffStr = cutoffDate.toISOString().split('T')[0]; // YYYY-MM-DD

  const filterFormula = `AND(
    OR({HubSpot Pushed}=FALSE(), {HubSpot Pushed}=BLANK()),
    IS_AFTER({Date Detected}, '${cutoffStr}')
  )`;

  let records;
  try {
    records = await getBase()(TABLE)
      .select({
        filterByFormula: filterFormula,
        sort: [{ field: 'Date Detected', direction: 'asc' }],
      })
      .all();
  } catch (err) {
    console.error('[HubSpot Push] ✗ Failed to fetch records from Airtable:', err.message);
    console.log('[HubSpot Push] ══════════════════════════════════════════');
    return { pushed: 0, failed: 0, skipped: 0, dryRun };
  }

  console.log(`[HubSpot Push] Found ${records.length} unpushed record(s) from last 7 days (cutoff: ${cutoffStr})`);

  for (const record of records) {
    const signal  = mapRecord(record);
    const parsed  = parseContactInfo(signal.contact_info);

    if (!parsed.email) {
      console.log(`  [Push] Skipping ${signal.company_name} (${record.id}) — no email in Contact Info`);
      skipped++;
      continue;
    }

    if (!signal.company_name) {
      console.log(`  [Push] Skipping ${record.id} — no company name`);
      skipped++;
      continue;
    }

    const industry = signal.industry || signal.company?.industry || '';
    if (!industry.trim() || industry.trim().toLowerCase() === 'unknown') {
      console.log(`  [Push] Skipping ${signal.company_name} (${record.id}) — no industry (needed for proof clients)`);
      skipped++;
      continue;
    }

    if (!signal.claude_generated && signal.ab_test_group === 'claude') {
      console.log(`  [Push] Skipping ${signal.company_name} (${record.id}) — claude group but no emails generated`);
      skipped++;
      continue;
    }
    }

    const contact = {
      name:         parsed.name       || '',
      first_name:   parsed.first_name || '',
      last_name:    parsed.last_name  || '',
      email:        parsed.email,
      title:        parsed.title      || '',
      linkedin_url: parsed.linkedin_url || '',
      send_day:     signal.send_day   || 1,
      email_source: signal.email_source || 'Apollo',
      abGroup:      signal.ab_test_group === 'claude' ? 'claude' : 'starfish',
    };

    if (dryRun) {
      console.log(`  [Push] Would push: ${parsed.email} — ${signal.company_name} [${contact.abGroup}]`);
      pushed++;
      continue;
    }

    try {
      const result = await pushSignalToHubSpot(signal, contact, record.id);

      if (result.success) {
        pushed++;
        await markPushed(record.id);
        console.log(`  [Push] ✓ ${parsed.email} — ${signal.company_name} pushed (${result.contactId})`);
      } else {
        failed++;
        console.log(`  [Push] ✗ ${parsed.email} — ${signal.company_name} failed: ${result.error || result.reason}`);
      }
    } catch (err) {
      failed++;
      console.error(`  [Push] ✗ Unexpected error for ${parsed.email}: ${err.message}`);
    }

    // Brief pause to avoid HubSpot rate limits
    await new Promise(r => setTimeout(r, 400));
  }

  console.log('[HubSpot Push] ══════════════════════════════════════════');
  console.log(`[HubSpot Push] Done — pushed: ${pushed}, failed: ${failed}, skipped: ${skipped}`);
  console.log('[HubSpot Push] ══════════════════════════════════════════');

  return { pushed, failed, skipped, dryRun };
}
