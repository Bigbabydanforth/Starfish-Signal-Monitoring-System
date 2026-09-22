/**
 * scripts/fix_bci_email_contacts.js
 *
 * Finds all contacts pushed to HubSpot in the last 3 weeks (Aug 17 – Sep 7, 2026)
 * that are currently enrolled in a sequence being sent from a @starfishbci.com address.
 *
 * How it works:
 *   - Fetches all pushed Airtable records created since Aug 17
 *   - Looks each one up in HubSpot by email
 *   - Checks if they are currently enrolled in a sequence
 *   - For enrolled contacts: checks if their signal type routes to a BCI sender
 *     (Rebrand → zack@starfishbci.com was the active BCI route before the fix)
 *   - In --fix mode: unenrolls + re-enrolls from the correct StarfishCo sender
 *
 * Run:
 *   node --env-file=.env scripts/fix_bci_email_contacts.js              (scan)
 *   node --env-file=.env scripts/fix_bci_email_contacts.js --fix        (fix)
 */

import 'dotenv/config';
import axios from 'axios';
import { query } from '../execution/utils/airtable_client.js';
import { getSequenceRoute } from '../hubspot/sequenceRouting.js';

const FIX      = process.argv.includes('--fix');
const HS_TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
const HS_BASE  = 'https://api.hubapi.com';

// 3 weeks back from Sep 7, 2026
const CUTOFF_DATE = '2026-08-17';

// BCI sender emails our pipeline ever used
const BCI_SENDERS = new Set([
  'zack@starfishbci.com',
  'cole@starfishbci.com',
  'andrew@starfishbci.com',
  'david@starfishbci.com',
]);

// StarfishCo replacement sender for each BCI email
const BCI_TO_STARFISH = {
  'zack@starfishbci.com':   process.env.ZACK_SENDER_EMAIL   || 'zack@starfishco.com',
  'cole@starfishbci.com':   process.env.COLE_SENDER_EMAIL   || 'cole@starfishco.com',
  'andrew@starfishbci.com': process.env.ANDREW_SENDER_EMAIL || 'andrew@starfishco.com',
  'david@starfishbci.com':  process.env.DAVID_SENDER_EMAIL  || 'david@starfishco.com',
};

// HubSpot owner IDs for re-enrollment
const OWNER_IDS = {
  'zack@starfishco.com':   process.env.ZACK_HUBSPOT_OWNER_ID   || null,
  'cole@starfishco.com':   process.env.COLE_HUBSPOT_OWNER_ID   || null,
  'andrew@starfishco.com': process.env.ANDREW_HUBSPOT_OWNER_ID || null,
  'david@starfishco.com':  process.env.DAVID_HUBSPOT_OWNER_ID  || null,
};

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
      properties:   ['email', 'firstname', 'hs_sequences_is_enrolled', 'signal_data', 'ab_test_group'],
      limit: 1,
    });
    return res.data.results?.[0] || null;
  } catch {
    return null;
  }
}

