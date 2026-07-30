/**
 * push_backlog_signals.js
 *
 * Pushes old un-pushed Airtable records that now have real emails
 * (after re_enrich_contacts.js updated them).
 *
 * Designed for the June 13 BSI backlog and other old signals outside
 * the 7-day window of the live push cron.
 *
 * BSI dedup logic:
 *   BSI signals create 5 records per company (send_day 1–5 with the same email).
 *   For old backlog signals, staggered timing is irrelevant — we push ONCE per
 *   unique email and suppress all other send_day variants for that email.
 *   This prevents 5 sequence enrollments for the same person.
 *
 * Hard skips (same as pushPendingSignals.js):
 *   - No valid email (placeholder or empty)
 *   - No company name
 *   - No industry (needed for proof clients)
 *   - Claude group but no emails generated
 *
 * Run with:
 *   node --env-file=.env scripts/push_backlog_signals.js              (preview)
 *   node --env-file=.env scripts/push_backlog_signals.js --live       (push to HubSpot)
 *   node --env-file=.env scripts/push_backlog_signals.js --batch=50   (limit per run)
 *   node --env-file=.env scripts/push_backlog_signals.js --date=2026-06-13  (specific date only)
 */

import 'dotenv/config';
import Airtable from 'airtable';
import { pushSignalToHubSpot } from '../hubspot/pushSignalToHubSpot.js';
import { updateRecords } from '../execution/utils/airtable_client.js';

const LIVE      = process.argv.includes('--live');
const batchArg  = process.argv.find(a => a.startsWith('--batch='));
const BATCH     = batchArg ? parseInt(batchArg.split('=')[1], 10) : Infinity;
const dateArg   = process.argv.find(a => a.startsWith('--date='));
const DATE_ONLY = dateArg ? dateArg.split('=')[1] : null;

const PLACEHOLDER = 'email_not_unlocked@domain.com';
const TABLE       = process.env.AIRTABLE_TABLE_NAME || 'Signals';

function getBase() {
  return new Airtable({ apiKey: process.env.AIRTABLE_API_KEY })
    .base(process.env.AIRTABLE_BASE_ID);
}

function extractWebsiteFromContactInfo(contactInfo) {
  if (!contactInfo) return null;
  for (const line of contactInfo.split('\n')) {
    const t = line.trim();
    if (t.startsWith('Website: ')) return t.slice('Website: '.length).trim();
    if (t.startsWith('Company Website: ')) return t.slice('Company Website: '.length).trim();
  }
  return null;
}

function extractEmail(contactInfo) {
  if (!contactInfo) return null;
  const m = contactInfo.match(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/);
  return m ? m[0].toLowerCase() : null;
}

function extractLinkedIn(contactInfo) {
  if (!contactInfo) return null;
  const m = contactInfo.match(/(https?:\/\/(?:www\.)?linkedin\.com\/\S+)/i);
  return m ? m[0] : null;
}

function parseName(contactInfo) {
  if (!contactInfo) return { first_name: '', last_name: '', title: '', name: '' };
  const lines = contactInfo.split('\n').map(l => l.trim()).filter(Boolean);
  let name = null, title = null;
  for (const line of lines) {
    if (line.includes('@') || /linkedin\.com/i.test(line) || line.startsWith('http') || line.startsWith('⚠️') || line.startsWith('Website:')) continue;
    if (!name) { name = line.replace(/^(name|title|email|linkedin)\s*:\s*/i, '').trim(); continue; }
    if (!title) { title = line.replace(/^(name|title|email|linkedin)\s*:\s*/i, '').trim(); }
  }
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  return {
    name:       name  || '',
    first_name: parts[0] || '',
    last_name:  parts.length > 1 ? parts.slice(1).join(' ') : '',
    title:      title || '',
  };
}

function pause(ms) { return new Promise(r => setTimeout(r, ms)); }

async function markPushed(recordId) {
  try {
    await updateRecords([{ id: recordId, fields: { 'HubSpot Pushed': true } }]);
  } catch (err) {
    console.warn(`  ⚠️  Could not mark ${recordId} as pushed: ${err.message}`);
  }
}

