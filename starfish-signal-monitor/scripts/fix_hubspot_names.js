/**
 * fix_hubspot_names.js
 *
 * Finds all HubSpot contacts where firstname = "Name:" (broken parse bug)
 * and corrects them using the lastname field, which contains the full name
 * e.g. lastname = "Diana Courson" → firstname = "Diana", lastname = "Courson"
 *
 * Run with:
 *   node --env-file=.env scripts/fix_hubspot_names.js           (preview — no changes)
 *   node --env-file=.env scripts/fix_hubspot_names.js --live    (apply fixes)
 */

import 'dotenv/config';
import axios from 'axios';

const TOKEN    = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
const BASE_URL = 'https://api.hubapi.com';
const LIVE     = process.argv.includes('--live');

if (!TOKEN) {
  console.error('HUBSPOT_PRIVATE_APP_TOKEN not set in .env');
  process.exit(1);
}

const headers = {
  Authorization:  `Bearer ${TOKEN}`,
  'Content-Type': 'application/json',
};

function splitName(fullName) {
  const parts = (fullName || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstname: '', lastname: '' };
  if (parts.length === 1) return { firstname: parts[0], lastname: '' };
  return { firstname: parts[0], lastname: parts.slice(1).join(' ') };
}

async function searchBrokenContacts(after = null) {
  const body = {
    filterGroups: [{
      filters: [{
        propertyName: 'firstname',
        operator:     'EQ',
        value:        'Name:',
      }],
    }],
    properties: ['email', 'firstname', 'lastname', 'company', 'hubspot_pushed_date'],
    limit: 100,
    ...(after ? { after } : {}),
  };

  const res = await axios.post(`${BASE_URL}/crm/v3/objects/contacts/search`, body, { headers, timeout: 15000 });
  return res.data;
}

async function patchContact(contactId, firstname, lastname) {
  await axios.patch(
    `${BASE_URL}/crm/v3/objects/contacts/${contactId}`,
    { properties: { firstname, lastname } },
    { headers, timeout: 15000 }
  );
}

async function run() {
  console.log('────────────────────────────────────────────────────────────');
  console.log('FIX HUBSPOT NAMES — firstname = "Name:" (broken parse)');
  console.log(`Mode: ${LIVE ? 'LIVE (will update HubSpot)' : 'PREVIEW (no changes)'}`);
  console.log('────────────────────────────────────────────────────────────\n');

  // Fetch all broken contacts
  const all   = [];
  let after   = null;
  let page    = 1;

  try {
    while (true) {
      const data = await searchBrokenContacts(after);
      all.push(...data.results);
      console.log(`  Fetched page ${page} — ${data.results.length} contacts (total: ${all.length})`);
      if (data.paging?.next?.after) {
        after = data.paging.next.after;
        page++;
        await new Promise(r => setTimeout(r, 300));
      } else {
        break;
      }
    }
  } catch (err) {
    console.error('\nHubSpot search error:', err.response?.data?.message || err.message);
    process.exit(1);
  }

  if (all.length === 0) {
    console.log('\nNo broken contacts found. Nothing to fix.');
    return;
  }

  console.log(`\nFound ${all.length} contact(s) with firstname = "Name:"\n`);

  let fixed   = 0;
  let skipped = 0;
  let failed  = 0;

  for (const contact of all) {
    const id       = contact.id;
    const p        = contact.properties;
    const email    = p.email    || '(no email)';
    const company  = p.company  || '(no company)';
    // The full name is sitting in the lastname field e.g. "Diana Courson"
    const fullName = (p.lastname || '').trim();

    if (!fullName || fullName.toLowerCase() === 'name:') {
      console.log(`  ⚠️  SKIP  ${email.padEnd(46)} — no usable name in lastname field (lastname="${p.lastname}")`);
      skipped++;
      continue;
    }

    const { firstname, lastname } = splitName(fullName);

    if (!firstname) {
      console.log(`  ⚠️  SKIP  ${email.padEnd(46)} — could not parse firstname from "${fullName}"`);
      skipped++;
      continue;
    }

    console.log(`  ${LIVE ? '✓ FIX ' : '→ WOULD FIX'} ${email.padEnd(46)} "${p.firstname} ${fullName}" → firstname="${firstname}" lastname="${lastname}" [${company}]`);

    if (LIVE) {
      try {
        await patchContact(id, firstname, lastname);
        fixed++;
        await new Promise(r => setTimeout(r, 200)); // stay within rate limit
      } catch (err) {
        console.error(`  ✗ FAIL  ${email} — ${err.response?.data?.message || err.message}`);
        failed++;
      }
    } else {
      fixed++; // count as "would fix" in preview
    }
  }

  console.log('\n────────────────────────────────────────────────────────────');
  if (LIVE) {
    console.log(`Fixed  : ${fixed}`);
    console.log(`Skipped: ${skipped}`);
    console.log(`Failed : ${failed}`);
  } else {
    console.log(`Would fix: ${fixed}`);
    console.log(`Would skip (no usable name): ${skipped}`);
    console.log('\nRun with --live to apply these fixes.');
  }
  console.log('────────────────────────────────────────────────────────────');
}

run();
