/**
 * hubspot/sequenceRouting.js
 *
 * Routing table: signal type + A/B group → sequence ID + sender.
 * Separated from pushSignalToHubSpot.js so routing can change (new signal
 * types, sender reassignments) without touching the push mechanics.
 *
 * getSequenceRoute(signalType, abGroup)
 *   Returns { sequenceId, ownerId, ownerEmail } for the given combination.
 *   Returns null if the signal type is not in the table.
 *   sequenceId will be null if the env var is not yet set — caller must check.
 *
 * validateRoutingTable()
 *   Logs a warning for every missing sequence ID or owner ID.
 *   Does NOT throw — missing IDs produce warnings, not crashes.
 *   Called once at pipeline startup (execution/main.js).
 *
 * SENDER ROUTING (confirmed by Zack, updated 2026-07-22):
 *   David  → Job Change, M&A Activity, Funding
 *   Zack   → Website Visitor
 *   Cole + Andrew (50/50 alternating) → News/Press, Rebrand, Brand Strategy Intent
 *
 * SEQUENCE IDs:
 *   Starfish sequences — confirmed by Zack, all IDs live.
 *   Claude sequences   — shell sequences built in HubSpot; IDs in .env.
 *   Rebrand            — routes to News/Press sequences (same content, different trigger).
 */

import 'dotenv/config';

// ── Sender configs: first name + meeting link ─────────────────────────────────
// Used by substituteTokens() in pushSignalToHubSpot.js to replace
// {{ sender.firstname }} and {{ owner.meetings_link }} in Claude-generated emails.
export const SENDER_CONFIGS = {
  'david@starfishco.com': {
    firstName:   'David',
    meetingLink: 'https://meetings.hubspot.com/david5100/new-business-call-with-dk?uuid=452443d6-b2ec-4bab-8be2-1dbf331f8abd',
  },
  'zack@starfishco.com': {
    firstName:   'Zack',
    meetingLink: 'https://meetings.hubspot.com/zack-kessler/starfish-20-minute-intro-zack?uuid=f8b5da07-35e3-49b2-aeb8-b8a8d353d375',
  },
  'andrew@starfishco.com': {
    firstName:   'Andrew',
    meetingLink: 'https://meetings.hubspot.com/andrew3223/20-minutes-with-andrew?uuid=4d88bcfe-7baf-48b0-83a2-7fcc28c277a4',
  },
  'cole@starfishco.com': {
    firstName:   'Cole',
    meetingLink: 'https://meetings.hubspot.com/cole-straughn?uuid=54b36b98-1e9e-466c-9037-8d38198aec01',
  },
};

/**
 * Returns { firstName, meetingLink } for a given sender email.
 * Falls back to empty strings if the email is not in the config.
 */
export function getSenderConfig(ownerEmail) {
  return SENDER_CONFIGS[ownerEmail] || { firstName: '', meetingLink: '' };
}

// ── Cole / Andrew 50/50 alternating split ────────────────────────────────────
// News/Press and BSI alternate between Cole and Andrew on each call.
// Counter is module-level so it persists across signals in a single pipeline run.
// Resets to 0 on each pipeline restart — that's fine for the 50/50 distribution.
let coleAndrewIndex = 0;

const COLE_ANDREW_SENDERS = [
  {
    email:   process.env.COLE_SENDER_EMAIL   || 'cole@starfishco.com',
    ownerId: process.env.COLE_HUBSPOT_OWNER_ID || null,
  },
  {
    email:   process.env.ANDREW_SENDER_EMAIL   || 'andrew@starfishco.com',
    ownerId: process.env.ANDREW_HUBSPOT_OWNER_ID || null,
  },
];

function getColeAndrewSender() {
  const sender = COLE_ANDREW_SENDERS[coleAndrewIndex % 2];
  coleAndrewIndex++;
  return sender;
}

// ── Routing table ─────────────────────────────────────────────────────────────
// NOTE: News/Press, Rebrand, and BSI use getColeAndrewSender() — this function
// is called at route-lookup time (not at module load), so the alternation is
// correct across signals in a single run.
const STATIC_ROUTING = {
  'Job Change': {
    ownerEmail: process.env.DAVID_SENDER_EMAIL      || 'david@starfishco.com',
    ownerId:    process.env.DAVID_HUBSPOT_OWNER_ID  || null,
    starfish:   process.env.HS_SEQ_JOB_CHANGE_STARFISH || null,
    claude:     process.env.HS_SEQ_JOB_CHANGE_CLAUDE   || null,
  },
  'M&A Activity': {
    ownerEmail: process.env.DAVID_SENDER_EMAIL      || 'david@starfishco.com',
    ownerId:    process.env.DAVID_HUBSPOT_OWNER_ID  || null,
    starfish:   process.env.HS_SEQ_MA_STARFISH || null,
    claude:     process.env.HS_SEQ_MA_CLAUDE   || null,
  },
  'Funding': {
    ownerEmail: process.env.DAVID_SENDER_EMAIL      || 'david@starfishco.com',
    ownerId:    process.env.DAVID_HUBSPOT_OWNER_ID  || null,
    starfish:   process.env.HS_SEQ_FUNDING_STARFISH || null,
    claude:     process.env.HS_SEQ_FUNDING_CLAUDE   || null,
  },
  'Website Visitor': {
    ownerEmail: process.env.ZACK_SENDER_EMAIL      || 'zack@starfishco.com',
    ownerId:    process.env.ZACK_HUBSPOT_OWNER_ID  || null,
    starfish:   process.env.HS_SEQ_WEBSITE_STARFISH || null,
    claude:     process.env.HS_SEQ_WEBSITE_CLAUDE   || null,
  },
};

