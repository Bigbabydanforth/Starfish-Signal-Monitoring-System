/**
 * scripts/fix_placeholder_tokens.js
 *
 * Finds pushed Airtable records where any email field still contains unsubstituted
 * {{ }} tokens (e.g. {{contact.firstname}}), re-substitutes them with real contact
 * data, and patches both Airtable and HubSpot with the corrected values.
 *
 * Run:
 *   node --env-file=.env scripts/fix_placeholder_tokens.js              (scan — no changes)
 *   node --env-file=.env scripts/fix_placeholder_tokens.js --fix        (fix all affected)
 *   node --env-file=.env scripts/fix_placeholder_tokens.js --fix --batch=10
 */

import 'dotenv/config';
import axios from 'axios';
import { query, updateRecords } from '../execution/utils/airtable_client.js';
import { SENDER_CONFIGS }       from '../hubspot/sequenceRouting.js';

const FIX   = process.argv.includes('--fix');
const batchArg = process.argv.find(a => a.startsWith('--batch='));
const BATCH = batchArg ? parseInt(batchArg.split('=')[1], 10) : Infinity;

const HS_TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
const HS_BASE  = 'https://api.hubapi.com';

const EMAIL_FIELDS = [];
for (let i = 1; i <= 10; i++) {
  EMAIL_FIELDS.push(`Email ${i} Subject`);
  EMAIL_FIELDS.push(`Email ${i} Body`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function pause(ms) { return new Promise(r => setTimeout(r, ms)); }

function hasToken(text) {
  return typeof text === 'string' && /\{\{/.test(text);
}

function extractEmail(ci) {
  if (!ci) return null;
  const m = ci.match(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/);
  return m ? m[0].toLowerCase() : null;
}

function parseContact(ci) {
  if (!ci) return { firstName: '', lastName: '', name: '' };
  function stripLabel(line) {
    return line.replace(/^(name|title|email|linkedin)\s*:\s*/i, '').trim();
  }
  const lines = ci.split('\n').map(l => l.trim()).filter(l =>
    l && !l.startsWith('⚠️') && !l.startsWith('http') &&
    !l.startsWith('Website:') && !l.startsWith('LinkedIn:')
  );
  let name = '';
  for (const line of lines) {
    const clean = stripLabel(line);
    if (clean.includes('@')) continue;
    if (!name) { name = clean; break; }
  }
  const parts = name.split(/\s+/).filter(Boolean);
  return {
    name,
    firstName: parts[0] || '',
    lastName:  parts.length > 1 ? parts.slice(1).join(' ') : '',
  };
}

function getSenderForType(signalType) {
  const DAVID = process.env.DAVID_SENDER_EMAIL || 'david@starfishco.com';
  const ZACK  = process.env.ZACK_SENDER_EMAIL  || 'zack@starfishco.com';
  const COLE  = process.env.COLE_SENDER_EMAIL  || 'cole@starfishco.com';
  if (['Job Change', 'M&A Activity', 'Funding'].includes(signalType)) return DAVID;
  if (['Website Visitor', 'Rebrand'].includes(signalType)) return ZACK;
  return COLE;
}

function substituteTokens(text, { firstName, company, senderFirstName, meetingLink, targetCo, sector }) {
  if (!text) return text;
  return text
    .replace(/\{\{\s*contact\.firstname\s*\}\}/gi,   firstName      || 'there')
    .replace(/\{\{\s*contact\.first_name\s*\}\}/gi,  firstName      || 'there')
    .replace(/\{\{\s*contact\.company\s*\}\}/gi,     company        || 'your company')
    .replace(/\{\{\s*sender\.firstname\s*\}\}/gi,    senderFirstName || '')
    .replace(/\{\{\s*owner\.meetings_link\s*\}\}/gi, meetingLink    || '')
    .replace(/\{\{\s*TargetCo\s*\}\}/gi,             targetCo       || 'the acquired company')
    .replace(/\{\{\s*Sector\s*\}\}/gi,               sector         || 'your category')
    // Catch-all: remove any remaining {{ ... }} tokens not covered above
    .replace(/\{\{[^}]*\}\}/g, (match) => {
      console.warn(`  ⚠️  Unknown token removed: ${match}`);
      return '';
    });
}

// ── HubSpot helpers ───────────────────────────────────────────────────────────
async function findHubSpotContact(email) {
  try {
    const res = await axios({
      method:  'POST',
      url:     `${HS_BASE}/crm/v3/objects/contacts/search`,
      headers: { Authorization: `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' },
      data: {
        filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
        properties: ['email', 'firstname', 'company'],
        limit: 1,
      },
      timeout: 15000,
    });
    return res.data.results?.[0] || null;
  } catch {
    return null;
  }
}

async function patchHubSpot(contactId, fields) {
  await axios({
    method:  'PATCH',
    url:     `${HS_BASE}/crm/v3/objects/contacts/${contactId}`,
    headers: { Authorization: `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' },
    data:    { properties: fields },
    timeout: 15000,
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
  console.log('════════════════════════════════════════════════════════════');
  console.log('PLACEHOLDER TOKEN FIXER');
  console.log(`Mode : ${FIX ? 'FIX — patching Airtable + HubSpot' : 'SCAN — no changes'}`);
  if (BATCH < Infinity) console.log(`Batch: ${BATCH} contacts max`);
  console.log('════════════════════════════════════════════════════════════\n');

  console.log('Fetching all pushed records from Airtable...');
  let records;
  try {
    records = await query({
      filterByFormula: `{HubSpot Pushed} = TRUE()`,
      fields: [
        'Company Name', 'Signal Type', 'Contact Info', 'Industry',
        'Acquired Company', 'AB Test Group',
        ...EMAIL_FIELDS,
      ],
    }, 120000);
  } catch (err) {
    console.error('Airtable fetch failed:', err.message);
    process.exit(1);
  }

  console.log(`  Total pushed records fetched: ${records.length}\n`);

  // Find affected records — any email field containing {{
  const affected = records.filter(r => {
    return EMAIL_FIELDS.some(field => hasToken(r.fields[field]));
  });

  console.log(`Affected records (contain {{ tokens): ${affected.length}`);

  if (affected.length === 0) {
    console.log('\n✓ No unsubstituted tokens found. All emails are clean.');
    return;
  }

  // Show sample of affected records and which tokens remain
  console.log('\n── Sample (first 15) ───────────────────────────────────────');
  for (const r of affected.slice(0, 15)) {
    const f        = r.fields;
    const company  = (f['Company Name'] || '(unknown)').padEnd(30);
    const type     = (f['Signal Type']  || '—').padEnd(18);
    // Collect unique tokens found
    const tokens   = new Set();
    for (const field of EMAIL_FIELDS) {
      const val = f[field] || '';
      const matches = val.match(/\{\{[^}]*\}\}/g) || [];
      matches.forEach(t => tokens.add(t));
    }
    console.log(`  ${company} | ${type} | tokens: ${[...tokens].join(', ')}`);
  }
  if (affected.length > 15) console.log(`  ... and ${affected.length - 15} more`);

  if (!FIX) {
    console.log(`\nSCAN complete. ${affected.length} record(s) need fixing.`);
    console.log('Run with --fix to apply corrections.');
    return;
  }

  // ── FIX MODE ─────────────────────────────────────────────────────────────
  const toFix = affected.slice(0, BATCH);
  console.log(`\nFixing ${toFix.length} record(s)...\n`);

  let fixed = 0, failed = 0;

  for (let i = 0; i < toFix.length; i++) {
    const record     = toFix[i];
    const f          = record.fields;
    const company    = f['Company Name'] || '';
    const signalType = f['Signal Type']  || '';
    const industry   = f['Industry']     || '';
    const targetCo   = f['Acquired Company'] || null;
    const parsed     = parseContact(f['Contact Info'] || '');
    const email      = extractEmail(f['Contact Info'] || '');

    console.log(`[${i + 1}/${toFix.length}] ${company}`);
    console.log(`  Contact: ${parsed.name || '—'} | Email: ${email || '—'}`);

    if (!email) {
      console.log('  ✗ SKIP: no email found in Contact Info\n');
      failed++;
      continue;
    }

    // Build substitution vars
    const senderEmail  = getSenderForType(signalType);
    const senderCfg    = SENDER_CONFIGS[senderEmail] || { firstName: '', meetingLink: '' };
    const tokenVars    = {
      firstName:      parsed.firstName,
      company:        company,
      senderFirstName: senderCfg.firstName,
      meetingLink:    senderCfg.meetingLink,
      targetCo,
      sector:         industry,
    };

    // Re-substitute all email fields
    const correctedAirtable = {};
    const correctedHubSpot  = {};
    let tokenCount = 0;

    for (const field of EMAIL_FIELDS) {
      const raw = f[field];
      if (!hasToken(raw)) continue;

      const fixed_val = substituteTokens(raw, tokenVars);
      correctedAirtable[field] = fixed_val;

      // Map Airtable field name → HubSpot property name
      const hsProp = field.toLowerCase().replace(/ /g, '_'); // "Email 1 Body" → "email_1_body"
      correctedHubSpot[hsProp] = fixed_val;
      tokenCount++;
    }

    console.log(`  Fields to fix: ${tokenCount}`);

    // Find HubSpot contact
    const hsContact = await findHubSpotContact(email);
    if (!hsContact) {
      console.log('  ⚠️  HubSpot contact not found — updating Airtable only');
    }

    // Patch HubSpot
    if (hsContact) {
      try {
        await patchHubSpot(hsContact.id, correctedHubSpot);
        console.log(`  ✓ HubSpot patched (id: ${hsContact.id})`);
      } catch (err) {
        const msg = err.response?.data?.message || err.message;
        console.log(`  ⚠️  HubSpot patch failed: ${msg}`);
      }
      await pause(300);
    }

    // Update Airtable
    try {
      await updateRecords([{ id: record.id, fields: correctedAirtable }]);
      console.log('  ✓ Airtable updated');
      fixed++;
    } catch (err) {
      console.log(`  ✗ Airtable update failed: ${err.message}`);
      failed++;
    }

    console.log('');
    await pause(500);
  }

  console.log('════════════════════════════════════════════════════════════');
  console.log('RESULTS');
  console.log('════════════════════════════════════════════════════════════');
  console.log(`  Fixed   : ${fixed}`);
  console.log(`  Failed  : ${failed}`);
  console.log(`  Total   : ${toFix.length}`);
  console.log('════════════════════════════════════════════════════════════');
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
