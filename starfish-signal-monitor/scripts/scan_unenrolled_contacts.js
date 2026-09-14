/**
 * scripts/scan_unenrolled_contacts.js
 *
 * Finds contacts we pushed to HubSpot in the last 3 weeks (Aug 17 – Sep 7, 2026)
 * that are NOT currently enrolled in any sequence.
 *
 * How it works:
 *   - Fetches all pushed Airtable records created since Aug 17
 *   - Looks each one up in HubSpot by email
 *   - Flags any contact where hs_sequences_is_enrolled !== 'true'
 *   - Shows the signal type + the sequence they SHOULD be in
 *   - In --fix mode: enrolls them into the correct sequence
 *
 * Run:
 *   node --env-file=.env scripts/scan_unenrolled_contacts.js              (scan)
 *   node --env-file=.env scripts/scan_unenrolled_contacts.js --fix        (fix — enroll missing)
 */

import 'dotenv/config';
import axios from 'axios';
import { query } from '../execution/utils/airtable_client.js';
import { getSequenceRoute } from '../hubspot/sequenceRouting.js';

const FIX      = process.argv.includes('--fix');
const HS_TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
const HS_BASE  = 'https://api.hubapi.com';

// Rolling 30-day window — always looks back 30 days from today
const CUTOFF_DATE = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

// Internal team emails — never enroll these into outbound sequences
const EXCLUDED_EMAILS = new Set([
  'jeff@starfishco.com',
  'rachel@starfishco.com',
]);

function pause(ms) { return new Promise(r => setTimeout(r, ms)); }

function extractEmail(ci) {
  if (!ci) return null;
  const m = ci.match(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/);
  return m ? m[0].toLowerCase() : null;
}

// ── HubSpot helpers ───────────────────────────────────────────────────────────
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

async function findHubSpotContact(email) {
  try {
    const res = await hsRequest('POST', '/crm/v3/objects/contacts/search', {
      filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
      properties:   ['email', 'firstname', 'company', 'hs_sequences_is_enrolled'],
      limit: 1,
    });
    return res.data.results?.[0] || null;
  } catch {
    return null;
  }
}

