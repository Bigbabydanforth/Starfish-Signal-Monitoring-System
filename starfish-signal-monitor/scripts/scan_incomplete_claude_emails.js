/**
 * scripts/scan_incomplete_claude_emails.js
 *
 * Finds all claude-group contacts whose Claude emails were generated under the
 * OLD system (7 emails for most types, 6 for Website Visitor) and are now
 * MISSING the new touches:
 *   - Non-Website Visitor : need Emails 8, 9, 10 (Email 8 Subject is blank)
 *   - Website Visitor     : need Emails 7, 8, 9  (Email 7 Subject is blank)
 *
 * For each contact it also checks HubSpot to see if they've already been pushed
 * (those will need a HubSpot patch in addition to the Airtable update).
 *
 * Run:
 *   node --env-file=.env scripts/scan_incomplete_claude_emails.js
 */

import 'dotenv/config';
import axios from 'axios';
import { query } from '../execution/utils/airtable_client.js';

const HS_TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
const HS_BASE  = 'https://api.hubapi.com';

const PLACEHOLDER = 'email_not_unlocked@domain.com';

function pause(ms) { return new Promise(r => setTimeout(r, ms)); }

function extractEmail(ci) {
  if (!ci) return null;
  const m = ci.match(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/);
  return m ? m[0].toLowerCase() : null;
}

