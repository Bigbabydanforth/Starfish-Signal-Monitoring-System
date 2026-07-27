/**
 * scripts/test_all_signals.js
 *
 * Pushes one fake test record to Airtable + HubSpot for each signal type.
 * AB Group : claude | Send Day : 1
 *
 *   - Job Change            → Camille James       lilycamillejames@gmail.com
 *   - M&A Activity          → Marie Duenas        duenasmarie41@gmail.com
 *   - News/Press            → Tyler Brooks        awtuyitobiloba@gmail.com
 *   - Funding               → Becky Diamond       sweetbeckydiamond@gmail.com
 *   - Website Visitor       → Howard Blanding     awotuyitobiloba@hotmail.com
 *   - Brand Strategy Intent → Ashley Morgan       awotuyifunmilayo@gmail.com
 *
 * USAGE:
 *   node scripts/test_all_signals.js
 *
 * Delete all test records from Airtable + HubSpot manually when done.
 */

import 'dotenv/config';
import { createRecords } from '../execution/utils/airtable_client.js';
import { pushSignalToHubSpot } from '../hubspot/pushSignalToHubSpot.js';

const TODAY = new Date().toISOString().split('T')[0];

const TESTS = [
  // ── Job Change ───────────────────────────────────────────────────────────────
  {
    label: 'Job Change — Camille James',
    signal: {
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
    },
    contact: {
      name:         'Camille James',
      first_name:   'Camille',
      last_name:    'James',
      email:        'lilycamillejames@gmail.com',
      title:        'Chief Marketing Officer',
      send_day:     1,
      email_source: 'Apollo',
      abGroup:      'claude',
    },
    airtable: {
      'Company Name':    'Hartwell Group',
      'Signal Type':     'Job Change',
      'Signal Details':  'Camille James joined as Chief Marketing Officer at Hartwell Group (Charlotte, NC). New CMO hire detected via Apollo.',
      'Contact Info':    'Name: Camille James\nTitle: Chief Marketing Officer\nLinkedIn: https://linkedin.com/in/camillejames\nEmail: lilycamillejames@gmail.com',
      'LinkedIn URL':    'https://linkedin.com/in/camillejames',
      'Company Revenue': 95000000,
      'Industry':        'Professional Services',
      'Date Detected':   TODAY,
      'Priority':        'HIGH',
      'Brief':           'Camille James recently joined Hartwell Group as Chief Marketing Officer. A newly appointed CMO at a $95M professional services firm is a high-value brand strategy signal.',
      'Contact Approach': 'Reach out to Camille directly and open with Starfish\'s experience helping professional services firms reposition after leadership transitions.',
      'Source URL':      'https://linkedin.com/in/camillejames',
      'Status':          'New',
      'Email Verified':  'Verified',
      'Send Day':        1,
      'Bespoke':         false,
      'Bespoke Reason':  '',
      'AB Test Group':   'claude',
      'Claude Generated': false,
    },
  },

  // ── M&A Activity ─────────────────────────────────────────────────────────────
  {
    label: 'M&A Activity — Marie Duenas',
    signal: {
      type:          'M&A Activity',
      signal_type:   'M&A Activity',
      priority:      'HIGH',
      brief:         'Sterling Pacific Holdings is acquiring Redwood Ventures in a $275M deal. Post-acquisition brand integration is a near-certain requirement — two legacy brands merging under one roof almost always demands a full brand strategy overhaul.',
      contact_approach: 'Reach out to Marie Duenas and lead with Starfish\'s post-acquisition brand integration experience for deals in the $200M–$500M range.',
      source:        'PredictLeads',
      source_url:    'https://predictleads.com',
      detected_date: TODAY,
      bespoke:       false,
      bespoke_reason: '',
      company: {
        name:           'Sterling Pacific Holdings',
        industry:       'Financial Services',
        website:        'https://sterlingpacificholdings.com',
        employee_count: 720,
        revenue:        185000000,
        headquarters:   { city: 'Seattle', state: 'WA', country: 'United States' },
      },
      deal: {
        type:   'acquires',
        seller: 'Redwood Ventures',
        amount: 275000000,
      },
    },
    contact: {
      name:         'Marie Duenas',
      first_name:   'Marie',
      last_name:    'Duenas',
      email:        'duenasmarie41@gmail.com',
      title:        'Chief Executive Officer',
      send_day:     1,
      email_source: 'Apollo',
      abGroup:      'claude',
    },
    airtable: {
      'Company Name':    'Sterling Pacific Holdings',
      'Signal Type':     'M&A Activity',
      'Signal Details':  'ACQUIRES: Sterling Pacific Holdings acquiring Redwood Ventures. Deal value: $275,000,000.',
      'Contact Info':    'Name: Marie Duenas\nTitle: Chief Executive Officer\nEmail: duenasmarie41@gmail.com',
      'Company Revenue': 185000000,
      'Industry':        'Financial Services',
      'Date Detected':   TODAY,
      'Priority':        'HIGH',
      'Brief':           'Sterling Pacific Holdings is acquiring Redwood Ventures in a $275M deal. Post-acquisition brand integration is a near-certain requirement.',
      'Contact Approach': 'Reach out to Marie Duenas and lead with Starfish\'s post-acquisition brand integration experience for deals in the $200M–$500M range.',
      'Source URL':      'https://predictleads.com',
      'Status':          'New',
      'Email Verified':  'Verified',
      'Send Day':        1,
      'Bespoke':         false,
      'Bespoke Reason':  '',
      'AB Test Group':   'claude',
      'Claude Generated': false,
    },
  },

  // ── News/Press ───────────────────────────────────────────────────────────────
  {
    label: 'News/Press — Tyler Brooks',
    signal: {
      type:          'News/Press',
      signal_type:   'News/Press',
      priority:      'MEDIUM',
      brief:         'Cascade Communications announced a major strategic pivot into enterprise software, signalling a brand identity mismatch — their current positioning as a telecoms provider no longer reflects their direction. This is a prime moment for a brand repositioning conversation.',
      contact_approach: 'Reach out to Tyler Brooks and reference the strategic pivot announcement — position Starfish as the firm that helps companies realign brand identity when the business direction changes.',
      source:        'MediaStack',
      source_url:    'https://mediastack.com',
      detected_date: TODAY,
      bespoke:       false,
      bespoke_reason: '',
      company: {
        name:           'Cascade Communications',
        industry:       'Telecommunications',
        website:        'https://cascadecomms.com',
        employee_count: 510,
        revenue:        88000000,
        headquarters:   { city: 'Denver', state: 'CO', country: 'United States' },
      },
      article: {
        title:        'Cascade Communications Announces Strategic Pivot to Enterprise Software',
        description:  'The company revealed plans to shift its core business focus amid growing demand for integrated enterprise solutions.',
        source:       'Business Wire',
        published_at: TODAY,
      },
    },
    contact: {
      name:         'Tyler Brooks',
      first_name:   'Tyler',
      last_name:    'Brooks',
      email:        'awtuyitobiloba@gmail.com',
      title:        'Chief Marketing Officer',
      send_day:     1,
      email_source: 'Apollo',
      abGroup:      'claude',
    },
    airtable: {
      'Company Name':    'Cascade Communications',
      'Signal Type':     'News/Press',
      'Signal Details':  'Cascade Communications Announces Strategic Pivot to Enterprise Software. The company revealed plans to shift its core business focus amid growing demand for integrated enterprise solutions. (Published by Business Wire)',
      'Contact Info':    'Name: Tyler Brooks\nTitle: Chief Marketing Officer\nEmail: awtuyitobiloba@gmail.com',
      'Company Revenue': 88000000,
      'Industry':        'Telecommunications',
      'Date Detected':   TODAY,
      'Priority':        'MEDIUM',
      'Brief':           'Cascade Communications announced a major strategic pivot into enterprise software — their current positioning no longer reflects their direction. Prime moment for a brand repositioning conversation.',
      'Contact Approach': 'Reach out to Tyler Brooks and reference the strategic pivot announcement — position Starfish as the firm that helps companies realign brand identity when the business direction changes.',
      'Source URL':      'https://mediastack.com',
      'Status':          'New',
      'Email Verified':  'Verified',
      'Send Day':        1,
      'Bespoke':         false,
      'Bespoke Reason':  '',
      'AB Test Group':   'claude',
      'Claude Generated': false,
    },
  },

  // ── Funding ──────────────────────────────────────────────────────────────────
  {
    label: 'Funding — Becky Diamond',
    signal: {
      type:          'Funding',
      signal_type:   'Funding',
      priority:      'HIGH',
      brief:         'Meridian Health Solutions closed a $60M Series B led by General Atlantic. Post-funding brand elevation is a well-documented pattern — companies at this stage use new capital to reposition from scrappy startup to credible enterprise brand.',
      contact_approach: 'Reach out to Becky Diamond and open with Starfish\'s track record helping health tech companies use post-funding momentum to build a brand that attracts enterprise health systems.',
      source:        'PredictLeads',
      source_url:    'https://predictleads.com',
      detected_date: TODAY,
      bespoke:       false,
      bespoke_reason: '',
      company: {
        name:           'Meridian Health Solutions',
        industry:       'Healthcare',
        website:        'https://meridianhealthsolutions.com',
        employee_count: 260,
        revenue:        54000000,
        funding_stage:  'Series B',
        headquarters:   { city: 'Nashville', state: 'TN', country: 'United States' },
      },
      article: {
        title:        'Meridian Health Solutions Raises $60M Series B to Expand Platform',
        description:  'General Atlantic led the round with participation from existing investors.',
        source:       'TechCrunch',
        published_at: TODAY,
      },
    },
    contact: {
      name:         'Becky Diamond',
      first_name:   'Becky',
      last_name:    'Diamond',
      email:        'sweetbeckydiamond@gmail.com',
      title:        'Chief Marketing Officer',
      send_day:     1,
      email_source: 'Apollo',
      abGroup:      'claude',
    },
    airtable: {
      'Company Name':    'Meridian Health Solutions',
      'Signal Type':     'Funding',
      'Signal Details':  'Meridian Health Solutions Raises $60M Series B to Expand Platform. General Atlantic led the round with participation from existing investors. (Published by TechCrunch)',
      'Contact Info':    'Name: Becky Diamond\nTitle: Chief Marketing Officer\nEmail: sweetbeckydiamond@gmail.com',
      'Company Revenue': 54000000,
      'Company Funding Stage': 'Series B',
      'Industry':        'Healthcare',
      'Date Detected':   TODAY,
      'Priority':        'HIGH',
      'Brief':           'Meridian Health Solutions closed a $60M Series B led by General Atlantic. Companies at this stage use new capital to reposition from scrappy startup to credible enterprise brand.',
      'Contact Approach': 'Reach out to Becky Diamond and open with Starfish\'s track record helping health tech companies use post-funding momentum to build a brand that attracts enterprise health systems.',
      'Source URL':      'https://predictleads.com',
      'Status':          'New',
      'Email Verified':  'Verified',
      'Send Day':        1,
      'Bespoke':         false,
      'Bespoke Reason':  '',
      'AB Test Group':   'claude',
      'Claude Generated': false,
    },
  },

  // ── Website Visitor ──────────────────────────────────────────────────────────
  {
    label: 'Website Visitor — Howard Blanding',
    signal: {
      type:          'Website Visitor',
      signal_type:   'Website Visitor',
      priority:      'HIGH',
      brief:         'Apex Consulting Group visited the Starfish website — a high-intent signal indicating active brand strategy evaluation. Website visitors are warm leads who have already shown interest by seeking out Starfish directly.',
      contact_approach: 'Reach out to Howard Blanding immediately — this is a warm signal. Lead with the fact that Starfish works exclusively with consulting and advisory firms at the $50M+ revenue tier.',
      source:        'AudienceLab',
      source_url:    'https://api.audiencelab.io',
      detected_date: TODAY,
      bespoke:       false,
      bespoke_reason: '',
      company: {
        name:           'Apex Consulting Group',
        industry:       'Management Consulting',
        website:        'https://apexconsultinggroup.com',
        employee_count: 430,
        revenue:        72000000,
        headquarters:   { city: 'Phoenix', state: 'AZ', country: 'United States' },
      },
      person: {
        first_name:   'Howard',
        last_name:    'Blanding',
        title:        'VP of Marketing',
        email:        'awotuyitobiloba@hotmail.com',
        linkedin_url: 'https://linkedin.com/in/howardblanding',
      },
    },
    contact: {
      name:         'Howard Blanding',
      first_name:   'Howard',
      last_name:    'Blanding',
      email:        'awotuyitobiloba@hotmail.com',
      title:        'VP of Marketing',
      send_day:     1,
      email_source: 'AudienceLab',
      abGroup:      'claude',
    },
    airtable: {
      'Company Name':    'Apex Consulting Group',
      'Signal Type':     'Website Visitor',
      'Signal Details':  'Apex Consulting Group visited the Starfish website. VP of Marketing detected via AudienceLab SuperPixel.',
      'Contact Info':    'Name: Howard Blanding\nTitle: VP of Marketing\nLinkedIn: https://linkedin.com/in/howardblanding\nEmail: awotuyitobiloba@hotmail.com',
      'LinkedIn URL':    'https://linkedin.com/in/howardblanding',
      'Company Revenue': 72000000,
      'Industry':        'Management Consulting',
      'Date Detected':   TODAY,
      'Priority':        'HIGH',
      'Brief':           'Apex Consulting Group visited the Starfish website — a high-intent signal indicating active brand strategy evaluation.',
      'Contact Approach': 'Reach out to Howard Blanding immediately — this is a warm signal. Lead with the fact that Starfish works exclusively with consulting and advisory firms at the $50M+ revenue tier.',
      'Source URL':      'https://api.audiencelab.io',
      'Status':          'New',
      'Email Verified':  'Verified',
      'Send Day':        1,
      'Bespoke':         false,
      'Bespoke Reason':  '',
      'AB Test Group':   'claude',
      'Claude Generated': false,
    },
  },

  // ── Brand Strategy Intent ────────────────────────────────────────────────────
  {
    label: 'Brand Strategy Intent — Ashley Morgan',
    signal: {
      type:          'Brand Strategy Intent',
      signal_type:   'Brand Strategy Intent',
      priority:      'HIGH',
      brief:         'Rockford Strategy Partners is actively researching brand strategy topics online — flagged by AudienceLab intent data. Active intent research at a $65M strategy firm strongly suggests they are evaluating a brand investment in the near term.',
      contact_approach: 'Reach out to Ashley Morgan and lead with Starfish\'s experience helping strategy and advisory firms build brands that command premium positioning in their market.',
      source:        'AudienceLab',
      source_url:    'https://api.audiencelab.io',
      detected_date: TODAY,
      bespoke:       false,
      bespoke_reason: '',
      company: {
        name:           'Rockford Strategy Partners',
        industry:       'Management Consulting',
        website:        'https://rockfordstrategy.com',
        employee_count: 210,
        revenue:        65000000,
        headquarters:   { city: 'Minneapolis', state: 'MN', country: 'United States' },
      },
      person: {
        first_name:   'Ashley',
        last_name:    'Morgan',
        title:        'Chief Marketing Officer',
        email:        'awotuyifunmilayo@gmail.com',
        linkedin_url: 'https://linkedin.com/in/ashleymorgan',
      },
    },
    contact: {
      name:         'Ashley Morgan',
      first_name:   'Ashley',
      last_name:    'Morgan',
      email:        'awotuyifunmilayo@gmail.com',
      title:        'Chief Marketing Officer',
      send_day:     1,
      email_source: 'AudienceLab',
      abGroup:      'claude',
    },
    airtable: {
      'Company Name':    'Rockford Strategy Partners',
      'Signal Type':     'Brand Strategy Intent',
      'Signal Details':  'Rockford Strategy Partners is actively researching brand strategy topics online — flagged by AudienceLab intent data. Industry: Management Consulting. This indicates active evaluation of branding services — not just passive interest.',
      'Contact Info':    'Name: Ashley Morgan\nTitle: Chief Marketing Officer\nLinkedIn: https://linkedin.com/in/ashleymorgan\nEmail: awotuyifunmilayo@gmail.com',
      'LinkedIn URL':    'https://linkedin.com/in/ashleymorgan',
      'Company Revenue': 65000000,
      'Industry':        'Management Consulting',
      'Date Detected':   TODAY,
      'Priority':        'HIGH',
      'Brief':           'Rockford Strategy Partners is actively researching brand strategy topics online. Active intent research at a $65M strategy firm strongly suggests they are evaluating a brand investment in the near term.',
      'Contact Approach': 'Reach out to Ashley Morgan and lead with Starfish\'s experience helping strategy and advisory firms build brands that command premium positioning in their market.',
      'Source URL':      'https://api.audiencelab.io',
      'Status':          'New',
      'Email Verified':  'Verified',
      'Send Day':        1,
      'Bespoke':         false,
      'Bespoke Reason':  '',
      'AB Test Group':   'claude',
      'Claude Generated': false,
    },
  },
];

