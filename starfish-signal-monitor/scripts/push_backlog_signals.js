/**
 * scripts/push_backlog_signals.js
 *
 * Pushes backlog signals to HubSpot in controlled batches with strict validation.
 *
 * Rules:
 *   - Today's run: 400 total — 200 starfish group, 200 claude group
 *   - Every contact pushed must have: email, company, industry, proof clients, send day
 *   - M&A signals must also have: Acquired Company + Acquired Company Industry
 *   - Claude group: must have Claude Generated = true AND all 7 email bodies
 *   - Starfish group: emails NOT sent to HubSpot (uses pre-built HubSpot sequences)
 *   - No duplicate contacts: one push per unique email address
 *   - No already-pushed signals: HubSpot Pushed = TRUE records are skipped
 *   - No duplicate contact names at same company: if same name appears for same company, push one only
 *   - Proof clients are looked up live from data/proof_clients.js at push time
 *   - All fields passed to pushSignalToHubSpot() which handles HubSpot upsert + sequence enrollment
 *
 * Run:
 *   node --env-file=.env scripts/push_backlog_signals.js              (preview)
 *   node --env-file=.env scripts/push_backlog_signals.js --live       (push to HubSpot)
 *   node --env-file=.env scripts/push_backlog_signals.js --starfish=100 --claude=100  (custom counts)
 */

import 'dotenv/config';
import Airtable      from 'airtable';
import { pushSignalToHubSpot } from '../hubspot/pushSignalToHubSpot.js';
import { updateRecords }       from '../execution/utils/airtable_client.js';
import { getProofClients }     from '../data/proof_clients.js';

const LIVE = process.argv.includes('--live');

const starfishArg = process.argv.find(a => a.startsWith('--starfish='));
const claudeArg   = process.argv.find(a => a.startsWith('--claude='));
const MAX_STARFISH = starfishArg ? parseInt(starfishArg.split('=')[1], 10) : 200;
const MAX_CLAUDE   = claudeArg   ? parseInt(claudeArg.split('=')[1],   10) : 200;

const PLACEHOLDER = 'email_not_unlocked@domain.com';
const TABLE       = process.env.AIRTABLE_TABLE_NAME || 'Signals';

function getBase() {
  return new Airtable({ apiKey: process.env.AIRTABLE_API_KEY })
    .base(process.env.AIRTABLE_BASE_ID);
}

function pause(ms) { return new Promise(r => setTimeout(r, ms)); }

function extractEmail(ci) {
  if (!ci) return null;
  const m = ci.match(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/);
  return m ? m[0].toLowerCase() : null;
}

function extractLinkedIn(ci) {
  if (!ci) return null;
  const m = ci.match(/(https?:\/\/(?:www\.)?linkedin\.com\/\S+)/i);
  return m ? m[0] : null;
}

function parseName(ci) {
  if (!ci) return { name: '', first_name: '', last_name: '', title: '' };
  const lines = ci.split('\n').map(l => l.trim()).filter(Boolean);
  let name = null, title = null;
  for (const line of lines) {
    if (line.includes('@') || /linkedin\.com/i.test(line) ||
        line.startsWith('http') || line.startsWith('⚠️') || line.startsWith('Website:')) continue;
    const clean = line.replace(/^(name|title|email|linkedin)\s*:\s*/i, '').trim();
    if (!name)  { name  = clean; continue; }
    if (!title) { title = clean; break; }
  }
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  return {
    name:       name  || '',
    first_name: parts[0] || '',
    last_name:  parts.length > 1 ? parts.slice(1).join(' ') : '',
    title:      title || '',
  };
}