async function checkHubSpot(email) {
  try {
    const res = await axios({
      method:  'POST',
      url:     `${HS_BASE}/crm/v3/objects/contacts/search`,
      headers: { Authorization: `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' },
      timeout: 15000,
      data: {
        filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
        properties:   ['email', 'email_8_subject', 'email_9_subject', 'email_10_subject'],
        limit: 1,
      },
    });
    return res.data.results?.[0] || null;
  } catch {
    return null;
  }
}

async function run() {
  if (!HS_TOKEN) { console.error('HUBSPOT_PRIVATE_APP_TOKEN not set'); process.exit(1); }

  console.log('════════════════════════════════════════════════════════════');
  console.log('INCOMPLETE CLAUDE EMAILS — SCAN');
  console.log('Finds claude-group contacts missing Email 7-10 (old 6/7-touch generation)');
  console.log('════════════════════════════════════════════════════════════\n');

  // ── Step 1: Pull all claude-group records that were already generated ──────
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
        'Company Name', 'Signal Type', 'Contact Info', 'AB Test Group',
        'HubSpot Pushed',
        'Email 7 Subject',
        'Email 8 Subject',
      ],
    }, 180000);
  } catch (err) {
    console.error('Airtable fetch failed:', err.message);
    process.exit(1);
  }

  console.log(`  Total claude-group generated records : ${records.length}`);

  // ── Step 2: Filter to records missing the new emails ─────────────────────
  const incomplete = records.filter(r => {
    const signalType = r.fields['Signal Type'] || '';
    const email7     = (r.fields['Email 7 Subject'] || '').trim();
    const email8     = (r.fields['Email 8 Subject'] || '').trim();
    const email      = extractEmail(r.fields['Contact Info'] || '');

    if (!email) return false;
    if (email.includes(PLACEHOLDER)) return false;

    if (signalType === 'Website Visitor') {
      // Old system gave 6 emails → Email 7 Subject is blank
      return email7 === '';
    } else {
      // Old system gave 7 emails → Email 8 Subject is blank
      return email8 === '';
    }
  });

  console.log(`  Records missing new emails           : ${incomplete.length}\n`);

  if (incomplete.length === 0) {
    console.log('✓ All claude-group contacts already have the full email set. Nothing to do.');
    return;
  }

  // ── Step 3: Deduplicate by email (BSI contacts share an email across send_days) ──
  const emailToRecords = new Map();
  for (const r of incomplete) {
    const email = extractEmail(r.fields['Contact Info'] || '');
    if (!emailToRecords.has(email)) emailToRecords.set(email, []);
    emailToRecords.get(email).push(r);
  }

  const uniqueEmails = [...emailToRecords.keys()];
  console.log(`  Unique contacts to update            : ${uniqueEmails.length}`);
  console.log(`  Total Airtable records affected      : ${incomplete.length}`);
  console.log('\nChecking each contact in HubSpot (this may take a minute)...\n');

  // ── Step 4: Check HubSpot for each unique contact ────────────────────────
  const inHubSpot    = [];
  const notInHubSpot = [];
  let   checked      = 0;

  for (const email of uniqueEmails) {
    const rList      = emailToRecords.get(email);
    const r          = rList[0];
    const company    = r.fields['Company Name'] || '(unknown)';
    const signalType = r.fields['Signal Type']  || '';
    const pushed     = r.fields['HubSpot Pushed'] === true;

    if (checked % 20 === 0) console.log(`  Checking ${checked + 1}/${uniqueEmails.length}...`);
    checked++;

    // Quick short-circuit: if Airtable says not pushed, skip the HubSpot API call
    if (!pushed) {
      notInHubSpot.push({ email, company, signalType, recordCount: rList.length, hsContact: null });
      await pause(50);
      continue;
    }

    const hsContact = await checkHubSpot(email);
    await pause(150);

    if (hsContact) {
      inHubSpot.push({ email, company, signalType, recordCount: rList.length, hsContact });
    } else {
      notInHubSpot.push({ email, company, signalType, recordCount: rList.length, hsContact: null });
    }
  }

  // ── Step 5: Group by signal type ─────────────────────────────────────────
  const byType = {};
  for (const c of [...inHubSpot, ...notInHubSpot]) {
    if (!byType[c.signalType]) byType[c.signalType] = { total: 0, inHS: 0, notInHS: 0 };
    byType[c.signalType].total++;
    if (c.hsContact) byType[c.signalType].inHS++;
    else             byType[c.signalType].notInHS++;
  }

  // ── Results ───────────────────────────────────────────────────────────────
  console.log('\n════════════════════════════════════════════════════════════');
  console.log('RESULTS');
  console.log('════════════════════════════════════════════════════════════');
  console.log(`  Unique contacts needing new emails   : ${uniqueEmails.length}`);
  console.log(`  Total Airtable records to update     : ${incomplete.length}`);
  console.log(`  Already in HubSpot (need HS patch)   : ${inHubSpot.length}`);
  console.log(`  Not yet in HubSpot (Airtable only)   : ${notInHubSpot.length}`);

  console.log('\n── Breakdown by signal type ──────────────────────────────');
  console.log(`  ${'Signal Type'.padEnd(28)} ${'Total'.padStart(6)} ${'In HubSpot'.padStart(12)} ${'Not Pushed'.padStart(12)} ${'New emails needed'}`);
  console.log(`  ${'─'.repeat(72)}`);
  for (const [type, counts] of Object.entries(byType).sort((a, b) => b[1].total - a[1].total)) {
    const newEmails = type === 'Website Visitor' ? 'Emails 7, 8, 9' : 'Emails 8, 9, 10';
    console.log(`  ${type.padEnd(28)} ${String(counts.total).padStart(6)} ${String(counts.inHS).padStart(12)} ${String(counts.notInHS).padStart(12)}   ${newEmails}`);
  }

  if (inHubSpot.length > 0) {
    console.log('\n── Contacts already in HubSpot (sample — first 20) ──────');
    for (const c of inHubSpot.slice(0, 20)) {
      console.log(`  ${c.company.padEnd(32)} | ${c.signalType.padEnd(24)} | ${c.email}`);
    }
    if (inHubSpot.length > 20) console.log(`  ... and ${inHubSpot.length - 20} more`);
  }

  console.log('\n════════════════════════════════════════════════════════════');
  console.log(`Next step: run generate_missing_claude_emails.js to fill in`);
  console.log(`the missing touches and patch HubSpot for pushed contacts.`);
  console.log('════════════════════════════════════════════════════════════');
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
