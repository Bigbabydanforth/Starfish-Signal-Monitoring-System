/**
 * scripts/test_sender_fix.js
 *
 * Unit tests for the sender meeting-link fix.
 * Tests assembleProspectData() and generateClaudeEmails() without calling Claude.
 * All assertions must pass (exit code 0) before running fix_existing_emails.js.
 *
 * Run: node --env-file=.env scripts/test_sender_fix.js
 */

import { assembleProspectData, generateClaudeEmails } from '../hubspot/generateClaudeEmails.js';
import { SENDER_CONFIGS, getSequenceRoute } from '../hubspot/sequenceRouting.js';

let passed = 0;
let failed = 0;

function assert(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ [${passed + failed + 1}] ${label}`);
    passed++;
  } else {
    console.error(`  ✗ [${passed + failed + 1}] ${label}`);
    if (detail) console.error(`       → ${detail}`);
    failed++;
  }
}

// ── Sample data ───────────────────────────────────────────────────────────────
const sampleSignal = {
  type:           'Brand Strategy Intent',
  signal_type:    'Brand Strategy Intent',
  company_name:   'Acme Corp',
  company:        { name: 'Acme Corp', industry: 'Technology', website: 'https://acme.com' },
  industry:       'Technology',
  brief:          'Acme Corp is actively researching brand strategy.',
  signal_details: 'BSI signal detected.',
};

const sampleContact = {
  name:       'Jane Smith',
  firstName:  'Jane',
  first_name: 'Jane',
  lastName:   'Smith',
  last_name:  'Smith',
  title:      'CMO',
  email:      'jane@acme.com',
};

const andrewSender = {
  name:        'Andrew',
  email:       process.env.ANDREW_SENDER_EMAIL || 'andrew@starfishco.com',
  meetingLink: process.env.ANDREW_MEETING_LINK || SENDER_CONFIGS['andrew@starfishco.com']?.meetingLink || null,
};

const coleSender = {
  name:        'Cole',
  email:       process.env.COLE_SENDER_EMAIL || 'cole@starfishco.com',
  meetingLink: process.env.COLE_MEETING_LINK || SENDER_CONFIGS['cole@starfishco.com']?.meetingLink || null,
};

// ── Run tests ─────────────────────────────────────────────────────────────────
console.log('\n════════════════════════════════════════════════════════════');
console.log('SENDER FIX — UNIT TESTS');
console.log('════════════════════════════════════════════════════════════\n');

// Test 1: assembleProspectData includes the real meeting link when sender is provided
const prospectWithAndrew = assembleProspectData(sampleSignal, sampleContact, andrewSender);
assert(
  'assembleProspectData includes Andrew\'s meeting link when sender is passed',
  andrewSender.meetingLink && prospectWithAndrew.includes(andrewSender.meetingLink),
  `Expected to find: ${andrewSender.meetingLink}\nIn output: ${prospectWithAndrew.slice(-300)}`
);

// Test 2: assembleProspectData with Cole's sender includes Cole's link (not Andrew's)
const prospectWithCole = assembleProspectData(sampleSignal, sampleContact, coleSender);
assert(
  'assembleProspectData includes Cole\'s meeting link and NOT Andrew\'s when Cole is sender',
  coleSender.meetingLink &&
  prospectWithCole.includes(coleSender.meetingLink) &&
  (!andrewSender.meetingLink || !prospectWithCole.includes(andrewSender.meetingLink)),
  `Cole link present: ${prospectWithCole.includes(coleSender.meetingLink)}, Andrew link absent: ${!prospectWithCole.includes(andrewSender.meetingLink)}`
);

// Test 3: assembleProspectData with no sender includes fallback "not provided" text
const prospectNoSender = assembleProspectData(sampleSignal, sampleContact, null);
assert(
  'assembleProspectData falls back gracefully when sender is null',
  prospectNoSender.includes('not provided') || prospectNoSender.includes('NOT PROVIDED'),
  'Expected "not provided" fallback text'
);

// Test 4: assembleProspectData includes the "Do NOT use" instruction when link is present
assert(
  'assembleProspectData tells Claude not to use {{owner.meetings_link}} token',
  prospectWithAndrew.includes('Do NOT use {{owner.meetings_link}}'),
  'Missing instruction to avoid token'
);

// Test 5: assembleProspectData includes "MEETING BOOKING LINK" section header
assert(
  'assembleProspectData includes MEETING BOOKING LINK section',
  prospectWithAndrew.includes('MEETING BOOKING LINK'),
  'Missing section header'
);

// Test 6: Andrew's link is NOT in Cole's prospect data (links don't bleed across senders)
assert(
  'Cole\'s prospect data does not contain Andrew\'s meeting link',
  !andrewSender.meetingLink || !prospectWithCole.includes(andrewSender.meetingLink),
  'Andrew\'s link leaked into Cole\'s prospect data'
);

// Test 7: SENDER_CONFIGS has all 4 senders with non-empty meeting links
const allSendersHaveLinks = [
  'david@starfishco.com',
  'zack@starfishco.com',
  'andrew@starfishco.com',
  'cole@starfishco.com',
].every(email => {
  const cfg = SENDER_CONFIGS[email];
  return cfg && cfg.meetingLink && cfg.meetingLink.startsWith('https://');
});
assert(
  'SENDER_CONFIGS has valid HTTPS meeting links for all 4 senders',
  allSendersHaveLinks,
  'One or more senders are missing a valid meeting link in SENDER_CONFIGS'
);

// Test 8: env vars for meeting links are set
const envLinksSet = [
  process.env.DAVID_MEETING_LINK,
  process.env.ZACK_MEETING_LINK,
  process.env.ANDREW_MEETING_LINK,
  process.env.COLE_MEETING_LINK,
].every(v => v && v.startsWith('https://'));
assert(
  'All 4 *_MEETING_LINK env vars are set and start with https://',
  envLinksSet,
  `DAVID=${!!process.env.DAVID_MEETING_LINK} ZACK=${!!process.env.ZACK_MEETING_LINK} ANDREW=${!!process.env.ANDREW_MEETING_LINK} COLE=${!!process.env.COLE_MEETING_LINK}`
);

// Test 9: generateClaudeEmails is a function that accepts 3 arguments
assert(
  'generateClaudeEmails is an exported async function',
  typeof generateClaudeEmails === 'function',
  'Not a function'
);
assert(
  'generateClaudeEmails accepts sender as optional 3rd param (Function.length >= 2)',
  generateClaudeEmails.length >= 2,
  `Function.length = ${generateClaudeEmails.length} (expected >= 2 — sender has a default so JS reports 2, not 3)`
);

// Test 10: assembleProspectData HTML example uses the actual URL, not the token
assert(
  'assembleProspectData HTML example uses the real URL, not {{owner.meetings_link}}',
  prospectWithAndrew.includes(`href="${andrewSender.meetingLink}"`) &&
  !prospectWithAndrew.includes('href="{{owner.meetings_link}}"'),
  'HTML example still contains the token instead of the real URL'
);

// Test 11: BSI + claude group → sender must be Cole (permanent rule)
const bsiClaudeRoute = getSequenceRoute('Brand Strategy Intent', 'claude');
const COLE_EMAIL   = process.env.COLE_SENDER_EMAIL   || 'cole@starfishco.com';
assert(
  'BSI + claude → sender is always Cole (not Andrew, not alternating)',
  bsiClaudeRoute?.ownerEmail === COLE_EMAIL,
  `Expected: ${COLE_EMAIL}  Got: ${bsiClaudeRoute?.ownerEmail}`
);

// Test 12: News/Press + claude group → sender must be Andrew (permanent rule)
const newsClaudeRoute = getSequenceRoute('News/Press', 'claude');
const ANDREW_EMAIL = process.env.ANDREW_SENDER_EMAIL || 'andrew@starfishco.com';
assert(
  'News/Press + claude → sender is always Andrew (not Cole, not alternating)',
  newsClaudeRoute?.ownerEmail === ANDREW_EMAIL,
  `Expected: ${ANDREW_EMAIL}  Got: ${newsClaudeRoute?.ownerEmail}`
);

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\n════════════════════════════════════════════════════════════');
console.log(`RESULTS: ${passed} passed, ${failed} failed`);
console.log('════════════════════════════════════════════════════════════\n');

if (failed > 0) {
  console.error(`${failed} test(s) failed — fix the issues above before proceeding.\n`);
  process.exit(1);
} else {
  console.log('All tests passed. Proceed to Test 2.\n');
  process.exit(0);
}
