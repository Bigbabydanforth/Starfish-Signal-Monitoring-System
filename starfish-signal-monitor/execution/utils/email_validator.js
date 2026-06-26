/*
 * EMAIL VERIFICATION — June 2026
 *
 * verifyEmail(email, source, apolloStatus) is the single centralised gate for
 * email deliverability. It applies trust-level logic based on where the email
 * came from and Apollo's email_status field, using Hunter only when necessary.
 *
 * Sources and their behaviour:
 *
 *   'apollo'    → Layer 1 is Apollo email_status (free, no extra API call).
 *                 'verified' / 'likely_to_engage' → accept immediately.
 *                 'risky' → run Hunter verifier.
 *                 'unavailable' / null → discard (cascade will try Hunter next).
 *
 *   'hunter'    → Always run Hunter verifier (found email, not confirmed).
 *                 Hunter unavailable → accept but flag (fail open).
 *
 *   'puppeteer' → Always run Hunter verifier (least reliable source).
 *                 Hunter unavailable → discard (fail closed — no email > bad email).
 *
 * Return value: { valid: boolean, flagged: boolean, reason: string }
 *   valid:   true = use this email | false = discard
 *   flagged: true = risky but usable — append [unverified] to contact info
 *   reason:  short string for logging only
 */

import axios from 'axios';
import { getBreaker } from './circuit_breaker.js';
import { sendErrorAlert } from './telegram_client.js';

// Module-level flag — once Hunter quota is confirmed exhausted this run, skip all verify calls.
let _hunterQuotaExhausted = false;

// ── Private helper ─────────────────────────────────────────────────────────────

/**
 * Calls Hunter's /v2/email-verifier endpoint.
 * @returns {'deliverable'|'risky'|'undeliverable'|null}
 *   null means the API call failed or circuit is open — caller decides what to do.
 */
