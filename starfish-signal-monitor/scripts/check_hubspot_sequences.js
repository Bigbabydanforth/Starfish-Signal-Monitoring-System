/**
 * check_hubspot_sequences.js
 *
 * Queries HubSpot directly for all contacts currently enrolled in a sequence.
 * Uses the built-in HubSpot property hs_sequences_is_enrolled = true.
 *
 * Run with:
 *   node --env-file=.env scripts/check_hubspot_sequences.js
 */

import 'dotenv/config';
import axios from 'axios';

const TOKEN    = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
const BASE_URL = 'https://api.hubapi.com';

if (!TOKEN) {
  console.error('HUBSPOT_PRIVATE_APP_TOKEN not set in .env');
  process.exit(1);
}

const headers = {
  Authorization:  `Bearer ${TOKEN}`,
  'Content-Type': 'application/json',
};

async function searchContacts(after = null) {
  const body = {
    filterGroups: [{
      filters: [{
        propertyName: 'hs_sequences_is_enrolled',
        operator:     'EQ',
        value:        'true',
      }],
    }],
    properties: [
      'email',
      'firstname',
      'lastname',
      'company',
      'jobtitle',
      'hs_sequences_is_enrolled',
      'hs_sequences_enrolled_count',
      'ab_test_group',
      'signal_data',
      'sequence_enrolled',
      'hubspot_pushed_date',
    ],
    limit: 100,
    ...(after ? { after } : {}),
  };

  const res = await axios.post(`${BASE_URL}/crm/v3/objects/contacts/search`, body, { headers });
  return res.data;
}

async function run() {
  console.log('────────────────────────────────────────────────────────────');
  console.log('HUBSPOT SEQUENCE ENROLLMENTS');
  console.log('Contacts where hs_sequences_is_enrolled = true');
  console.log('────────────────────────────────────────────────────────────\n');

  let all     = [];
  let after   = null;
  let page    = 1;

  try {
    while (true) {
      const data = await searchContacts(after);
      all.push(...data.results);
      console.log(`  Fetched page ${page} — ${data.results.length} contacts (total so far: ${all.length})`);

      if (data.paging?.next?.after) {
        after = data.paging.next.after;
        page++;
        await new Promise(r => setTimeout(r, 300)); // respect rate limit
      } else {
        break;
      }
    }
  } catch (err) {
    console.error('\nHubSpot API error:', err.response?.data?.message || err.message);
    process.exit(1);
  }

  if (all.length === 0) {
    console.log('\nNo contacts currently enrolled in any sequence.');
    return;
  }

  console.log(`\nFound ${all.length} enrolled contact(s):\n`);

  // Group by signal type
  const grouped = {};
  for (const c of all) {
    const p          = c.properties;
    const signalType = p.signal_data || 'Unknown';
    if (!grouped[signalType]) grouped[signalType] = [];
    grouped[signalType].push(p);
  }

  for (const [type, contacts] of Object.entries(grouped).sort()) {
    console.log(`${type} (${contacts.length})`);
    for (const p of contacts) {
      const name    = [p.firstname, p.lastname].filter(Boolean).join(' ') || '—';
      const email   = p.email   || '—';
      const company = p.company || '—';
      const abGroup = p.ab_test_group || '—';
      const pushed  = p.hubspot_pushed_date || '—';
      const count   = p.hs_sequences_enrolled_count || '1';
      console.log(`  • ${name.padEnd(28)} ${email.padEnd(44)} ${company.padEnd(35)} [${abGroup}] pushed:${pushed} enrollments:${count}`);
    }
    console.log();
  }

  console.log('────────────────────────────────────────────────────────────');
  console.log(`Total enrolled in sequences: ${all.length}`);
  console.log('────────────────────────────────────────────────────────────');
}

run();