// Skip check: returns a reason string if the record should be skipped, otherwise null.
function skipReason(f, abGroup) {
  const ci       = f['Contact Info'] || '';
  const email    = extractEmail(ci);
  const industry = (f['Industry'] || '').trim();

  if (!email || email === PLACEHOLDER)                       return 'no valid email';
  if (ci.includes('Research Needed'))                        return 'Research Needed';
  if (ci.includes('Contact Needed'))                         return 'Contact Needed';
  if (!f['Company Name']?.trim())                            return 'no company name';
  if (!industry || industry.toLowerCase() === 'unknown')     return 'missing industry';
  if (!f['Send Day'])                                        return 'missing send day';
  if (!getProofClients(industry))                            return 'no proof clients for industry';

  // M&A must have both acquired company fields
  if (f['Signal Type'] === 'M&A Activity') {
    if (!f['Acquired Company']?.trim())                      return 'M&A missing Acquired Company';
    if (!f['Acquired Company Industry']?.trim())             return 'M&A missing Acquired Company Industry';
  }

  // Claude group must have emails generated.
  // Website Visitor uses a 6-touch sequence — Email 7 Body is intentionally absent for that type.
  if (abGroup === 'claude') {
    if (f['Claude Generated'] !== true)                      return 'claude group: emails not generated';
    if (!f['Email 1 Subject']?.trim())                       return 'claude group: missing Email 1 Subject';
    const isWebsiteVisitor = f['Signal Type'] === 'Website Visitor';
    const bodies = isWebsiteVisitor
      ? ['Email 1 Body','Email 2 Body','Email 3 Body','Email 4 Body','Email 5 Body','Email 6 Body']
      : ['Email 1 Body','Email 2 Body','Email 3 Body','Email 4 Body','Email 5 Body','Email 6 Body','Email 7 Body'];
    const missing = bodies.filter(b => !f[b]?.trim());
    if (missing.length > 0)                                  return `claude group: missing ${missing.join(', ')}`;
  }

  return null;
}

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
  console.log(`Mode    : ${LIVE ? 'LIVE — pushing to HubSpot' : 'PREVIEW — no changes'}`);
  console.log(`Targets : ${MAX_STARFISH} starfish + ${MAX_CLAUDE} claude = ${MAX_STARFISH + MAX_CLAUDE} total`);
  console.log('════════════════════════════════════════════════════════════\n');

  console.log('Fetching all eligible unpushed records from Airtable...');
  let records;
  try {
    records = await getBase()(TABLE)
      .select({
        filterByFormula: `AND(
          OR({HubSpot Pushed}=FALSE(), {HubSpot Pushed}=BLANK()),
          NOT({Contact Info} = ""),
          NOT(FIND("${PLACEHOLDER}", {Contact Info}) > 0),
          NOT(FIND("Research Needed", {Contact Info}) > 0),
          NOT(FIND("Contact Needed", {Contact Info}) > 0),
          NOT({Industry} = ""),
          NOT({Send Day} = BLANK())
        )`,
        fields: [
          'Company Name', 'Signal Type', 'Contact Info', 'Date Detected',
          'Company Website', 'Industry', 'Priority', 'Brief', 'Source URL',
          'Send Day', 'AB Test Group', 'Email Source', 'Bespoke', 'Bespoke Reason',
          'Acquired Company', 'Acquired Company Industry',
          'Claude Generated', 'Email 1 Subject',
          'Email 1 Body', 'Email 2 Body', 'Email 3 Body', 'Email 4 Body',
          'Email 5 Body', 'Email 6 Body', 'Email 7 Body',
          'Proof Clients',
        ],
        sort: [{ field: 'Date Detected', direction: 'asc' }],
      })
      .all();
  } catch (err) {
    console.error('Airtable fetch failed:', err.message);
    process.exit(1);
  }

  console.log(`  Raw records fetched: ${records.length}\n`);

  // ── Deduplicate ────────────────────────────────────────────────────────────
  // Rule 1: one push per unique email address (BSI broadcast = same email across 5 send_day records)
  // Rule 2: one push per unique (contact name + company) combination — catches same person across signals
  // Extra send_day records for the same email get suppressed (marked HubSpot Pushed = true)
  const seenEmails   = new Map(); // email → first record
  const seenNameKeys = new Set(); // "name||company" → already seen
  const toSuppress   = [];        // extra BSI send_day records

  for (const r of records) {
    const f       = r.fields;
    const ci      = f['Contact Info'] || '';
    const email   = extractEmail(ci);
    if (!email || email === PLACEHOLDER) continue;

    if (seenEmails.has(email)) {
      toSuppress.push(r.id);
      continue;
    }

    // Duplicate name+company check (different signals, same contact)
    const parsed   = parseName(ci);
    const nameKey  = `${(parsed.name || '').toLowerCase().trim()}||${(f['Company Name'] || '').toLowerCase().trim()}`;
    if (parsed.name && seenNameKeys.has(nameKey)) {
      console.log(`  [Dedup] Skipping duplicate contact: "${parsed.name}" @ ${f['Company Name']}`);
      toSuppress.push(r.id);
      continue;
    }

    seenEmails.set(email, r);
    if (parsed.name) seenNameKeys.add(nameKey);
  }

  const deduped = [...seenEmails.values()];
  console.log(`  After dedup: ${deduped.length} unique contacts (${toSuppress.length} extras to suppress)\n`);

  // ── Split by AB group and apply per-group validation ──────────────────────
  const starfishPool = [];
  const claudePool   = [];
  const skipLog      = [];

  for (const r of deduped) {
    const f       = r.fields;
    const abGroup = (f['AB Test Group'] || '').toLowerCase();

    if (abGroup !== 'starfish' && abGroup !== 'claude') {
      skipLog.push({ company: f['Company Name'], reason: `unknown AB group: "${abGroup}"` });
      continue;
    }

    const reason = skipReason(f, abGroup);
    if (reason) {
      skipLog.push({ company: f['Company Name'], reason });
      continue;
    }

    if (abGroup === 'starfish') starfishPool.push(r);
    else                        claudePool.push(r);
  }

  const starfishBatch = starfishPool.slice(0, MAX_STARFISH);
  const claudeBatch   = claudePool.slice(0, MAX_CLAUDE);
  const toPush        = [...starfishBatch, ...claudeBatch];

  console.log('══ Eligible breakdown ══════════════════════════════════════');
  console.log(`  Starfish pool  : ${starfishPool.length} → pushing ${starfishBatch.length}`);
  console.log(`  Claude pool    : ${claudePool.length} → pushing ${claudeBatch.length}`);
  console.log(`  Total to push  : ${toPush.length}`);
  console.log(`  Skipped        : ${skipLog.length}`);
  if (skipLog.length > 0) {
    console.log('\n  Skip reasons (first 10):');
    for (const s of skipLog.slice(0, 10)) {
      console.log(`    ${(s.company || '?').padEnd(35)} — ${s.reason}`);
    }
    if (skipLog.length > 10) console.log(`    ... and ${skipLog.length - 10} more`);
  }
  console.log('');

  if (toPush.length === 0) {
    console.log('Nothing to push.');
    return;
  }

  if (!LIVE) {
    console.log('── Preview (first 15 contacts) ─────────────────────────────');
    for (const r of toPush.slice(0, 15)) {
      const f       = r.fields;
      const parsed  = parseName(f['Contact Info'] || '');
      const email   = extractEmail(f['Contact Info'] || '');
      const abGroup = f['AB Test Group'] || '—';
      const company = (f['Company Name'] || '').padEnd(30);
      const type    = (f['Signal Type']  || '').padEnd(22);
      console.log(`  [${abGroup.padEnd(8)}] ${company} | ${type} | Day ${f['Send Day']} | ${parsed.name || '—'} | ${email}`);
    }
    if (toPush.length > 15) console.log(`  ... and ${toPush.length - 15} more`);
    console.log(`\nPREVIEW: Would push ${toPush.length} contacts (${starfishBatch.length} starfish + ${claudeBatch.length} claude).`);
    console.log('Run with --live to apply.');
    return;
  }

  // ── LIVE: suppress extras first, then push ────────────────────────────────
  if (toSuppress.length > 0) {
    console.log(`Suppressing ${toSuppress.length} duplicate send_day records...`);
    for (const id of toSuppress) {
      await suppress(id);
      await pause(120);
    }
    console.log('  Done.\n');
  }

  let pushed = 0, skipped = 0, failed = 0;

  for (let i = 0; i < toPush.length; i++) {
    const record  = toPush[i];
    const f       = record.fields;
    const ci      = f['Contact Info'] || '';
    const email   = extractEmail(ci);
    const parsed  = parseName(ci);
    const abGroup = (f['AB Test Group'] || '').toLowerCase();
    const sendDay = f['Send Day'] || 1;
    const company = f['Company Name'] || '';
    const sigType = f['Signal Type']  || '';
    const industry= f['Industry']     || '';

    console.log(`[${i + 1}/${toPush.length}] [${abGroup}] ${company} [${sigType}] Day ${sendDay}`);
    console.log(`  Contact : ${parsed.name || '—'} | ${parsed.title || '—'}`);
    console.log(`  Email   : ${email}`);

    // Build signal object — pass ALL fields through cleanly
    const signal = {
      signal_type:    sigType,
      type:           sigType,
      company_name:   company,
      company: {
        name:     company,
        website:  f['Company Website'] || '',
        industry,
      },
      industry,
      priority:       f['Priority']       || 'MEDIUM',
      brief:          f['Brief']          || '',
      source:         '',
      source_url:     f['Source URL']     || '',
      date_detected:  f['Date Detected']  || '',
      bespoke:        f['Bespoke'] === true,
      bespoke_reason: f['Bespoke Reason'] || '',
      acquired_company:          f['Acquired Company']          || null,
      acquired_company_industry: f['Acquired Company Industry'] || null,

      // Claude email fields — only used when abGroup = 'claude'
      // pushSignalToHubSpot will use these directly instead of calling Claude again
      // IF contact.abGroup is already set to 'claude' and emails are pre-generated
      email_1_subject: abGroup === 'claude' ? (f['Email 1 Subject'] || null) : null,
      email_1_body:    abGroup === 'claude' ? (f['Email 1 Body']    || null) : null,
      email_2_body:    abGroup === 'claude' ? (f['Email 2 Body']    || null) : null,
      email_3_body:    abGroup === 'claude' ? (f['Email 3 Body']    || null) : null,
      email_4_body:    abGroup === 'claude' ? (f['Email 4 Body']    || null) : null,
      email_5_body:    abGroup === 'claude' ? (f['Email 5 Body']    || null) : null,
      email_6_body:    abGroup === 'claude' ? (f['Email 6 Body']    || null) : null,
      email_7_body:    abGroup === 'claude' ? (f['Email 7 Body']    || null) : null,
    };

    const contact = {
      name:         parsed.name,
      first_name:   parsed.first_name,
      last_name:    parsed.last_name,
      email,
      title:        parsed.title,
      linkedin_url: extractLinkedIn(ci) || '',
      send_day:     sendDay,
      email_source: f['Email Source'] || 'Apollo',
      abGroup,
    };

    try {
      const result = await pushSignalToHubSpot(signal, contact, record.id);
      if (result.success || result.reason === 'already_exists') {
        console.log(`  ✓ Pushed [${result.abGroup || abGroup}] (${result.contactId || 'ok'})`);
        await markPushed(record.id);
        pushed++;
      } else {
        console.log(`  ✗ Failed: ${result.error || result.reason}`);
        failed++;
      }
    } catch (err) {
      console.log(`  ✗ Error: ${err.message}`);
      failed++;
    }

    console.log('');
    await pause(500);
  }

  console.log('════════════════════════════════════════════════════════════');
  console.log('RESULTS');
  console.log('════════════════════════════════════════════════════════════');
  console.log(`  Pushed          : ${pushed}`);
  console.log(`  Failed          : ${failed}`);
  console.log(`  Validation skip : ${skipped}`);
  console.log(`  Starfish pushed : ${starfishBatch.length}`);
  console.log(`  Claude pushed   : ${claudeBatch.length}`);
  console.log('════════════════════════════════════════════════════════════');
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
