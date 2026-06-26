/*
 * EMAIL VERIFICATION UPGRADE — June 2026
 *
 * All email assignment now routes through verifyEmail(email, source, apolloStatus)
 * from utils/email_validator.js. Returns { valid, flagged, reason }.
 *
 * Sources and fail policy:
 *   'apollo'    → Layer 1 is Apollo email_status (free). 'verified'/'likely_to_engage'
 *                 → accept immediately. 'risky' → run Hunter verifier. Otherwise discard.
 *   'hunter'    → Always run Hunter verifier. Unavailable → accept flagged (fail open).
 *   'puppeteer' → Always run Hunter verifier. Unavailable → discard (fail closed).
 *
 * Flagged emails (valid but risky): stored with email_flagged / _email_flagged = true
 * so formatContactInfo() can append [unverified] to the Airtable Contact Info field.
 *
 * BSI T1 (AudienceLab identity-resolved contacts): isFakeEmail() only — no verifyEmail().
 * BSI T2 / T3 contacts that fail verification: skipped (reachability filter drops
 * contacts with no email AND no LinkedIn — preserving LinkedIn-only contacts).
 *
 * circuit_breaker.js — no changes. Hunter verifier calls are protected inside verifyEmail().
 */

import 'dotenv/config';
import fs from 'fs';
import axios from 'axios';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

import * as airtableClient from './utils/airtable_client.js';
import { createRecordsInBase } from './utils/airtable_client.js';
import { getTodayStamp, getTodayString, formatShortDate } from './utils/date_helpers.js';
import { formatRevenue, formatNumber } from './utils/text_parsing.js';
import { sendErrorAlert } from './utils/telegram_client.js';
import { findEmailWithPuppeteer, findCompanyDomain, findEmailPatternViaGoogle } from './utils/puppeteer_email_finder.js';
import { getKnownDomain } from './utils/known_domains.js';
import { isFakeEmail, verifyEmail } from './utils/email_validator.js';
import { getBreaker } from './utils/circuit_breaker.js';
import { extractDomain, findEmailWithApollo, findEmailWithHunterPerson, findEmailWithHunterDomain } from './utils/email_enrichment.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TMP_DIR = resolve(__dirname, '../.tmp');

// ── BSI strict title allowlist ────────────────────────────────────────────────
// Only contacts matching these roles are allowed into Airtable for BSI signals.
// Protects Carly's time and keeps the database clean — drop anything else.
// Marketing/brand leadership, senior C-suite (own the brand budget), and
// communications leaders. Finance, ops-only, HR, tech, legal, etc. are excluded.
const BSI_ALLOWED_TITLE_KEYWORDS = [
  // Marketing & Brand C-suite
  'cmo', 'chief marketing', 'chief brand', 'chief communications',
  // General C-suite (valid T3 targets — they greenlight brand spend)
  'ceo', 'chief executive',
  'coo', 'chief operating',
  'president',
  // VP-level Marketing / Brand / Communications
  'vp marketing', 'vp of marketing', 'vp brand', 'vp of brand',
  'vp communications', 'vp of communications',
  'vice president marketing', 'vice president of marketing',
  'vice president brand', 'vice president of brand',
  'vice president communications', 'vice president of communications',
  'svp marketing', 'svp brand', 'svp communications',
  'svp of marketing', 'svp of brand', 'svp of communications',
  'evp marketing', 'evp brand', 'evp communications',
  'evp of marketing', 'evp of brand', 'evp of communications',
  'senior vice president marketing', 'senior vice president brand',
  'senior vice president of marketing', 'senior vice president of brand',
  'executive vice president marketing', 'executive vice president brand',
  'executive vice president of marketing', 'executive vice president of brand',
  // Head / Director level — senior practitioners with budget influence
  'head of marketing', 'head of brand', 'head of communications',
  'director of marketing', 'marketing director',
  'director of brand', 'brand director', 'director of brand marketing',
  'director of communications', 'communications director',
];

function isBSIAllowedTitle(title) {
  if (!title) return false;
  const t = title.toLowerCase().trim();
  return BSI_ALLOWED_TITLE_KEYWORDS.some(k => t.includes(k));
}


// ── BSI send-day assignment — determines outreach sequence ─────────────────────
// Day 1: CMO / VP Marketing / Chief Brand Officer  (owns budget)
// Day 2: CEO / President                           (top decision-maker)
// Day 3: COO                                       (ops integration context)
// Day 4: Head/Director of Marketing or Brand       (senior practitioners)
// Day 5: Communications roles                      (brand visibility angle)
function assignSendDay(title) {
  if (!title) return 5;
  const t = title.toLowerCase();
  if (['cmo', 'chief marketing', 'chief brand',
       'vp marketing', 'vp of marketing', 'vp brand', 'vp of brand',
       'svp marketing', 'svp of marketing', 'evp marketing', 'evp of marketing',
       'senior vice president marketing', 'senior vice president of marketing',
       'senior vice president brand', 'senior vice president of brand',
       'executive vice president marketing', 'executive vice president of marketing',
       'executive vice president brand', 'executive vice president of brand',
       'vice president marketing', 'vice president of marketing',
       'vice president brand', 'vice president of brand',
       'vp brand marketing', 'vp of brand marketing'].some(k => t.includes(k))) return 1;
  if (['ceo', 'chief executive', 'president'].some(k => t.includes(k))) return 2;
  if (['coo', 'chief operating'].some(k => t.includes(k))) return 3;
  if (['head of marketing', 'head of brand',
       'director of marketing', 'marketing director',
       'director of brand', 'brand director'].some(k => t.includes(k))) return 4;
  if (['communications', 'comms'].some(k => t.includes(k))) return 5;
  return 5;
}

// ── Apollo broadcast search — find up to 5 contacts across all exec + marketing + comms roles ──
// Used exclusively for BSI signals. Returns an array of contact objects (never throws).
async function apolloBroadcastSearch(domain) {
  if (!process.env.APOLLO_API_KEY || !domain) return [];
  if (getBreaker('apollo').isOpen()) {
    console.log(`  [Apollo/Broadcast] ⚡ Circuit open — skipping ${domain}`);
    return [];
  }

  const baseUrl = process.env.APOLLO_API_URL || 'https://api.apollo.io/v1';
  const body = {
    // Apollo API uses q_-prefixed params for filtering (q_organization_domains, q_person_titles).
    // organization_domains (unprefixed) is silently ignored — causes same contacts to appear
    // for every domain as Apollo returns global top-matches instead of company-specific results.
    q_person_titles: [
      // C-Suite
      'CEO', 'Chief Executive Officer',
      'COO', 'Chief Operating Officer',
      'President',
      // Marketing & Brand
      'CMO', 'Chief Marketing Officer',
      'VP Marketing', 'VP of Marketing', 'Vice President Marketing', 'Vice President of Marketing',
      'SVP Marketing', 'SVP of Marketing', 'Senior Vice President of Marketing',
      'EVP Marketing', 'EVP of Marketing',
      'Head of Marketing', 'Head of Brand',
      'Director of Marketing', 'Marketing Director',
      'Chief Brand Officer',
      // Communications
      'VP Communications', 'VP of Communications',
      'Head of Communications', 'Director of Communications',
      'Chief Communications Officer'
    ],
    q_organization_domains: domain,
    per_page: 5,
    page: 1
  };

  // Up to 3 attempts on 429: wait 15s after attempt 1, wait 30s after attempt 2.
  // Three attempts prevents a transient rate-limit from silently dropping all contacts.
  const RETRY_DELAYS = [15000, 30000];
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await axios.post(`${baseUrl}/mixed_people/api_search`, body, {
        headers: { 'X-Api-Key': process.env.APOLLO_API_KEY, 'Content-Type': 'application/json' },
        timeout: 15000
      });
      getBreaker('apollo').recordSuccess();
      const people = res.data?.people || [];
      console.log(`  [Apollo/Broadcast] ${people.length} contacts found at ${domain}`);

      // Apollo's search results hide last_name, email, and linkedin_url at the plan level.
      // Enrich each contact via /people/{id} to reveal the full profile.
      // Skip enrichment if the search already returned last_name + linkedin_url (paid plan may include them).
      const enriched = [];
      for (const p of people) {
        let full = p;
        if (p.id && (!p.last_name || !p.linkedin_url)) {
          try {
            const enrichRes = await axios.get(`${baseUrl}/people/${p.id}`, {
              headers: { 'X-Api-Key': process.env.APOLLO_API_KEY },
              timeout: 15000
            });
            full = enrichRes.data?.person || p;
          } catch (enrichErr) {
            console.warn(`  [Apollo/BSI] Enrichment failed for person ${p.id} — using raw search data: ${enrichErr.message}`);
          }
        }
        enriched.push({
          firstName:    full.first_name   || p.first_name   || '',
          lastName:     full.last_name    || p.last_name    || '',
          title:        full.title        || p.title        || null,
          linkedin_url: full.linkedin_url || p.linkedin_url || null,
          email:        full.email        || p.email        || null
        });
      }
      return enriched;
    } catch (err) {
      const status = err.response?.status;
      if (status === 429 && attempt < 3) {
        const wait = RETRY_DELAYS[attempt - 1];
        console.warn(`  [Apollo/Broadcast] ⏳ Rate limited (429) at ${domain} — retrying in ${wait / 1000}s (attempt ${attempt}/3)...`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      if (status === 401)      console.warn(`  [Apollo/Broadcast] ❌ Unauthorized (401) — check APOLLO_API_KEY`);
      else if (status === 429) console.warn(`  [Apollo/Broadcast] ⏳ Rate limited (429) at ${domain} — all 3 attempts exhausted, marking Contact Needed`);
      else if (status === 422) console.warn(`  [Apollo/Broadcast] ⚠️  422 Unprocessable at ${domain}:`, JSON.stringify(err.response?.data)?.slice(0, 200));
      else {
        console.warn(`  [Apollo/Broadcast] ⚠️  Error at ${domain}: ${err.message}`);
        getBreaker('apollo').recordFailure(err.message);
      }
      return [];
    }
  }
  return [];
}

// ── Extract named person from a News/Press article ────────────────────────────
// Looks for patterns like "Jane Smith appointed as CMO" or "named John Doe as VP Marketing"
// Returns { firstName, lastName } or null if no name found.
function extractNameFromArticle(signal) {
  const text = [signal.article?.title, signal.article?.description].filter(Boolean).join(' ');
  if (!text) return null;

  // Pattern: "FirstName LastName appointed/named/joins as/hired as <title>"
  // or "appointed/named FirstName LastName as <title>"
  const patterns = [
    // "appointed Jane Smith as CMO" / "named John Doe as VP Marketing"
    /(?:appointed|named|promoted|hired)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\s+(?:as|to)\s+/,
    // "Jane Smith appointed as CMO" / "Jane Smith joins as VP"
    /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\s+(?:appointed|named|joins as|hired as|promoted to)/,
    // "Jane Smith, CMO" — name followed by comma and title keyword
    /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+),\s+(?:CMO|CEO|COO|CBO|President|VP|SVP|EVP|Director|Head of)/,
  ];

  for (const regex of patterns) {
    const match = text.match(regex);
    if (match) {
      const fullName = match[1].trim();
      const parts = fullName.split(/\s+/);
      if (parts.length >= 2) {
        return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
      }
    }
  }
  return null;
}

// ── Apply Hunter email pattern to a person's name ─────────────────────────────
function applyHunterPattern(pattern, firstName, lastName, domain) {
  if (!pattern || !firstName || !domain) return null;
  const first = firstName.toLowerCase().replace(/[^a-z]/g, '');
  if (!first) return null; // M1: non-latin name stripped to empty — would produce @domain.com
  const last  = (lastName || '').toLowerCase().replace(/[^a-z]/g, '');
  // If the pattern requires a last name component but we have none, bail out —
  // otherwise patterns like "{first}.{last}" produce "john." with a trailing dot.
  if (!last && (pattern.includes('{last}') || pattern.includes('{l}'))) return null;
  const f     = first[0] || '';
  const l     = last[0]  || '';
  const local = pattern
    .replace('{first}', first)
    .replace('{last}',  last)
    .replace('{f}',     f)
    .replace('{l}',     l);
  if (!local || local.includes('{')) return null;
  return `${local}@${domain}`;
}

// verifyEmailWithHunter removed — replaced by verifyEmail() imported from utils/email_validator.js.
// verifyEmail() adds Apollo email_status as a free Layer 1 gate and returns null (instead of false)
// when Hunter is unavailable, so callers can choose fail-open vs fail-closed per context.