async function suppress(recordId) {
  try {
    await updateRecords([{ id: recordId, fields: { 'HubSpot Pushed': true } }]);
  } catch (err) {
    console.warn(`  ⚠️  Could not suppress ${recordId}: ${err.message}`);
  }
}

async function run() {
  console.log('════════════════════════════════════════════════════════════');
  console.log('PUSH BACKLOG SIGNALS TO HUBSPOT');
  console.log('Scope: Un-pushed records with valid emails (outside 7-day cron window)');
  console.log('BSI dedup: one push per unique email (suppress extra send_day records)');
  if (DATE_ONLY) console.log(`Date filter: ${DATE_ONLY} only`);
  if (BATCH < Infinity) console.log(`Batch: ${BATCH} records max`);
  console.log(`Mode: ${LIVE ? 'LIVE (will push to HubSpot)' : 'PREVIEW (no changes)'}`);
  console.log('════════════════════════════════════════════════════════════\n');

  // Build filter
  let filterFormula = `AND(
    OR({HubSpot Pushed}=FALSE(), {HubSpot Pushed}=BLANK()),
    NOT({Contact Info} = ""),
    NOT(FIND("${PLACEHOLDER}", {Contact Info}) > 0)
  )`;

  if (DATE_ONLY) {
    filterFormula = `AND(
      OR({HubSpot Pushed}=FALSE(), {HubSpot Pushed}=BLANK()),
      NOT({Contact Info} = ""),
      NOT(FIND("${PLACEHOLDER}", {Contact Info}) > 0),
      {Date Detected} = '${DATE_ONLY}'
    )`;
  }

  console.log('Fetching un-pushed records from Airtable...');
  let records;
  try {
    records = await getBase()(TABLE)
      .select({
        filterByFormula: filterFormula,
        fields: [
          'Company Name', 'Signal Type', 'Contact Info', 'Date Detected',
          'Company Website', 'Industry', 'Priority', 'Brief', 'Source URL',
          'Send Day', 'AB Test Group', 'Email Source', 'Bespoke', 'Bespoke Reason',
          'Acquired Company', 'Claude Generated', 'Email 1 Subject', 'Email 1 Body',
          'Email 2 Body', 'Email 3 Body', 'Email 4 Body',
          'Email 5 Body', 'Email 6 Body', 'Email 7 Body',
        ],
        sort: [{ field: 'Send Day', direction: 'asc' }], // send_day 1 first
      })
      .all();
  } catch (err) {
    console.error('Airtable fetch failed:', err.message);
    process.exit(1);
  }

  console.log(`Found ${records.length} eligible record(s)\n`);

  if (records.length === 0) {
    console.log('Nothing to push. Run re_enrich_contacts.js --live first to find real emails.');
    return;
  }

  // Group by email — keep only the FIRST (send_day 1) record per email.
  // All other send_day records for the same email will be suppressed.
  const seenEmails  = new Map(); // email → first record (to push)
  const toSuppress  = [];        // record IDs to suppress (extra send_days)

  for (const r of records) {
    const email = extractEmail(r.fields['Contact Info']);
    if (!email || email === PLACEHOLDER) continue;

    if (!seenEmails.has(email)) {
      seenEmails.set(email, r);
    } else {
      toSuppress.push(r.id);
    }
  }

  const toPush = [...seenEmails.values()].slice(0, BATCH);

  console.log(`Unique emails to push : ${toPush.length}`);
  console.log(`BSI extras to suppress: ${toSuppress.length}\n`);

  let pushed  = 0;
  let skipped = 0;
  let failed  = 0;

  // Suppress BSI duplicates first
  if (LIVE && toSuppress.length > 0) {
    console.log(`Suppressing ${toSuppress.length} extra BSI send_day records...`);
    for (const id of toSuppress) {
      await suppress(id);
      await pause(150);
    }
    console.log('  Done.\n');
  } else if (toSuppress.length > 0) {
    console.log(`Would suppress ${toSuppress.length} extra BSI send_day records.\n`);
  }

  // Push unique contacts
  for (const record of toPush) {
    const f           = record.fields;
    const companyName = f['Company Name'] || '';
    const signalType  = f['Signal Type']  || '';
    const contactInfo = f['Contact Info'] || '';
    const website     = f['Company Website'] || extractWebsiteFromContactInfo(contactInfo) || '';
    const industry    = f['Industry'] || '';
    const sendDay     = f['Send Day'] || 1;
    const abGroup     = f['AB Test Group'] || undefined;
    const emailSource = f['Email Source'] || 'Apollo';
    const claudeGen   = f['Claude Generated'] === true;

    const email   = extractEmail(contactInfo);
    const linkedin= extractLinkedIn(contactInfo);
    const parsed  = parseName(contactInfo);

    console.log(`── ${companyName} [${signalType}] send_day:${sendDay}`);
    console.log(`   Email   : ${email}`);
    console.log(`   Contact : ${parsed.name || '—'} | ${parsed.title || '—'}`);

    // Hard skips
    if (!email || email === PLACEHOLDER) {
      console.log(`   SKIP: no valid email\n`); skipped++; continue;
    }
    if (!companyName) {
      console.log(`   SKIP: no company name\n`); skipped++; continue;
    }
    if (!industry || industry.trim().toLowerCase() === 'unknown') {
      console.log(`   SKIP: no industry\n`); skipped++; continue;
    }
    if (abGroup === 'claude' && !claudeGen) {
      console.log(`   SKIP: claude group but no emails generated\n`); skipped++; continue;
    }

    if (!LIVE) {
      console.log(`   → WOULD PUSH to HubSpot\n`);
      pushed++;
      continue;
    }

    const signal = {
      signal_type:    signalType,
      type:           signalType,
      company_name:   companyName,
      company: { name: companyName, website, industry },
      industry,
      priority:       f['Priority']       || 'MEDIUM',
      brief:          f['Brief']          || '',
      source:         '',
      source_url:     f['Source URL']     || '',
      date_detected:  f['Date Detected']  || '',
      bespoke:        f['Bespoke'] === true,
      bespoke_reason: f['Bespoke Reason'] || '',
      acquired_company: f['Acquired Company'] || null,
      claude_generated: claudeGen,
      // Pass through pre-generated Claude emails if present
      email_1_subject: f['Email 1 Subject'] || null,
      email_1_body:    f['Email 1 Body']    || null,
      email_2_body:    f['Email 2 Body']    || null,
      email_3_body:    f['Email 3 Body']    || null,
      email_4_body:    f['Email 4 Body']    || null,
      email_5_body:    f['Email 5 Body']    || null,
      email_6_body:    f['Email 6 Body']    || null,
      email_7_body:    f['Email 7 Body']    || null,
    };

    const contact = {
      name:         parsed.name,
      first_name:   parsed.first_name,
      last_name:    parsed.last_name,
      email,
      title:        parsed.title,
      linkedin_url: linkedin || '',
      send_day:     sendDay,
      email_source: emailSource,
      abGroup,
    };

    try {
      const result = await pushSignalToHubSpot(signal, contact, record.id);
      if (result.success) {
        console.log(`   ✓ Pushed (${result.contactId || 'ok'}) [${result.abGroup || '—'}]`);
        await markPushed(record.id);
        pushed++;
      } else {
        console.log(`   ✗ Failed: ${result.error || result.reason}`);
        failed++;
      }
    } catch (err) {
      console.log(`   ✗ Error: ${err.message}`);
      failed++;
    }

    console.log();
    await pause(400);
  }

  console.log('════════════════════════════════════════════════════════════');
  if (LIVE) {
    console.log(`Pushed   : ${pushed}`);
    console.log(`Skipped  : ${skipped}`);
    console.log(`Failed   : ${failed}`);
    if (pushed > 0) console.log('\nContacts pushed — HubSpot workflow will enroll them in sequences.');
  } else {
    console.log(`Would push   : ${pushed}`);
    console.log(`Would skip   : ${skipped}`);
    console.log('\nPreview only. Run with --live to apply.');
  }
  console.log('════════════════════════════════════════════════════════════');
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
