/**
 * scripts/list_hubspot_properties.js
 *
 * Fetches all custom contact properties from HubSpot and prints their
 * exact internal names — so we can see what HubSpot actually named them.
 *
 * USAGE:
 *   node scripts/list_hubspot_properties.js
 */

import 'dotenv/config';
import axios from 'axios';

const HUBSPOT_TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN;

if (!HUBSPOT_TOKEN) {
  console.error('❌  HUBSPOT_PRIVATE_APP_TOKEN not set in .env — aborting');
  process.exit(1);
}

async function run() {
  const res = await axios.get('https://api.hubapi.com/crm/v3/properties/contacts', {
    headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` },
    timeout: 10000,
  });

  // Filter to custom properties only (exclude HubSpot built-ins)
  const custom = res.data.results.filter(p => !p.hubspotDefined);

  console.log(`\nCustom contact properties (${custom.length} total):\n`);
  console.log('Internal Name'.padEnd(40) + 'Label');
  console.log('─'.repeat(75));
  for (const p of custom) {
    console.log(p.name.padEnd(40) + p.label);
  }
  console.log('');
}

run().catch(err => {
  console.error('Fatal error:', err.response?.data?.message || err.message);
  process.exit(1);
});