// ── Apollo people search — find an exec by domain ─────────────────────────────
// For M&A signals: searches full C-Suite (CEO, CFO, COO, etc.)
// For all other signal types: searches marketing titles only
async function apolloFindExec(domain, signalType) {
  if (!process.env.APOLLO_API_KEY || !domain) return null;
  if (getBreaker('apollo').isOpen()) {
    console.log(`  [Apollo/exec] ⚡ Circuit open — skipping ${domain}`);
    return null;
  }
  try {
    const baseUrl = process.env.APOLLO_API_URL || 'https://api.apollo.io/v1';
    const titles = signalType === 'M&A Activity'
      ? ['CEO', 'Chief Executive Officer', 'COO', 'Chief Operating Officer',
         'CFO', 'Chief Financial Officer', 'CMO', 'Chief Marketing Officer',
         'President', 'Managing Director', 'Managing Partner']
      : [
          // C-level marketing & brand
          'Chief Marketing Officer', 'CMO',
          'Chief Brand Officer', 'CBO',
          // VP-level (most common decision-maker)
          'VP Marketing', 'VP of Marketing', 'Vice President of Marketing', 'Vice President Marketing',
          'VP Brand', 'VP of Brand', 'VP Brand Marketing',
          // SVP/EVP
          'SVP Marketing', 'SVP of Marketing', 'Senior Vice President of Marketing',
          'EVP Marketing', 'EVP of Marketing',
          // Head/Director (senior enough to own budget)
          'Head of Marketing', 'Head of Brand',
          'Director of Marketing', 'Marketing Director'
        ];
    const res = await axios.post(`${baseUrl}/mixed_people/api_search`, {
      q_person_titles:        titles,
      q_organization_domains: domain,
      per_page:               1
    }, {
      headers: { 'X-Api-Key': process.env.APOLLO_API_KEY, 'Content-Type': 'application/json' },
      timeout: 15000
    });
    getBreaker('apollo').recordSuccess();
    let p = res.data?.people?.[0];
    if (!p?.first_name) {
      console.log(`  [Apollo/exec] ℹ️  No results for ${domain} (${signalType})`);
      return null;
    }
    // Enrich to get last_name if search result didn't include it
    if (p.id && !p.last_name) {
      try {
        const enrichRes = await axios.get(`${baseUrl}/people/${p.id}`, {
          headers: { 'X-Api-Key': process.env.APOLLO_API_KEY },
          timeout: 15000
        });
        p = enrichRes.data?.person || p;
      } catch (enrichErr) { console.warn(`  [Apollo/exec] Enrichment failed for person ${p.id} — using raw search data: ${enrichErr.message}`); }
    }
    return { firstName: p.first_name, lastName: p.last_name || '', title: p.title || null };
  } catch (err) {
    const status = err.response?.status;
    if (status === 401)      console.warn(`  [Apollo/exec] ❌ Unauthorized (401) — check APOLLO_API_KEY`);
    else if (status === 429) console.warn(`  [Apollo/exec] ⏳ Rate limited (429) at ${domain}`);
    else if (status === 422) console.warn(`  [Apollo/exec] ℹ️  422 Unprocessable at ${domain} — domain not in Apollo database`);
    // 422 is a normal "not found" response, NOT an outage — do not trip the circuit
    else {
      console.warn(`  [Apollo/exec] ⚠️  Error at ${domain}: ${err.message}`);
      getBreaker('apollo').recordFailure(err.message);
    }
    return null;
  }
}

// --- Format Helpers ---

function formatSignalDetails(signal) {
  // If this signal was merged in deduplication, its details are already built — preserve them
  if (signal.signalDetails && signal.signalDetails.startsWith('⚡ SIGNAL SEEN')) {
    return signal.signalDetails.length > 2000
      ? signal.signalDetails.substring(0, 1997) + '...'
      : signal.signalDetails;
  }

  let details = '';

  if (signal.type === 'Job Change') {
    if (!signal.person) return '(Job Change — person data missing)';
    const fullName  = `${signal.person.first_name || ''} ${signal.person.last_name || ''}`.trim();
    const revenue   = signal.company.revenue ? formatRevenue(signal.company.revenue) : 'Unknown revenue';
    const employees = signal.company.employee_count
      ? signal.company.employee_count.toLocaleString() + ' employees' // format number
      : 'Unknown employee count';

    details = `${fullName} joined ${signal.company.name} as ${signal.person.title || 'Unknown'}. `;
    details += `Company: ${signal.company.industry || 'Unknown industry'}, ${revenue}, ${employees}.`;
    if (signal.person.job_started_at) {
      details += ` Started: ${formatShortDate(signal.person.job_started_at)}.`;
    }
  }
  else if (signal.type === 'Website Visitor') {
    const fullName  = signal.person
      ? `${signal.person.first_name || ''} ${signal.person.last_name || ''}`.trim()
      : 'Unknown';
    const title     = signal.person?.title || 'Unknown Title';
    const employees = signal.company.employee_count
      ? signal.company.employee_count.toLocaleString() + ' employees'
      : null;
    details = `${fullName} (${title}) from ${signal.company.name} visited the Starfish website.`;
    if (signal.detected_date)    details += ` Visit: ${signal.detected_date}.`;
    if (signal.company.industry) details += ` Industry: ${signal.company.industry}.`;
    if (employees)               details += ` Company size: ${employees}.`;
  }
  else if (signal.type === 'Brand Strategy Intent') {
    // BSI details focus on the company, not the (discarded) AL contact
    const employees = signal.company.employee_count
      ? signal.company.employee_count.toLocaleString() + ' employees'
      : null;
    details = `${signal.company.name} is actively researching brand strategy online.`;
    if (signal.company.industry) details += ` Industry: ${signal.company.industry}.`;
    if (employees)               details += ` Company size: ${employees}.`;
    if (signal.bsi_contacts?.length > 0) {
      details += ` Broadcast contacts: ${signal.bsi_contacts.length} exec(s) identified.`;
    }
  }
  else if (signal.type === 'News/Press') {
    if (!signal.article) return '(News/Press — article data missing)';
    details = signal.article.title || '';
    if (signal.article.description) details += '. ' + signal.article.description;
    details += ` (Published by ${signal.article.source || 'Unknown'} on ${formatShortDate(signal.article.published_at)})`;
  }
  else if (signal.type === 'M&A Activity') {
    if (!signal.deal?.type) return '(M&A Activity — deal data missing)';
    const dealType = signal.deal.type.replace(/_/g, ' ').toUpperCase();
    details = `${dealType}: ${signal.company.name}`;
    if (signal.deal.seller) details += ` acquiring ${signal.deal.seller}`;
    details += signal.deal.amount ? `. Deal value: $${formatNumber(signal.deal.amount)}` : `. Deal value: Undisclosed`;
    if (signal.deal.seller_revenue > 0) details += `. Target revenue: ${formatRevenue(signal.deal.seller_revenue)}`;
    if (signal.deal.description) details += `. ${signal.deal.description}`;
  }
  else if (signal.type === 'Rebrand') {
    details = `${signal.company.name} is rebranding` +
      (signal.rebrand?.new_name ? ` to ${signal.rebrand.new_name}` : '') +
      (signal.rebrand?.summary ? `. ${signal.rebrand.summary}` : '');
  }

  return details.length > 2000 ? details.substring(0, 1997) + '...' : details;
}

// Maps a stored verification result to the Airtable "Email Verified" single-select field.
function getEmailVerifiedStatus(verification) {
  if (!verification) return 'Unverified';
  if (verification.reason === 'apollo_verified') return 'Verified';
  if (verification.reason === 'apollo_likely')   return 'Likely';
  if (verification.flagged === true)             return 'Risky (Flagged)';
  if (verification.valid   === true)             return 'Verified';
  return 'Unverified';
}

// ── Format a single BSI broadcast contact for the Airtable Contact Info field ──
function formatBSIContactInfo(contact, companyWebsite) {
  const name = `${contact.first_name || ''} ${contact.last_name || ''}`.trim();
  let info = '';
  if (name)               info += `Name: ${name}`;
  if (contact.title)      info += `\nTitle: ${contact.title}`;
  if (contact.email)      info += `\nEmail: ${contact.email}${contact.email_flagged ? ' [unverified]' : ''}`;
  if (contact.linkedin_url) info += `\nLinkedIn: ${contact.linkedin_url}`;
  if (!contact.email && !contact.linkedin_url && companyWebsite) info += `\nWebsite: ${companyWebsite}`;
  if (contact.email_flagged) info += `\nEmail flagged as risky — verify before sending`;
  return info.length > 500 ? info.substring(0, 497) + '...' : info || 'Contact info not available';
}

function formatContactInfo(signal) {
  let info = '';

  if ((signal.type === 'Job Change' || signal.source === 'AudienceLab') && signal.person) {
    const name = `${signal.person.first_name || ''} ${signal.person.last_name || ''}`.trim();
    info = `Name: ${name}\nTitle: ${signal.person.title || 'Unknown'}`;
    if (signal.person.linkedin_url)  info += `\nLinkedIn: ${signal.person.linkedin_url}`;
    if (signal.person.email)         info += `\nEmail: ${signal.person.email}${signal._email_flagged ? ' [unverified]' : ''}`;
    else if (signal._puppeteer_email) info += `\nEmail: ${signal._puppeteer_email}${signal._email_flagged ? ' [unverified]' : ''} (via ${signal._puppeteer_source})`;
    if (signal._email_flagged)       info += `\nEmail flagged as risky — verify before sending`;
    if (signal.person.phone)         info += `\nPhone: ${signal.person.phone}`;
    if (signal.person.department)    info += `\nDept: ${signal.person.department}`;
  } else if (signal.type === 'M&A Activity' && signal.ma_contacts?.length > 0) {
    // M&A — list C-Suite contacts of the acquiring company
    // Build lines individually and stop before hitting the 500-char Airtable field limit
    const lines = [];
    let total = 0;
    for (const c of signal.ma_contacts) {
      let line = `${c.name} — ${c.title || 'Unknown Title'}`;
      if (c.email)        line += ` | ${c.email}${c.email_flagged ? ' [unverified]' : ''}`;
      if (c.linkedin_url) line += ` | ${c.linkedin_url}`;
      if (total + line.length + 1 > 490) break; // +1 for \n, leave headroom
      lines.push(line);
      total += line.length + 1;
    }
    info = lines.join('\n');
  } else {
    // News/Press or M&A with no contacts found
    if (signal._puppeteer_email) {
      info = `Email: ${signal._puppeteer_email}${signal._email_flagged ? ' [unverified]' : ''} (via ${signal._puppeteer_source})`;
    } else if (signal.company.website) {
      info = `Company Website: ${signal.company.website}`;
    } else {
      info = 'Contact info not available';
    }
  }

  return info.length > 500 ? info.substring(0, 497) + '...' : info;
}

// bsiContact: undefined = non-BSI signal (use formatContactInfo)
//             null      = BSI with no contacts found ("Contact Needed")
//             object    = one BSI broadcast contact (use formatBSIContactInfo)
function formatForAirtable(signal, bsiContact) {
  // Compute and cache Signal Details on the signal object before writing to Airtable.
  // Without this, workflow_4b (Sheets) and workflow_5 (email) never see what was written here
  // and fall back to their own simpler reconstruction logic — producing three different versions
  // of the same field. With this, all consumers read the same rich string Airtable received.
  // Skip if already set (merged signals have signal.signalDetails from workflow_3).
  if (signal.signalDetails == null) {
    signal.signalDetails = formatSignalDetails(signal);
  }

  let contactInfo;
  if (signal.type === 'Brand Strategy Intent' && bsiContact !== undefined) {
    if (bsiContact) {
      contactInfo = formatBSIContactInfo(bsiContact, signal.company.website);
    } else {
      contactInfo = `⚠️ Contact Needed${signal.company.website ? '\nWebsite: ' + signal.company.website : ''}`;
    }
  } else {
    contactInfo = formatContactInfo(signal);
    // Cache so workflow_4b (Sheets) and workflow_5 (email) show the identical string
    // that was written to Airtable — not a separately rebuilt version.
    // BSI is excluded because each BSI contact produces a different contactInfo string.
    signal._contactInfo = contactInfo;
  }

  return {
    fields: {
      'Company Name':          signal.company.name,
      'Signal Type':           signal.type,
      'Signal Details':        signal.signalDetails,
      'Contact Info':          contactInfo,
      'Company Revenue':       signal.company.revenue || null,
      'Company Funding Stage': signal.company.funding_stage || null,
      'Industry':              signal.company.industry || null,
      'Date Detected':         signal.detected_date,
      'Priority':              signal.priority,
      'Brief':                 signal._enrichment_failed
                                 ? `⚠️ [Email enrichment crashed — contact info may be incomplete. Review before outreach.]\n\n${signal.brief || '(no brief)'}`
                                 : signal._claude_failed
                                   ? `⚠️ [Claude enrichment failed — placeholder priority, not a real analysis]\n\n${signal.brief}`
                                   : signal._auto_approved
                                     ? `${signal.brief}\n\n⏱️ Note: This PDL signal was auto-approved (timeout) — not manually reviewed in Telegram.`
                                     : signal.brief,
      'Contact Approach':      signal.contact_approach,
      'Source URL':            signal.source_url || null,
      'Status':                (signal._claude_failed || signal._enrichment_failed) ? 'Needs Review' : 'New',
      'Email Verified':        (bsiContact && typeof bsiContact === 'object')
                                 ? getEmailVerifiedStatus(bsiContact.emailVerification)
                                 : getEmailVerifiedStatus(signal.emailVerification),
      // L1: 'Send Day' is BSI-only (1–5 for broadcast stagger). null for all other signal types is intentional.
      'Send Day':              (bsiContact && typeof bsiContact === 'object') ? (bsiContact.send_day || null) : null
    }
  };
}

