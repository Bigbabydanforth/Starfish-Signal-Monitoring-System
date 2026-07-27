/**
 * scripts/test_job_change.js
 *
 * Test: Job Change signal → Airtable + HubSpot
 * AB Group : claude | Send Day : 1
 *
 * USAGE:
 *   node scripts/test_job_change.js
 *
 * Delete Airtable + HubSpot test records manually when done.
 */

import 'dotenv/config';
import { createRecords } from '../execution/utils/airtable_client.js';
import { pushSignalToHubSpot } from '../hubspot/pushSignalToHubSpot.js';

const TODAY = new Date().toISOString().split('T')[0];

const SIGNAL = {
  type:          'Job Change',
  signal_type:   'Job Change',
  priority:      'HIGH',
  brief:         'Camille James recently joined Hartwell Group as Chief Marketing Officer. A newly appointed CMO at a $95M professional services firm is a high-value brand strategy signal — new marketing leadership almost always triggers a brand review in the first quarter.',
  contact_approach: 'Reach out to Camille directly and open with Starfish\'s experience helping professional services firms reposition after leadership transitions.',
  source:        'Apollo',
  source_url:    'https://linkedin.com/in/camillejames',
  detected_date: TODAY,
  bespoke:       false,
  bespoke_reason: '',
  company: {
    name:           'Hartwell Group',
    industry:       'Professional Services',
    website:        'https://hartwellgroup.com',
    employee_count: 390,
    revenue:        95000000,
    headquarters:   { city: 'Charlotte', state: 'NC', country: 'United States' },
  },
  person: {
    first_name:   'Camille',
    last_name:    'James',
    title:        'Chief Marketing Officer',
    email:        'lilycamillejames@gmail.com',
    linkedin_url: 'https://linkedin.com/in/camillejames',
    job_started_at: '2026-07',
  },
};

const CONTACT = {
  name:         'Camille James',
  first_name:   'Camille',
  last_name:    'James',
  email:        'lilycamillejames@gmail.com',
  title:        'Chief Marketing Officer',
  linkedin_url: 'https://linkedin.com/in/camillejames',
  send_day:     1,
  email_source: 'Apollo',
  abGroup:      'claude',
};

const AIRTABLE_RECORD = {
  fields: {
    'Company Name':    'Hartwell Group',
    'Signal Type':     'Job Change',
    'Signal Details':  'Camille James joined as Chief Marketing Officer at Hartwell Group (Charlotte, NC). New CMO hire detected via Apollo.',
    'Contact Info':    'Name: Camille James\nTitle: Chief Marketing Officer\nLinkedIn: https://linkedin.com/in/camillejames\nEmail: lilycamillejames@gmail.com',
    'LinkedIn URL':    'https://linkedin.com/in/camillejames',
    'Company Revenue': 95000000,
    'Industry':        'Professional Services',
    'Date Detected':   TODAY,
    'Priority':        'HIGH',
    'Brief':           'Camille James recently joined Hartwell Group as Chief Marketing Officer. A newly appointed CMO at a $95M professional services firm is a high-value brand strategy signal — new marketing leadership almost always triggers a brand review in the first quarter.',
    'Contact Approach': 'Reach out to Camille directly and open with Starfish\'s experience helping professional services firms reposition after leadership transitions.',
    'Source URL':      'https://linkedin.com/in/camillejames',
    'Status':          'New',
    'Email Verified':  'Verified',
    'Send Day':        1,
    'Bespoke':         false,
    'Bespoke Reason':  '',
    'AB Test Group':   'claude',
    'Claude Generated': false,
  }
};

async function run() {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  TEST: Job Change — Camille James');
  console.log('  AB Group  : claude');
  console.log('  Send Day  : 1');
  console.log('  Email     : lilycamillejames@gmail.com');
  console.log('══════════════════════════════════════════════════════\n');

  // Step 1: Airtable
  console.log('── Step 1: Saving to Airtable...');
  let airtableRecordId = null;
  try {
    const created = await createRecords([AIRTABLE_RECORD]);
    airtableRecordId = created?.[0]?.id || null;
    console.log(`✅  Airtable: ${airtableRecordId}`);
  } catch (err) {
    console.error(`❌  Airtable failed: ${err.message}`);
  }

  // Step 2: HubSpot (claude group — 7 personalised emails will be generated)
  console.log('\n── Step 2: Pushing to HubSpot (generating Claude emails)...');
  const result = await pushSignalToHubSpot({ ...SIGNAL, airtableRecordId }, CONTACT, airtableRecordId);

  console.log('\n══════════════════════════════════════════════════════');
  if (result.success) {
    console.log(`✅  HubSpot SUCCESS — contact ${result.contactId}`);
    console.log(`    Reason : ${result.reason || 'enrolled / staged'}`);
  } else {
    console.log(`❌  HubSpot FAILED — ${result.error || result.reason}`);
  }
  console.log('══════════════════════════════════════════════════════\n');
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