async function unenrollContact(contactId, userId) {
  try {
    const res = await hsRequest('GET', `/crm/v4/objects/contacts/${contactId}/associations/sequence_enrollment`);
    const enrollments = res.data?.results || [];
    if (enrollments.length === 0) return { success: true, note: 'no active enrollments found' };

    let unenrolled = 0;
    for (const enrollment of enrollments) {
      try {
        await hsRequest('DELETE', `/automation/v4/sequences/enrollments/${enrollment.toObjectId}?userId=${userId}`);
        unenrolled++;
      } catch {}
    }
    return { success: true, unenrolled, total: enrollments.length };
  } catch (err) {
    return { success: false, error: err.response?.data?.message || err.message };
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
  console.log('BCI SENDER AUDIT — 3-week backlog (Aug 17 – Sep 7, 2026)');
  console.log(`Mode : ${FIX ? 'FIX — unenroll + re-enroll from StarfishCo email' : 'SCAN — no changes'}`);
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
  console.log('  Checking each one in HubSpot...\n');

  const enrolled    = [];  // enrolled contacts
  const bciFlagged  = [];  // enrolled AND routing to a BCI sender
  let   notFound    = 0;

  for (let i = 0; i < records.length; i++) {
    const f          = records[i].fields;
    const company    = f['Company Name'] || '';
    const signalType = f['Signal Type']  || '';
    const abGroup    = f['AB Test Group'] || 'starfish';
    const email      = extractEmail(f['Contact Info'] || '');

    if (!email) continue;

    // Progress every 25 contacts
    if (i % 25 === 0) console.log(`  Checking ${i + 1}/${records.length}...`);

    const hsContact = await findHubSpotContact(email);
    await pause(150);

    if (!hsContact) { notFound++; continue; }

    const isEnrolled = hsContact.properties?.hs_sequences_is_enrolled === 'true';
    if (!isEnrolled) continue;

    enrolled.push({ record: records[i], hsContact, company, signalType, abGroup, email });

    // Determine if this contact routes to a BCI sender.
    // For News/Press and BSI (Cole/Andrew rotation), getSequenceRoute() advances a
    // module-level counter — calling it here in a scan loop would permanently skew
    // the rotation for the next pipeline run. Instead, infer the sender from the
    // signal type directly without touching the counter.
    const inferredBciSender = (() => {
      if (['Job Change', 'M&A Activity', 'Funding'].includes(signalType)) return 'david@starfishbci.com';
      if (['Website Visitor', 'Rebrand'].includes(signalType)) return 'zack@starfishbci.com';
      return null; // News/Press + BSI: Cole/Andrew via starfishco.com — not BCI
    })();
    if (inferredBciSender && BCI_SENDERS.has(inferredBciSender)) {
      // Re-use getSequenceRoute only for non-rotation types (no counter side-effect here)
      const route = getSequenceRoute(signalType, abGroup);
      bciFlagged.push({ record: records[i], hsContact, company, signalType, abGroup, email, route: route || { ownerEmail: inferredBciSender } });
    }
  }

  console.log('\n════════════════════════════════════════════════════════════');
  console.log('SCAN RESULTS');
  console.log('════════════════════════════════════════════════════════════');
  console.log(`  Total records in window   : ${records.length}`);
  console.log(`  Not found in HubSpot      : ${notFound}`);
  console.log(`  Currently enrolled        : ${enrolled.length}`);
  console.log(`  Sending from BCI domain   : ${bciFlagged.length}`);

  if (bciFlagged.length > 0) {
    console.log('\n── Contacts sending from BCI ─────────────────────────────');
    for (const c of bciFlagged) {
      const route        = c.route;
      const starfishSender = BCI_TO_STARFISH[route.ownerEmail] || '(unknown)';
      console.log(`  ${(c.company).padEnd(30)} | ${c.signalType.padEnd(18)} | ${c.email}`);
      console.log(`    BCI sender : ${route.ownerEmail}`);
      console.log(`    Should be  : ${starfishSender}`);
    }
  }

  if (enrolled.length > 0 && bciFlagged.length === 0) {
    console.log('\n  ✓ All enrolled contacts are using StarfishCo senders — no BCI senders found.');
    console.log('\n── All enrolled contacts (for reference) ─────────────────');
    for (const c of enrolled) {
      console.log(`  ${(c.company).padEnd(30)} | ${c.signalType.padEnd(18)} | ${c.abGroup}`);
    }
  }

  if (!FIX || bciFlagged.length === 0) {
    if (bciFlagged.length === 0) console.log('\n✓ Nothing to fix.');
    else console.log('\nRun with --fix to unenroll + re-enroll from StarfishCo senders.');
    return;
  }

  // ── FIX MODE ─────────────────────────────────────────────────────────────
  console.log(`\n\nFixing ${bciFlagged.length} contacts...\n`);
  let fixed = 0, failed = 0;

  for (const c of bciFlagged) {
    console.log(`${c.company} — ${c.email}`);

    const starfishSender = BCI_TO_STARFISH[c.route.ownerEmail];
    const userId         = OWNER_IDS[starfishSender] || null;
    const route          = getSequenceRoute(c.signalType, c.abGroup);

    if (!userId) {
      console.log(`  ⚠️  No HubSpot owner ID for ${starfishSender} — skipping`);
      failed++;
      continue;
    }

    if (!route?.sequenceId) {
      console.log(`  ⚠️  No sequence ID for ${c.signalType}/${c.abGroup} — skipping`);
      failed++;
      continue;
    }

    // Unenroll
    await pause(400);
    const unenroll = await unenrollContact(c.hsContact.id, userId);
    if (unenroll.success) {
      console.log(`  ✓ Unenrolled (${unenroll.note || `${unenroll.unenrolled}/${unenroll.total}`})`);
    } else {
      console.log(`  ⚠️  Unenroll failed: ${unenroll.error} — still attempting re-enrollment`);
    }

    // Re-enroll with StarfishCo sender
    await pause(400);
    const enroll = await enrollInSequence(c.hsContact.id, route.sequenceId, starfishSender, userId);
    if (enroll.success) {
      console.log(`  ✓ Re-enrolled → ${starfishSender} / seq ${route.sequenceId}`);
      fixed++;
    } else {
      console.log(`  ✗ Re-enrollment failed: ${enroll.error}`);
      failed++;
    }
    console.log('');
    await pause(500);
  }

  console.log('════════════════════════════════════════════════════════════');
  console.log('RESULTS');
  console.log('════════════════════════════════════════════════════════════');
  console.log(`  Fixed  : ${fixed}`);
  console.log(`  Failed : ${failed}`);
  console.log('════════════════════════════════════════════════════════════');
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
