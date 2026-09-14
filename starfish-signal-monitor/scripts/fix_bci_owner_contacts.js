/**
 * scripts/fix_bci_owner_contacts.js
 *
 * Finds HubSpot contacts whose contact owner (hubspot_owner_id) is set to
 * one of the BCI user accounts (cole/david/zack/andrew @starfishbci.com).
 *
 * How it works:
 *   1. Fetches all HubSpot owners — finds the IDs for the four BCI accounts
 *   2. Searches all contacts where hubspot_owner_id is any of those BCI owner IDs
 *   3. Reports which contacts are affected and what the correct StarfishCo owner should be
 *   4. In --fix mode: patches each contact's hubspot_owner_id to the StarfishCo equivalent
 *
 * Run:
 *   node --env-file=.env scripts/fix_bci_owner_contacts.js              (scan)
 *   node --env-file=.env scripts/fix_bci_owner_contacts.js --fix        (fix — reassign owners)
 */

import 'dotenv/config';
import axios from 'axios';

const FIX      = process.argv.includes('--fix');
const HS_TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
const HS_BASE  = 'https://api.hubapi.com';

// BCI → StarfishCo email mapping
const BCI_TO_STARFISH_EMAIL = {
  'zack@starfishbci.com':   process.env.ZACK_SENDER_EMAIL   || 'zack@starfishco.com',
  'cole@starfishbci.com':   process.env.COLE_SENDER_EMAIL   || 'cole@starfishco.com',
  'andrew@starfishbci.com': process.env.ANDREW_SENDER_EMAIL || 'andrew@starfishco.com',
  'david@starfishbci.com':  process.env.DAVID_SENDER_EMAIL  || 'david@starfishco.com',
};

// StarfishCo owner IDs from env
const STARFISH_OWNER_IDS = {
  'zack@starfishco.com':   process.env.ZACK_HUBSPOT_OWNER_ID   || null,
  'cole@starfishco.com':   process.env.COLE_HUBSPOT_OWNER_ID   || null,
  'andrew@starfishco.com': process.env.ANDREW_HUBSPOT_OWNER_ID || null,
  'david@starfishco.com':  process.env.DAVID_HUBSPOT_OWNER_ID  || null,
};

function pause(ms) { return new Promise(r => setTimeout(r, ms)); }

