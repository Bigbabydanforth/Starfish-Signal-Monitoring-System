/**
 * scripts/backfill_email_subjects.js
 *
 * Finds all claude-group Airtable records that are missing email subjects 2-9
 * (or 2-6 for Website Visitor) and writes them back from the HubSpot contact record.
 *
 * No Claude API calls — HubSpot already has every subject from the original push.
 * This script just copies them across to Airtable where they were missing.
 *
 * Run (scan):  node --env-file=.env scripts/backfill_email_subjects.js
 * Run (live):  node --env-file=.env scripts/backfill_email_subjects.js --live
 */

import 'dotenv/config';
import axios from 'axios';
import { query, updateRecords } from '../execution/utils/airtable_client.js';

const LIVE     = process.argv.includes('--live');
const HS_TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
const HS_BASE  = 'https://api.hubapi.com';

const PLACEHOLDER = 'email_not_unlocked@domain.com';

function pause(ms) { return new Promise(r => setTimeout(r, ms)); }

function extractEmail(ci) {
  if (!ci) return null;
  const m = ci.match(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/);
  return m ? m[0].toLowerCase() : null;
}

async function hsRequest(method, endpoint, data = null) {
  const cfg = {
    method,
    url:     `${HS_BASE}${endpoint}`,
    headers: { Authorization: `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' },
    timeout: 15000,
  };
  if (data) cfg.data = data;
  return axios(cfg);
}

// Fetch email subjects 2-10 from HubSpot for a given contact email.
async function getHubSpotSubjects(email, isWebsite) {
  const props = [
    'email',
    'email_2_subject', 'email_3_subject', 'email_4_subject',
    'email_5_subject', 'email_6_subject', 'email_7_subject',
    'email_8_subject', 'email_9_subject',
    ...(isWebsite ? [] : ['email_10_subject']),
  ];
  try {
    const res = await hsRequest('POST', '/crm/v3/objects/contacts/search', {
      filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
      properties: props,
      limit: 1,
    });
    return res.data.results?.[0]?.properties || null;
  } catch {
    return null;
  }
}

// Convert HubSpot property key → Airtable field name.
// email_2_subject → "Email 2 Subject"
function toAirtableKey(hsKey) {
  return hsKey.replace(/^email_(\d+)_subject$/, (_, n) => `Email ${n} Subject`);
}

async function run() {
  if (!HS_TOKEN) { console.error('HUBSPOT_PRIVATE_APP_TOKEN not set'); process.exit(1); }

  console.log('════════════════════════════════════════════════════════════');
  console.log('BACKFILL EMAIL SUBJECTS (HubSpot → Airtable)');
  console.log(`Mode: ${LIVE ? 'LIVE — writing subjects to Airtable' : 'SCAN — no changes'}`);
  console.log('════════════════════════════════════════════════════════════\n');

  // Fetch records missing Email 2 Subject (proxy for "all subjects 2-N are missing")
  console.log('Fetching Airtable records missing email subjects...');
  let records;
  try {
    records = await query({
      filterByFormula: `AND(
        {AB Test Group} = "claude",
        {Claude Generated} = TRUE(),
        {HubSpot Pushed} = TRUE(),
        NOT({Contact Info} = ""),
        NOT(FIND("${PLACEHOLDER}", {Contact Info}) > 0),
        {Email 2 Subject} = ""
      )`,
      fields: ['Company Name', 'Signal Type', 'Contact Info'],
    }, 180000);
  } catch (err) {
    console.error('Airtable fetch failed:', err.message);
    process.exit(1);
  }

  console.log(`  Records missing subjects: ${records.length}\n`);

  if (records.length === 0) {
    console.log('✓ All claude-group records already have email subjects. Nothing to do.');
    return;
  }

  // Deduplicate by email — multiple Airtable records can share the same contact
  const emailToRecords = new Map();
  for (const r of records) {
    const email = extractEmail(r.fields['Contact Info'] || '');
    if (!email || email.includes(PLACEHOLDER)) continue;
    if (!emailToRecords.has(email)) emailToRecords.set(email, []);
    emailToRecords.get(email).push(r);
  }

  const uniqueEmails = [...emailToRecords.keys()];
  const totalRecords = uniqueEmails.reduce((s, e) => s + emailToRecords.get(e).length, 0);

  console.log(`  Unique contacts : ${uniqueEmails.length}`);
  console.log(`  Airtable records: ${totalRecords}`);

  if (!LIVE) {
    console.log('\nSample (first 20 contacts):');
    for (const email of uniqueEmails.slice(0, 20)) {
      const r = emailToRecords.get(email)[0];
      const company = (r.fields['Company Name'] || '').padEnd(32);
      const type    = (r.fields['Signal Type']  || '').padEnd(22);
      console.log(`  ${company} | ${type} | ${email}`);
    }
    if (uniqueEmails.length > 20) console.log(`  ... and ${uniqueEmails.length - 20} more`);
    console.log(`\nRun with --live to copy subjects from HubSpot → Airtable.\n`);
    return;
  }

  // ── LIVE ─────────────────────────────────────────────────────────────────────
  let fixed = 0, noHsRecord = 0, noHsSubjects = 0, failed = 0;

  for (let i = 0; i < uniqueEmails.length; i++) {
    const email      = uniqueEmails[i];
    const rList      = emailToRecords.get(email);
    const r          = rList[0];
    const company    = r.fields['Company Name'] || '';
    const signalType = r.fields['Signal Type']  || '';
    const isWebsite  = signalType.toLowerCase() === 'website visitor';

    console.log(`[${i + 1}/${uniqueEmails.length}] ${company} — ${email}`);

    const hsProps = await getHubSpotSubjects(email, isWebsite);
    await pause(150);

    if (!hsProps) {
      console.log(`  ⚠️  Not found in HubSpot — skipping\n`);
      noHsRecord++;
      continue;
    }

    // Pick only the subject keys that have a real value in HubSpot
    const subjectHsKeys = isWebsite
      ? ['email_2_subject', 'email_3_subject', 'email_4_subject',
         'email_5_subject', 'email_6_subject', 'email_7_subject',
         'email_8_subject', 'email_9_subject']
      : ['email_2_subject', 'email_3_subject', 'email_4_subject',
         'email_5_subject', 'email_6_subject', 'email_7_subject',
         'email_8_subject', 'email_9_subject', 'email_10_subject'];

    const newFields = {};
    for (const hsKey of subjectHsKeys) {
      const val = (hsProps[hsKey] || '').trim();
      if (val) newFields[toAirtableKey(hsKey)] = val;
    }

    if (Object.keys(newFields).length === 0) {
      console.log(`  ⚠️  HubSpot contact has no email subjects stored — skipping\n`);
      noHsSubjects++;
      continue;
    }

    const updates = rList.map(rec => ({ id: rec.id, fields: newFields }));
    try {
      await updateRecords(updates);
      console.log(`  ✓ Wrote ${Object.keys(newFields).length} subjects to ${updates.length} Airtable record(s)\n`);
      fixed++;
    } catch (err) {
      console.log(`  ✗ Airtable write failed: ${err.message}\n`);
      failed++;
    }

    await pause(200);
  }

  console.log('════════════════════════════════════════════════════════════');
  console.log('RESULTS');
  console.log('════════════════════════════════════════════════════════════');
  console.log(`  Fixed             : ${fixed} contacts (${totalRecords} Airtable records)`);
  console.log(`  Not in HubSpot    : ${noHsRecord}`);
  console.log(`  No subjects in HS : ${noHsSubjects}  (these contacts may need regeneration)`);
  console.log(`  Failed            : ${failed}`);
  console.log('════════════════════════════════════════════════════════════');
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
