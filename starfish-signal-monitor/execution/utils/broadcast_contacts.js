// utils/broadcast_contacts.js
// Universal broadcast contact search — finds up to N verified contacts at any company domain.
// Self-contained (no workflow_4 imports) to avoid circular dependencies.
// Imported by workflow_4 for all non-BSI signal types.
//
// Usage:
//   import { findBroadcastContacts } from './utils/broadcast_contacts.js';
//   const contacts = await findBroadcastContacts(domain, companyName, { maxContacts: 4, excludeEmail: null });

import 'dotenv/config';
import axios from 'axios';
import { getBreaker } from './circuit_breaker.js';
import { verifyEmail, isFakeEmail } from './email_validator.js';

// ─── Title lists ──────────────────────────────────────────────────────────────
// Mirrors apolloBroadcastSearch's person_titles in workflow_4.
const BROADCAST_PERSON_TITLES = [
  // ── Primary: marketing/brand/comms ──────────────────────────────────────────
  'Chief Marketing Officer', 'CMO',
  'Chief Brand Officer', 'CBO',
  'Chief Communications Officer',
  'VP Marketing', 'VP of Marketing', 'Vice President Marketing', 'Vice President of Marketing',
  'VP Brand', 'VP of Brand', 'VP Brand Marketing',
  'VP Communications', 'VP of Communications',
  'Vice President Brand', 'Vice President of Brand',
  'Vice President Communications', 'Vice President of Communications',
  'SVP Marketing', 'SVP of Marketing', 'Senior Vice President of Marketing', 'Senior Vice President Marketing',
  'SVP Brand', 'SVP of Brand', 'Senior Vice President Brand', 'Senior Vice President of Brand',
  'SVP Communications', 'SVP of Communications',
  'EVP Marketing', 'EVP of Marketing', 'Executive Vice President of Marketing', 'Executive Vice President Marketing',
  'EVP Brand', 'EVP of Brand', 'Executive Vice President Brand', 'Executive Vice President of Brand',
  'EVP Communications', 'EVP of Communications',
  'Head of Marketing', 'Head of Brand', 'Head of Communications',
  'Director of Marketing', 'Marketing Director',
  'Director of Brand', 'Brand Director', 'Director of Brand Marketing',
  'Director of Communications', 'Communications Director',
  'VP Public Affairs', 'VP of Public Affairs', 'Vice President Public Affairs', 'Vice President of Public Affairs',
  'SVP Public Affairs', 'EVP Public Affairs',
  'Head of Public Relations', 'VP Public Relations', 'VP of Public Relations',
  'Vice President Public Relations', 'Director of Public Relations', 'Public Relations Director',
  // ── C-suite fallback ─────────────────────────────────────────────────────────
  'CEO', 'Chief Executive Officer',
  'COO', 'Chief Operating Officer',
  'President',
  'Managing Partner', 'Senior Partner', 'Equity Partner', 'Founding Partner',
  'Managing Director'
];

// Approved marketing/brand/comms keywords — used to gate email unlock credits.
// Only unlock emails for contacts in these roles (same logic as isBSIAllowedTitle).
const APPROVED_UNLOCK_KEYWORDS = [
  'cmo', 'chief marketing', 'chief brand', 'chief communications',
  'vp marketing', 'vp of marketing', 'vp brand', 'vp of brand',
  'vp communications', 'vp of communications',
  'vice president marketing', 'vice president brand', 'vice president communications',
  'svp marketing', 'svp brand', 'svp communications',
  'evp marketing', 'evp brand', 'evp communications',
  'head of marketing', 'head of brand', 'head of communications',
  'director of marketing', 'marketing director',
  'director of brand', 'brand director', 'director of brand marketing',
  'director of communications', 'communications director',
  'public affairs', 'public relations',
];

const CSUITE_UNLOCK_KEYWORDS = [
  'chief executive', 'chief operating', 'president',
  'managing partner', 'senior partner', 'equity partner', 'founding partner',
  'managing director'
];