// ── Run all tests sequentially ────────────────────────────────────────────────
async function run() {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  MULTI-SIGNAL TEST RUN (6 signal types)');
  console.log('  AB Group : claude | Send Day : 1');
  console.log('══════════════════════════════════════════════════════\n');

  for (const test of TESTS) {
    console.log(`\n── ${test.label}`);
    console.log(`   Email: ${test.contact.email}`);

    // Step 1: Airtable
    let airtableRecordId = null;
    try {
      const created = await createRecords([{ fields: test.airtable }]);
      airtableRecordId = created?.[0]?.id || null;
      console.log(`   ✅ Airtable: ${airtableRecordId}`);
    } catch (err) {
      console.error(`   ❌ Airtable failed: ${err.message}`);
    }

    // Step 2: HubSpot (claude — 7 personalised emails generated per contact)
    try {
      const signal = { ...test.signal, airtableRecordId };
      const result = await pushSignalToHubSpot(signal, test.contact, airtableRecordId);
      if (result.success) {
        console.log(`   ✅ HubSpot: contact ${result.contactId} [claude]`);
      } else {
        console.error(`   ❌ HubSpot failed: ${result.error || result.reason}`);
      }
    } catch (err) {
      console.error(`   ❌ HubSpot exception: ${err.message}`);
    }

    // Small delay between pushes to avoid rate limits
    await new Promise(r => setTimeout(r, 800));
  }

  console.log('\n══════════════════════════════════════════════════════');
  console.log('  ALL DONE — check Airtable + HubSpot for all 6');
  console.log('  Delete test records manually when done.');
  console.log('══════════════════════════════════════════════════════\n');
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
