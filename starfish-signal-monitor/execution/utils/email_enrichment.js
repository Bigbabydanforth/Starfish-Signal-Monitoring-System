import 'dotenv/config';
import axios from 'axios';
import { getBreaker } from './circuit_breaker.js';

// Extract bare domain from a website URL (e.g. "https://www.acme.com/foo" → "acme.com")
export function extractDomain(website) {
  if (!website) return null;
  return website.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/.*$/, '').toLowerCase() || null;
}

// Title keywords for BSI domain-search — marketing/brand ONLY.
// No CEO/CFO/COO — for BSI we need the person who owns the brand budget.
export const HUNTER_BSI_TITLE_KEYWORDS = [
  'cmo', 'chief marketing', 'chief brand',
  'vp marketing', 'vp of marketing', 'vp brand', 'vp of brand',
  'svp marketing', 'svp brand', 'evp marketing', 'evp brand',
  'vice president marketing', 'vice president brand', 'vice president of marketing', 'vice president of brand',
  'senior vice president marketing', 'senior vice president brand',
  'executive vice president marketing', 'executive vice president brand',
  'head of marketing', 'head of brand',
  'director of marketing', 'marketing director', 'director of brand', 'brand director',
  'director of brand marketing', 'brand officer'
];
export const HUNTER_BSI_DEPT_KEYWORDS = ['marketing', 'brand'];

// Title keywords for News/Press & M&A domain-search — marketing/brand + senior decision-makers.
// Deliberately excludes CFO, CIO, CTO, CHRO — Starfish sells branding/marketing services,
// so those roles have no budget or mandate for brand work.
export const HUNTER_EXEC_TITLE_KEYWORDS = [
  ...HUNTER_BSI_TITLE_KEYWORDS,
  'ceo', 'chief executive',
  'coo', 'chief operating',
  'cro', 'chief revenue',
  'president',
  // Senior/Executive VP without a function — valid senior targets at large companies.
  // Marketing SVPs/EVPs are already in HUNTER_BSI_TITLE_KEYWORDS; these catch bare titles.
  'senior vice president', 'executive vice president',
  // Partner-level contacts — primary targets at law firms, consulting, and PE firms.
  'managing partner', 'senior partner', 'equity partner', 'founding partner',
  'managing director', 'partner'
];
export const HUNTER_EXEC_DEPT_KEYWORDS = ['marketing', 'brand', 'executive'];

// Apollo email reveal — try to get a real work email before falling back to Puppeteer.
// Uses /people/match with the person's LinkedIn URL. Never throws — returns null on failure.
export async function findEmailWithApollo(signal) {
  if (signal.type !== 'Job Change' && signal.type !== 'Website Visitor') return null;
  const linkedinUrl = signal.person?.linkedin_url;
  const personName  = `${signal.person?.first_name || ''} ${signal.person?.last_name || ''}`.trim() || signal.company.name;
  if (!linkedinUrl) {
    console.log(`  [Apollo] ⏭️  Skipping ${personName} — no LinkedIn URL`);
    return null;
  }

  // Validate LinkedIn URL format before sending to Apollo — malformed URLs return 422
  // and were previously silent (no audit trail). Now we log them so bad data is visible.
  const LINKEDIN_RE = /^https?:\/\/(www\.)?linkedin\.com\/in\/[a-zA-Z0-9\-_%]+\/?/i;
  if (!LINKEDIN_RE.test(linkedinUrl)) {
    console.warn(`  [Apollo] ⚠️  Skipping ${personName} — malformed LinkedIn URL: "${linkedinUrl}"`);
    return null;
  }

  if (getBreaker('apollo').isOpen()) {
    console.log(`  [Apollo] ⚡ Circuit open — skipping ${personName}`);
    return null;
  }
  try {
    const baseUrl = process.env.APOLLO_API_URL || 'https://api.apollo.io/v1';
    const res = await axios.post(`${baseUrl}/people/match`, {
      linkedin_url:            linkedinUrl,
      reveal_personal_emails:  false
    }, {
      headers: { 'X-Api-Key': process.env.APOLLO_API_KEY, 'Content-Type': 'application/json' },
      timeout: 15000
    });
    getBreaker('apollo').recordSuccess();
    const person      = res.data?.person || {};
    const email       = person.email        || null;
    const emailStatus = person.email_status || null; // 'verified'|'guessed'|'bounced'|'unavailable'|null
    if (email) {
      console.log(`  [Apollo] ✅ ${personName} → ${email}${emailStatus ? ` [${emailStatus}]` : ''}`);
    } else {
      console.log(`  [Apollo] ℹ️  No email returned for ${personName} — trying Hunter...`);
    }
    return email ? { email, emailStatus } : null;
  } catch (err) {
    const status = err.response?.status;
    if (status === 401)      console.warn(`  [Apollo] ❌ Unauthorized (401) — check APOLLO_API_KEY`);
    else if (status === 429) console.warn(`  [Apollo] ⏳ Rate limited (429) for ${personName}`);
    else if (status === 422) console.warn(`  [Apollo] ℹ️  422 Unprocessable for ${personName} — person not in Apollo database`);
    // 422 is a normal "not found" response, NOT an outage — do not trip the circuit
    else {
      console.warn(`  [Apollo] ⚠️  Error for ${personName}: ${err.message}`);
      getBreaker('apollo').recordFailure(err.message);
    }
    return null;
  }
}