async function runHunterVerifier(email) {
  if (!process.env.HUNTER_API_KEY) return null;
  if (_hunterQuotaExhausted)       return null;
  if (getBreaker('hunter').isOpen()) {
    console.log(`  [Hunter Verifier] ⚡ Circuit open — cannot verify ${email}`);
    return null;
  }

  const call = async () => {
    const res = await axios.get('https://api.hunter.io/v2/email-verifier', {
      params: { email, api_key: process.env.HUNTER_API_KEY },
      timeout: 10000,
    });
    return res;
  };

  let res;
  try {
    res = await call();
  } catch (err) {
    const httpStatus = err.response?.status;

    if (httpStatus === 402) {
      if (!_hunterQuotaExhausted) {
        _hunterQuotaExhausted = true;
        console.error('[Hunter Verifier] ❌ Quota exhausted (402) — verification disabled for this run. Top up at hunter.io.');
        sendErrorAlert('⚠️ Hunter.io quota exhausted (402) — email verification is disabled for today\'s run. Top up credits at hunter.io.').catch(() => {});
      }
      return null;
    }

    if (httpStatus === 401) {
      console.error('[Hunter Verifier] ❌ Unauthorized (401) — check HUNTER_API_KEY');
      return null; // do not trip circuit breaker
    }

    if (httpStatus === 422) {
      console.log(`  [Hunter Verifier] ${email} → undeliverable (422 — invalid format)`);
      await new Promise(r => setTimeout(r, 200));
      return 'undeliverable';
    }

    if (httpStatus === 429) {
      // Exponential backoff: 5s → 15s → 45s (3 attempts total, jitter ±20%)
      for (let attempt = 1; attempt <= 3; attempt++) {
        const baseDelay = 5000 * Math.pow(3, attempt - 1);
        const jitter    = baseDelay * 0.2 * (Math.random() * 2 - 1); // ±20%
        const delay     = Math.round(baseDelay + jitter);
        console.warn(`  [Hunter Verifier] ⏳ Rate limited (429) — waiting ${(delay / 1000).toFixed(1)}s before retry ${attempt}/3 for ${email}...`);
        await new Promise(r => setTimeout(r, delay));
        try {
          res = await call();
          break; // success — fall through to success handling below
        } catch (retryErr) {
          if (retryErr.response?.status === 429 && attempt < 3) continue; // try again
          console.warn(`  [Hunter Verifier] ❌ All retries failed for ${email}: ${retryErr.message}`);
          getBreaker('hunter').recordFailure(retryErr.message);
          await new Promise(r => setTimeout(r, 200));
          return null;
        }
      }
      // fall through to success handling below
    } else {
      getBreaker('hunter').recordFailure(err.message);
      await new Promise(r => setTimeout(r, 200));
      return null;
    }
  }

  // Success path (initial call or after 429 retry)
  try {
    getBreaker('hunter').recordSuccess();
    const rawStatus = res.data?.data?.status;
    // Map Hunter statuses to our canonical values
    let result;
    if (rawStatus === 'deliverable') result = 'deliverable';
    else if (rawStatus === 'undeliverable') result = 'undeliverable';
    else result = 'risky'; // 'risky', 'unknown', or anything else
    console.log(`  [Hunter Verifier] ${email} → ${result}`);
    await new Promise(r => setTimeout(r, 200));
    return result;
  } catch (parseErr) {
    console.error(`  [Hunter Verifier] Failed to parse response for ${email}: ${parseErr.message}`);
    await new Promise(r => setTimeout(r, 200));
    return null;
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

// Internal — runs the branch logic, no logging. Called by the exported verifyEmail().
async function _computeVerification(email, source, apolloStatus) {
  // ── Branch 1: Apollo source ────────────────────────────────────────────────
  if (source === 'apollo') {
    if (apolloStatus === 'verified')
      return { valid: true,  flagged: false, reason: 'apollo_verified' };
    if (apolloStatus === 'likely_to_engage')
      return { valid: true,  flagged: false, reason: 'apollo_likely' };
    if (apolloStatus === 'risky') {
      const h = await runHunterVerifier(email);
      if (h === 'deliverable')   return { valid: true,  flagged: false, reason: 'apollo_risky_hunter_confirmed' };
      if (h === 'risky')         return { valid: true,  flagged: true,  reason: 'apollo_risky_hunter_risky' };
      if (h === 'undeliverable') return { valid: false, flagged: false, reason: 'apollo_risky_hunter_undeliverable' };
      return { valid: true, flagged: true, reason: 'apollo_risky_hunter_unavailable' }; // null → use flagged
    }
    if (apolloStatus === 'bounced')
      return { valid: false, flagged: false, reason: 'apollo_bounced' };
    return { valid: false, flagged: false, reason: 'apollo_unavailable' };
  }

  // ── Branch 2: Hunter source ────────────────────────────────────────────────
  if (source === 'hunter') {
    const h = await runHunterVerifier(email);
    if (h === 'deliverable')   return { valid: true,  flagged: false, reason: 'hunter_deliverable' };
    if (h === 'risky')         return { valid: true,  flagged: true,  reason: 'hunter_risky' };
    if (h === 'undeliverable') return { valid: false, flagged: false, reason: 'hunter_undeliverable' };
    return { valid: true, flagged: true, reason: 'hunter_unavailable' }; // null → use flagged (fail open)
  }

  // ── Branch 3: Puppeteer source ─────────────────────────────────────────────
  if (source === 'puppeteer') {
    const h = await runHunterVerifier(email);
    if (h === 'deliverable')   return { valid: true,  flagged: false, reason: 'puppeteer_deliverable' };
    if (h === 'risky')         return { valid: true,  flagged: true,  reason: 'puppeteer_risky' };
    if (h === 'undeliverable') return { valid: false, flagged: false, reason: 'puppeteer_undeliverable' };
    return { valid: false, flagged: false, reason: 'puppeteer_unavailable' }; // null → discard (fail closed)
  }

  return { valid: false, flagged: false, reason: `unknown_source_${source}` };
}

/**
 * Central email verification gate.
 *
 * @param {string}      email        The email address to check.
 * @param {string}      source       Where the email came from: 'apollo' | 'hunter' | 'puppeteer'
 * @param {string|null} apolloStatus Apollo's email_status field value, or null if not from Apollo.
 * @returns {Promise<{ valid: boolean, flagged: boolean, reason: string }>}
 *   valid:   true = use this email | false = discard
 *   flagged: true = risky but usable — append [unverified] to contact info
 *   reason:  short string for logging
 */
export async function verifyEmail(email, source, apolloStatus = null) {
  if (!email || typeof email !== 'string') {
    return { valid: false, flagged: false, reason: 'invalid_email_value' };
  }

  const result = await _computeVerification(email, source, apolloStatus);
  const { valid, flagged, reason } = result;

  // Structured log — one line per call, appears in Railway logs
  if (valid && !flagged) {
    console.log(`[Email Verification] ✓ ${email} accepted — source: ${source}, reason: ${reason}`);
  } else if (valid && flagged) {
    console.log(`[Email Verification] ⚠️ ${email} flagged — source: ${source}, reason: ${reason}, saving with flag`);
  } else {
    console.log(`[Email Verification] ✗ ${email} discarded — source: ${source}, reason: ${reason}, moving to next step`);
  }

  return result;
}

// ── Shared email validation — union of all patterns from workflow_4 and enrich_airtable ──

// Fake email patterns — Puppeteer sometimes picks up placeholder/example emails
const FAKE_EMAIL_PATTERNS = [
  /^john\.?doe@/i,
  /^john\.?smith@/i,
  /^j\.?doe@/i,
  /^johndoe@/i,
  /^jane\.?doe@/i,
  /^jane\.?smith@/i,
  /^firstname[\._]lastname@/i,
  /^first[\._]last@/i,
  /^name@/i,
  /^user@/i,
  /^example@/i,
  /^test@/i,
  /^sample@/i,
  /^placeholder@/i,
  /^yourname@/i,
  /^email@/i,
  /^email_not_unlocked@/i,  // Apollo placeholder when email exists but is paywalled
  /^admin@/i,
  // FLast@ regex removed — it caused false positives on legitimate emails
  // like JSmith@company.com or MJones@company.com. Other patterns already
  // catch true placeholders (john.doe@, firstname.lastname@, etc.).
];

// Generic inbox prefixes that are never a real person's email
const GENERIC_EMAIL_PREFIXES = [
  'noreply', 'no-reply', 'support@', 'info@', 'hello@', 'contact@',
  'press@', 'media@', 'media.', 'legal@', 'privacy@', 'unsubscribe', 'team@',
  'service@', 'sales@', 'billing@', 'admin@', 'hr@', 'careers@',
  'jobs@', 'recruitment@', 'partnerships@', 'abuse@',
  'investor@', 'investors@', 'ir@', 'webmaster@', 'postmaster@',
  'inquiries', 'customerservice', 'helpdesk', 'donotreply', 'do-not-reply',
  'notifications@', 'alerts@', 'bounce@', 'mailer@', 'robot@', 'daemon@',
  // Generic/placeholder local parts that are not real people
  'anything@', 'someone@', 'nobody@', 'everybody@', 'quality@', 'beerquality@',
  'webmail@', 'newsroom@', 'news@', 'marketing@', 'advertising@', 'retail@',
  // Generic department mailboxes that Hunter sometimes returns as "contacts"
  'solutions', 'marketingteam', 'marketingdept', 'digitalmarketing',
  'operations', 'businessdev', 'businessdevelopment', 'corporate',
  'communications', 'generalinfo', 'generalinquiries', 'globalmarketing'
];

// Free/personal email domains — never a company contact
const PERSONAL_EMAIL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com',
  'icloud.com', 'me.com', 'mac.com', 'live.com', 'msn.com', 'protonmail.com'
]);