// ─── Filter helpers ───────────────────────────────────────────────────────────
// These mirror the exact logic from workflow_4 — kept in sync manually.

// Private copy — avoids circular import with workflow_4. Kept in sync with isNameComplete() there.
const _PLACEHOLDER_NAMES = ['unknown', 'n/a', 'na', 'none', 'test', 'null', 'undefined', '-'];

function _isNameComplete(firstName, lastName) {
  const first = (firstName || '').toString().trim();
  const last  = (lastName  || '').toString().trim();
  if (!first || !last)       return false;
  if (first.length <= 1)     return false;
  if (last.length  <= 1)     return false;
  if (_PLACEHOLDER_NAMES.includes(first.toLowerCase())) return false;
  if (_PLACEHOLDER_NAMES.includes(last.toLowerCase()))  return false;
  if (/^\d+$/.test(first) || /^\d+$/.test(last))       return false;
  return true;
}

const UNEMPLOYED_SIGNALS = [
  'seeking new opportunity',
  'seeking opportunities',
  'seeking next opportunity',
  'open to work',
  'open to opportunities',
  'in transition',
  'self-employed',
  'freelance',
  'freelancer',
  'independent consultant',
  'independent contractor',
  'available for hire',
  'looking for new role',
  'exploring opportunities',
  // Legacy terms kept for backward compatibility
  'seeking', 'job seeker', 'looking for', 'self employed',
  'consultant at self', 'between roles'
];

function _isCurrentlyEmployed(title) {
  const t = (title || '').toLowerCase().trim();
  return !UNEMPLOYED_SIGNALS.some(s => t.includes(s));
}

// Known MLM/direct-sales companies — private copy to avoid circular import with workflow_4.
const _KNOWN_MLM_COMPANIES = [
  'amway', 'herbalife', 'forever living', 'forever living products',
  'avon', 'avon products', 'primerica',
  'world financial group', 'wfg',
  'symmetry financial', 'symmetry financial group',
  'northwestern mutual', 'new york life',
  'mass mutual', 'massmutual', 'globe life',
  'php agency', 'family first life', 'american income life', 'transamerica',
  'monat', 'monat global', 'isagenix', 'advocare', 'arbonne', 'younique',
  'color street', 'scentsy', 'pampered chef', 'thirty one gifts',
  'nu skin', 'nuskin', '4life', 'it works',
  'beachbody', 'team beachbody', 'life vantage', 'lifevantage',
  'market america', 'usana', 'nerium', 'neora'
];

const _MLM_TITLE_INDICATORS = [
  'national marketing director', 'independent distributor',
  'independent representative', 'independent associate',
  'independent agent', 'independent business owner', 'ibo',
  'qualified platinum', 'qualified director', 'diamond director',
  'emerald', 'ruby director', 'sapphire',
  'senior marketing director', 'executive marketing director',
  // Legacy terms
  'qualified', 'independent', 'distributor', 'brand ambassador', 'brand partner'
];

function _isCorporateEmployee(title, companyName) {
  const t = (title || '').toLowerCase().trim();
  const hasMlmTitle = _MLM_TITLE_INDICATORS.some(m => t.includes(m));
  if (!hasMlmTitle) return true; // title looks clean — pass regardless of company

  // Title looks MLM-like — only reject if the company is a known MLM.
  // "Senior Marketing Director" at Nike has a matching title token but Nike is not an MLM.
  if (!companyName) return true; // no company name to cross-check — safe fallback
  const c = companyName.toLowerCase().trim();
  return !_KNOWN_MLM_COMPANIES.some(mlm => c.includes(mlm));
}

