/**
 * scripts/fix_sender_signoff.js
 *
 * Strips the sender first name from email sign-offs in Airtable + HubSpot.
 *
 * Problem: Email bodies were stored with "Best,\nAndrew" (or Cole/David/Zack)
 * as the sign-off. The correct sign-off is just "Best," — HubSpot appends the
 * full sender signature automatically, so the name in the body is both wrong
 * (may be the old sender) and a duplicate.
 *
 * What this fixes:
 *   "Best,\nAndrew"               → "Best,"
 *   "Best,\nCole"                 → "Best,"
 *   "Best,\nDavid"                → "Best,"
 *   "Best,\nZack"                 → "Best,"
 *   "Best,\n{{sender.firstname}}" → "Best,"  (token not yet substituted)
 *
 * Run:
 *   node --env-file=.env scripts/fix_sender_signoff.js              (scan — no changes)
 *   node --env-file=.env scripts/fix_sender_signoff.js --live       (fix Airtable + HubSpot)
 *   node --env-file=.env scripts/fix_sender_signoff.js --live --batch=100
 */

import 'dotenv/config';
import axios from 'axios';
import { query, updateRecords } from '../execution/utils/airtable_client.js';

const LIVE     = process.argv.includes('--live');
const batchArg = process.argv.find(a => a.startsWith('--batch='));
const BATCH    = batchArg ? parseInt(batchArg.split('=')[1], 10) : Infinity;

const HS_TOKEN    = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
const HS_BASE     = 'https://api.hubapi.com';
const PLACEHOLDER = 'email_not_unlocked@domain.com';

const SENDER_NAMES = ['Andrew', 'Cole', 'David', 'Zack'];

const EMAIL_BODY_FIELDS = [
  'Email 1 Body', 'Email 2 Body', 'Email 3 Body', 'Email 4 Body', 'Email 5 Body',
  'Email 6 Body', 'Email 7 Body', 'Email 8 Body', 'Email 9 Body', 'Email 10 Body',
];
const HS_BODY_PROPS = [
  'email_1_body', 'email_2_body', 'email_3_body', 'email_4_body', 'email_5_body',
  'email_6_body', 'email_7_body', 'email_8_body', 'email_9_body', 'email_10_body',
];

function pause(ms) { return new Promise(r => setTimeout(r, ms)); }

function extractEmail(ci) {
  if (!ci) return null;
  const m = ci.match(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/);
  return m ? m[0].toLowerCase() : null;
}

// Strips the sender name (or token) from the end of a "Best,\n<Name>" sign-off.
// Returns the fixed string, or the original if no fix was needed.
function stripSenderName(body) {
  if (!body) return body;
  const namePattern = SENDER_NAMES.join('|');
  // Remove a hardcoded sender name after "Best,"
  let fixed = body.replace(
    new RegExp(`(\\nBest,\\n)(${namePattern})(\\s*)$`, 'i'),
    '$1'
  );
  // Remove the {{sender.firstname}} token after "Best," (not yet substituted)
  fixed = fixed.replace(/(\nBest,\n)\{\{\s*sender\.firstname\s*\}\}(\s*)$/i, '$1');
  return fixed.trimEnd();
}