async function hsRequest(method, endpoint, data = null, params = null) {
  const cfg = {
    method,
    url:     `${HS_BASE}${endpoint}`,
    headers: { Authorization: `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' },
    timeout: 20000,
  };
  if (data)   cfg.data   = data;
  if (params) cfg.params = params;
  return axios(cfg);
}

// ── Step 1: Resolve BCI owner IDs from HubSpot owners list ───────────────────
// Uses v2 owners API (no extra scope required) with per-email lookup fallback
async function resolveBciOwnerIds() {
  const bciEmails = Object.keys(BCI_TO_STARFISH_EMAIL);
  const resolved  = {};  // bciEmail → { id, firstName, lastName }

  // Try fetching all owners at once via v2 endpoint (broader scope compatibility)
  try {
    const res  = await hsRequest('GET', '/owners/v2/owners', null, { includeInactive: false });
    const owners = Array.isArray(res.data) ? res.data : (res.data.results || []);

    for (const owner of owners) {
      const email = (owner.email || '').toLowerCase();
      if (bciEmails.includes(email)) {
        resolved[email] = {
          id:        String(owner.ownerId || owner.id),
          firstName: owner.firstName || '',
          lastName:  owner.lastName  || '',
        };
      }
    }

    if (Object.keys(resolved).length > 0 || owners.length > 0) return resolved;
  } catch (e) {
    // v2 also failed — fall through to per-email lookup
  }

  // Per-email lookup: GET /owners/v2/owners?email=xxx
  for (const bciEmail of bciEmails) {
    try {
      const res = await hsRequest('GET', '/owners/v2/owners', null, { email: bciEmail });
      const list = Array.isArray(res.data) ? res.data : [];
      if (list.length > 0) {
        const o = list[0];
        resolved[bciEmail] = {
          id:        String(o.ownerId || o.id),
          firstName: o.firstName || '',
          lastName:  o.lastName  || '',
        };
      }
      await pause(200);
    } catch {
      // owner not found for this email — skip
    }
  }

  return resolved;
}

// ── Step 2: Fetch all contacts owned by a specific owner ID ──────────────────
async function fetchContactsByOwner(ownerId) {
  const contacts = [];
  let after = undefined;

  while (true) {
    const body = {
      filterGroups: [{
        filters: [{
          propertyName: 'hubspot_owner_id',
          operator:     'EQ',
          value:        ownerId,
        }],
      }],
      properties: ['email', 'firstname', 'lastname', 'company', 'hubspot_owner_id'],
      limit: 100,
    };
    if (after) body.after = after;

    try {
      const res = await hsRequest('POST', '/crm/v3/objects/contacts/search', body);
      const results = res.data.results || [];
      contacts.push(...results);

      if (res.data.paging?.next?.after) {
        after = res.data.paging.next.after;
        await pause(300);
      } else {
        break;
      }
    } catch (err) {
      console.error(`  Error fetching contacts for owner ${ownerId}:`, err.response?.data?.message || err.message);
      break;
    }
  }

  return contacts;
}

// ── Step 3: Patch contact owner ───────────────────────────────────────────────
async function patchContactOwner(contactId, newOwnerId) {
  try {
    await hsRequest('PATCH', `/crm/v3/objects/contacts/${contactId}`, {
      properties: { hubspot_owner_id: newOwnerId },
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.response?.data?.message || err.message };
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
  if (!HS_TOKEN) { console.error('HUBSPOT_PRIVATE_APP_TOKEN not set'); process.exit(1); }

  console.log('════════════════════════════════════════════════════════════');
  console.log('BCI CONTACT OWNER AUDIT');
  console.log(`Mode : ${FIX ? 'FIX — reassigning owners to StarfishCo accounts' : 'SCAN — no changes'}`);
  console.log('════════════════════════════════════════════════════════════\n');

  // Step 1 — resolve BCI owner IDs
  console.log('Step 1: Looking up BCI owner IDs in HubSpot...');
  let bciOwners;
  try {
    bciOwners = await resolveBciOwnerIds();
  } catch (err) {
    console.error('Failed to fetch HubSpot owners:', err.response?.data?.message || err.message);
    process.exit(1);
  }

  const bciEmailsFound = Object.keys(bciOwners);
  if (bciEmailsFound.length === 0) {
    console.log('\n  No BCI owner accounts found in this HubSpot portal.');
    console.log('  (The BCI accounts may not be connected / may use different emails.)');
    return;
  }

  console.log(`  Found ${bciEmailsFound.length} BCI owner account(s):\n`);
  for (const [email, info] of Object.entries(bciOwners)) {
    console.log(`    ${email.padEnd(30)}  →  owner ID: ${info.id}  (${info.firstName} ${info.lastName})`);
  }

  // Step 2 — find contacts owned by each BCI owner
  console.log('\nStep 2: Searching contacts assigned to BCI owners...\n');

  const affected = [];  // { contact, bciEmail, bciOwnerId, starfishEmail, starfishOwnerId }

  for (const [bciEmail, bciInfo] of Object.entries(bciOwners)) {
    console.log(`  Fetching contacts owned by ${bciEmail} (ID: ${bciInfo.id})...`);
    const contacts = await fetchContactsByOwner(bciInfo.id);
    console.log(`    → ${contacts.length} contact(s) found`);
    await pause(400);

    const starfishEmail   = BCI_TO_STARFISH_EMAIL[bciEmail] || null;
    const starfishOwnerId = starfishEmail ? (STARFISH_OWNER_IDS[starfishEmail] || null) : null;

    for (const c of contacts) {
      affected.push({ contact: c, bciEmail, bciOwnerId: bciInfo.id, starfishEmail, starfishOwnerId });
    }
  }

  // Report
  console.log('\n════════════════════════════════════════════════════════════');
  console.log('SCAN RESULTS');
  console.log('════════════════════════════════════════════════════════════');
  console.log(`  BCI owner accounts found : ${bciEmailsFound.length}`);
  console.log(`  Contacts with BCI owner  : ${affected.length}`);

  if (affected.length === 0) {
    console.log('\n  ✓ No contacts are assigned to BCI owner accounts.');
    return;
  }

  // Group by BCI owner for display
  const byOwner = {};
  for (const item of affected) {
    if (!byOwner[item.bciEmail]) byOwner[item.bciEmail] = [];
    byOwner[item.bciEmail].push(item);
  }

  for (const [bciEmail, items] of Object.entries(byOwner)) {
    console.log(`\n── Owned by ${bciEmail} (${items.length} contacts) ─────────────────`);
    console.log(`   Should be reassigned to: ${items[0].starfishEmail || '(unknown — no mapping)'}`);
    console.log(`   StarfishCo owner ID    : ${items[0].starfishOwnerId || '(not in env)'}\n`);
    for (const { contact: c } of items.slice(0, 30)) {
      const p    = c.properties;
      const name = [p.firstname, p.lastname].filter(Boolean).join(' ') || '—';
      const co   = p.company || '—';
      const em   = p.email   || '—';
      console.log(`    ${name.padEnd(24)} | ${co.padEnd(28)} | ${em}`);
    }
    if (items.length > 30) console.log(`    ... and ${items.length - 30} more`);
  }

  if (!FIX) {
    console.log(`\n\nRun with --fix to reassign all ${affected.length} contact(s) to StarfishCo owners.`);
    return;
  }

  // ── FIX MODE ─────────────────────────────────────────────────────────────
  console.log(`\n\nFixing ${affected.length} contacts...\n`);
  let fixed = 0, skipped = 0, failed = 0;

  for (let i = 0; i < affected.length; i++) {
    const { contact: c, bciEmail, starfishEmail, starfishOwnerId } = affected[i];
    const p    = c.properties;
    const name = [p.firstname, p.lastname].filter(Boolean).join(' ') || '(no name)';

    process.stdout.write(`[${i + 1}/${affected.length}] ${name} (${p.email || '—'})  `);

    if (!starfishOwnerId) {
      console.log(`⚠️  No StarfishCo owner ID for ${starfishEmail} — skipping`);
      skipped++;
      continue;
    }

    const result = await patchContactOwner(c.id, starfishOwnerId);
    if (result.success) {
      console.log(`✓  ${bciEmail} → ${starfishEmail}`);
      fixed++;
    } else {
      console.log(`✗  ${result.error}`);
      failed++;
    }

    await pause(250);
  }

  console.log('\n════════════════════════════════════════════════════════════');
  console.log('RESULTS');
  console.log('════════════════════════════════════════════════════════════');
  console.log(`  Fixed   : ${fixed}`);
  console.log(`  Skipped : ${skipped}  (missing StarfishCo owner ID in env)`);
  console.log(`  Failed  : ${failed}`);
  console.log(`  Total   : ${affected.length}`);
  console.log('════════════════════════════════════════════════════════════');
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