// Hunter email-finder — for Job Change signals (specific person lookup).
// Requires first name, last name, and a domain. Only trusts results with score ≥ 70.
// Never throws — returns null on failure.
export async function findEmailWithHunterPerson(signal) {
  if (signal.type !== 'Job Change') return null;
  if (!process.env.HUNTER_API_KEY) return null;

  const firstName = signal.person?.first_name;
  const lastName  = signal.person?.last_name;
  const domain    = extractDomain(signal.company?.website);

  if (!firstName || !lastName || !domain) return null;

  if (getBreaker('hunter').isOpen()) {
    console.log(`  [Hunter] ⚡ Circuit open — skipping ${firstName} ${lastName}`);
    return null;
  }
  try {
    const res = await axios.get('https://api.hunter.io/v2/email-finder', {
      params: { domain, first_name: firstName, last_name: lastName, api_key: process.env.HUNTER_API_KEY },
      timeout: 15000
    });
    getBreaker('hunter').recordSuccess();
    const { email, score } = res.data?.data || {};
    if (email && score >= 70) {
      console.log(`  [Hunter] ✅ ${firstName} ${lastName} → ${email} (score ${score})`);
      return email;
    }
    if (email) {
      console.log(`  [Hunter] ⚠️  ${firstName} ${lastName} → ${email} rejected (score ${score} < 70)`);
    } else {
      console.log(`  [Hunter] ℹ️  No email found for ${firstName} ${lastName} at ${domain}`);
    }
    return null;
  } catch (err) {
    const status = err.response?.status;
    if (status === 401)      console.warn(`  [Hunter] ❌ Unauthorized (401) — check HUNTER_API_KEY`);
    else if (status === 429) console.warn(`  [Hunter] ⏳ Rate limited (429) at ${domain}`);
    else {
      console.warn(`  [Hunter] ⚠️  Error for ${firstName} ${lastName}: ${err.message}`);
      getBreaker('hunter').recordFailure(err.message);
    }
    return null;
  }
}

// Hunter domain-search — for News/Press & M&A signals (find marketing exec).
// Returns the best marketing/exec email found at the company's domain, or null.
// Never throws — returns null on failure.
export async function findEmailWithHunterDomain(signal) {
  if (signal.type === 'Job Change') return null;
  if (!process.env.HUNTER_API_KEY) return null;

  const domain = extractDomain(signal.company?.website);
  if (!domain) return null;

  // BSI signals use stricter marketing-only title filter to avoid finance/ops/IT contacts
  const isBSI    = signal.type === 'Brand Strategy Intent';
  const titleKws = isBSI ? HUNTER_BSI_TITLE_KEYWORDS    : HUNTER_EXEC_TITLE_KEYWORDS;
  const deptKws  = isBSI ? HUNTER_BSI_DEPT_KEYWORDS     : HUNTER_EXEC_DEPT_KEYWORDS;

  if (getBreaker('hunter').isOpen()) {
    console.log(`  [Hunter/domain] ⚡ Circuit open — skipping ${domain}`);
    return null;
  }
  try {
    const res = await axios.get('https://api.hunter.io/v2/domain-search', {
      params: { domain, api_key: process.env.HUNTER_API_KEY },
      timeout: 15000
    });
    getBreaker('hunter').recordSuccess();

    const data    = res.data?.data || {};
    const emails  = data.emails    || [];
    const pattern = data.pattern   || null;

    const isExec = (e) => {
      const pos  = (e.position   || '').toLowerCase();
      const dept = (e.department || '').toLowerCase();
      return titleKws.some(k => pos.includes(k)) ||
             deptKws.some(k => dept.includes(k));
    };

    const execEmails = emails.filter(e => isExec(e));
    // Prefer marketing/brand contacts (CMO, VP Marketing, etc.) over CEO/President.
    // Sort: marketing titles first, CEO/President as last resort.
    execEmails.sort((a, b) => {
      const aPos = (a.position || '').toLowerCase();
      const bPos = (b.position || '').toLowerCase();
      const aIsMarketing = titleKws === HUNTER_BSI_TITLE_KEYWORDS
        ? titleKws.some(k => aPos.includes(k))
        : HUNTER_BSI_TITLE_KEYWORDS.some(k => aPos.includes(k));
      const bIsMarketing = titleKws === HUNTER_BSI_TITLE_KEYWORDS
        ? titleKws.some(k => bPos.includes(k))
        : HUNTER_BSI_TITLE_KEYWORDS.some(k => bPos.includes(k));
      if (aIsMarketing && !bIsMarketing) return -1;
      if (!aIsMarketing && bIsMarketing) return 1;
      return 0;
    });
    const pick = execEmails[0] || null;  // Never fall back to non-exec contacts
    const name  = pick ? `${pick.first_name || ''} ${pick.last_name || ''}`.trim() : null;
    const title = pick?.position || null;

    if (pick?.value) {
      console.log(`  [Hunter] ✅ ${signal.company.name} → ${pick.value}${title ? ` (${title})` : ''}`);
    } else if (isBSI) {
      console.log(`  [Hunter/BSI] ⚠️  No marketing exec found at ${domain} — skipping non-marketing contacts`);
    } else {
      console.log(`  [Hunter] ℹ️  No exec email found at ${domain}${pattern ? ` (pattern: "${pattern}" saved for next step)` : ''}`);
    }

    return {
      email:     pick?.value     || null,
      name,
      title,
      firstName: pick?.first_name || null,
      lastName:  pick?.last_name  || null,
      pattern
    };
  } catch (err) {
    const status = err.response?.status;
    if (status === 429) console.warn(`  [Hunter/domain] ⏳ Rate limited (429) at ${domain}`);
    else {
      console.warn(`  [Hunter/domain] ⚠️  Error at ${domain}: ${err.message}`);
      getBreaker('hunter').recordFailure(err.message);
    }
    return null;
  }
}