// Signal types that use the Cole/Andrew 50/50 split — resolved dynamically at lookup time
const COLE_ANDREW_SIGNAL_TYPES = new Set(['News/Press', 'Rebrand', 'Brand Strategy Intent']);
const COLE_ANDREW_SEQ = {
  'News/Press':           { starfish: process.env.HS_SEQ_NEWS_STARFISH,    claude: process.env.HS_SEQ_NEWS_CLAUDE    },
  'Rebrand':              { starfish: process.env.HS_SEQ_NEWS_STARFISH,    claude: process.env.HS_SEQ_NEWS_CLAUDE    },
  'Brand Strategy Intent':{ starfish: process.env.HS_SEQ_BSI_STARFISH,     claude: process.env.HS_SEQ_BSI_CLAUDE     },
};

/**
 * Returns the sequence route for a given signal type and A/B group.
 *
 * @param {string} signalType - e.g. 'Job Change', 'M&A Activity'
 * @param {string} abGroup    - 'starfish' | 'claude'
 * @returns {{ sequenceId: string|null, ownerId: string|null, ownerEmail: string }|null}
 *   null if signalType is not in the routing table.
 *   sequenceId will be null if the env var is not yet set.
 */
export function getSequenceRoute(signalType, abGroup = 'starfish') {
  if (COLE_ANDREW_SIGNAL_TYPES.has(signalType)) {
    const sender = getColeAndrewSender();
    const seqs   = COLE_ANDREW_SEQ[signalType];
    return {
      sequenceId: (abGroup === 'claude' ? seqs?.claude : seqs?.starfish) || null,
      ownerId:    sender.ownerId,
      ownerEmail: sender.email,
    };
  }

  const route = STATIC_ROUTING[signalType];
  if (!route) return null;

  const sequenceId = abGroup === 'claude' ? route.claude : route.starfish;
  return {
    sequenceId:  sequenceId || null,
    ownerId:     route.ownerId,
    ownerEmail:  route.ownerEmail,
  };
}

/**
 * Logs a warning for every missing sequence ID or owner ID.
 * Non-fatal — does not throw.
 * Called once at pipeline startup from execution/main.js.
 */
export function validateRoutingTable() {
  console.log('[Routing] Validating HubSpot sequence routing table...');
  let warnings = 0;

  // Check static routes
  for (const [signalType, route] of Object.entries(STATIC_ROUTING)) {
    if (!route.starfish) {
      console.warn(`[Routing] ⚠️  No Starfish sequence ID for: ${signalType}`);
      warnings++;
    }
    if (!route.claude) {
      console.warn(`[Routing] ⚠️  No Claude sequence ID for: ${signalType} — shell sequences not built yet`);
      warnings++;
    }
    if (!route.ownerId) {
      console.warn(`[Routing] ⚠️  No owner ID for sender: ${route.ownerEmail}`);
      warnings++;
    }
  }

  // Check Cole/Andrew routes
  for (const [signalType, seqs] of Object.entries(COLE_ANDREW_SEQ)) {
    if (!seqs.starfish) {
      console.warn(`[Routing] ⚠️  No Starfish sequence ID for: ${signalType}`);
      warnings++;
    }
    if (!seqs.claude) {
      console.warn(`[Routing] ⚠️  No Claude sequence ID for: ${signalType} — shell sequences not built yet`);
      warnings++;
    }
  }
  if (!process.env.COLE_HUBSPOT_OWNER_ID) {
    console.warn(`[Routing] ⚠️  No owner ID for Cole (COLE_HUBSPOT_OWNER_ID not set)`);
    warnings++;
  }
  if (!process.env.ANDREW_HUBSPOT_OWNER_ID) {
    console.warn(`[Routing] ⚠️  No owner ID for Andrew (ANDREW_HUBSPOT_OWNER_ID not set)`);
    warnings++;
  }

  if (warnings === 0) {
    console.log('[Routing] ✓ All sequence IDs and owner IDs confirmed');
  } else {
    console.warn(`[Routing] ${warnings} warning(s) — contacts without a sequence ID will be skipped at enrollment`);
  }
}