// ── Expand signals to Airtable records ────────────────────────────────────────
// BSI signals expand to one record per broadcast contact (or one "Contact Needed" record).
// All other signal types map 1-to-1.
function expandToRecords(signals) {
  const records = [];
  for (const signal of signals) {
    if (signal.type === 'Brand Strategy Intent') {
      if (signal.bsi_contacts?.length > 0) {
        // Hard cap at 5 contacts per signal — Airtable batches are 10 records max and
        // one signal expanding to 10+ records would overflow a single batch and cause failures.
        const contacts = signal.bsi_contacts.slice(0, 5);
        for (const contact of contacts) {
          const record = sanitizeAirtableRecord(formatForAirtable(signal, contact));
          if (record) records.push(record);
        }
      } else {
        const record = sanitizeAirtableRecord(formatForAirtable(signal, null));
        if (record) records.push(record);
      }
    } else {
      const record = sanitizeAirtableRecord(formatForAirtable(signal));
      if (record) records.push(record);
    }
  }
  return records;
}

function chunkArray(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

// Validate and sanitize a record before sending to Airtable.
// - Drops records missing required fields (returns null — caller skips)
// - Replaces undefined values with null (Airtable API rejects undefined)
// - Truncates long-text fields to Airtable's 100,000-char hard limit
const AIRTABLE_TEXT_LIMIT = 100_000;
const AIRTABLE_REQUIRED   = ['Company Name', 'Signal Type', 'Date Detected'];

function sanitizeAirtableRecord(record) {
  const fields = record.fields;
  for (const key of AIRTABLE_REQUIRED) {
    if (!fields[key]) {
      console.warn(`[Airtable/Validation] Dropping record — missing required field: "${key}" (Company: ${fields['Company Name'] || '?'})`);
      return null;
    }
  }
  const cleaned = {};
  for (const [key, val] of Object.entries(fields)) {
    if (val === undefined) {
      cleaned[key] = null;
    } else if (typeof val === 'string' && val.length > AIRTABLE_TEXT_LIMIT) {
      console.warn(`[Airtable/Validation] Field "${key}" truncated (${val.length} → ${AIRTABLE_TEXT_LIMIT}) for: ${fields['Company Name']}`);
      cleaned[key] = val.slice(0, AIRTABLE_TEXT_LIMIT);
    } else {
      cleaned[key] = val;
    }
  }
  return { fields: cleaned };
}

// --- Main Workflow ---

async function saveToAirtable(deduplicatedSignals) {
  const today    = getTodayStamp();
  const todayStr = getTodayString();

  if (deduplicatedSignals.length === 0) {
    console.log('[Airtable] No signals to save — skipping');
    return 0;
  }

  // Per-run Apollo enrichment cache — avoids duplicate API calls for the same company
  const apolloCache = new Map(); // domain/name → enrichment result for this run

  // Step 4.1: Apollo company enrichment — fill missing revenue, industry, AND website
  // Runs for any signal missing revenue OR website, so Hunter has a domain to work with later.
  console.log('[Airtable] Running Apollo company enrichment...');
  for (const signal of deduplicatedSignals) {
    // Check KNOWN_DOMAINS first — instant, no API call needed
    if (!signal.company.website) {
      const knownDomain = getKnownDomain(signal.company.name);
      if (knownDomain) {
        signal.company.website = `https://${knownDomain}`;
        console.log(`  [Domain] ✅ ${signal.company.name} → ${knownDomain} (KNOWN_DOMAINS)`);
      }
    }

    const needsRevenue = !signal.company.revenue || signal.company.revenue === 0;
    const needsWebsite = !signal.company.website;
    if (!needsRevenue && !needsWebsite) continue; // already have both — skip

    // Only worth calling Apollo if we have a domain or company name
    const website = signal.company.website;
    const name    = signal.company.name;
    if (!website && !name) continue;

    // Check Apollo cache before making an API call.
    // Prefer domain as cache key — it's unambiguous. When no website is available, fall back
    // to a name-based key so the same company isn't queried twice in the same run.
    // Name keys are prefixed with 'name:' to avoid collisions with domain keys.
    const cacheKey = website
      ? website.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/.*$/, '')
      : `name:${name.toLowerCase().trim()}`;
    if (apolloCache.has(cacheKey)) {
      const org = apolloCache.get(cacheKey);
      if (org.website_url && !signal.company.website) {
        signal.company.website = org.website_url;
      }
      const _rev = Number(org.annual_revenue || org.estimated_annual_revenue);
      if (!isNaN(_rev) && _rev > 0 && !signal.company.revenue) {
        signal.company.revenue = _rev;
      }
      signal.company.industry  = signal.company.industry  || org.industry    || null;
      if (signal.company.headquarters) {
        signal.company.headquarters.country = signal.company.headquarters.country || org.country || null;
        signal.company.headquarters.state   = signal.company.headquarters.state   || org.state   || null;
      } else {
        signal.company.headquarters = { city: null, state: org.state || null, country: org.country || null };
      }
      console.log(`  [Apollo] ♻️  ${name} — using cached result`);
      continue;
    }

    try {
      const baseUrl = process.env.APOLLO_API_URL || 'https://api.apollo.io/v1';
      const body = {};
      if (website) {
        body.domain = website.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/.*$/, '');
      } else {
        body.name = name;
      }

      const res = await axios.post(`${baseUrl}/organizations/enrich`, body, {
        headers: { 'X-Api-Key': process.env.APOLLO_API_KEY, 'Content-Type': 'application/json' },
        timeout: 15000
      });
      const org = res.data?.organization || res.data || {};
      // Cache the result — keyed by domain when available, otherwise by 'name:<normalized>'.
      // Both are prefixed differently so they can't collide with each other.
      apolloCache.set(cacheKey, org);

      // Always save website when Apollo finds it — Hunter needs this domain
      if (org.website_url && !signal.company.website) {
        signal.company.website = org.website_url;
        console.log(`  [Apollo] 🌐 ${name} — website: ${org.website_url}`);
      }

      const _rev = Number(org.annual_revenue || org.estimated_annual_revenue);
      if (!isNaN(_rev) && _rev > 0 && !signal.company.revenue) {
        signal.company.revenue = _rev;
        console.log(`  [Apollo] ✅ ${name} — revenue $${(_rev/1e6).toFixed(0)}M`);
      }
      signal.company.industry  = signal.company.industry  || org.industry    || null;
      if (signal.company.headquarters) {
        signal.company.headquarters.country = signal.company.headquarters.country || org.country || null;
        signal.company.headquarters.state   = signal.company.headquarters.state   || org.state   || null;
      } else {
        signal.company.headquarters = { city: null, state: org.state || null, country: org.country || null };
      }
    } catch { /* Apollo error — skip, not critical */ }

    await new Promise(r => setTimeout(r, 400));
  }

  // Step 4.2: Email enrichment — Apollo → Hunter → Puppeteer
  // Runs up to 5 signals concurrently to reduce wall-clock time at scale.
  // Each signal is its own object — parallel mutation is safe.
  // Uses `return` (not `continue`) because this is a standalone async function.
  // Override with ENRICHMENT_CONCURRENCY env var (see execution/utils/config.js for all options)
  const ENRICHMENT_CONCURRENCY = Number(process.env.ENRICHMENT_CONCURRENCY) || 5;
  console.log(`[Airtable] Running email enrichment (Apollo → Hunter → Puppeteer) [concurrency: ${ENRICHMENT_CONCURRENCY}]...`);

  async function enrichOneSignal(signal) {
    console.log(`[Email Enrichment] Starting cascade for: ${signal.company.name} (${signal.type})`);

    // ── Brand Strategy Intent: 4-Tier Contact Waterfall ──────────────────────
    //
    // Tier 1: AL sent the right person WITH a valid email → use them, done.
    // Tier 2: Find ONE marketing/brand decision-maker ourselves → one record.
    // Tier 3: Can't find marketing person → broadcast to up to 5 senior leaders.
    // Tier 4: All cascades exhausted → flag "Contact Needed" for Carly.
    //
    // signal.person is always cleared — contacts live in signal.bsi_contacts[].
    if (signal.type === 'Brand Strategy Intent') {
      const alPerson = signal.person;
      const alTitle  = (alPerson?.title || '').toLowerCase().trim();
      // Marketing/brand titles are the Tier 2 target — matches HUNTER_BSI_TITLE_KEYWORDS
      const alTitleIsBrandMarketing = alTitle && HUNTER_BSI_TITLE_KEYWORDS.some(k => alTitle.includes(k));

      signal.person       = null; // never let the raw AL contact leak into Airtable
      signal.bsi_contacts = [];

      // ── TIER 1: AL sent the right person with a valid email ─────────────────
      // Perfect case — one contact, one record, no APIs needed.
      if (alPerson?.first_name && alTitleIsBrandMarketing) {
        if (alPerson.email && !isFakeEmail(alPerson.email)) {
          // T1 AudienceLab contacts are identity-resolved — isFakeEmail() gate only, no Hunter verifier.
          signal.bsi_contacts.push({
            first_name:   alPerson.first_name,
            last_name:    alPerson.last_name  || '',
            title:        alPerson.title,
            email:        alPerson.email,
            linkedin_url: alPerson.linkedin_url || null,
            source:       'audiencelab',
            send_day:     assignSendDay(alPerson.title)
          });
          console.log(`  [BSI/T1] ✅ AL has right person + email — ${alPerson.first_name} ${alPerson.last_name} (${alPerson.title}) → ${alPerson.email}`);
          console.log(`  [BSI] ✅ ${signal.company.name} — Tier 1 complete`);
          return;
        }
      }

      // ── Discover domain (needed for all remaining tiers) ────────────────────
      if (!signal.company.website) {
        const discovered = await findCompanyDomain(signal.company.name);
        if (discovered) {
          signal.company.website = `https://${discovered}`;
          console.log(`  [Domain] ✅ ${signal.company.name} → ${discovered} (via Puppeteer)`);
        }
        await new Promise(r => setTimeout(r, 400));
      }
      const bsiDomain = extractDomain(signal.company?.website);

      // ── TIER 2: Find ONE marketing/brand decision-maker ─────────────────────
      // Target titles: CMO, VP Marketing, Brand Director, Head of Marketing, etc.
      // Stop as soon as we find one — that's enough for our campaign.
      // Order: Apollo first (highest quality) → Hunter person-finder → Hunter domain-search.
      console.log(`  [BSI/T2] Looking for a marketing/brand contact at ${signal.company.name}...`);

      // Step 2.1: Apollo exec search (marketing titles only) — PRIMARY source
      // Apollo has verified professional data and searches by exact title — best quality contact.
      if (bsiDomain && !getBreaker('apollo').isOpen()) {
        const exec = await apolloFindExec(bsiDomain, 'Brand Strategy Intent');
        if (exec) {
          signal.bsi_contacts.push({
            first_name:   exec.firstName,
            last_name:    exec.lastName || '',
            title:        exec.title    || null,
            email:        null,
            linkedin_url: exec.linkedin_url || null,
            source:       'apollo',
            send_day:     assignSendDay(exec.title)
          });
          console.log(`  [BSI/T2] ✅ Apollo found: ${exec.firstName} ${exec.lastName} (${exec.title})`);
        } else {
          console.log(`  [BSI/T2] ℹ️  Apollo found no marketing contact at ${bsiDomain} — trying Hunter...`);
        }
        await new Promise(r => setTimeout(r, 400));
      }

      // Step 2.2: Hunter person-finder for the AudienceLab contact — FIRST BACKUP
      // Only runs if Apollo found nothing AND AudienceLab gave us a person with the right title but no email.
      if (signal.bsi_contacts.length === 0 && alPerson?.first_name && alTitleIsBrandMarketing && bsiDomain && process.env.HUNTER_API_KEY && !getBreaker('hunter').isOpen()) {
        console.log(`  [BSI/T2] AL has ${alPerson.title} but no email — trying Hunter for ${alPerson.first_name} ${alPerson.last_name}...`);
        try {
          const hRes = await axios.get('https://api.hunter.io/v2/email-finder', {
            params: { domain: bsiDomain, first_name: alPerson.first_name, last_name: alPerson.last_name || '', api_key: process.env.HUNTER_API_KEY },
            timeout: 15000
          });
          getBreaker('hunter').recordSuccess();
          const { email: hEmail, score } = hRes.data?.data || {};
          if (hEmail && score >= 70 && !isFakeEmail(hEmail)) {
            const { valid, flagged, reason } = await verifyEmail(hEmail, 'hunter', null);
            await new Promise(r => setTimeout(r, 400));
            if (valid) {
              if (flagged) console.log(`  [BSI/T2] ⚠️  ${hEmail} flagged as risky (${reason}) — saving with [unverified] note`);
              signal.bsi_contacts.push({
                first_name:   alPerson.first_name,
                last_name:    alPerson.last_name  || '',
                title:        alPerson.title,
                email:        hEmail,
                email_flagged:    flagged || undefined,
                emailVerification: { valid, flagged, reason },
                linkedin_url: alPerson.linkedin_url || null,
                source:       'audiencelab+hunter',
                send_day:     assignSendDay(alPerson.title)
              });
              console.log(`  [BSI/T2] ✅ Found email for AL contact → ${hEmail} (score ${score})`);
            } else {
              console.log(`  [BSI/T2] ❌ ${hEmail} failed verification (${reason}) — keeping AL contact without email`);
              if (alPerson.linkedin_url) {
                signal.bsi_contacts.push({
                  first_name:   alPerson.first_name,
                  last_name:    alPerson.last_name  || '',
                  title:        alPerson.title,
                  email:        null,
                  linkedin_url: alPerson.linkedin_url,
                  source:       'audiencelab',
                  send_day:     assignSendDay(alPerson.title)
                });
              }
            }
          } else if (alPerson.linkedin_url) {
            // Keep them with LinkedIn only — right person even without email
            signal.bsi_contacts.push({
              first_name:   alPerson.first_name,
              last_name:    alPerson.last_name  || '',
              title:        alPerson.title,
              email:        null,
              linkedin_url: alPerson.linkedin_url,
              source:       'audiencelab',
              send_day:     assignSendDay(alPerson.title)
            });
            console.log(`  [BSI/T2] ℹ️  No email found — keeping AL contact with LinkedIn only`);
          }
        } catch (err) {
          const status = err.response?.status;
          if (status === 429)      console.warn(`  [BSI/T2] ⏳ Hunter rate limited (429)`);
          else if (status === 401) console.warn(`  [BSI/T2] ❌ Hunter unauthorized (401)`);
          else { console.warn(`  [BSI/T2] ⚠️  Hunter error: ${err.message}`); getBreaker('hunter').recordFailure(err.message); }
        }
        await new Promise(r => setTimeout(r, 400));
      }

      // Step 2.3: Hunter domain-search filtered to marketing/brand titles — SECOND BACKUP
      // Only runs if both Apollo and the AL person lookup came up empty.
      if (signal.bsi_contacts.length === 0 && bsiDomain && process.env.HUNTER_API_KEY && !getBreaker('hunter').isOpen()) {
        console.log(`  [BSI/T2] Searching Hunter for marketing/brand contact at ${bsiDomain}...`);
        try {
          const hDomRes = await axios.get('https://api.hunter.io/v2/domain-search', {
            params: { domain: bsiDomain, api_key: process.env.HUNTER_API_KEY },
            timeout: 15000
          });
          getBreaker('hunter').recordSuccess();
          const hEmails  = hDomRes.data?.data?.emails || [];
          const bsiMatch = hEmails.find(e => {
            const pos  = (e.position   || '').toLowerCase();
            const dept = (e.department || '').toLowerCase();
            return HUNTER_BSI_TITLE_KEYWORDS.some(k => pos.includes(k)) ||
                   HUNTER_BSI_DEPT_KEYWORDS.some(k => dept.includes(k));
          });
          // Reject contacts with no first name — a generic dept mailbox with no person is useless
          if (bsiMatch && bsiMatch.first_name) {
            let bsiMatchEmail = null;
            let bsiMatchEmailFlagged;
            let bsiMatchEmailVerification;
            if (bsiMatch.value && !isFakeEmail(bsiMatch.value)) {
              const { valid, flagged, reason } = await verifyEmail(bsiMatch.value, 'hunter', null);
              await new Promise(r => setTimeout(r, 400));
              if (valid) {
                bsiMatchEmail             = bsiMatch.value;
                bsiMatchEmailFlagged      = flagged || undefined;
                bsiMatchEmailVerification = { valid, flagged, reason };
                if (flagged) console.log(`  [BSI/T2] ⚠️  ${bsiMatch.value} flagged as risky (${reason}) — saving with [unverified] note`);
              } else {
                console.log(`  [BSI/T2] ❌ ${bsiMatch.value} failed verification (${reason})`);
              }
            }
            signal.bsi_contacts.push({
              first_name:        bsiMatch.first_name,
              last_name:         bsiMatch.last_name  || '',
              title:             bsiMatch.position   || null,
              email:             bsiMatchEmail,
              email_flagged:     bsiMatchEmailFlagged,
              emailVerification: bsiMatchEmailVerification,
              linkedin_url:      bsiMatch.linkedin   || null,
              source:            'hunter',
              send_day:          assignSendDay(bsiMatch.position)
            });
            console.log(`  [BSI/T2] ✅ Hunter found: ${bsiMatch.first_name} ${bsiMatch.last_name} (${bsiMatch.position})${bsiMatchEmail ? ` → ${bsiMatchEmail}` : ' — no email'}`);
          } else if (bsiMatch) {
            console.log(`  [BSI/T2] ℹ️  Hunter matched a role at ${bsiDomain} but no person name — skipping (generic mailbox)`);
          } else {
            console.log(`  [BSI/T2] ℹ️  Hunter has no marketing/brand contact at ${bsiDomain}`);
          }
        } catch (err) {
          const status = err.response?.status;
          if (status === 429)      console.warn(`  [BSI/T2] ⏳ Hunter rate limited (429) at ${bsiDomain}`);
          else if (status === 401) console.warn(`  [BSI/T2] ❌ Hunter unauthorized (401)`);
          else { console.warn(`  [BSI/T2] ⚠️  Hunter domain-search error: ${err.message}`); getBreaker('hunter').recordFailure(err.message); }
        }
        await new Promise(r => setTimeout(r, 400));
      }

      // Step 2.4: Fill email for the Tier 2 contact if they have a name but no email
      const t2Found = signal.bsi_contacts[0];
      if (t2Found && !t2Found.email && t2Found.first_name && bsiDomain) {
        // Hunter person-finder — requires last name, skip if missing to avoid guaranteed 400 errors
        if (process.env.HUNTER_API_KEY && !getBreaker('hunter').isOpen() && t2Found.last_name) {
          try {
            const hRes = await axios.get('https://api.hunter.io/v2/email-finder', {
              params: { domain: bsiDomain, first_name: t2Found.first_name, last_name: t2Found.last_name || '', api_key: process.env.HUNTER_API_KEY },
              timeout: 15000
            });
            getBreaker('hunter').recordSuccess();
            const { email: hEmail, score } = hRes.data?.data || {};
            if (hEmail && score >= 70 && !isFakeEmail(hEmail)) {
              const { valid, flagged, reason } = await verifyEmail(hEmail, 'hunter', null);
              await new Promise(r => setTimeout(r, 400));
              if (valid) {
                t2Found.email = hEmail;
                t2Found.email_flagged    = flagged || undefined;
                t2Found.emailVerification = { valid, flagged, reason };
                if (flagged) console.log(`  [BSI/T2] ⚠️  ${hEmail} flagged as risky (${reason}) — saving with [unverified] note`);
                console.log(`  [BSI/T2] ✅ Hunter email: ${t2Found.first_name} ${t2Found.last_name} → ${hEmail} (score ${score})`);
              } else {
                console.log(`  [BSI/T2] ❌ ${hEmail} failed verification (${reason}) for ${t2Found.first_name} ${t2Found.last_name} — trying pattern...`);
              }
            } else if (hEmail) {
              console.log(`  [BSI/T2] ⚠️  ${t2Found.first_name} ${t2Found.last_name} → ${hEmail} rejected (score ${score || 'n/a'}${isFakeEmail(hEmail) ? ', fake' : ', below threshold'})`);
            } else {
              console.log(`  [BSI/T2] ℹ️  No email found for ${t2Found.first_name} ${t2Found.last_name} — trying pattern...`);
            }
          } catch (err) {
            const status = err.response?.status;
            if (status === 429)      console.warn(`  [BSI/T2] ⏳ Hunter rate limited (429)`);
            else if (status === 401) console.warn(`  [BSI/T2] ❌ Hunter unauthorized (401)`);
            else { console.warn(`  [BSI/T2] ⚠️  Hunter error: ${err.message}`); getBreaker('hunter').recordFailure(err.message); }
          }
          await new Promise(r => setTimeout(r, 400));
        }

        // Pattern construction if Hunter person-finder also came up empty
        if (!t2Found.email && process.env.HUNTER_API_KEY) {
          let t2Pattern = null;
          try {
            const patRes = await axios.get('https://api.hunter.io/v2/domain-search', {
              params: { domain: bsiDomain, api_key: process.env.HUNTER_API_KEY },
              timeout: 15000
            });
            t2Pattern = patRes.data?.data?.pattern || null;
            if (t2Pattern) console.log(`  [Pattern/BSI/T2] Hunter pattern: "${t2Pattern}"`);
            else           console.log(`  [Pattern/BSI/T2] Hunter has no pattern — trying Puppeteer...`);
          } catch (err) {
            const status = err.response?.status;
            if (status === 429) console.warn(`  [Pattern/BSI/T2] ⏳ Hunter rate limited`);
            else console.warn(`  [Pattern/BSI/T2] ⚠️  Hunter error: ${err.message}`);
          }
          await new Promise(r => setTimeout(r, 400));

          if (!t2Pattern) {
            const patResult = await findEmailPatternViaGoogle(bsiDomain);
            t2Pattern = patResult?.pattern || null;
            if (t2Pattern) console.log(`  [Pattern/BSI/T2] Puppeteer pattern: "${t2Pattern}"`);
            await new Promise(r => setTimeout(r, 600));
          }

          if (t2Pattern) {
            const constructed = applyHunterPattern(t2Pattern, t2Found.first_name, t2Found.last_name, bsiDomain);
            if (constructed && !isFakeEmail(constructed)) {
              console.log(`  [Pattern/BSI/T2] "${t2Pattern}" → ${constructed} — verifying...`);
              const { valid, flagged, reason } = await verifyEmail(constructed, 'hunter', null);
              await new Promise(r => setTimeout(r, 400));
              if (valid) {
                t2Found.email = constructed;
                t2Found.email_flagged    = flagged || undefined;
                t2Found.emailVerification = { valid, flagged, reason };
                if (flagged) console.log(`  [Pattern/BSI/T2] ⚠️  ${constructed} flagged as risky (${reason}) — saving with [unverified] note`);
                console.log(`  [Pattern/BSI/T2] ✅ ${t2Found.first_name} ${t2Found.last_name} → ${constructed}`);
              } else {
                console.log(`  [Pattern/BSI/T2] ❌ ${constructed} failed verification (${reason})`);
              }
            }
          }
        }
      }

      // ── TIER 2 SUCCESS CHECK ─────────────────────────────────────────────────
      // A contact only counts if they are actually reachable — email OR LinkedIn.
      // A name with no way to reach them is useless and must not block Tier 3.
      // Also run the strict title check here: Apollo isn't always perfectly precise and
      // can occasionally return someone whose actual title doesn't match the searched title.
      const t2Contact = signal.bsi_contacts[0];
      if (t2Contact) {
        if (t2Contact.email || t2Contact.linkedin_url) {
          if (!isBSIAllowedTitle(t2Contact.title)) {
            // Reachable but wrong role — drop and fall through to Tier 3
            const t2Name = `${t2Contact.first_name} ${t2Contact.last_name}`.trim();
            console.log(`  [BSI/T2] ⛔ ${t2Name} (${t2Contact.title || 'Unknown Title'}) — not a Starfish target role — falling through to Tier 3`);
            signal.bsi_contacts = [];
          } else {
            console.log(`  [BSI] ✅ ${signal.company.name} — Tier 2: ${t2Contact.first_name} ${t2Contact.last_name} (${t2Contact.title})${t2Contact.email ? ` → ${t2Contact.email}` : ' — LinkedIn only'}`);
            return;
          }
        } else {
          // Found a name but no way to reach them — drop and fall through to Tier 3
          console.log(`  [BSI/T2] ⚠️  ${t2Contact.first_name} ${t2Contact.last_name} found but unreachable (no email, no LinkedIn) — falling through to Tier 3`);
          signal.bsi_contacts = [];
        }
      }

      // ── TIER 3: Broadcast to senior leaders ─────────────────────────────────
      // No marketing/brand person found anywhere. Go wide:
      // CEO, COO, President, anyone in Marketing or Communications. Up to 5.
      console.log(`  [BSI/T3] No marketing contact found — broadcasting to senior leaders at ${signal.company.name}...`);

      if (bsiDomain) {
        // Step 3.1: Apollo broadcast search (CEO, COO, President, Marketing, Comms)
        if (!getBreaker('apollo').isOpen()) {
          const apolloContacts = await apolloBroadcastSearch(bsiDomain);
          for (const c of apolloContacts) {
            if (signal.bsi_contacts.length >= 5) break;
            if (!c.firstName?.trim()) continue; // skip contacts with no name — unreachable
            const apolloEmail = c.email && !isFakeEmail(c.email) ? c.email : null;
            signal.bsi_contacts.push({
              first_name:        c.firstName,
              last_name:         c.lastName,
              title:             c.title,
              email:             apolloEmail,
              // Apollo broadcast emails come from a professional database — mark valid so
              // getEmailVerifiedStatus() doesn't incorrectly show 'Unverified' in Airtable.
              // Step 3.3 will run Hunter person-finder for contacts still missing email.
              emailVerification: apolloEmail ? { valid: true, flagged: false, reason: 'apollo_broadcast' } : undefined,
              linkedin_url:      c.linkedin_url,
              source:            'apollo',
              send_day:          assignSendDay(c.title)
            });
            console.log(`  [BSI/T3] ➕ Apollo: ${c.firstName} ${c.lastName} (${c.title})${apolloEmail ? ` ✉️ ${apolloEmail}` : ''}`);
          }
          if (apolloContacts.length === 0) console.log(`  [BSI/T3] ℹ️  Apollo found no contacts at ${bsiDomain}`);
          await new Promise(r => setTimeout(r, 400));
        }

        // Step 3.2: Hunter domain-search fallback (broader exec titles)
        if (signal.bsi_contacts.length === 0 && process.env.HUNTER_API_KEY && !getBreaker('hunter').isOpen()) {
          console.log(`  [BSI/T3] Apollo found nothing — trying Hunter domain-search at ${bsiDomain}...`);
          try {
            const hDomRes = await axios.get('https://api.hunter.io/v2/domain-search', {
              params: { domain: bsiDomain, api_key: process.env.HUNTER_API_KEY },
              timeout: 15000
            });
            getBreaker('hunter').recordSuccess();
            const hEmails     = hDomRes.data?.data?.emails || [];
            const execMatches = hEmails.filter(e => {
              const pos  = (e.position   || '').toLowerCase();
              const dept = (e.department || '').toLowerCase();
              return HUNTER_EXEC_TITLE_KEYWORDS.some(k => pos.includes(k)) ||
                     HUNTER_EXEC_DEPT_KEYWORDS.some(k => dept.includes(k));
            });
            for (const e of execMatches) {
              if (signal.bsi_contacts.length >= 5) break;
              if (!e.first_name?.trim()) continue; // skip contacts with no name — unreachable
              const email = e.value && !isFakeEmail(e.value) ? e.value : null;
              signal.bsi_contacts.push({
                first_name:   e.first_name,
                last_name:    e.last_name  || '',
                title:        e.position   || null,
                email,
                // Hunter domain-search emails pass isFakeEmail() — mark valid so
                // getEmailVerifiedStatus() doesn't incorrectly show 'Unverified' in Airtable.
                // Step 3.3 will run Hunter person-finder for contacts still missing email.
                emailVerification: email ? { valid: true, flagged: false, reason: 'hunter_domain' } : undefined,
                linkedin_url: e.linkedin   || null,
                source:       'hunter',
                send_day:     assignSendDay(e.position)
              });
              console.log(`  [BSI/T3] ➕ Hunter: ${e.first_name} ${e.last_name} (${e.position})${email ? ` ✉️ ${email}` : ''}`);
            }
            if (signal.bsi_contacts.length === 0) console.log(`  [BSI/T3] ℹ️  Hunter also found no contacts at ${bsiDomain}`);
          } catch (err) {
            const status = err.response?.status;
            if (status === 429)      console.warn(`  [BSI/T3] ⏳ Hunter rate limited (429) at ${bsiDomain}`);
            else if (status === 401) console.warn(`  [BSI/T3] ❌ Hunter unauthorized (401)`);
            else { console.warn(`  [BSI/T3] ⚠️  Hunter error: ${err.message}`); getBreaker('hunter').recordFailure(err.message); }
          }
          await new Promise(r => setTimeout(r, 400));
        }

        // Step 3.3: Hunter person-finder for each T3 contact still missing email
        if (signal.bsi_contacts.length > 0 && process.env.HUNTER_API_KEY) {
          for (const contact of signal.bsi_contacts) {
            if (contact.email || !contact.first_name) continue;
            // Hunter requires both first AND last name — skip if no last name to avoid a
            // guaranteed 400 error that records a circuit breaker failure.
            if (!contact.last_name) {
              console.log(`  [BSI/T3] ⏭️  Skipping Hunter for ${contact.first_name} (${contact.title || 'Unknown Title'}) — no last name`);
              continue;
            }
            console.log(`  [BSI/T3] Hunter searching for ${contact.first_name} ${contact.last_name} (${contact.title || 'Unknown Title'}) at ${bsiDomain}...`);
            try {
              const hRes = await axios.get('https://api.hunter.io/v2/email-finder', {
                params: { domain: bsiDomain, first_name: contact.first_name, last_name: contact.last_name || '', api_key: process.env.HUNTER_API_KEY },
                timeout: 15000
              });
              const { email: hEmail, score } = hRes.data?.data || {};
              if (hEmail && score >= 70 && !isFakeEmail(hEmail)) {
                const { valid, flagged, reason } = await verifyEmail(hEmail, 'hunter', null);
                await new Promise(r => setTimeout(r, 400));
                if (valid) {
                  contact.email = hEmail;
                  contact.email_flagged    = flagged || undefined;
                  contact.emailVerification = { valid, flagged, reason };
                  if (flagged) console.log(`  [BSI/T3] ⚠️  ${hEmail} flagged as risky (${reason}) — saving with [unverified] note`);
                  console.log(`  [BSI/T3] ✅ Hunter: ${contact.first_name} ${contact.last_name} → ${hEmail} (score ${score})`);
                } else {
                  console.log(`  [BSI/T3] ❌ ${hEmail} failed verification (${reason}) for ${contact.first_name} ${contact.last_name} — will try pattern`);
                }
              } else if (hEmail) {
                console.log(`  [BSI/T3] ⚠️  ${contact.first_name} ${contact.last_name} → ${hEmail} rejected (score ${score || 'n/a'}${isFakeEmail(hEmail) ? ', fake' : ', below threshold'})`);
              } else {
                console.log(`  [BSI/T3] ℹ️  No email found for ${contact.first_name} ${contact.last_name} — will use LinkedIn or pattern`);
              }
            } catch (err) {
              const status = err.response?.status;
              if (status === 429)      console.warn(`  [BSI/T3] ⏳ Hunter rate limited (429) for ${contact.first_name} ${contact.last_name}`);
              else if (status === 401) console.warn(`  [BSI/T3] ❌ Hunter unauthorized (401) — check HUNTER_API_KEY`);
              else {
                console.warn(`  [BSI/T3] ⚠️  Hunter error for ${contact.first_name} ${contact.last_name}: ${err.message}`);
                getBreaker('hunter').recordFailure(err.message);
              }
            }
            await new Promise(r => setTimeout(r, 400));
          }
        }

        // Step 3.4: Pattern construction for T3 contacts still missing email
        const t3NeedingEmail = signal.bsi_contacts.filter(c => !c.email && c.first_name && c.last_name);
        if (t3NeedingEmail.length > 0 && process.env.HUNTER_API_KEY) {
          let t3Pattern = null;
          try {
            const patRes = await axios.get('https://api.hunter.io/v2/domain-search', {
              params: { domain: bsiDomain, api_key: process.env.HUNTER_API_KEY },
              timeout: 15000
            });
            t3Pattern = patRes.data?.data?.pattern || null;
            if (t3Pattern) console.log(`  [Pattern/BSI/T3] Hunter pattern: "${t3Pattern}"`);
            else           console.log(`  [Pattern/BSI/T3] Hunter has no pattern — trying Puppeteer...`);
          } catch (err) {
            const status = err.response?.status;
            if (status === 429) console.warn(`  [Pattern/BSI/T3] ⏳ Hunter rate limited`);
            else console.warn(`  [Pattern/BSI/T3] ⚠️  Hunter error: ${err.message}`);
          }
          await new Promise(r => setTimeout(r, 400));

          if (!t3Pattern) {
            const patResult = await findEmailPatternViaGoogle(bsiDomain);
            t3Pattern = patResult?.pattern || null;
            if (t3Pattern) console.log(`  [Pattern/BSI/T3] Puppeteer pattern: "${t3Pattern}"`);
            await new Promise(r => setTimeout(r, 600));
          }

          if (t3Pattern) {
            for (const contact of t3NeedingEmail) {
              const constructed = applyHunterPattern(t3Pattern, contact.first_name, contact.last_name, bsiDomain);
              if (!constructed || isFakeEmail(constructed)) continue;
              console.log(`  [Pattern/BSI/T3] "${t3Pattern}" → ${constructed} — verifying...`);
              const { valid, flagged, reason } = await verifyEmail(constructed, 'hunter', null);
              await new Promise(r => setTimeout(r, 400));
              if (valid) {
                contact.email = constructed;
                contact.email_flagged    = flagged || undefined;
                contact.emailVerification = { valid, flagged, reason };
                if (flagged) console.log(`  [Pattern/BSI/T3] ⚠️  ${constructed} flagged as risky (${reason}) — saving with [unverified] note`);
                console.log(`  [Pattern/BSI/T3] ✅ ${contact.first_name} ${contact.last_name} → ${constructed}`);
              } else {
                console.log(`  [Pattern/BSI/T3] ❌ ${constructed} failed verification (${reason})`);
              }
            }
          }
        }
      } else {
        console.log(`  [BSI] ⚠️  ${signal.company.name} — no domain found, cannot run broadcast search`);
      }

      // ── TIER 3 REACHABILITY FILTER ───────────────────────────────────────────
      // Drop any broadcast contact with no email AND no LinkedIn — completely unreachable.
      const unreachable = signal.bsi_contacts.filter(c => !c.email && !c.linkedin_url);
      if (unreachable.length > 0) {
        for (const u of unreachable) {
          const uName = `${u.first_name || ''} ${u.last_name || ''}`.trim() || 'Unknown';
          console.log(`  [BSI/T3] ⚠️  Dropping unreachable contact: ${uName} (${u.title || 'Unknown Title'}) — no email, no LinkedIn`);
        }
        signal.bsi_contacts = signal.bsi_contacts.filter(c => c.email || c.linkedin_url);
      }

      // ── BSI STRICT TITLE FILTER ──────────────────────────────────────────────
      // Final gate before Airtable: drop any contact whose title isn't a role
      // Starfish actually needs. Catches poor-quality contacts that leaked through
      // T3's broader Hunter search (e.g., "Managing Partner", "CRO", "VP Finance").
      // T1 and T2 contacts are already title-validated at their source, but this
      // acts as a safety net for T3 Apollo and Hunter domain-search results.
      const titleFiltered = signal.bsi_contacts.filter(c => !isBSIAllowedTitle(c.title));
      if (titleFiltered.length > 0) {
        for (const d of titleFiltered) {
          const dName = `${d.first_name || ''} ${d.last_name || ''}`.trim() || 'Unknown';
          console.log(`  [BSI/TitleFilter] ⛔ Dropping irrelevant title: ${dName} (${d.title || 'Unknown Title'}) — not a Starfish target role`);
        }
        signal.bsi_contacts = signal.bsi_contacts.filter(c => isBSIAllowedTitle(c.title));
      }

      // ── TIER 4: Nothing found → Contact Needed (Carly) ──────────────────────
      const withEmail    = signal.bsi_contacts.filter(c => c.email).length;
      const withLinkedIn = signal.bsi_contacts.filter(c => c.linkedin_url && !c.email).length;
      if (signal.bsi_contacts.length === 0) {
        console.log(`  [BSI] ⚠️  ${signal.company.name} — all tiers exhausted, flagging as "Contact Needed"`);
      } else {
        console.log(`  [BSI] ✅ ${signal.company.name} — Tier 3 broadcast: ${signal.bsi_contacts.length} contacts (${withEmail} with email, ${withLinkedIn} LinkedIn only)`);
      }
      return;
    }

    // Check if email already came through from the fetch stage (PDL, AudienceLab, etc.)
    // These come from third-party databases that can be months stale — verify before trusting.
    if (signal.person?.email && !isFakeEmail(signal.person.email)) {
      const { valid, flagged, reason } = await verifyEmail(signal.person.email, 'hunter', null);
      await new Promise(r => setTimeout(r, 400));
      if (valid) {
        signal._email_flagged    = flagged || undefined;
        signal.emailVerification = { valid, flagged, reason };
        if (flagged) console.log(`  [Email] ⚠️  ${signal.company.name} — pre-loaded email flagged as risky (${reason}) — saving with [unverified] note`);
        console.log(`  [Email] ✅ ${signal.company.name} — pre-loaded email verified (${signal.person.email})`);
        return;
      }
      console.log(`  [Email] ❌ ${signal.company.name} — pre-loaded email ${signal.person.email} failed verification (${reason}) — running cascade`);
      signal.person.email = null; // clear so the cascade below can find a good one
    }

    // ── Website Visitor with known person: run person-specific email lookup ──────
    // AudienceLab Pixel gives us first name, last name, and title for the visitor.
    // Only run the cascade if their title is a relevant marketing/brand decision-maker.
    // Irrelevant titles (teacher, engineer, etc.) are skipped — no API calls wasted.
    if (signal.type === 'Website Visitor' && signal.person?.first_name && signal.person?.last_name) {
      const RELEVANT_WV_TITLE_KEYWORDS = [
        'cmo', 'chief marketing', 'chief brand', 'cbo', 'ceo', 'chief executive',
        'coo', 'chief operating', 'president',
        'vp marketing', 'vp brand', 'vp of marketing', 'vp of brand', 'vp brand marketing',
        'vice president marketing', 'vice president brand', 'vice president of marketing',
        'vice president of brand', 'vice president brand marketing',
        'svp marketing', 'svp brand', 'svp brand marketing',
        'senior vice president marketing', 'senior vice president brand',
        'senior vice president of marketing', 'senior vice president of brand',
        'evp marketing', 'evp brand', 'evp brand marketing',
        'executive vice president marketing', 'executive vice president of marketing',
        'executive vice president brand',
        'head of marketing', 'head of brand', 'director of marketing',
        'director of brand', 'director of brand marketing', 'marketing director',
        'marketing', 'brand'
      ];

      const wvTitle = (signal.person.title || '').toLowerCase().trim();
      if (wvTitle && wvTitle !== 'unknown') {
        const isRelevant = RELEVANT_WV_TITLE_KEYWORDS.some(kw => wvTitle.includes(kw));
        if (!isRelevant) {
          console.log(`  [Email/WV] ⛔ Skipping cascade for ${signal.company.name} — irrelevant title: "${signal.person.title}"`);
          return;
        }
      } else {
        // Unknown title — skip cascade, signal already set to LOW priority in workflow_2
        console.log(`  [Email/WV] ⏭️  Skipping cascade for ${signal.company.name} — title unknown`);
        return;
      }
      // Ensure we have a domain first
      if (!signal.company.website) {
        const discovered = await findCompanyDomain(signal.company.name);
        if (discovered) {
          signal.company.website = `https://${discovered}`;
          console.log(`  [Domain] ✅ ${signal.company.name} → ${discovered} (via Puppeteer)`);
        }
        await new Promise(r => setTimeout(r, 400));
      }
      const wvDomain = extractDomain(signal.company?.website);

      // Step 1: Apollo people/match via LinkedIn URL (if available)
      if (signal.person.linkedin_url) {
        const apolloResult = await findEmailWithApollo(signal);
        if (apolloResult?.email && !isFakeEmail(apolloResult.email)) {
          const { valid, flagged, reason } = await verifyEmail(apolloResult.email, 'apollo', apolloResult.emailStatus);
          await new Promise(r => setTimeout(r, 400));
          if (valid) {
            signal.person.email = apolloResult.email;
            signal._email_flagged    = flagged || undefined;
            signal.emailVerification = { valid, flagged, reason };
            if (flagged) console.log(`  [Apollo/WV] ⚠️  ${apolloResult.email} flagged as risky (${reason}) — saving with [unverified] note`);
            console.log(`  [Apollo/WV] ✅ ${signal.company.name} → ${apolloResult.email}`);
            return;
          }
          console.log(`  [Apollo/WV] ❌ ${apolloResult.email} failed verification (${reason}) — continuing cascade`);
        }
      }

      // Step 2: Hunter person-finder — first + last + domain
      if (wvDomain && process.env.HUNTER_API_KEY) {
        console.log(`  [Hunter/WV] Searching for ${signal.person.first_name} ${signal.person.last_name} at ${wvDomain}...`);
        try {
          const hRes = await axios.get('https://api.hunter.io/v2/email-finder', {
            params: { domain: wvDomain, first_name: signal.person.first_name, last_name: signal.person.last_name, api_key: process.env.HUNTER_API_KEY },
            timeout: 15000
          });
          const { email: hEmail, score } = hRes.data?.data || {};
          if (hEmail && score >= 70 && !isFakeEmail(hEmail)) {
            const { valid, flagged, reason } = await verifyEmail(hEmail, 'hunter', null);
            await new Promise(r => setTimeout(r, 400));
            if (valid) {
              signal.person.email = hEmail;
              signal._email_flagged    = flagged || undefined;
              signal.emailVerification = { valid, flagged, reason };
              if (flagged) console.log(`  [Hunter/WV] ⚠️  ${hEmail} flagged as risky (${reason}) — saving with [unverified] note`);
              console.log(`  [Hunter/WV] ✅ ${signal.person.first_name} ${signal.person.last_name} at ${signal.company.name} → ${hEmail} (score ${score})`);
              return;
            }
            console.log(`  [Hunter/WV] ❌ ${hEmail} failed verification (${reason}) — trying pattern...`);
          } else if (hEmail) {
            console.log(`  [Hunter/WV] ⚠️  ${hEmail} rejected (score ${score || 'n/a'}${isFakeEmail(hEmail) ? ', fake' : ', below threshold'}) — trying pattern...`);
          } else {
            console.log(`  [Hunter/WV] ℹ️  No email found — trying Puppeteer...`);
          }
        } catch (err) {
          const status = err.response?.status;
          if (status === 429)      console.warn(`  [Hunter/WV] ⏳ Rate limited (429) at ${wvDomain} — trying Puppeteer...`);
          else if (status === 401) console.warn(`  [Hunter/WV] ❌ Unauthorized (401) — check HUNTER_API_KEY`);
          else { console.warn(`  [Hunter/WV] ⚠️  Error: ${err.message} — trying Puppeteer...`); getBreaker('hunter').recordFailure(err.message); }
        }
        await new Promise(r => setTimeout(r, 400));
      }

      // Step 3: Pattern construction — get domain pattern then construct + verify for this person
      if (wvDomain && process.env.HUNTER_API_KEY) {
        let wvPattern = null;

        // 3a: Hunter domain-search for pattern
        try {
          const patRes = await axios.get('https://api.hunter.io/v2/domain-search', {
            params: { domain: wvDomain, api_key: process.env.HUNTER_API_KEY },
            timeout: 15000
          });
          wvPattern = patRes.data?.data?.pattern || null;
          if (wvPattern) console.log(`  [Pattern/WV] Hunter pattern at ${wvDomain}: "${wvPattern}"`);
          else            console.log(`  [Pattern/WV] Hunter has no pattern at ${wvDomain} — trying Puppeteer...`);
        } catch (err) {
          const status = err.response?.status;
          if (status === 429)      console.warn(`  [Pattern/WV] ⏳ Hunter rate limited (429) at ${wvDomain}`);
          else if (status === 401) console.warn(`  [Pattern/WV] ❌ Hunter unauthorized (401)`);
          else                     console.warn(`  [Pattern/WV] ⚠️  Hunter error: ${err.message} — trying Puppeteer...`);
        }
        await new Promise(r => setTimeout(r, 400));

        // 3b: Puppeteer pattern scrape if Hunter had none
        if (!wvPattern) {
          const patResult = await findEmailPatternViaGoogle(wvDomain);
          wvPattern = patResult?.pattern || null;
          if (wvPattern) console.log(`  [Pattern/WV] Puppeteer pattern at ${wvDomain}: "${wvPattern}"`);
          await new Promise(r => setTimeout(r, 600));
        }

        // 3c: Apply pattern to this specific visitor and Hunter-verify
        if (wvPattern) {
          const constructed = applyHunterPattern(wvPattern, signal.person.first_name, signal.person.last_name || '', wvDomain);
          if (constructed && !isFakeEmail(constructed)) {
            console.log(`  [Pattern/WV] "${wvPattern}" → ${constructed} — verifying...`);
            const { valid, flagged, reason } = await verifyEmail(constructed, 'hunter', null);
            await new Promise(r => setTimeout(r, 400));
            if (valid) {
              signal.person.email = constructed;
              signal._email_flagged    = flagged || undefined;
              signal.emailVerification = { valid, flagged, reason };
              if (flagged) console.log(`  [Pattern/WV] ⚠️  ${constructed} flagged as risky (${reason}) — saving with [unverified] note`);
              console.log(`  [Pattern/WV] ✅ ${signal.company.name} → ${constructed}`);
              return;
            } else {
              console.log(`  [Pattern/WV] ❌ ${constructed} failed verification (${reason}) — trying Puppeteer...`);
            }
          }
        }
      }

      // Step 4: Puppeteer Google fallback — search for this specific person at the company
      console.log(`  [Puppeteer/WV] Searching ${signal.company.name}...`);
      const wvSearchTitle = signal.person.title || 'Marketing';
      const wvResult = await findEmailWithPuppeteer(signal.company.name, signal.company.website, wvSearchTitle);
      if (wvResult?.email && !isFakeEmail(wvResult.email)) {
        const wvTrustedDomain = getKnownDomain(signal.company.name) || wvDomain;
        const wvEmailDomain   = wvResult.email.split('@')[1]?.toLowerCase() || '';
        if (wvTrustedDomain && !wvEmailDomain.endsWith(wvTrustedDomain)) {
          console.log(`  [Puppeteer/WV] ❌ Rejected ${wvResult.email} — domain mismatch (expected ${wvTrustedDomain})`);
          console.log(`  [Puppeteer/WV] ℹ️  No valid email found — cascade exhausted for ${signal.company.name}`);
        } else {
          const { valid, flagged, reason } = await verifyEmail(wvResult.email, 'puppeteer', null);
          await new Promise(r => setTimeout(r, 400));
          if (valid) {
            signal._puppeteer_email  = wvResult.email;
            signal._puppeteer_source = wvResult.source;
            signal._email_flagged    = flagged || undefined;
            signal.emailVerification = { valid, flagged, reason };
            if (flagged) console.log(`  [Puppeteer/WV] ⚠️  ${wvResult.email} flagged as risky (${reason}) — saving with [unverified] note`);
            console.log(`  [Puppeteer/WV] ✅ ${signal.company.name} → ${wvResult.email}`);
          } else {
            console.log(`  [Puppeteer/WV] ❌ ${wvResult.email} failed verification (${reason}) — cascade exhausted for ${signal.company.name}`);
          }
        }
      } else {
        console.log(`  [Puppeteer/WV] ℹ️  No email found — cascade exhausted for ${signal.company.name}`);
      }
      return; // done — don't fall into the generic path
    }

    // Step 1: Apollo people/match (Job Change only — needs LinkedIn URL)
    const apolloResult = await findEmailWithApollo(signal);
    if (apolloResult?.email && !isFakeEmail(apolloResult.email)) {
      const knownDomain       = getKnownDomain(signal.company.name);
      const apolloEmailDomain = apolloResult.email.split('@')[1]?.toLowerCase() || '';
      if (knownDomain && !apolloEmailDomain.endsWith(knownDomain)) {
        console.log(`  [Apollo] ⚠️  Rejected ${apolloResult.email} — domain (${apolloEmailDomain}) doesn't match company (${knownDomain})`);
      } else {
        const { valid, flagged, reason } = await verifyEmail(apolloResult.email, 'apollo', apolloResult.emailStatus);
        await new Promise(r => setTimeout(r, 400));
        if (valid) {
          signal.person = signal.person || {};
          signal.person.email = apolloResult.email;
          signal._email_flagged    = flagged || undefined;
          signal.emailVerification = { valid, flagged, reason };
          if (flagged) console.log(`  [Apollo] ⚠️  ${apolloResult.email} flagged as risky (${reason}) — saving with [unverified] note`);
          return;
        }
        console.log(`  [Apollo] ❌ ${apolloResult.email} failed verification (${reason}) — continuing cascade`);
      }
    }

    // Step 2: If still no website, ask Puppeteer to Google it — Hunter needs this
    if (!signal.company.website) {
      const discovered = await findCompanyDomain(signal.company.name);
      if (discovered) {
        signal.company.website = `https://${discovered}`;
        console.log(`  [Domain] ✅ ${signal.company.name} → ${discovered} (via Puppeteer)`);
      }
      await new Promise(r => setTimeout(r, 400));
    }

    const domain = extractDomain(signal.company?.website);

    // Step 2a: Hunter email-finder (Job Change — first + last + domain)
    if (signal.type === 'Job Change') {
      const hunterEmail = await findEmailWithHunterPerson(signal);
      if (hunterEmail && !isFakeEmail(hunterEmail)) {
        const { valid, flagged, reason } = await verifyEmail(hunterEmail, 'hunter', null);
        await new Promise(r => setTimeout(r, 400));
        if (valid) {
          signal.person = signal.person || {};
          signal.person.email = hunterEmail;
          signal._email_flagged    = flagged || undefined;
          signal.emailVerification = { valid, flagged, reason };
          if (flagged) console.log(`  [Hunter/JC] ⚠️  ${hunterEmail} flagged as risky (${reason}) — saving with [unverified] note`);
          return;
        }
        console.log(`  [Hunter/JC] ❌ ${hunterEmail} failed verification (${reason}) — continuing cascade`);
      }
    }

    // Step 2b-MA: Enrich each ma_contact with Hunter email-finder (first + last + domain)
    if (signal.type === 'M&A Activity' && signal.ma_contacts?.length > 0 && domain) {
      let puppeteerCalledForCompany = false;

      for (const contact of signal.ma_contacts) {
        if (!contact.name) continue;

        // If Apollo's search result already included an email, verify it before accepting.
        // Previously this was skipped (if (contact.email) continue) which meant Apollo emails
        // for M&A contacts were never verified — inconsistent with Job Change handling.
        if (contact.email && !contact.email_verified) {
          if (!isFakeEmail(contact.email)) {
            const { valid, flagged, reason } = await verifyEmail(contact.email, 'apollo', contact.email_status || null);
            await new Promise(r => setTimeout(r, 400));
            if (valid) {
              contact.email_flagged     = flagged || undefined;
              contact.emailVerification = { valid, flagged, reason };
              contact.email_verified    = true;
              signal.emailVerification  = { valid, flagged, reason };
              if (flagged) console.log(`  [Apollo/MA] ⚠️  ${contact.email} flagged (${reason}) — saving with [unverified] note`);
              else         console.log(`  [Apollo/MA] ✅ ${contact.name} → ${contact.email} verified`);
              continue;
            }
            console.log(`  [Apollo/MA] ❌ ${contact.email} failed verification (${reason}) — clearing and trying Hunter`);
            contact.email = null; // clear so Hunter can try
          } else {
            console.log(`  [Apollo/MA] ⛔ ${contact.email} is fake — clearing and trying Hunter`);
            contact.email = null;
          }
        }
        if (contact.email) continue; // already verified above
        const [firstName, ...rest] = contact.name.split(' ');
        const lastName = rest.join(' ');
        if (!firstName) continue;
        if (!lastName) {
          console.log(`  [Hunter/MA] ⏭️  Skipping ${contact.name} — single-name contact, Hunter requires first + last`);
          continue;
        }

        if (process.env.HUNTER_API_KEY) {
          console.log(`  [Hunter/MA] Searching for ${contact.name} at ${domain}...`);
          try {
            const res = await axios.get('https://api.hunter.io/v2/email-finder', {
              params: { domain, first_name: firstName, last_name: lastName, api_key: process.env.HUNTER_API_KEY },
              timeout: 15000
            });
            const { email: hEmail, score } = res.data?.data || {};
            if (hEmail && score >= 70 && !isFakeEmail(hEmail)) {
              const { valid, flagged, reason } = await verifyEmail(hEmail, 'hunter', null);
              await new Promise(r => setTimeout(r, 400));
              if (valid) {
                contact.email = hEmail;
                contact.email_flagged    = flagged || undefined;
                contact.emailVerification = { valid, flagged, reason };
                signal.emailVerification  = { valid, flagged, reason }; // M&A: last found email wins
                if (flagged) console.log(`  [Hunter/MA] ⚠️  ${hEmail} flagged as risky (${reason}) — saving with [unverified] note`);
                console.log(`  [Hunter/MA] ✅ ${contact.name} (${contact.title}) → ${hEmail} (score ${score})`);
                continue;
              }
              console.log(`  [Hunter/MA] ❌ ${hEmail} failed verification (${reason}) for ${contact.name} — will try Puppeteer`);
            } else if (hEmail) {
              console.log(`  [Hunter/MA] ⚠️  ${contact.name} → ${hEmail} rejected (score ${score || 'n/a'}${isFakeEmail(hEmail) ? ', fake' : ', below threshold'})`);
            } else {
              console.log(`  [Hunter/MA] ℹ️  No email found for ${contact.name} — will try Puppeteer`);
            }
          } catch (err) {
            const status = err.response?.status;
            if (status === 429)      console.warn(`  [Hunter/MA] ⏳ Rate limited (429) for ${contact.name}`);
            else if (status === 401) console.warn(`  [Hunter/MA] ❌ Unauthorized (401) — check HUNTER_API_KEY`);
            else { console.warn(`  [Hunter/MA] ⚠️  Error for ${contact.name}: ${err.message}`); getBreaker('hunter').recordFailure(err.message); }
          }
          await new Promise(r => setTimeout(r, 400));
        }
      }

      const stillMissing = signal.ma_contacts.find(c => !c.email && c.name);
      if (stillMissing && !puppeteerCalledForCompany) {
        puppeteerCalledForCompany = true;
        console.log(`  [Puppeteer/MA] Searching ${signal.company.name}...`);
        const puppeteerResult = await findEmailWithPuppeteer(
          signal.company.name,
          signal.company.website,
          'CEO OR CMO OR CFO OR COO OR President'
        );
        if (puppeteerResult?.email && !isFakeEmail(puppeteerResult.email)) {
          const { valid, flagged, reason } = await verifyEmail(puppeteerResult.email, 'puppeteer', null);
          await new Promise(r => setTimeout(r, 400));
          if (valid) {
            stillMissing.email = puppeteerResult.email;
            stillMissing.email_flagged    = flagged || undefined;
            stillMissing.emailVerification = { valid, flagged, reason };
            signal.emailVerification       = { valid, flagged, reason }; // M&A: last found email wins
            if (flagged) console.log(`  [Puppeteer/MA] ⚠️  ${puppeteerResult.email} flagged as risky (${reason}) — saving with [unverified] note`);
            console.log(`  [Puppeteer/MA] ✅ ${stillMissing.name} → ${puppeteerResult.email}`);
          } else {
            console.log(`  [Puppeteer/MA] ❌ ${puppeteerResult.email} failed verification (${reason}) — contacts will show LinkedIn only`);
          }
        } else {
          console.log(`  [Puppeteer/MA] ℹ️  No email found — contacts will show LinkedIn only`);
        }
      }
      return; // M&A with ma_contacts — skip general enrichment
    }

    // Step 2b: Hunter domain-search (News/Press & M&A — best exec email at domain)
    // For News/Press: first try Hunter person-search using name extracted from article
    if (signal.type === 'News/Press' && domain && process.env.HUNTER_API_KEY && !getBreaker('hunter').isOpen()) {
      const extracted = extractNameFromArticle(signal);
      if (extracted) {
        console.log(`  [Hunter/NP] Found name in article: ${extracted.firstName} ${extracted.lastName} — trying person search at ${domain}...`);
        try {
          const res = await axios.get('https://api.hunter.io/v2/email-finder', {
            params: {
              domain,
              first_name: extracted.firstName,
              last_name: extracted.lastName,
              api_key: process.env.HUNTER_API_KEY
            },
            timeout: 15000
          });
          getBreaker('hunter').recordSuccess();
          const { email: hEmail, score } = res.data?.data || {};
          if (hEmail && score >= 70 && !isFakeEmail(hEmail)) {
            const { valid, flagged, reason } = await verifyEmail(hEmail, 'hunter', null);
            await new Promise(r => setTimeout(r, 400));
            if (valid) {
              signal._puppeteer_email  = hEmail;
              signal._puppeteer_source = `Hunter (${extracted.firstName} ${extracted.lastName})`;
              signal._email_flagged    = flagged || undefined;
              signal.emailVerification = { valid, flagged, reason };
              if (flagged) console.log(`  [Hunter/NP] ⚠️  ${hEmail} flagged as risky (${reason}) — saving with [unverified] note`);
              console.log(`  [Hunter/NP] ✅ ${extracted.firstName} ${extracted.lastName} → ${hEmail} (score ${score})`);
              return;
            }
            console.log(`  [Hunter/NP] ❌ ${hEmail} failed verification (${reason}) — falling through to domain search`);
          } else if (hEmail) {
            console.log(`  [Hunter/NP] ⚠️  ${hEmail} rejected (score ${score || 'n/a'}${isFakeEmail(hEmail) ? ', fake' : ', below threshold'}) — falling through to domain search`);
          } else {
            console.log(`  [Hunter/NP] ℹ️  No email found for ${extracted.firstName} ${extracted.lastName} — falling through to domain search`);
          }
        } catch (err) {
          const status = err.response?.status;
          if (status === 429)      console.warn(`  [Hunter/NP] ⏳ Rate limited (429) for ${extracted.firstName} ${extracted.lastName}`);
          else if (status === 401) console.warn(`  [Hunter/NP] ❌ Unauthorized (401) — check HUNTER_API_KEY`);
          else {
            console.warn(`  [Hunter/NP] ⚠️  Person search error: ${err.message}`);
            getBreaker('hunter').recordFailure(err.message);
          }
        }
        await new Promise(r => setTimeout(r, 400));
      }
    }

    // Step 2b-NP: Apollo exec search for News/Press — runs BEFORE Hunter domain-search.
    // Apollo identifies the specific marketing/brand decision-maker at this company by domain.
    // We then hand that name to Hunter's email-finder for a targeted lookup, which is far
    // more accurate than Hunter's broad domain-search which returns whoever it finds first.
    // This keeps Apollo as the contact-identification layer, Hunter as the email-delivery layer.
    if (signal.type === 'News/Press' && domain && !getBreaker('apollo').isOpen()) {
      const apolloExec = await apolloFindExec(domain, signal.type);
      if (apolloExec?.firstName) {
        console.log(`  [Apollo/NP] ✅ ${signal.company.name} → found ${apolloExec.firstName} ${apolloExec.lastName} (${apolloExec.title || 'exec'})`);
        // Hand the Apollo-identified exec to Hunter for a targeted email lookup.
        // Hunter requires both first and last name — skip if Apollo returned no last name
        // (some Apollo records have only a first name, which causes a Hunter 400 error and
        //  records a circuit breaker failure, potentially tripping the breaker for the whole run).
        if (process.env.HUNTER_API_KEY && !getBreaker('hunter').isOpen() && apolloExec.lastName) {
          try {
            const res = await axios.get('https://api.hunter.io/v2/email-finder', {
              params: { domain, first_name: apolloExec.firstName, last_name: apolloExec.lastName, api_key: process.env.HUNTER_API_KEY },
              timeout: 15000
            });
            getBreaker('hunter').recordSuccess();
            const { email: hEmail, score } = res.data?.data || {};
            if (hEmail && score >= 70 && !isFakeEmail(hEmail)) {
              const { valid, flagged, reason } = await verifyEmail(hEmail, 'hunter', null);
              await new Promise(r => setTimeout(r, 400));
              if (valid) {
                signal._puppeteer_email  = hEmail;
                signal._puppeteer_source = `Apollo+Hunter (${apolloExec.firstName} ${apolloExec.lastName})`;
                signal._email_flagged    = flagged || undefined;
                signal.emailVerification = { valid, flagged, reason };
                if (flagged) console.log(`  [Apollo/NP] ⚠️  ${hEmail} flagged as risky (${reason}) — saving with [unverified] note`);
                console.log(`  [Apollo/NP] ✅ ${apolloExec.firstName} ${apolloExec.lastName} → ${hEmail} (score ${score})`);
                return;
              }
              console.log(`  [Apollo/NP] ❌ ${hEmail} failed verification (${reason}) — falling through to domain search`);
            } else if (hEmail) {
              console.log(`  [Apollo/NP] ⚠️  ${hEmail} rejected (score ${score || 'n/a'}${isFakeEmail(hEmail) ? ', fake' : ', below threshold'}) — falling through to domain search`);
            } else {
              console.log(`  [Apollo/NP] ℹ️  Hunter has no email for ${apolloExec.firstName} ${apolloExec.lastName} — falling through to domain search`);
            }
          } catch (err) {
            const status = err.response?.status;
            if (status === 429)      console.warn(`  [Apollo/NP] ⏳ Hunter rate limited (429)`);
            else if (status === 401) console.warn(`  [Apollo/NP] ❌ Hunter unauthorized (401) — check HUNTER_API_KEY`);
            else {
              console.warn(`  [Apollo/NP] ⚠️  Hunter error: ${err.message}`);
              getBreaker('hunter').recordFailure(err.message);
            }
          }
          await new Promise(r => setTimeout(r, 400));
        }
      } else {
        console.log(`  [Apollo/NP] ℹ️  No marketing exec found at ${domain} — falling through to Hunter domain search`);
      }
      await new Promise(r => setTimeout(r, 400));
    }

    let hunterResult = null;
    if (signal.type !== 'Job Change') {
      hunterResult = await findEmailWithHunterDomain(signal);
      if (hunterResult?.email && !isFakeEmail(hunterResult.email)) {
        const { valid, flagged, reason } = await verifyEmail(hunterResult.email, 'hunter', null);
        await new Promise(r => setTimeout(r, 400));
        if (valid) {
          signal._puppeteer_email  = hunterResult.email;
          signal._puppeteer_source = `Hunter${hunterResult.title ? ` (${hunterResult.title})` : ''}`;
          signal._email_flagged    = flagged || undefined;
          signal.emailVerification = { valid, flagged, reason };
          if (flagged) console.log(`  [Hunter] ⚠️  ${hunterResult.email} flagged as risky (${reason}) — saving with [unverified] note`);
          return;
        }
        console.log(`  [Hunter] ❌ ${hunterResult.email} failed verification (${reason}) — trying pattern...`);
      }
    }

    // Step 2c: Hunter pattern → construct + verify
    if (domain) {
      let pattern = hunterResult?.pattern || null;
      if (!pattern && signal.type === 'Job Change' && process.env.HUNTER_API_KEY) {
        console.log(`  [Pattern] Checking Hunter for email pattern at ${domain}...`);
        try {
          const res = await axios.get('https://api.hunter.io/v2/domain-search', {
            params: { domain, api_key: process.env.HUNTER_API_KEY },
            timeout: 15000
          });
          pattern = res.data?.data?.pattern || null;
          if (pattern) console.log(`  [Pattern] Hunter pattern: "${pattern}"`);
          else         console.log(`  [Pattern] Hunter has no pattern for ${domain} — trying Puppeteer...`);
        } catch (err) {
          const status = err.response?.status;
          if (status === 429)      console.warn(`  [Pattern] ⏳ Hunter rate limited (429) at ${domain}`);
          else if (status === 401) console.warn(`  [Pattern] ❌ Hunter unauthorized (401) — check HUNTER_API_KEY`);
          else                     console.warn(`  [Pattern] ⚠️  Hunter domain-search error: ${err.message}`);
        }
        await new Promise(r => setTimeout(r, 400));
      }

      if (!pattern) {
        console.log(`  [Pattern] Trying Puppeteer for email pattern at ${domain}...`);
        const patternResult = await findEmailPatternViaGoogle(domain);
        pattern = patternResult?.pattern || null;
        await new Promise(r => setTimeout(r, 600));
      }

      if (pattern) {
        let targetFirst = null;
        let targetLast  = null;

        if (signal.type === 'Job Change' && signal.person?.first_name) {
          targetFirst = signal.person.first_name;
          targetLast  = signal.person.last_name || '';
        } else if (signal.type !== 'Job Change') {
          targetFirst = hunterResult?.firstName || null;
          targetLast  = hunterResult?.lastName  || null;
          if (!targetFirst) {
            const exec = await apolloFindExec(domain, signal.type);
            if (exec) { targetFirst = exec.firstName; targetLast = exec.lastName; }
            await new Promise(r => setTimeout(r, 400));
          }
        }

        if (targetFirst) {
          const constructed = applyHunterPattern(pattern, targetFirst, targetLast, domain);
          if (constructed && !isFakeEmail(constructed)) {
            console.log(`  [Pattern] "${pattern}" → ${constructed} — verifying...`);
            const { valid, flagged, reason } = await verifyEmail(constructed, 'hunter', null);
            await new Promise(r => setTimeout(r, 400));
            if (valid) {
              if (flagged) console.log(`  [Pattern] ⚠️  ${constructed} flagged as risky (${reason}) — saving with [unverified] note`);
              console.log(`  [Pattern] ✅ ${signal.company.name} → ${constructed}`);
              signal._email_flagged    = flagged || undefined;
              signal.emailVerification = { valid, flagged, reason };
              if (signal.type === 'Job Change') {
                signal.person = signal.person || {};
                signal.person.email = constructed;
              } else {
                signal._puppeteer_email  = constructed;
                signal._puppeteer_source = 'pattern';
              }
              return;
            } else {
              console.log(`  [Pattern] ${constructed} failed verification`);
            }
          }
        }
      }
    }

    // Step 3: Puppeteer fallback — Google + company website scrape
    const searchTitle = signal.type === 'Job Change'
      ? (signal.person?.title || 'CMO')
      : signal.type === 'M&A Activity'
        ? 'CEO OR CMO OR CFO OR COO OR CIO OR CHRO OR President OR "Managing Partner"'
        : 'CMO OR "VP Marketing" OR "Chief Marketing Officer"';

    console.log(`  [Puppeteer] Searching ${signal.company.name} for "${searchTitle}"...`);
    const result = await findEmailWithPuppeteer(
      signal.company.name,
      signal.company.website,
      searchTitle
    );

    if (result?.email && !isFakeEmail(result.email)) {
      const trustedDomain = getKnownDomain(signal.company.name) || domain;
      const emailDomain   = result.email.split('@')[1]?.toLowerCase() || '';
      if (trustedDomain && !emailDomain.endsWith(trustedDomain)) {
        console.log(`  [Puppeteer] ❌ Rejected ${result.email} — domain mismatch (expected ${trustedDomain})`);
        console.log(`[Email Enrichment] ✗ No valid email found for ${signal.company.name} after all steps — Contact Info will show "Contact Needed"`);
      } else {
        const { valid, flagged, reason } = await verifyEmail(result.email, 'puppeteer', null);
        if (valid) {
          signal._puppeteer_email  = result.email;
          signal._puppeteer_source = result.source;
          signal._email_flagged    = flagged || undefined;
          signal.emailVerification = { valid, flagged, reason };
          if (flagged) console.log(`  [Puppeteer] ⚠️  ${result.email} flagged as risky (${reason}) — saving with [unverified] note`);
          console.log(`  [Puppeteer] ✅ ${signal.company.name} → ${result.email}`);
        } else {
          console.log(`  [Puppeteer] ❌ ${result.email} failed verification (${reason})`);
          console.log(`[Email Enrichment] ✗ No valid email found for ${signal.company.name} after all steps — Contact Info will show "Contact Needed"`);
        }
      }
    } else {
      console.log(`[Email Enrichment] ✗ No valid email found for ${signal.company.name} after all steps — Contact Info will show "Contact Needed"`);
    }
  }

  // Run enrichment concurrently in batches of ENRICHMENT_CONCURRENCY
  for (let i = 0; i < deduplicatedSignals.length; i += ENRICHMENT_CONCURRENCY) {
    const batch = deduplicatedSignals.slice(i, i + ENRICHMENT_CONCURRENCY);
    await Promise.all(batch.map(s => enrichOneSignal(s).catch(err => {
      // C-NEW-2: mark failed signals so formatForAirtable() can flag them in Airtable
      // rather than silently writing an incomplete record with missing contact/email fields
      s._enrichment_failed = true;
      console.error(`  [Enrichment] Unexpected error for ${s.company?.name}: ${err.message}`);
    })));
  }

  // Step 4.3: Format and split by destination
  // AudienceLab signals go to a separate base (if configured) to avoid hitting the
  // main base record limit. All other signals go to the main base as normal.
  const alBaseId    = process.env.AUDIENCELAB_AIRTABLE_BASE_ID;
  const alTableName = process.env.AUDIENCELAB_AIRTABLE_TABLE_NAME;
  const useAlBase   = !!(alBaseId && alTableName);

  const mainSignals        = useAlBase
    ? deduplicatedSignals.filter(s => s.source !== 'AudienceLab')
    : deduplicatedSignals;
  const audienceLabSignals = useAlBase
    ? deduplicatedSignals.filter(s => s.source === 'AudienceLab')
    : [];

  const mainRecords = expandToRecords(mainSignals);
  const alRecords   = expandToRecords(audienceLabSignals);

  console.log(`[Airtable] Formatted ${mainRecords.length} records for main base${useAlBase ? `, ${alRecords.length} for AudienceLab base` : ''}`);

  let totalInserted  = 0;
  const failedRecords = [];

  // ── Shared batch insert helper ─────────────────────────────────────────────
  async function insertBatches(records, label, insertFn) {
    const batches = chunkArray(records, 10);
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      try {
        console.log(`[${label}] Inserting batch ${i + 1}/${batches.length} (${batch.length} records)...`);
        const result = await insertFn(batch);
        totalInserted += result.length;
        console.log(`[${label}] Batch ${i + 1} done (${result.length} records)`);
        if (i < batches.length - 1) await new Promise(r => setTimeout(r, 1000));
      } catch (error) {
        console.error(`[${label}] Batch ${i + 1} failed:`, error.message);

        const isRateLimit = error.statusCode === 429 ||
          (error.message || '').toLowerCase().includes('rate limit') ||
          (error.message || '').toLowerCase().includes('too many requests');

        if (isRateLimit) {
          // Rate limit: wait then retry the ENTIRE batch — safe because nothing was written yet
          console.warn(`[${label}] Rate limit — waiting 30s before retrying batch ${i + 1}...`);
          await new Promise(r => setTimeout(r, 30000));
          try {
            const result = await insertFn(batch);
            totalInserted += result.length;
            console.log(`[${label}] Batch ${i + 1} succeeded on retry (${result.length} records)`);
            if (i < batches.length - 1) await new Promise(r => setTimeout(r, 1000));
            continue;
          } catch (retryErr) {
            console.error(`[${label}] Batch ${i + 1} still failed after retry:`, retryErr.message);
            // Fall through to individual insertion — do NOT retry batch again (risk of duplicates)
          }
        }

        // Network/timeout errors have no HTTP status — the request may have already reached
        // Airtable and written some records before the connection dropped. Individual re-insertion
        // would create duplicates. Add the whole batch to failedRecords for manual review instead.
        const httpStatus = error.statusCode || error.response?.status;
        if (!httpStatus) {
          console.error(`[${label}] Batch ${i + 1} failed with a network/timeout error (no HTTP status) — skipping individual fallback to avoid duplicates. ${batch.length} record(s) added to failed list.`);
          failedRecords.push(...batch);
          continue;
        }

        // HTTP error (4xx/5xx from Airtable): request was rejected before any records were written.
        // Individual insertion is safe — it will identify and isolate the bad record.
        console.log(`[${label}] Falling back to individual insertion for batch ${i + 1} (HTTP ${httpStatus})...`);
        await new Promise(r => setTimeout(r, 2000));
        for (const record of batch) {
          try {
            const result = await insertFn([record]);
            totalInserted += result.length;
          } catch (singleErr) {
            console.error(`[${label}] Single record failed (${record.fields?.['Company Name'] || '?'}):`, singleErr.message);
            failedRecords.push(record);
          }
          await new Promise(r => setTimeout(r, 300));
        }
      }
    }
  }

  // Step 4.4: Insert main signals into main base
  if (mainRecords.length > 0) {
    await insertBatches(mainRecords, 'Airtable', batch => airtableClient.createRecords(batch));
  }

  // Step 4.4b: Insert AudienceLab signals into separate base (if configured)
  if (alRecords.length > 0 && useAlBase) {
    console.log(`[Airtable/AudienceLab] Inserting ${alRecords.length} records into separate base (${alBaseId})...`);
    await insertBatches(alRecords, 'Airtable/AudienceLab', batch => createRecordsInBase(alBaseId, alTableName, batch));
  }

  if (failedRecords.length > 0) {
    fs.writeFileSync(`${TMP_DIR}/airtable_failures_${today}.json`, JSON.stringify(failedRecords, null, 2));
    await sendErrorAlert(`Airtable: ${failedRecords.length} records failed to insert. See .tmp/airtable_failures_${today}.json`);
  }

  // Step 4.5: Verify
  let verifyCount = '?';
  try {
    const verifyRecords = await airtableClient.query({ filterByFormula: `IS_SAME({Date Detected}, '${todayStr}', 'day')` });
    verifyCount = verifyRecords.length;
    console.log(`[Airtable] Verification: ${verifyCount} records with today's date`);
  } catch (err) {
    console.error('[Airtable] Verification query failed:', err.message);
  }

  // Step 4.6: Log
  const totalToInsert = mainRecords.length + alRecords.length;
  const status        = totalInserted === totalToInsert ? 'SUCCESS' : 'PARTIAL FAILURE';
  const logEntry      = `
[${new Date().toISOString()}] Airtable Insertion Log
=================================================
Total to insert:   ${totalToInsert} (main: ${mainRecords.length}, AudienceLab: ${alRecords.length})
Inserted:          ${totalInserted}
Failed:            ${failedRecords.length}
Verification:      ${verifyCount}
Status:            ${status}
=================================================
`;

  fs.appendFileSync(`${TMP_DIR}/airtable_log_${today}.txt`, logEntry);
  console.log(`[Airtable] Complete: ${totalInserted}/${totalToInsert} records — ${status}`);

  return totalInserted;
}

export default saveToAirtable;