// Returns true when the title is worth spending an email unlock credit on.
function _isUnlockTarget(title) {
  if (!title) return false;
  const t = title.toLowerCase();
  if (/(?:^|[\s,/&-])cmo(?:[\s,/&-]|$)/.test(t)) return true;
  return (
    APPROVED_UNLOCK_KEYWORDS.some(k => t.includes(k)) ||
    CSUITE_UNLOCK_KEYWORDS.some(k => t.includes(k))
  );
}

// Day 1: CMO / VP Marketing / Chief Brand   — owns budget
// Day 2: CEO / President                    — top decision-maker
// Day 3: COO                                — ops integration context
// Day 4: Head/Director of Marketing or Brand — senior practitioners (also default for unknown)
// Day 5: Comms roles                        — brand visibility angle
function _assignSendDay(title) {
  if (!title) return 4;
  const t = title.toLowerCase();
  if ([
    'cmo', 'chief marketing', 'chief brand',
    'vp marketing', 'vp of marketing', 'vp brand', 'vp of brand',
    'svp marketing', 'svp of marketing', 'evp marketing', 'evp of marketing',
    'senior vice president marketing', 'senior vice president of marketing',
    'senior vice president brand', 'senior vice president of brand',
    'executive vice president marketing', 'executive vice president of marketing',
    'executive vice president brand', 'executive vice president of brand',
    'vice president marketing', 'vice president of marketing',
    'vice president brand', 'vice president of brand',
    'vp brand marketing', 'vp of brand marketing'
  ].some(k => t.includes(k))) return 1;
  if (t.includes('chief executive') || t.includes('chief executive officer') ||
      /(?:^|[\s,/&-])ceo(?:[\s,/&-]|$)/.test(t) ||
      (t.includes('president') && !t.includes('vice president'))) return 2;
  if (t.includes('chief operating') ||
      /(?:^|[\s,/&-])coo(?:[\s,/&-]|$)/.test(t)) return 3;
  if ([
    'head of marketing', 'head of brand',
    'director of marketing', 'marketing director',
    'director of brand', 'brand director'
  ].some(k => t.includes(k))) return 4;
  if (['communications', 'comms'].some(k => t.includes(k))) return 5;
  return 4;  // default — unknown titles land at Day 4 (practitioner level)
}

// Public alias — exported for use in workflow_4 and tests.
export function getSendDay(title) { return _assignSendDay(title); }

