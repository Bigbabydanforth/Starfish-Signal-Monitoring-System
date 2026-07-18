/**
 * scripts/setup_hubspot_properties.js
 *
 * One-time setup: creates all custom HubSpot contact properties needed
 * by the Starfish Signal Monitor integration.
 *
 * USAGE:
 *   node scripts/setup_hubspot_properties.js
 *
 * Safe to re-run — skips properties that already exist (409 = already exists).
 * Run this BEFORE running test_hubspot.js or enabling HUBSPOT_AUTO_PUSH.
 */

import 'dotenv/config';
import axios from 'axios';

const HUBSPOT_TOKEN    = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
const HUBSPOT_BASE_URL = 'https://api.hubapi.com';

if (!HUBSPOT_TOKEN) {
  console.error('❌  HUBSPOT_PRIVATE_APP_TOKEN not set in .env — aborting');
  process.exit(1);
}

const headers = {
  Authorization:  `Bearer ${HUBSPOT_TOKEN}`,
  'Content-Type': 'application/json',
};

// All 12 custom contact properties required by pushSignalToHubSpot.js
const PROPERTIES = [
  { name: 'signal_type',         label: 'Signal Type',          type: 'string', fieldType: 'text'     },
  { name: 'signal_priority',     label: 'Signal Priority',      type: 'string', fieldType: 'text'     },
  { name: 'signal_brief',        label: 'Signal Brief',         type: 'string', fieldType: 'textarea' },
  { name: 'signal_source',       label: 'Signal Source',        type: 'string', fieldType: 'text'     },
  { name: 'signal_date',         label: 'Signal Date',          type: 'string', fieldType: 'text'     },
  { name: 'send_day',            label: 'Send Day',             type: 'string', fieldType: 'text'     },
  { name: 'contact_source',      label: 'Contact Source',       type: 'string', fieldType: 'text'     },
  { name: 'sequence_enrolled',   label: 'Sequence Enrolled',    type: 'string', fieldType: 'text'     },
  { name: 'hubspot_pushed_date', label: 'HubSpot Pushed Date',  type: 'string', fieldType: 'text'     },
  { name: 'proof_clients',       label: 'Proof Clients',        type: 'string', fieldType: 'textarea' },
  { name: 'portfolio_company',   label: 'Portfolio Company',    type: 'string', fieldType: 'text'     },
  { name: 'portfolio_industry',  label: 'Portfolio Industry',   type: 'string', fieldType: 'text'     },
];

async function createProperty(prop) {
  try {
    await axios.post(
      `${HUBSPOT_BASE_URL}/crm/v3/properties/contacts`,
      {
        name:        prop.name,
        label:       prop.label,
        type:        prop.type,
        fieldType:   prop.fieldType,
        groupName:   'contactinformation',
        description: `Starfish Signal Monitor — ${prop.label}`,
      },
      { headers, timeout: 10000 }
    );
    console.log(`  ✓  Created: ${prop.name}`);
  } catch (err) {
    if (err.response?.status === 409) {
      console.log(`  ─  Already exists: ${prop.name} (skipped)`);
    } else {
      const msg = err.response?.data?.message || err.message;
      console.error(`  ✗  Failed: ${prop.name} — ${msg}`);
    }
  }
}

async function run() {
  console.log('\n─────────────────────────────────────────────────────');
  console.log('HUBSPOT PROPERTY SETUP');
  console.log(`Creating ${PROPERTIES.length} custom contact properties...`);
  console.log('─────────────────────────────────────────────────────\n');

  for (const prop of PROPERTIES) {
    await createProperty(prop);
  }

  console.log('\n─────────────────────────────────────────────────────');
  console.log('Done. Now run: node scripts/test_hubspot.js');
  console.log('─────────────────────────────────────────────────────\n');
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