function needsFix(body) {
  if (!body) return false;
  const namePattern = SENDER_NAMES.join('|');
  if (new RegExp(`\\nBest,\\n(${namePattern})\\s*$`, 'i').test(body)) return true;
  if (/\nBest,\n\{\{\s*sender\.firstname\s*\}\}\s*$/i.test(body)) return true;
  return false;
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
  } catch { return null; }
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
  console.log('FIX SENDER NAME IN EMAIL SIGN-OFFS');
  console.log(`Mode  : ${LIVE ? 'LIVE — fixing Airtable + HubSpot' : 'SCAN — no changes'}`);
  if (BATCH < Infinity) console.log(`Batch : ${BATCH}`);
  console.log('════════════════════════════════════════════════════════════\n');

  console.log('Fetching claude-group records from Airtable...');
  let records;
  try {
    records = await query({
      filterByFormula: `AND(
        {AB Test Group} = "claude",
        {Claude Generated} = TRUE(),
        {HubSpot Pushed} = TRUE(),
        NOT({Contact Info} = ""),
        NOT(FIND("${PLACEHOLDER}", {Contact Info}) > 0)
      )`,
      fields: ['Contact Info', 'Company Name', ...EMAIL_BODY_FIELDS],
    }, 300000);
  } catch (err) {
    console.error('Airtable fetch failed:', err.message);
    process.exit(1);
  }

  console.log(`  Total records fetched : ${records.length}`);

  // ── Find records that need fixing ─────────────────────────────────────────
  const affected = records.filter(r =>
    EMAIL_BODY_FIELDS.some(f => needsFix(r.fields[f] || ''))
  );

  console.log(`  Records needing fix   : ${affected.length}\n`);

  if (affected.length === 0) {
    console.log('✓ No sign-off issues found. All clean.');
    return;
  }

  // Deduplicate by email
  const emailToRecords = new Map();
  for (const r of affected) {
    const email = extractEmail(r.fields['Contact Info'] || '');
    if (!email) continue;
    if (!emailToRecords.has(email)) emailToRecords.set(email, []);
    emailToRecords.get(email).push(r);
  }

  const uniqueEmails = [...emailToRecords.keys()].slice(0, BATCH);

  console.log(`  Unique contacts       : ${uniqueEmails.length}`);

  if (!LIVE) {
    console.log('\nSample (first 20 contacts):');
    for (const email of uniqueEmails.slice(0, 20)) {
      const r       = emailToRecords.get(email)[0];
      const company = (r.fields['Company Name'] || '(unknown)').padEnd(36);
      // Show which bodies and what name is in the sign-off
      const issues = EMAIL_BODY_FIELDS
        .filter(f => needsFix(r.fields[f] || ''))
        .map(f => {
          const body = r.fields[f] || '';
          const nameMatch = body.match(/\nBest,\n(\S+)\s*$/i);
          return `${f.replace('Email ', 'E').replace(' Body', 'B')}="${nameMatch?.[1] || 'token'}"`;
        })
        .join(', ');
      console.log(`  ${company} | ${issues}`);
    }
    if (uniqueEmails.length > 20) console.log(`  ... and ${uniqueEmails.length - 20} more`);
    console.log(`\nRun with --live to fix all ${uniqueEmails.length} contacts.\n`);
    return;
  }

  // ── LIVE ──────────────────────────────────────────────────────────────────
  let fixed = 0, hsFailed = 0, failed = 0;

  for (let i = 0; i < uniqueEmails.length; i++) {
    const email = uniqueEmails[i];
    const rList = emailToRecords.get(email);
    const r     = rList[0];
    const company = r.fields['Company Name'] || '';

    console.log(`[${i + 1}/${uniqueEmails.length}] ${company} — ${email}`);

    // Build fixed Airtable fields
    const newFields = {};
    for (const field of EMAIL_BODY_FIELDS) {
      const original = r.fields[field] || '';
      if (needsFix(original)) {
        newFields[field] = stripSenderName(original);
      }
    }

    if (Object.keys(newFields).length === 0) continue;

    const fieldList = Object.keys(newFields).map(f => f.replace('Email ', 'E').replace(' Body', 'B')).join(', ');
    console.log(`  Fixing: ${fieldList}`);

    // Update all Airtable records sharing this email
    const updates = rList.map(rec => ({ id: rec.id, fields: newFields }));
    try {
      await updateRecords(updates);
      console.log(`  ✓ Airtable: fixed ${updates.length} record(s)`);
    } catch (err) {
      console.log(`  ✗ Airtable write failed: ${err.message}\n`);
      failed++;
      continue;
    }

    // Patch HubSpot
    await pause(150);
    const hsId = await findHubSpotId(email);
    if (hsId) {
      const hsProps = {};
      for (const [field, val] of Object.entries(newFields)) {
        const idx = EMAIL_BODY_FIELDS.indexOf(field);
        if (idx !== -1) hsProps[HS_BODY_PROPS[idx]] = val;
      }
      const patch = await patchHubSpotContact(hsId, hsProps);
      if (patch.success) {
        console.log(`  ✓ HubSpot: patched contact ${hsId}`);
      } else {
        console.log(`  ⚠️  HubSpot patch failed: ${patch.error}`);
        hsFailed++;
      }
    } else {
      console.log(`  ⚠️  HubSpot: contact not found`);
      hsFailed++;
    }

    fixed++;
    console.log('');
    await pause(250);
  }

  console.log('════════════════════════════════════════════════════════════');
  console.log('RESULTS');
  console.log('════════════════════════════════════════════════════════════');
  console.log(`  Fixed (Airtable)    : ${fixed} contacts`);
  console.log(`  HubSpot patched     : ${fixed - hsFailed}`);
  console.log(`  HubSpot failed      : ${hsFailed}`);
  console.log(`  Airtable failed     : ${failed}`);
  console.log('════════════════════════════════════════════════════════════');
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
