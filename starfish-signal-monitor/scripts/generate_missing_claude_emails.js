/**
 * scripts/generate_missing_claude_emails.js
 *
 * For all claude-group contacts generated under the OLD email system
 * (7 emails for most types, 6 for Website Visitor), generates the missing touches:
 *   - Non-Website Visitor : Emails 8, 9, 10
 *   - Website Visitor     : Emails 7, 8, 9
 *
 * For each contact:
 *   1. Calls generateClaudeEmails() — generates the full set (9 or 10 emails)
 *   2. Writes ONLY the new email fields to Airtable (leaves existing emails 1–7 untouched)
 *   3. If already pushed to HubSpot: PATCHes just the new email properties on the contact
 *
 * Run:
 *   node --env-file=.env scripts/generate_missing_claude_emails.js              (preview — no Claude calls)
 *   node --env-file=.env scripts/generate_missing_claude_emails.js --live       (generate + write)
 *   node --env-file=.env scripts/generate_missing_claude_emails.js --live --batch=50
 */

import 'dotenv/config';
import axios from 'axios';
import { query, updateRecords } from '../execution/utils/airtable_client.js';
import { generateClaudeEmails } from '../hubspot/generateClaudeEmails.js';
import { SENDER_CONFIGS }       from '../hubspot/sequenceRouting.js';

const LIVE     = process.argv.includes('--live');
const batchArg = process.argv.find(a => a.startsWith('--batch='));
const BATCH    = batchArg ? parseInt(batchArg.split('=')[1], 10) : Infinity;

const HS_TOKEN     = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
const HS_BASE      = 'https://api.hubapi.com';
const PLACEHOLDER  = 'email_not_unlocked@domain.com';

function pause(ms) { return new Promise(r => setTimeout(r, ms)); }

function extractEmail(ci) {
  if (!ci) return null;
  const m = ci.match(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/);
  return m ? m[0].toLowerCase() : null;
}

// Same logic as generate_claude_emails_backlog.js — avoids side-effecting the
// Cole/Andrew round-robin counter in sequenceRouting.js.
function getSenderEmailForType(signalType) {
  const DAVID   = process.env.DAVID_SENDER_EMAIL   || 'david@starfishco.com';
  const ZACK    = process.env.ZACK_SENDER_EMAIL    || 'zack@starfishco.com';
  const COLE    = process.env.COLE_SENDER_EMAIL    || 'cole@starfishco.com';
  const ANDREW  = process.env.ANDREW_SENDER_EMAIL  || 'andrew@starfishco.com';
  if (['Job Change', 'M&A Activity', 'Funding'].includes(signalType)) return DAVID;
  if (['Website Visitor', 'Rebrand'].includes(signalType)) return ZACK;
  if (signalType === 'Brand Strategy Intent') return COLE;   // BSI → Cole (permanent)
  return ANDREW; // News/Press → Andrew (permanent)
}

function getSenderConfig(ownerEmail) {
  return SENDER_CONFIGS[ownerEmail] || { firstName: '', meetingLink: '' };
}

function substituteTokens(text, { contactFirstName, contactCompany, senderFirstName, meetingLink, targetCo, sector }) {
  if (!text) return text;
  return text
    .replace(/\{\{\s*contact\.firstname\s*\}\}/gi,    contactFirstName || 'there')
    .replace(/\{\{\s*contact\.first_name\s*\}\}/gi,   contactFirstName || 'there')
    .replace(/\{\{\s*contact\.company\s*\}\}/gi,      contactCompany   || 'your company')
    .replace(/\{\{\s*sender\.firstname\s*\}\}/gi,     senderFirstName  || '')
    .replace(/\{\{\s*owner\.meetings_link\s*\}\}/gi,  meetingLink      || '')
    .replace(/\{\{\s*TargetCo\s*\}\}/gi,              targetCo         || 'the acquired company')
    .replace(/\{\{\s*Sector\s*\}\}/gi,                sector           || 'your category');
}

