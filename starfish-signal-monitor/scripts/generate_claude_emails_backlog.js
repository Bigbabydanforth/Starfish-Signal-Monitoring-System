/**
 * scripts/generate_claude_emails_backlog.js
 *
 * Generates Claude outreach emails for all unpushed Airtable records that are
 * assigned to the "claude" AB test group but haven't had emails generated yet.
 *
 * Uses generateClaudeEmails() — the exact same function the live pipeline uses.
 * Model: claude-sonnet-4-6 (never Haiku).
 *
 * Per-signal logic:
 *   - Fetches all unpushed records where AB Test Group = "claude" AND Claude Generated ≠ TRUE
 *   - Deduplicates by email — one generation per unique contact
 *   - For BSI signals with the same email across multiple send_day records,
 *     the same generated emails are written to ALL matching records
 *   - On success: writes Email 1 Subject, Email 1-7 Body, Claude Generated = true,
 *     Claude Generated At to Airtable
 *   - On failure (Claude API error or bad JSON): skips and logs — does NOT write partial data
 *
 * Run:
 *   node --env-file=.env scripts/generate_claude_emails_backlog.js              (preview — no Claude calls)
 *   node --env-file=.env scripts/generate_claude_emails_backlog.js --live       (generate + write)
 *   node --env-file=.env scripts/generate_claude_emails_backlog.js --live --batch=50  (limit to 50 contacts)
 */

import 'dotenv/config';
import { query, updateRecords } from '../execution/utils/airtable_client.js';
import { generateClaudeEmails } from '../hubspot/generateClaudeEmails.js';
import { SENDER_CONFIGS } from '../hubspot/sequenceRouting.js';

// Returns sender email for a signal type WITHOUT calling getSequenceRoute().
// getSequenceRoute() increments the Cole/Andrew module-level counter as a side
// effect — calling it from a backfill script shifts the counter for subsequent
// pipeline runs that import the same module in a long-lived process.
function getSenderEmailForType(signalType) {
  const DAVID = process.env.DAVID_SENDER_EMAIL || 'david@starfishco.com';
  const ZACK  = process.env.ZACK_SENDER_EMAIL  || 'zack@starfishco.com';
  const COLE  = process.env.COLE_SENDER_EMAIL  || 'cole@starfishco.com';
  if (['Job Change', 'M&A Activity', 'Funding'].includes(signalType)) return DAVID;
  if (signalType === 'Website Visitor') return ZACK;
  return COLE; // News/Press, Rebrand, Brand Strategy Intent
}

function getSenderConfig(ownerEmail) {
  return SENDER_CONFIGS[ownerEmail] || { firstName: '', meetingLink: '' };
}

// Replaces all tokens with real values before writing to Airtable.
// Mirrors pushSignalToHubSpot.js substituteTokens — must stay in sync.
function substituteTokens(text, { contactFirstName, contactCompany, senderFirstName, meetingLink }) {
  if (!text) return text;
  return text
    .replace(/\{\{\s*contact\.firstname\s*\}\}/gi,    contactFirstName || 'there')
    .replace(/\{\{\s*contact\.first_name\s*\}\}/gi,   contactFirstName || 'there')
    .replace(/\{\{\s*contact\.company\s*\}\}/gi,      contactCompany   || 'your company')
    .replace(/\{\{\s*sender\.firstname\s*\}\}/gi,     senderFirstName  || '')
    .replace(/\{\{\s*owner\.meetings_link\s*\}\}/gi,  meetingLink      || '');
}

const LIVE      = process.argv.includes('--live');
const batchArg  = process.argv.find(a => a.startsWith('--batch='));
const BATCH     = batchArg ? parseInt(batchArg.split('=')[1], 10) : Infinity;

const PLACEHOLDER = 'email_not_unlocked@domain.com';

function pause(ms) { return new Promise(r => setTimeout(r, ms)); }

function extractEmail(ci) {
  if (!ci) return null;
  const m = ci.match(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/);
  return m ? m[0].toLowerCase() : null;
}

