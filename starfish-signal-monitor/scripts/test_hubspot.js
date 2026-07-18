/**
 * scripts/test_hubspot.js
 *
 * Smoke-tests the HubSpot integration end-to-end using a fake signal.
 * Verifies: token auth → contact upsert → company upsert → association → custom props.
 *
 * USAGE:
 *   node scripts/test_hubspot.js
 *
 * After it runs, search HubSpot CRM for "hubspot-test@starfish-test.io" to confirm
 * the contact, company, and all custom properties. Delete the test record manually when done.
 *
 * This script does NOT touch Airtable or run any pipeline workflows.
 */

import 'dotenv/config';
import { pushSignalToHubSpot } from '../hubspot/pushSignalToHubSpot.js';

// ── Fake signal ───────────────────────────────────────────────────────────────
const TEST_SIGNAL = {
  type:           'Job Change',
  signal_type:    'Job Change',
  priority:       'HIGH',
  brief:          'Sarah Chen joined Nike as VP of Marketing. Strong brand budget signal — Nike is actively building out their marketing leadership.',
  source:         'PDL',
  date_detected:  new Date().toISOString().split('T')[0],
  company: {
    name:           'Nike',
    industry:       'Retail',
    website:        'https://nike.com',
    employee_count: 79000,
    revenue:        51000000000,
  },
};

// ── Fake contact ──────────────────────────────────────────────────────────────
const TEST_CONTACT = {
  name:         'Sarah Chen',
  email:        'hubspot-test@starfish-test.io',
  title:        'VP of Marketing',
  send_day:     1,
  email_source: 'Apollo',
};

// ── Run ───────────────────────────────────────────────────────────────────────
async function run() {
  console.log('\n─────────────────────────────────────────────────────');
  console.log('HUBSPOT INTEGRATION TEST');
  console.log('─────────────────────────────────────────────────────\n');

  const token = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
  if (!token) {
    console.error('❌  HUBSPOT_PRIVATE_APP_TOKEN is not set in .env — aborting');
    process.exit(1);
  }
  console.log(`✓  Token loaded: ${token.slice(0, 12)}...`);
  console.log('\nPushing test signal...\n');

  const result = await pushSignalToHubSpot(TEST_SIGNAL, TEST_CONTACT);

  console.log('\n─────────────────────────────────────────────────────');
  if (result.success && result.contactId) {
    console.log(`✅  SUCCESS`);
    console.log(`    Contact ID:  ${result.contactId}`);
    console.log(`    Signal type: ${result.signalType}`);
    console.log(`    Route:       ${result.route ? JSON.stringify(result.route) : 'none (sequence IDs not set yet)'}`);
    console.log('\n→ Verify in HubSpot CRM:');
    console.log('  1. Search contacts for: hubspot-test@starfish-test.io');
    console.log('  2. Confirm custom properties are set (signal_type, signal_brief, proof_clients, etc.)');
    console.log('  3. Confirm company "Nike" is linked');
    console.log('  4. Delete the test contact + company manually when done.');
  } else if (result.reason === 'already_exists') {
    console.log('✅  Contact already existed — updated in place');
  } else {
    console.log(`❌  Failed: ${result.error || result.reason}`);
  }
  console.log('─────────────────────────────────────────────────────\n');
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