async function enrollInSequence(contactId, sequenceId, senderEmail, userId) {
  try {
    await hsRequest('POST', `/automation/v4/sequences/enrollments?userId=${userId}`, {
      sequenceId, contactId, senderEmail,
    });
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error:   err.response?.data?.message || err.message,
      status:  err.response?.status,
    };
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
  if (!HS_TOKEN) { console.error('HUBSPOT_PRIVATE_APP_TOKEN not set'); process.exit(1); }

  console.log('════════════════════════════════════════════════════════════');
  console.log('UNENROLLED CONTACTS AUDIT — 3-week backlog (Aug 17 – Sep 7, 2026)');
  console.log(`Mode : ${FIX ? 'FIX — enrolling into correct sequences' : 'SCAN — no changes'}`);
  console.log('════════════════════════════════════════════════════════════\n');

  // Pull all pushed records from the 3-week window
  console.log(`Fetching Airtable records pushed since ${CUTOFF_DATE}...`);
  let records;
  try {
    records = await query({
      filterByFormula: `AND(
        {HubSpot Pushed} = TRUE(),
        IS_AFTER(CREATED_TIME(), "${CUTOFF_DATE}")
      )`,
      fields: ['Company Name', 'Signal Type', 'Contact Info', 'AB Test Group'],
    }, 120000);
  } catch (err) {
    console.error('Airtable fetch failed:', err.message);
    process.exit(1);
  }

  console.log(`  Records in window : ${records.length}`);
  console.log('  Checking each contact in HubSpot...\n');

  const unenrolled = [];
  const enrolled   = [];
  let   notFound   = 0;
  let   noEmail    = 0;

  for (let i = 0; i < records.length; i++) {
    const f          = records[i].fields;
    const company    = f['Company Name'] || '';
    const signalType = f['Signal Type']  || '';
    const abGroup    = f['AB Test Group'] || 'starfish';
    const email      = extractEmail(f['Contact Info'] || '');

    if (!email) { noEmail++; continue; }
    if (EXCLUDED_EMAILS.has(email)) continue;

    if (i % 25 === 0) console.log(`  Checking ${i + 1}/${records.length}...`);

    const hsContact = await findHubSpotContact(email);
    await pause(150);

    if (!hsContact) { notFound++; continue; }

    const isEnrolled = hsContact.properties?.hs_sequences_is_enrolled === 'true';

    if (isEnrolled) {
      enrolled.push({ record: records[i], hsContact, company, signalType, abGroup, email });
    } else {
      unenrolled.push({ record: records[i], hsContact, company, signalType, abGroup, email });
    }
  }

  // ── Results ───────────────────────────────────────────────────────────────
  console.log('\n════════════════════════════════════════════════════════════');
  console.log('SCAN RESULTS');
  console.log('════════════════════════════════════════════════════════════');
  console.log(`  Total records in window : ${records.length}`);
  console.log(`  No email in record      : ${noEmail}`);
  console.log(`  Not found in HubSpot    : ${notFound}`);
  console.log(`  Enrolled in sequence    : ${enrolled.length}`);
  console.log(`  NOT enrolled            : ${unenrolled.length}`);

  if (unenrolled.length === 0) {
    console.log('\n  ✓ All pushed contacts are enrolled in a sequence — nothing to fix.');
    return;
  }

  // Group unenrolled by signal type for a clean summary
  const byType = {};
  for (const c of unenrolled) {
    if (!byType[c.signalType]) byType[c.signalType] = [];
    byType[c.signalType].push(c);
  }

  console.log('\n── Unenrolled contacts by signal type ────────────────────');
  for (const [type, items] of Object.entries(byType)) {
    console.log(`\n  ${type} (${items.length})`);
    for (const c of items) {
      const route = getSequenceRoute(c.signalType, c.abGroup);
      const seqId = route?.sequenceId || '(no sequence ID)';
      const owner = route?.ownerEmail || '(no owner)';
      console.log(`    ${(c.company).padEnd(30)} | ${c.abGroup.padEnd(8)} | ${c.email}`);
      console.log(`      → Sequence: ${seqId}  |  Sender: ${owner}`);
    }
  }

  if (!FIX) {
    console.log(`\n\nRun with --fix to enroll all ${unenrolled.length} contact(s) into their sequences.`);
    return;
  }

  // ── FIX MODE ─────────────────────────────────────────────────────────────
  console.log(`\n\nEnrolling ${unenrolled.length} contacts...\n`);
  let fixed = 0, skipped = 0, failed = 0;

  for (let i = 0; i < unenrolled.length; i++) {
    const c     = unenrolled[i];
    const route = getSequenceRoute(c.signalType, c.abGroup);

    console.log(`[${i + 1}/${unenrolled.length}] ${c.company} — ${c.email}`);
    console.log(`  Signal: ${c.signalType} | Group: ${c.abGroup}`);

    if (!route) {
      console.log(`  ⚠️  No routing rule for signal type "${c.signalType}" — skipping`);
      skipped++;
      continue;
    }
    if (!route.sequenceId) {
      console.log(`  ⚠️  No sequence ID for ${c.signalType}/${c.abGroup} — skipping`);
      skipped++;
      continue;
    }
    if (!route.ownerId) {
      console.log(`  ⚠️  No owner ID for sender ${route.ownerEmail} — skipping`);
      skipped++;
      continue;
    }

    await pause(400);
    const result = await enrollInSequence(c.hsContact.id, route.sequenceId, route.ownerEmail, route.ownerId);

    if (result.success) {
      console.log(`  ✓ Enrolled → ${route.ownerEmail} / seq ${route.sequenceId}`);
      fixed++;
    } else {
      console.log(`  ✗ Failed: ${result.error}`);
      failed++;
    }
    console.log('');
    await pause(400);
  }

  console.log('════════════════════════════════════════════════════════════');
  console.log('RESULTS');
  console.log('════════════════════════════════════════════════════════════');
  console.log(`  Enrolled  : ${fixed}`);
  console.log(`  Skipped   : ${skipped}  (missing sequence/owner ID)`);
  console.log(`  Failed    : ${failed}`);
  console.log(`  Total     : ${unenrolled.length}`);
  console.log('════════════════════════════════════════════════════════════');
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