// Parse Name, Title from Contact Info
// Handles both plain format (Name\nTitle\nEmail) and labelled format (Name: John\nTitle: CMO\nEmail: ...)
function parseContact(ci) {
  if (!ci) return { name: '', firstName: '', lastName: '', title: '' };

  // Strip label prefixes like "Name: ", "Title: ", "Email: ", "LinkedIn: "
  function stripLabel(line) {
    return line.replace(/^(name|title|email|linkedin)\s*:\s*/i, '').trim();
  }

  const lines = ci.split('\n').map(l => l.trim()).filter(l =>
    l &&
    !l.startsWith('⚠️') &&
    !l.startsWith('http') &&
    !l.startsWith('Website:') &&
    !l.startsWith('LinkedIn:')
  );

  let name = '', title = '';
  for (const line of lines) {
    const clean = stripLabel(line);
    if (clean.includes('@')) continue; // skip email lines
    if (!name) { name = clean; continue; }
    if (!title) { title = clean; break; }
  }

  const parts = name.split(/\s+/).filter(Boolean);
  return {
    name,
    firstName: parts[0] || '',
    lastName:  parts.length > 1 ? parts.slice(1).join(' ') : '',
    title,
  };
}

async function run() {
  console.log('════════════════════════════════════════════════════════════');
  console.log('GENERATE CLAUDE EMAILS — Backlog (claude AB group, not yet generated)');
  console.log(`Mode  : ${LIVE ? 'LIVE — calling Claude + writing to Airtable' : 'PREVIEW — no Claude calls, no writes'}`);
  if (BATCH < Infinity) console.log(`Batch : ${BATCH} unique contacts max`);
  console.log('════════════════════════════════════════════════════════════\n');

  console.log('Fetching records...');
  let records;
  try {
    records = await query({
      filterByFormula: `AND(
        OR({HubSpot Pushed}=FALSE(), {HubSpot Pushed}=BLANK()),
        {AB Test Group} = "claude",
        OR({Claude Generated}=FALSE(), {Claude Generated}=BLANK()),
        NOT({Contact Info} = ""),
        NOT(FIND("${PLACEHOLDER}", {Contact Info}) > 0),
        NOT(FIND("Research Needed", {Contact Info}) > 0),
        NOT(FIND("Contact Needed", {Contact Info}) > 0)
      )`,
      fields: [
        'Company Name', 'Signal Type', 'Contact Info', 'Industry',
        'Brief', 'Signal Details', 'Acquired Company', 'Company Website',
        'Bespoke', 'Send Day', 'AB Test Group',
      ],
    }, 120000);
  } catch (err) {
    console.error('Airtable fetch failed:', err.message);
    process.exit(1);
  }

  // Filter to records with a real email
  const withEmail = records.filter(r => {
    const email = extractEmail(r.fields['Contact Info'] || '');
    return email && !email.includes(PLACEHOLDER);
  });

  console.log(`  Records fetched (claude group, no emails) : ${records.length}`);
  console.log(`  With valid email                          : ${withEmail.length}\n`);

  if (withEmail.length === 0) {
    console.log('Nothing to generate — all claude-group contacts already have emails.');
    return;
  }

  // Group by email — collect ALL record IDs sharing the same email
  // (BSI sends the same contact across multiple send_day records)
  const emailToRecords = new Map(); // email → [record, ...]
  for (const r of withEmail) {
    const email = extractEmail(r.fields['Contact Info'] || '');
    if (!emailToRecords.has(email)) emailToRecords.set(email, []);
    emailToRecords.get(email).push(r);
  }

  // One generation per unique email, up to BATCH
  const uniqueEmails = [...emailToRecords.keys()].slice(0, BATCH);

  console.log(`Unique contacts to generate for : ${uniqueEmails.length}`);
  console.log(`Total Airtable records to update: ${uniqueEmails.reduce((s, e) => s + emailToRecords.get(e).length, 0)}\n`);

  if (!LIVE) {
    console.log('Sample (first 10 contacts):');
    for (const email of uniqueEmails.slice(0, 10)) {
      const r       = emailToRecords.get(email)[0];
      const company = (r.fields['Company Name'] || '(unknown)').padEnd(30);
      const type    = r.fields['Signal Type'] || '—';
      const parsed  = parseContact(r.fields['Contact Info'] || '');
      console.log(`  ${company} | ${type} | ${parsed.name || '—'} | ${email}`);
    }
    if (uniqueEmails.length > 10) console.log(`  ... and ${uniqueEmails.length - 10} more`);
    console.log(`\nPREVIEW: Would generate emails for ${uniqueEmails.length} contacts (${uniqueEmails.reduce((s,e)=>s+emailToRecords.get(e).length,0)} Airtable records).`);
    console.log('Run with --live to apply.');
    return;
  }

  // ── LIVE: generate and write ────────────────────────────────────────────────
  let generated = 0, failed = 0;
  const generatedAt = new Date().toISOString();

  for (let i = 0; i < uniqueEmails.length; i++) {
    const email   = uniqueEmails[i];
    const rList   = emailToRecords.get(email);
    const r       = rList[0]; // use first record for signal data
    const f       = r.fields;

    const company    = f['Company Name'] || '';
    const signalType = f['Signal Type']  || '';
    const industry   = f['Industry']     || '';
    const parsed     = parseContact(f['Contact Info'] || '');

    console.log(`[${i + 1}/${uniqueEmails.length}] ${company} [${signalType}] — ${parsed.name || email}`);

    if (!parsed.firstName) {
      console.log(`  ✗ SKIP: no contact first name in Contact Info\n`);
      failed++;
      continue;
    }

    // Build signal object matching the shape generateClaudeEmails() expects
    const signal = {
      type:           signalType,
      signal_type:    signalType,
      company_name:   company,
      company: {
        name:     company,
        industry: industry,
        website:  f['Company Website'] || null,
      },
      industry:         industry,
      brief:            f['Brief']            || '',
      signal_details:   f['Signal Details']   || '',
      acquired_company: f['Acquired Company'] || null,
      bespoke:          f['Bespoke'] === true,
    };

    // Build contact object
    const contact = {
      name:      parsed.name,
      firstName: parsed.firstName,
      first_name:parsed.firstName,
      lastName:  parsed.lastName,
      last_name: parsed.lastName,
      title:     parsed.title,
      email,
    };

    let result;
    try {
      result = await generateClaudeEmails(signal, contact);
    } catch (err) {
      console.log(`  ✗ Unexpected error: ${err.message}\n`);
      failed++;
      await pause(1000);
      continue;
    }

    if (!result.success) {
      console.log(`  ✗ Generation failed: ${result.error}\n`);
      failed++;
      await pause(500);
      continue;
    }

    // Get sender for this signal type so we can substitute all tokens
    const senderEmail = getSenderEmailForType(signalType);
    const sender      = getSenderConfig(senderEmail);
    const tokenVars  = {
      contactFirstName: parsed.firstName,
      contactCompany:   company,
      senderFirstName:  sender.firstName,
      meetingLink:      sender.meetingLink,
    };

    // Substitute all tokens before writing — no {{ }} left in Airtable
    const emails = result.emails;
    const subst  = (t) => substituteTokens(t, tokenVars);

    // Build Airtable fields from result
    const emailFields = {
      'Claude Generated':    true,
      'Claude Generated At': generatedAt,
      'Email 1 Subject':     subst(emails.email_1_subject) || null,
      'Email 1 Body':        subst(emails.email_1_body)    || null,
      'Email 2 Body':        subst(emails.email_2_body)    || null,
      'Email 3 Body':        subst(emails.email_3_body)    || null,
      'Email 4 Body':        subst(emails.email_4_body)    || null,
      'Email 5 Body':        subst(emails.email_5_body)    || null,
      'Email 6 Body':        subst(emails.email_6_body)    || null,
      'Email 7 Body':        subst(emails.email_7_body)    || null,
    };

    // Write to ALL Airtable records sharing this email (BSI send_day tiers)
    const updates = rList.map(rec => ({ id: rec.id, fields: emailFields }));

    try {
      await updateRecords(updates);
      console.log(`  ✓ Written to ${updates.length} record(s)\n`);
      generated++;
    } catch (writeErr) {
      console.log(`  ✗ Airtable write failed: ${writeErr.message}\n`);
      failed++;
    }

    // Pause between contacts to avoid Claude rate limits
    await pause(1500);
  }

  console.log('════════════════════════════════════════════════════════════');
  console.log('RESULTS');
  console.log('════════════════════════════════════════════════════════════');
  console.log(`  Contacts generated : ${generated}`);
  console.log(`  Failed / skipped   : ${failed}`);
  console.log(`  Total attempted    : ${uniqueEmails.length}`);
  console.log('════════════════════════════════════════════════════════════');
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