// ─── Domain validation ────────────────────────────────────────────────────────
// Mirrors isEmailDomainValid() in workflow_4 exactly.
// Kept here as a private copy to avoid a circular import
// (workflow_4 imports broadcast_contacts; broadcast_contacts cannot import workflow_4).
function _isEmailDomainValid(email, companyWebsite) {
  if (!email || !companyWebsite) return false;
  if (typeof email !== 'string' || typeof companyWebsite !== 'string') return false;

  const emailDomain = email.split('@')[1]?.toLowerCase().trim();
  const companyDomain = companyWebsite
    .replace(/https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split('/')[0]
    .toLowerCase()
    .trim();

  if (!emailDomain || !companyDomain) return false;

  if (emailDomain === companyDomain) return true;

  if (emailDomain.endsWith('.' + companyDomain)) {
    const afterCompanyDomain = emailDomain.slice(
      emailDomain.lastIndexOf('.' + companyDomain) + ('.' + companyDomain).length
    );
    if (afterCompanyDomain === '') return true;
  }

  const KNOWN_COUNTRY_TLDS = [
    '.com.ph', '.co.uk', '.com.au', '.co.nz', '.com.sg', '.com.hk',
    '.com.my', '.co.in', '.com.br', '.com.mx', '.com.ar', '.co.za',
    '.com.co', '.com.pe', '.com.vn', '.com.tw', '.co.jp', '.co.kr',
    '.com.ng', '.co.ke', '.com.eg', '.co.id', '.com.tr', '.co.il'
  ];
  if (KNOWN_COUNTRY_TLDS.some(tld => emailDomain.endsWith(tld))) return false;

  return false;
}

// ─── Apollo broadcast search ──────────────────────────────────────────────────
// POST /mixed_people/api_search filtered to target titles at a specific domain.
// POST /people/match (1 credit) to unlock email for approved titles.
// Never throws — returns [] on any failure.
async function _apolloSearch(domain) {
  if (!process.env.APOLLO_API_KEY || !domain) return [];
  if (getBreaker('apollo').isOpen()) {
    console.log(`  [Broadcast/Apollo] ⚡ Circuit open — skipping ${domain}`);
    return [];
  }

  const baseUrl = process.env.APOLLO_API_URL || 'https://api.apollo.io/v1';
  const body = {
    person_titles:         BROADCAST_PERSON_TITLES,
    person_seniorities:    ['c_suite', 'vp', 'head', 'director', 'owner', 'partner'],
    person_locations:      ['United States'],
    q_organization_domains: domain,
    per_page: 10,
    page: 1
  };

  const RETRY_DELAYS = [15000, 30000];
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await axios.post(`${baseUrl}/mixed_people/api_search`, body, {
        headers: { 'X-Api-Key': process.env.APOLLO_API_KEY, 'Content-Type': 'application/json' },
        timeout: 15000
      });
      getBreaker('apollo').recordSuccess();

      const people = res.data?.people || [];
      console.log(`  [Broadcast/Apollo] ${people.length} contacts at ${domain} (${people.filter(p => p.has_email).length} with email)`);

      const enriched = [];
      for (const p of people) {
        let email       = null;
        let emailStatus = null;
        let lastName    = p.last_name    || '';
        let linkedinUrl = p.linkedin_url || null;

        if (p.has_email && p.id && _isUnlockTarget(p.title)) {
          // POST /people/match — 1 Apollo credit to reveal email
          try {
            const matchRes = await axios.post(`${baseUrl}/people/match`, {
              id: p.id,
              reveal_personal_emails: false
            }, {
              headers: { 'X-Api-Key': process.env.APOLLO_API_KEY, 'Content-Type': 'application/json' },
              timeout: 15000
            });
            const full   = matchRes.data?.person || {};
            const rawEmail = full.email || null;
            email = (rawEmail &&
              rawEmail !== 'email_not_unlocked@domain.com' &&
              !/^[^@]+@domain\.com$/.test(rawEmail))
              ? rawEmail : null;
            emailStatus = full.email_status || null;
            if (!lastName)    lastName    = full.last_name    || '';
            if (!linkedinUrl) linkedinUrl = full.linkedin_url || null;
            if (email) {
              console.log(`  [Broadcast/Apollo] ✅ ${p.first_name} ${lastName} (${p.title}) → ${email}${emailStatus ? ` [${emailStatus}]` : ''}`);
            } else {
              console.log(`  [Broadcast/Apollo] ℹ️  ${p.first_name} ${p.title} — unlock returned no email`);
            }
          } catch (matchErr) {
            console.warn(`  [Broadcast/Apollo] Unlock failed for ${p.first_name} (${p.id}): ${matchErr.message}`);
          }
        } else if (p.has_email && p.id && !_isUnlockTarget(p.title)) {
          console.log(`  [Broadcast/Apollo] ⛔ ${p.first_name} ${p.last_name || ''} (${p.title}) — title not target role, skipping unlock`);
        } else if (p.id && (!lastName || !linkedinUrl)) {
          // No email — GET /people/{id} (free) just to fill in last_name / linkedin_url
          try {
            const enrichRes = await axios.get(`${baseUrl}/people/${p.id}`, {
              headers: { 'X-Api-Key': process.env.APOLLO_API_KEY },
              timeout: 15000
            });
            const full = enrichRes.data?.person || {};
            if (!lastName)    lastName    = full.last_name    || '';
            if (!linkedinUrl) linkedinUrl = full.linkedin_url || null;
          } catch (enrichErr) {
            console.warn(`  [Broadcast/Apollo] Profile fetch failed for ${p.first_name} (${p.id}): ${enrichErr.message}`);
          }
        }

        enriched.push({
          firstName:    p.first_name || '',
          lastName,
          title:        p.title      || null,
          linkedin_url: linkedinUrl,
          email,
          email_status: emailStatus
        });
      }
      return enriched;

    } catch (err) {
      const status = err.response?.status;
      if (status === 429 && attempt < 3) {
        const wait = RETRY_DELAYS[attempt - 1];
        console.warn(`  [Broadcast/Apollo] ⏳ Rate limited (429) at ${domain} — retrying in ${wait / 1000}s (attempt ${attempt}/3)...`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      if (status === 401)      console.warn(`  [Broadcast/Apollo] ❌ Unauthorized (401) — check APOLLO_API_KEY`);
      else if (status === 429) console.warn(`  [Broadcast/Apollo] ⏳ Rate limited (429) at ${domain} — all attempts exhausted`);
      else if (status === 422) console.warn(`  [Broadcast/Apollo] ⚠️  422 Unprocessable at ${domain}:`, JSON.stringify(err.response?.data)?.slice(0, 200));
      else {
        console.warn(`  [Broadcast/Apollo] ⚠️  Error at ${domain}: ${err.message}`);
        getBreaker('apollo').recordFailure(err.message);
      }
      return [];
    }
  }
  return [];
}

// ─── _makeContact() — normalised contact object with both old + new key shapes ─
// formatBSIContactInfo() (workflow_4) reads old keys: first_name, last_name, linkedin_url, email_flagged.
// New workflow code reads new keys: name, firstName, lastName, linkedinUrl, isFixed, emailSource.
// Returning both lets everything work without touching formatBSIContactInfo.
function _makeContact({ firstName, lastName, title, email, emailVerification, linkedinUrl, source, isFixed = false }) {
  const fullName = `${firstName || ''} ${lastName || ''}`.trim();
  return {
    // ── Old-shape keys (used by formatBSIContactInfo, expandToRecords) ──────
    first_name:        firstName       || '',
    last_name:         lastName        || '',
    email:             email           || null,
    email_flagged:     emailVerification?.flagged || undefined,
    linkedin_url:      linkedinUrl     || null,
    // ── New-shape keys ────────────────────────────────────────────────────────
    name:              fullName,
    firstName:         firstName       || '',
    lastName:          lastName        || '',
    linkedinUrl:       linkedinUrl     || null,
    emailSource:       source          || null,
    emailVerification: emailVerification || null,
    isFixed,
    // ── Shared ────────────────────────────────────────────────────────────────
    title:             title           || null,
    source:            source          || null,
    send_day:          _assignSendDay(title)
  };
}

// ─── findBroadcastContacts ────────────────────────────────────────────────────
// Finds up to MAX_CONTACTS_PER_COMPANY (4) verified exec contacts at a domain.
//
// Parameters (destructured object):
//   domain          {string}  — bare domain, e.g. "hubspot.com"
//   companyName     {string}  — used in log lines
//   companyWebsite  {string}  — full URL (unused internally, passed through for callers)
//   signalType      {string}  — used in log prefix only
//   fixedContact    {object|null} — pre-resolved Contact #1 (e.g. job-changer).
//                                   Always placed first; broadcast fills remaining slots.
//     fixedContact.name, .email, .title, .linkedinUrl, .emailSource, .emailVerification
//
// Returns array of contact objects (old + new shape keys, sorted by send_day).
// First element is fixedContact when provided.
export async function findBroadcastContacts({ domain, companyName, companyWebsite, signalType: _signalType, fixedContact }) {
  const MAX = 4;
  const contacts = [];

  // ── Step 0: Prepend fixedContact as Contact #1 ──────────────────────────────
  if (fixedContact) {
    const nameParts = (fixedContact.name || '').split(' ');
    const fFirst = nameParts[0] || '';
    const fLast  = nameParts.slice(1).join(' ') || '';
    contacts.push(_makeContact({
      firstName:         fFirst,
      lastName:          fLast,
      title:             fixedContact.title           || null,
      email:             fixedContact.email           || null,
      emailVerification: fixedContact.emailVerification || { valid: true, reason: 'fixed_contact' },
      linkedinUrl:       fixedContact.linkedinUrl     || fixedContact.linkedin_url || null,
      source:            fixedContact.emailSource     || 'fixed',
      isFixed:           true
    }));
    // Override send_day to 1 — job-changer is always the first touchpoint
    contacts[0].send_day = 1;
  }

  if (!domain) {
    if (contacts.length > 0) return contacts;
    return [];
  }

  // Dedup: skip any broadcast contact whose email matches the fixedContact
  const excludeEmail = fixedContact?.email?.toLowerCase() || null;

  // ── Step 1: Apollo broadcast search ─────────────────────────────────────────
  if (!getBreaker('apollo').isOpen()) {
    const apolloContacts = await _apolloSearch(domain);
    for (const c of apolloContacts) {
      if (contacts.length >= MAX) break;
      if (!c.firstName?.trim()) continue;

      if (excludeEmail && c.email && c.email.toLowerCase() === excludeEmail) {
        console.log(`  [Broadcast] ⏭️  ${c.firstName} ${c.lastName || ''} — same as Contact #1`);
        continue;
      }
      if (!_isUnlockTarget(c.title)) {
        console.log(`  [Broadcast] ⛔ ${c.firstName} ${c.lastName || ''} (${c.title}) — title not a target role`);
        continue;
      }
      if (!_isNameComplete(c.firstName, c.lastName)) {
        console.log(`  [Broadcast] ⛔ ${c.firstName} ${c.lastName || ''} — incomplete name`);
        continue;
      }
      if (!_isCurrentlyEmployed(c.title)) {
        console.log(`  [Broadcast] ⛔ ${c.firstName} ${c.lastName || ''} (${c.title}) — not currently employed`);
        continue;
      }
      if (!_isCorporateEmployee(c.title, companyName)) {
        console.log(`  [Broadcast] ⛔ ${c.firstName} ${c.lastName || ''} (${c.title}) — MLM/distributor title`);
        continue;
      }

      const rawEmail = c.email && !isFakeEmail(c.email) ? c.email : null;
      let verifiedEmail     = null;
      let emailVerification = null;
      if (rawEmail) {
        const src    = c.email_status ? 'apollo' : 'hunter';
        const result = await verifyEmail(rawEmail, src, c.email_status || null);
        await new Promise(r => setTimeout(r, 300));
        if (result.valid) {
          verifiedEmail     = rawEmail;
          emailVerification = result;
          if (result.flagged) console.log(`  [Broadcast] ⚠️  ${rawEmail} flagged as risky (${result.reason})`);
        } else {
          console.log(`  [Broadcast] ❌ ${rawEmail} failed verification (${result.reason}) — keeping LinkedIn if available`);
        }
      }

      // domain validation confirmed — reject emails from a different company's domain
      if (verifiedEmail && companyWebsite && !_isEmailDomainValid(verifiedEmail, companyWebsite)) {
        console.log(`  [Broadcast] Domain mismatch discarded: ${verifiedEmail}`);
        verifiedEmail = null;
      }

      if (!verifiedEmail && !c.linkedin_url) continue;

      contacts.push(_makeContact({
        firstName:         c.firstName,
        lastName:          c.lastName   || '',
        title:             c.title,
        email:             verifiedEmail,
        emailVerification,
        linkedinUrl:       c.linkedin_url,
        source:            'apollo'
      }));
      console.log(`  [Broadcast] ➕ ${c.firstName} ${c.lastName || ''} (${c.title || 'Unknown'})${verifiedEmail ? ` → ${verifiedEmail}` : ' — LinkedIn only'}`);
    }
    await new Promise(r => setTimeout(r, 400));
  }

  // ── Step 2: Hunter domain-search fallback when Apollo returned nothing ───────
  // (Excluding fixedContact slot — only run Hunter if broadcast slots are empty)
  const broadcastCount = contacts.filter(c => !c.isFixed).length;
  if (broadcastCount === 0 && process.env.HUNTER_API_KEY && !getBreaker('hunter').isOpen()) {
    console.log(`  [Broadcast/Hunter] Apollo empty — trying Hunter domain-search at ${domain}...`);
    try {
      const hRes = await axios.get('https://api.hunter.io/v2/domain-search', {
        params: { domain, api_key: process.env.HUNTER_API_KEY },
        timeout: 15000
      });
      getBreaker('hunter').recordSuccess();

      const hEmails     = hRes.data?.data?.emails || [];
      const execMatches = hEmails.filter(e => _isUnlockTarget(e.position));

      for (const e of execMatches) {
        if (contacts.length >= MAX) break;
        if (!e.first_name?.trim()) continue;
        if (!_isNameComplete(e.first_name, e.last_name)) continue;
        if (!_isCurrentlyEmployed(e.position))           continue;
        if (!_isCorporateEmployee(e.position, companyName)) {
          console.log(`  [Broadcast/Hunter] ⛔ ${e.first_name} ${e.last_name || ''} (${e.position}) — MLM/distributor title`);
          continue;
        }

        const rawEmail = e.value && !isFakeEmail(e.value) ? e.value : null;
        let verifiedEmail     = null;
        let emailVerification = null;
        if (rawEmail) {
          const { valid, flagged, reason } = await verifyEmail(rawEmail, 'hunter', null);
          await new Promise(r => setTimeout(r, 300));
          if (valid) { verifiedEmail = rawEmail; emailVerification = { valid, flagged, reason }; }
        }
        // domain validation confirmed — reject emails from a different company's domain
        if (verifiedEmail && companyWebsite && !_isEmailDomainValid(verifiedEmail, companyWebsite)) {
          console.log(`  [Broadcast] Domain mismatch discarded: ${verifiedEmail}`);
          verifiedEmail = null;
        }

        if (!verifiedEmail && !e.linkedin) continue;

        contacts.push(_makeContact({
          firstName:         e.first_name,
          lastName:          e.last_name || '',
          title:             e.position,
          email:             verifiedEmail,
          emailVerification,
          linkedinUrl:       e.linkedin,
          source:            'hunter'
        }));
        console.log(`  [Broadcast/Hunter] ➕ ${e.first_name} ${e.last_name || ''} (${e.position || 'Unknown'})${verifiedEmail ? ` → ${verifiedEmail}` : ' — LinkedIn only'}`);
      }
    } catch (err) {
      const status = err.response?.status;
      if (status === 429)      console.warn(`  [Broadcast/Hunter] ⏳ Rate limited (429) at ${domain}`);
      else if (status === 401) console.warn(`  [Broadcast/Hunter] ❌ Hunter unauthorized (401)`);
      else {
        console.warn(`  [Broadcast/Hunter] ⚠️  ${err.message}`);
        getBreaker('hunter').recordFailure(err.message);
      }
    }
    await new Promise(r => setTimeout(r, 400));
  }

  // Sort by send_day — fixedContact stays at [0] (send_day 1), rest sorted ascending
  const fixed   = contacts.filter(c => c.isFixed);
  const dynamic = contacts.filter(c => !c.isFixed).sort((a, b) => a.send_day - b.send_day);
  const result  = [...fixed, ...dynamic];

  if (result.length > 0) {
    console.log(`  [Broadcast] ✅ ${companyName} — ${result.length} contact(s) found at ${domain}`);
  } else {
    console.log(`  [Broadcast] ℹ️  ${companyName} — no contacts found at ${domain}`);
  }
  return result;
}
