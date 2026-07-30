/**
 * fix_hubspot_recent_duplicates.js
 *
 * Finds HubSpot contacts pushed by our system in the last 7 days
 * (hubspot_pushed_date is set within the last 7 days) that have been
 * enrolled in more than one sequence, and unenrolls the extra enrollments,
 * keeping only the most recent one.
 *
 * Excludes manually enrolled contacts (law firms etc.) with no hubspot_pushed_date.
 *
 * Run with:
 *   node --env-file=.env scripts/fix_hubspot_recent_duplicates.js           (preview)
 *   node --env-file=.env scripts/fix_hubspot_recent_duplicates.js --live    (unenroll extras)
 *   node --env-file=.env scripts/fix_hubspot_recent_duplicates.js --days=14 (extend window)
 */

import 'dotenv/config';
import axios from 'axios';

const TOKEN    = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
const BASE_URL = 'https://api.hubapi.com';
const LIVE     = process.argv.includes('--live');

// --days=N override (default 7)
const daysArg  = process.argv.find(a => a.startsWith('--days='));
const DAYS     = daysArg ? parseInt(daysArg.split('=')[1], 10) : 7;

if (!TOKEN) {
  console.error('HUBSPOT_PRIVATE_APP_TOKEN not set in .env');
  process.exit(1);
}

const headers = {
  Authorization:  `Bearer ${TOKEN}`,
  'Content-Type': 'application/json',
};

// Calculate cutoff date (YYYY-MM-DD)
const cutoff = new Date();
cutoff.setDate(cutoff.getDate() - DAYS);
const cutoffStr = cutoff.toISOString().split('T')[0];

async function get(url, params = {}) {
  const res = await axios.get(url, { headers, params, timeout: 15000 });
  return res.data;
}

async function del(url) {
  await axios.delete(url, { headers, timeout: 15000 });
}

// Contacts pushed by our pipeline in the last N days with more than one enrollment.
// hubspot_pushed_date is only set by pushSignalToHubSpot.js — reliably excludes
// manually enrolled law-firm contacts.
async function fetchRecentMultiEnrolled(after = null) {
  const body = {
    filterGroups: [{
      filters: [
        { propertyName: 'hubspot_pushed_date',         operator: 'HAS_PROPERTY' },
        { propertyName: 'hubspot_pushed_date',         operator: 'GTE', value: cutoffStr },
        { propertyName: 'hs_sequences_enrolled_count', operator: 'GT',  value: '1' },
      ],
    }],
    properties: [
      'email', 'firstname', 'lastname', 'company',
      'hs_sequences_enrolled_count', 'hs_sequences_is_enrolled',
      'hubspot_pushed_date', 'ab_test_group', 'signal_data',
    ],
    limit: 100,
    ...(after ? { after } : {}),
  };
  const res = await axios.post(`${BASE_URL}/crm/v3/objects/contacts/search`, body, { headers, timeout: 15000 });
  return res.data;
}

// All sequence enrollments for a contact
async function getEnrollments(contactId) {
  try {
    const data = await get(`${BASE_URL}/automation/v4/sequences/enrollments`, { contactId });
    return data.results || [];
  } catch (err) {
    if (err.response?.status === 404) return [];
    throw err;
  }
}

async function unenroll(enrollmentId) {
  await del(`${BASE_URL}/automation/v4/sequences/enrollments/${enrollmentId}`);
}

async function run() {
  console.log('────────────────────────────────────────────────────────────');
  console.log('FIX RECENT DUPLICATE SEQUENCE ENROLLMENTS');
  console.log(`Scope : Pipeline contacts pushed in last ${DAYS} days (since ${cutoffStr})`);
  console.log('Filter: hubspot_pushed_date is set + hs_sequences_enrolled_count > 1');
  console.log(`Mode  : ${LIVE ? 'LIVE (will unenroll extras)' : 'PREVIEW (no changes)'}`);
  console.log('────────────────────────────────────────────────────────────\n');

  const contacts = [];
  let after = null;
  let page  = 1;

  try {
    while (true) {
      const data = await fetchRecentMultiEnrolled(after);
      contacts.push(...data.results);
      console.log(`  Fetched page ${page} — ${data.results.length} contacts (total: ${contacts.length})`);
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

  if (contacts.length === 0) {
    console.log(`\nNo pipeline contacts pushed in the last ${DAYS} days with multiple enrollments.`);
    return;
  }

  console.log(`\nFound ${contacts.length} contact(s) with duplicate enrollments. Checking each...\n`);

  let totalUnenrolled = 0;
  let totalFailed     = 0;
  let totalNoAction   = 0;

  for (const contact of contacts) {
    const p          = contact.properties;
    const email      = p.email    || '(no email)';
    const name       = [p.firstname, p.lastname].filter(Boolean).join(' ') || '—';
    const company    = p.company  || '—';
    const totalCount = p.hs_sequences_enrolled_count || '?';
    const isActive   = p.hs_sequences_is_enrolled === 'true';
    const pushedDate = p.hubspot_pushed_date || '—';
    const signalType = p.signal_data || '—';

    let enrollments;
    try {
      enrollments = await getEnrollments(contact.id);
      await new Promise(r => setTimeout(r, 250));
    } catch (err) {
      console.log(`  ⚠️  ${email} — could not fetch enrollments: ${err.response?.data?.message || err.message}`);
      totalNoAction++;
      continue;
    }

    if (enrollments.length <= 1) {
      // Only 1 active enrollment despite count > 1 — rest are completed/inactive
      totalNoAction++;
      continue;
    }

    // Sort oldest → newest by enrolledAt
    enrollments.sort((a, b) => new Date(a.enrolledAt || 0) - new Date(b.enrolledAt || 0));

    const keeper = enrollments[enrollments.length - 1]; // most recent
    const extras = enrollments.slice(0, -1);            // everything older

    console.log(`  ${email} — ${name} [${company}]`);
    console.log(`    Signal: ${signalType} | pushed: ${pushedDate} | enrolled ${totalCount}x | active: ${isActive}`);
    console.log(`    KEEP   : enrollment ${keeper.id} → seq ${keeper.sequenceId} (${keeper.enrolledAt || 'unknown date'})`);

    for (const e of extras) {
      console.log(`    ${LIVE ? 'UNENROLL' : 'WOULD UNENROLL'}: enrollment ${e.id} → seq ${e.sequenceId} (${e.enrolledAt || 'unknown date'}) state:${e.state || 'unknown'}`);

      if (LIVE) {
        try {
          await unenroll(e.id);
          totalUnenrolled++;
          await new Promise(r => setTimeout(r, 300));
        } catch (err) {
          if (err.response?.status === 404) {
            console.log(`    ↳ Already unenrolled (404)`);
            totalUnenrolled++;
          } else {
            console.log(`    ✗ Failed: ${err.response?.data?.message || err.message}`);
            totalFailed++;
          }
        }
      } else {
        totalUnenrolled++;
      }
    }
    console.log();
  }

  console.log('────────────────────────────────────────────────────────────');
  if (LIVE) {
    console.log(`Unenrolled  : ${totalUnenrolled}`);
    console.log(`Failed      : ${totalFailed}`);
    console.log(`No action   : ${totalNoAction} (only 1 active enrollment, rest completed)`);
  } else {
    console.log(`Would unenroll: ${totalUnenrolled}`);
    console.log(`No action needed: ${totalNoAction} (only 1 active enrollment, rest completed)`);
    console.log('\nRun with --live to apply.');
  }
  console.log('────────────────────────────────────────────────────────────');
}

run();