// Search engine / directory domains — never a real company contact email
const THIRD_PARTY_SEARCH_DOMAINS = new Set([
  'duckduckgo.com', 'bing.com'
]);

const FILE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'ico', 'webp', 'bmp', 'mp4', 'mp3', 'pdf', 'zip', 'exe', 'css', 'js', 'xml', 'json']);

export function isFakeEmail(email) {
  if (!email || typeof email !== 'string') return true;
  const lower = email.toLowerCase().trim();
  const parts = lower.split('@');
  if (parts.length !== 2) return true;
  const [localPart, domain] = parts;

  // Generic prefix check on localPart only (avoids matching valid domains like multimedia.com)
  const isGeneric = GENERIC_EMAIL_PREFIXES.some(p => {
    if (p.endsWith('@')) {
      return localPart === p.slice(0, -1);
    }
    return localPart.includes(p);
  });
  if (isGeneric) return true;

  if (FAKE_EMAIL_PATTERNS.some(pattern => pattern.test(lower))) return true;

  // Reject short local parts (e.g. e@, jd@)
  if (localPart.length < 3) return true;
  // Reject local parts ending with a special character (e.g. black-@1x.png)
  if (/[-_+.]$/.test(localPart)) return true;
  // Reject personal/free email domains
  if (PERSONAL_EMAIL_DOMAINS.has(domain)) return true;
  // Reject search engine domains (e.g. error-lite@duckduckgo.com)
  if (THIRD_PARTY_SEARCH_DOMAINS.has(domain)) return true;
  // Reject URL-encoded local parts (e.g. x3d%22@, %22@ from HTML attribute scraping)
  if (localPart.includes('%')) return true;
  // Reject local parts that start with a non-alphanumeric character (e.g. .john@, -john@)
  if (!/^[a-zA-Z0-9]/.test(localPart)) return true;

  // Reject system/department emails: 3+ underscores in local part (relaxed from 2 to allow double-barrelled/middle names)
  if ((localPart.match(/_/g) || []).length >= 3) return true;

  // Reject file extensions mistaken as TLDs (e.g. a-logo-black-@1x.png)
  const tld = domain.split('.').pop();
  if (FILE_EXTENSIONS.has(tld)) return true;
  return false;
}