function parseContact(ci) {
  if (!ci) return { name: '', firstName: '', lastName: '', title: '' };
  function stripLabel(line) {
    return line.replace(/^(name|title|email|linkedin)\s*:\s*/i, '').trim();
  }
  const lines = ci.split('\n').map(l => l.trim()).filter(l =>
    l && !l.startsWith('⚠️') && !l.startsWith('http') &&
    !l.startsWith('Website:') && !l.startsWith('LinkedIn:')
  );
  let name = '', title = '';
  for (const line of lines) {
    const clean = stripLabel(line);
    if (clean.includes('@')) continue;
    if (!name) { name = clean; continue; }
    if (!title) { title = clean; break; }
  }
  const parts = name.split(/\s+/).filter(Boolean);
  return { name, firstName: parts[0] || '', lastName: parts.length > 1 ? parts.slice(1).join(' ') : '', title };
}

// ── HubSpot helpers ───────────────────────────────────────────────────────────
async function hsRequest(method, endpoint, data = null) {
  const cfg = {
    method, url: `${HS_BASE}${endpoint}`,
    headers: { Authorization: `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' },
    timeout: 15000,
  };
  if (data) cfg.data = data;
  return axios(cfg);
}

async function findHubSpotId(email) {
  try {
    const res = await hsRequest('POST', '/crm/v3/objects/contacts/search', {
      filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
      properties: ['email'],
      limit: 1,
    });
    return res.data.results?.[0]?.id || null;
  } catch {
    return null;
  }
}

async function patchHubSpotContact(contactId, properties) {
  try {
    await hsRequest('PATCH', `/crm/v3/objects/contacts/${contactId}`, { properties });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.response?.data?.message || err.message };
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
  if (!HS_TOKEN) { console.error('HUBSPOT_PRIVATE_APP_TOKEN not set'); process.exit(1); }

  console.log('════════════════════════════════════════════════════════════');
  console.log('GENERATE MISSING CLAUDE EMAILS (Emails 8-10 / 7-9 for Website Visitor)');
  console.log(`Mode  : ${LIVE ? 'LIVE — calling Claude + writing to Airtable + patching HubSpot' : 'PREVIEW — no Claude calls, no writes'}`);
  if (BATCH < Infinity) console.log(`Batch : ${BATCH} unique contacts max`);
  console.log('════════════════════════════════════════════════════════════\n');

  // ── Fetch Airtable records ─────────────────────────────────────────────────
  console.log('Fetching claude-group records from Airtable...');
  let records;
  try {
    records = await query({
      filterByFormula: `AND(
        {AB Test Group} = "claude",
        {Claude Generated} = TRUE(),
        NOT({Contact Info} = ""),
        NOT(FIND("${PLACEHOLDER}", {Contact Info}) > 0),
        NOT(FIND("Research Needed", {Contact Info}) > 0),
        NOT(FIND("Contact Needed", {Contact Info}) > 0)
      )`,
      fields: [
        'Company Name', 'Signal Type', 'Contact Info', 'Industry',
        'Brief', 'Signal Details', 'Acquired Company', 'Company Website',
        'Bespoke', 'Send Day', 'AB Test Group', 'HubSpot Pushed',
        'Email 7 Subject', 'Email 8 Subject',
      ],
    }, 180000);
  } catch (err) {
    console.error('Airtable fetch failed:', err.message);
    process.exit(1);
  }

  console.log(`  Total claude-group generated records : ${records.length}`);

  // ── Filter to records missing new emails ───────────────────────────────────
  const incomplete = records.filter(r => {
    const signalType = r.fields['Signal Type'] || '';
    const email7     = (r.fields['Email 7 Subject'] || '').trim();
    const email8     = (r.fields['Email 8 Subject'] || '').trim();
    const email      = extractEmail(r.fields['Contact Info'] || '');
    if (!email || email.includes(PLACEHOLDER)) return false;
    return signalType === 'Website Visitor' ? email7 === '' : email8 === '';
  });

  console.log(`  Records missing new emails           : ${incomplete.length}\n`);

  if (incomplete.length === 0) {
    console.log('✓ Nothing to do — all claude-group contacts already have the full email set.');
    return;
  }

  // ── Deduplicate by email ───────────────────────────────────────────────────
  const emailToRecords = new Map();
  for (const r of incomplete) {
    const email = extractEmail(r.fields['Contact Info'] || '');
    if (!emailToRecords.has(email)) emailToRecords.set(email, []);
    emailToRecords.get(email).push(r);
  }

  const uniqueEmails = [...emailToRecords.keys()].slice(0, BATCH);
  const totalRecords = uniqueEmails.reduce((s, e) => s + emailToRecords.get(e).length, 0);

  console.log(`  Unique contacts to process           : ${uniqueEmails.length}`);
  console.log(`  Total Airtable records to update     : ${totalRecords}`);

  if (!LIVE) {
    console.log('\nSample (first 15 contacts):');
    for (const email of uniqueEmails.slice(0, 15)) {
      const r       = emailToRecords.get(email)[0];
      const company = (r.fields['Company Name'] || '(unknown)').padEnd(32);
      const type    = (r.fields['Signal Type'] || '—').padEnd(24);
      const missing = r.fields['Signal Type'] === 'Website Visitor' ? 'Emails 7,8,9' : 'Emails 8,9,10';
      console.log(`  ${company} | ${type} | ${missing} | ${email}`);
    }
    if (uniqueEmails.length > 15) console.log(`  ... and ${uniqueEmails.length - 15} more`);
    console.log(`\nPREVIEW: Would generate missing emails for ${uniqueEmails.length} contacts (${totalRecords} Airtable records).`);
    console.log('Run with --live to apply.\n');
    return;
  }

  // ── LIVE: generate, write to Airtable, patch HubSpot ─────────────────────
  let generated = 0, failed = 0, hsPatched = 0, hsSkipped = 0;

  for (let i = 0; i < uniqueEmails.length; i++) {
    const email   = uniqueEmails[i];
    const rList   = emailToRecords.get(email);
    const r       = rList[0];
    const f       = r.fields;

    const company    = f['Company Name'] || '';
    const signalType = f['Signal Type']  || '';
    const industry   = f['Industry']     || '';
    const pushed     = f['HubSpot Pushed'] === true;
    const parsed     = parseContact(f['Contact Info'] || '');
    const isWebsite  = signalType.toLowerCase() === 'website visitor';
    const missingStr = isWebsite ? 'Emails 7,8,9' : 'Emails 8,9,10';

    console.log(`[${i + 1}/${uniqueEmails.length}] ${company} [${signalType}] — ${parsed.name || email}`);
    console.log(`  Missing: ${missingStr} | In HubSpot: ${pushed ? 'yes' : 'no'}`);

    if (!parsed.firstName) {
      console.log(`  ✗ SKIP: no first name in Contact Info\n`);
      failed++;
      continue;
    }

    // Build signal + contact objects
    const signal = {
      type:             signalType,
      signal_type:      signalType,
      company_name:     company,
      company:          { name: company, industry, website: f['Company Website'] || null },
      industry,
      brief:            f['Brief']            || '',
      signal_details:   f['Signal Details']   || '',
      acquired_company: f['Acquired Company'] || null,
      bespoke:          f['Bespoke'] === true,
    };
    const contact = {
      name:       parsed.name,
      firstName:  parsed.firstName,
      first_name: parsed.firstName,
      lastName:   parsed.lastName,
      last_name:  parsed.lastName,
      title:      parsed.title,
      email,
    };

    // Resolve sender before calling Claude so the correct meeting link is baked into the prompt
    const senderEmail         = getSenderEmailForType(signalType);
    const sender              = getSenderConfig(senderEmail);
    const senderForGeneration = {
      name:        sender.firstName,
      email:       senderEmail,
      meetingLink: sender.meetingLink || null,
    };

    // Call Claude
    let result;
    try {
      result = await generateClaudeEmails(signal, contact, senderForGeneration);
    } catch (err) {
      console.log(`  ✗ Unexpected Claude error: ${err.message}\n`);
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

    // Token substitution
    const tokenVars   = {
      contactFirstName: parsed.firstName,
      contactCompany:   company,
      senderFirstName:  sender.firstName,
      meetingLink:      sender.meetingLink,
      targetCo:         signal.acquired_company || null,
      sector:           industry,
    };
    const emails = result.emails;
    const sub    = (t) => substituteTokens(t, tokenVars);

    // Build ONLY the new email fields — never overwrite existing emails 1–7
    let newAirtableFields, newHubSpotProps;

    if (isWebsite) {
      // Website Visitor: was 6, now needs 7, 8, 9
      newAirtableFields = {
        'Email 7 Subject': sub(emails.email_7_subject) || null,
        'Email 7 Body':    sub(emails.email_7_body)    || null,
        'Email 8 Subject': sub(emails.email_8_subject) || null,
        'Email 8 Body':    sub(emails.email_8_body)    || null,
        'Email 9 Subject': sub(emails.email_9_subject) || null,
        'Email 9 Body':    sub(emails.email_9_body)    || null,
      };
      newHubSpotProps = {
        email_7_subject: sub(emails.email_7_subject) || null,
        email_7_body:    sub(emails.email_7_body)    || null,
        email_8_subject: sub(emails.email_8_subject) || null,
        email_8_body:    sub(emails.email_8_body)    || null,
        email_9_subject: sub(emails.email_9_subject) || null,
        email_9_body:    sub(emails.email_9_body)    || null,
      };
    } else {
      // All other types: was 7, now needs 8, 9, 10
      newAirtableFields = {
        'Email 8 Subject':  sub(emails.email_8_subject)  || null,
        'Email 8 Body':     sub(emails.email_8_body)     || null,
        'Email 9 Subject':  sub(emails.email_9_subject)  || null,
        'Email 9 Body':     sub(emails.email_9_body)     || null,
        'Email 10 Subject': sub(emails.email_10_subject) || null,
        'Email 10 Body':    sub(emails.email_10_body)    || null,
      };
      newHubSpotProps = {
        email_8_subject:  sub(emails.email_8_subject)  || null,
        email_8_body:     sub(emails.email_8_body)     || null,
        email_9_subject:  sub(emails.email_9_subject)  || null,
        email_9_body:     sub(emails.email_9_body)     || null,
        email_10_subject: sub(emails.email_10_subject) || null,
        email_10_body:    sub(emails.email_10_body)    || null,
      };
    }

    // Write to Airtable (all records sharing this email)
    const updates = rList.map(rec => ({ id: rec.id, fields: newAirtableFields }));
    try {
      await updateRecords(updates);
      console.log(`  ✓ Airtable: wrote ${missingStr} to ${updates.length} record(s)`);
    } catch (writeErr) {
      console.log(`  ✗ Airtable write failed: ${writeErr.message}\n`);
      failed++;
      await pause(500);
      continue;
    }

    // Patch HubSpot if already pushed
    if (pushed) {
      await pause(150);
      const hsId = await findHubSpotId(email);
      if (hsId) {
        const patch = await patchHubSpotContact(hsId, newHubSpotProps);
        if (patch.success) {
          console.log(`  ✓ HubSpot: patched contact ${hsId} with ${missingStr}`);
          hsPatched++;
        } else {
          console.log(`  ⚠️  HubSpot patch failed: ${patch.error}`);
          hsSkipped++;
        }
      } else {
        console.log(`  ⚠️  HubSpot: contact not found — Airtable updated, HubSpot skipped`);
        hsSkipped++;
      }
    } else {
      hsSkipped++;
    }

    generated++;
    console.log('');
    await pause(400);
  }

  // ── Final summary ─────────────────────────────────────────────────────────
  console.log('════════════════════════════════════════════════════════════');
  console.log('RESULTS');
  console.log('════════════════════════════════════════════════════════════');
  console.log(`  Generated + written to Airtable : ${generated}`);
  console.log(`  HubSpot contacts patched        : ${hsPatched}`);
  console.log(`  HubSpot skipped (not pushed)    : ${hsSkipped}`);
  console.log(`  Failed                          : ${failed}`);
  console.log(`  Total attempted                 : ${uniqueEmails.length}`);
  if (generated < uniqueEmails.length && BATCH < Infinity) {
    console.log(`\n  Run again without --batch to process the rest, or increase the batch size.`);
  }
  console.log('════════════════════════════════════════════════════════════');
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
