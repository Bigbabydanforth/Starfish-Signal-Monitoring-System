import 'dotenv/config';
import axios from 'axios';
import fs from 'fs';
import path, { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import { extractCompanyName, parseHeadquarters, sanitizeApiInput, sanitizeRevenue } from './text_parsing.js';
import { query as airtableQuery } from './airtable_client.js';

// Retry delay with jitter — prevents thundering herd when multiple concurrent
// workflow runs all hit a rate limit and retry at exactly the same moment.
// base: base delay in ms. Returns a value between base and base * 1.5.
function retryDelay(base = 30000) {
  return base + Math.floor(Math.random() * base * 0.5);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TMP_DIR = resolve(__dirname, '../../.tmp');

// ─── LinkedIn URL normalization ───────────────────────────────────────────────
// Strips protocol, www., and trailing slash so that http://www.linkedin.com/in/john/
// and https://linkedin.com/in/john are treated as the same person.
function normalizeLinkedIn(url) {
  if (!url) return '';
  return url.toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/$/, '');
}

// ─── Apollo API ───────────────────────────────────────────────────────────────

// Exact request body from project_specs.md Section 1
function buildApolloRequestBody() {
  return {
    person_titles: [
      // C-level marketing & brand
      'CMO',
      'Chief Marketing Officer',
      'Chief Brand Officer',
      // C-level exec (new CEO/COO often signals brand overhaul)
      'CEO',
      'Chief Executive Officer',
      'COO',
      'Chief Operating Officer',
      'President',
      // VP-level
      'VP Marketing',
      'Vice President Marketing',
      'Vice President of Marketing',
      'VP Brand',
      'Vice President Brand',
      // SVP-level
      'SVP Brand',
      'SVP Marketing',
      'Senior Vice President Brand',
      'Senior Vice President of Brand',
      'Senior Vice President Marketing',
      // EVP-level
      'EVP Marketing',
      'Executive Vice President Marketing',
      'Executive Vice President of Marketing',
      'EVP Brand',
      'EVP Brand Marketing',
      'Executive Vice President Brand Marketing',
      // Director/Head level
      'Head of Marketing',
      'Head of Brand',
      'Director of Marketing',
      'Director of Brand Marketing',
      'Marketing Director',
      // SVP Brand Marketing
      'SVP Brand Marketing',
      'Senior Vice President Brand Marketing',
      // VP Brand Marketing
      'VP Brand Marketing',
      'Vice President Brand Marketing'
    ],
    organization_locations: ['United States'],
    organization_num_employees_ranges: ['501-1000', '1000-5000', '5000-10000', '10000+'],
    changed_job_recently: true,
    page: 1,
    per_page: 100
  };
}

// ─── Apollo company enrichment (shared helper) ───────────────────────────────

// Used by PDL source to fill in revenue, industry, HQ etc.
// Queries Apollo organization enrichment by company name or website domain.
// Never throws — returns {} on any failure.
async function enrichCompanyWithApollo(companyName, websiteUrl) {
  if (!companyName && !websiteUrl) return {};
  const baseUrl = process.env.APOLLO_API_URL || 'https://api.apollo.io/v1';
  try {
    const body = {};
    if (websiteUrl) {
      body.domain = sanitizeApiInput(websiteUrl
        .replace(/^https?:\/\//i, '')
        .replace(/^www\./i, '')
        .replace(/\/.*$/, ''));
    } else {
      body.name = sanitizeApiInput(companyName);
    }
    const res = await axios.post(`${baseUrl}/organizations/enrich`, body, {
      headers: { 'X-Api-Key': process.env.APOLLO_API_KEY, 'Content-Type': 'application/json' },
      timeout: 15000  // 15s matches all other API calls — prevents one slow Apollo response from occupying a concurrency slot for 30s
    });
    return res.data?.organization || res.data || {};
  } catch (err) {
    const status = err.response?.status;
    if (status !== 422 && status !== 404) {
      // 422/404 = company not in Apollo — expected, not worth logging
      console.warn(`  [Apollo/enrich] Company enrichment failed for "${companyName || websiteUrl}" (${status ?? err.message})`);
    }
    return {};
  }
}

// ─── PeopleDataLabs fallback enrichment ──────────────────────────────────────

// Called when Apollo returns no start_date for a person.
// Takes their LinkedIn URL, queries PDL, returns the start_date string or null.
// Never throws — all errors are swallowed and return null.
async function enrichWithPDL(linkedinUrl) {
  if (!process.env.PDL_API_KEY || !linkedinUrl) return null;

  // PDL expects "linkedin.com/in/username" — strip http(s):// and www.
  const normalizedUrl = linkedinUrl
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '');

  try {
    const res = await axios.get('https://api.peopledatalabs.com/v5/person/enrich', {
      params:  { profile: normalizedUrl },
      headers: { 'X-Api-Key': process.env.PDL_API_KEY },
      timeout: 30000
    });

    const experiences = res.data?.data?.experience || [];

    // is_primary marks their current main job; fall back to end_date === null
    const current = experiences.find(e => e.is_primary === true)
                 || experiences.find(e => e.end_date === null);

    if (!current?.start_date) return null;

    // PDL may return "YYYY-MM" or "YYYY" — normalise to "YYYY-MM-DD"
    const parts = current.start_date.split('-');
    if (parts.length === 1) return `${parts[0]}-01-01`;
    if (parts.length === 2) return `${parts[0]}-${parts[1]}-01`;
    return current.start_date;

  } catch (err) {
    const status = err.response?.status;
    if (status === 404) return null; // person not in PDL database
    if (status === 402) console.warn('[PDL] Credits exhausted — skipping PDL fallback');
    else {
      // Log status and message only — never log response body which may echo API keys
      const errMsg = err.response?.data?.error?.message || err.response?.data?.message || err.message;
      console.warn(`[PDL] Lookup failed (${status ?? 'network'}) — ${errMsg}`);
    }
    return null;
  }
}

// Fetch job-change signals from Apollo.
// Saves raw response to .tmp/apollo_raw_YYYYMMDD.json.
// Returns array of signal objects with structure from project_specs.md Section 1.
async function fetchApolloSignals() {
  const today    = new Date().toISOString().split('T')[0].replace(/-/g, ''); // YYYYMMDD
  const todayStr = new Date().toISOString().split('T')[0];                   // YYYY-MM-DD

  const baseUrl = process.env.APOLLO_API_URL || 'https://api.apollo.io/v1';
  const url     = `${baseUrl}/mixed_people/api_search`;

  // ── HTTP call (up to 2 attempts on rate limit) ──────────────────────────────
  let rawResponse;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await axios.post(url, buildApolloRequestBody(), {
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key':    process.env.APOLLO_API_KEY
        },
        timeout: 30000
      });

      rawResponse = response.data; // { people: [...], pagination: {...} }
      break;

    } catch (err) {
      const status = err.response?.status;

      if (status === 401) {
        throw new Error('Apollo API: invalid API key (401) — check APOLLO_API_KEY in .env');
      }

      if (status === 422) {
        const errMsg = err.response?.data?.error || err.response?.data?.message || 'unprocessable request';
        throw new Error(`Apollo API: 422 — ${errMsg}`);
      }

      if (status === 429 && attempt === 1) {
        const delay = retryDelay(30000);
        console.warn(`[Apollo] Rate limit hit (429) — retrying in ${Math.round(delay / 1000)}s...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      if (status === 429 && attempt === 2) {
        throw new Error('Apollo API: rate limit still exceeded after retry (429)');
      }

      if (status === 500) {
        throw new Error('Apollo API: server error (500) — try again later');
      }

      throw new Error(`Apollo API: ${err.message}`);
    }
  }

  // ── Save raw response ────────────────────────────────────────────────────────
  fs.writeFileSync(
    path.join(TMP_DIR, `apollo_raw_${today}.json`),
    JSON.stringify(rawResponse, null, 2)
  );

  // ── Load existing Airtable LinkedIn URLs — skip already-saved people ─────────
  const existingApolloUrls = new Set();
  try {
    const ninetyDaysAgo = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const existingRecords = await airtableQuery({
      filterByFormula: `AND({Signal Type} = "Job Change", IS_AFTER({Date Detected}, '${ninetyDaysAgo}'))`,
      fields: ['Source URL']
    });
    for (const rec of existingRecords) {
      const url = rec.fields['Source URL'];
      if (url) existingApolloUrls.add(normalizeLinkedIn(url));
    }
    console.log(`[Apollo] Loaded ${existingApolloUrls.size} existing Job Change URLs from Airtable — will skip duplicates`);
  } catch (err) {
    console.warn('[Apollo] Could not load Airtable cache — proceeding without dedup:', err.message);
  }

  // ── Enrich each person and filter to last 90 days ───────────────────────────
  const enrichBaseUrl = process.env.APOLLO_API_URL || 'https://api.apollo.io/v1';
  const signals       = [];
  let   skippedOld    = 0;
  let   skippedNoDate = 0;
  let   skippedAirtable = 0;

  for (const person of (rawResponse.people || [])) {
    // Skip anyone already in Airtable — no enrichment or PDL credits needed
    const personLinkedin = normalizeLinkedIn(person.linkedin_url);
    if (personLinkedin && existingApolloUrls.has(personLinkedin)) {
      skippedAirtable++;
      continue;
    }

    // Fetch full profile to get employment history + job start date
    let fullPerson = person;
    try {
      const enrichRes = await axios.get(`${enrichBaseUrl}/people/${person.id}`, {
        headers: { 'X-Api-Key': process.env.APOLLO_API_KEY },
        timeout: 30000
      });
      fullPerson = enrichRes.data.person || enrichRes.data || person;
    } catch (enrichErr) {
      console.warn(`  [Apollo] Person enrichment failed for ${person.id} — using search result: ${enrichErr.message}`);
    }

    // Find current role in employment history
    const currentJob = (fullPerson.employment_history || []).find(j => j.current === true);
    const apolloDate = currentJob?.start_date || null;

    // Step 1: Apollo date pre-filter — skip clearly stale records before spending PDL credits.
    // 90 days matches the dedup window in workflow_3 — anything older would be deduped anyway.
    if (apolloDate && new Date(apolloDate) < new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)) {
      skippedOld++;
      continue;
    }

    // Step 2: Only call PDL on survivors — people Apollo says changed recently.
    const linkedinUrl = fullPerson.linkedin_url || person.linkedin_url;
    const pdlDate     = await enrichWithPDL(linkedinUrl);
    await new Promise(r => setTimeout(r, 200)); // rate limit buffer between PDL calls

    const startDate = pdlDate || apolloDate; // PDL wins; Apollo is fallback only

    if (pdlDate) {
      console.log(`[PDL] Confirmed start date for ${fullPerson.first_name || person.first_name}: ${pdlDate}`);
    } else if (apolloDate) {
      console.log(`[PDL] No PDL record for ${fullPerson.first_name || person.first_name} — using Apollo date: ${apolloDate} (unverified)`);
    }

    if (!startDate) skippedNoDate++;

    const org     = fullPerson.organization || person.organization || {};
    const revenue = sanitizeRevenue(org.annual_revenue || org.estimated_annual_revenue) ?? 0;

    signals.push({
      type:       'Job Change',
      source:     'Apollo',
      source_url: fullPerson.linkedin_url || person.linkedin_url || null,

      company: {
        name:           org.name,
        revenue,
        funding_total:  org.total_funding           || null,
        funding_stage:  org.latest_funding_stage    || null,
        headquarters: {
          city:    org.city    || null,
          state:   org.state   || null,
          country: org.country || null
        },
        industry:       org.industry                || null,
        website:        org.website_url             || null,
        employee_count: org.estimated_num_employees || null,
        founded_year:   org.founded_year            || null,
        stock_ticker:   org.publicly_traded_symbol  || null
      },

      person: {
        first_name:      fullPerson.first_name   || person.first_name   || null,
        last_name:       fullPerson.last_name    || person.last_name    || null,
        title:           fullPerson.title        || person.title        || null,
        linkedin_url:    fullPerson.linkedin_url || person.linkedin_url || null,
        email:           fullPerson.email        || null,
        email_status:    fullPerson.email_status || null, // Apollo's own deliverability verdict — used downstream in verifyEmail()
        job_started_at:  startDate
      },

      detected_date: todayStr,
      raw_data:      fullPerson
    });

    // 200ms between enrichment calls to stay well under rate limits
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`[Apollo] Fetched ${signals.length} recent job change signals (${skippedAirtable} already in Airtable, ${skippedOld} too old, ${skippedNoDate} no date)`);

  return signals;
}

// ─── PDL as job-change SOURCE ─────────────────────────────────────────────────
// Note: Coresignal was removed — date verification is now done manually by
// Gideon via Telegram (workflow_3b_verify_pdl.js) after deduplication.

// ─── PDL as job-change SOURCE ─────────────────────────────────────────────────

// Queries PDL Person Search for marketing leaders who recently changed roles
// at large US companies. Uses Apollo company enrichment to fill in revenue.
// Returns signals in the same format as fetchApolloSignals().
async function fetchPDLSignals() {
  if (!process.env.PDL_API_KEY) {
    console.log('[PDL Source] PDL_API_KEY not set — skipping');
    return [];
  }

  const todayStr      = new Date().toISOString().split('T')[0];
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
    .toISOString().split('T')[0];

  // Validate date string is safe (YYYY-MM-DD format only) before SQL interpolation
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ninetyDaysAgo)) throw new Error('Invalid date format for PDL query');

  const SQL = `
    SELECT * FROM person
    WHERE (
      (job_title_role = 'marketing' AND job_title_levels IN ('cxo', 'vp', 'director'))
      OR (job_title_levels = 'cxo' AND (
        job_title = 'chief executive officer'
        OR job_title = 'ceo'
        OR job_title = 'chief operating officer'
        OR job_title = 'coo'
        OR job_title = 'president'
        OR job_title = 'chief brand officer'
        OR job_title = 'cbo'
      ))
    )
    AND job_last_changed >= '${ninetyDaysAgo}'
    AND job_company_size IN ('501-1000', '1001-5000', '5001-10000', '10001+')
    AND job_company_inferred_revenue IN ('$50M to $100M', '$100M to $250M', '$250M to $500M', '$500M to $1B', '$1B to $10B', '$10B+')
    AND location_country = 'united states'
  `.trim();

  let rawResponse;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await axios.get('https://api.peopledatalabs.com/v5/person/search', {
        params:  { sql: SQL, size: 110 },
        headers: { 'X-Api-Key': process.env.PDL_API_KEY },
        timeout: 30000
      });
      rawResponse = res.data;
      break;
    } catch (err) {
      const status = err.response?.status;
      if (status === 402) throw new Error('PDL Source: credits exhausted (402)');
      if (status === 401) throw new Error('PDL Source: invalid API key (401)');
      if (status === 429 && attempt === 1) {
        const delay = retryDelay(30000);
        console.warn(`[PDL] Rate limit (429) — waiting ${Math.round(delay / 1000)}s before retry...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw new Error(`PDL Source: ${err.message}`);
    }
  }

  const today = new Date().toISOString().split('T')[0].replace(/-/g, '');
  fs.writeFileSync(
    path.join(TMP_DIR, `pdl_raw_${today}.json`),
    JSON.stringify(rawResponse, null, 2)
  );

  const people = rawResponse.data || [];
  console.log(`[PDL Source] Total matching in database: ${rawResponse.total} | Fetched: ${people.length}`);

  // Build a Set of LinkedIn URLs already saved in Airtable (Job Change records only).
  // This lets us skip people we've already processed — no Apollo enrichment credits wasted.
  const existingLinkedInUrls = new Set();
  try {
    const pdlNinetyDaysAgo = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const existingRecords = await airtableQuery({
      filterByFormula: `AND({Signal Type} = "Job Change", IS_AFTER({Date Detected}, '${pdlNinetyDaysAgo}'))`,
      fields: ['Source URL']
    });
    for (const rec of existingRecords) {
      const url = rec.fields['Source URL'];
      if (url) {
        // Normalize: strip protocol, www., and trailing slash for reliable comparison
        existingLinkedInUrls.add(normalizeLinkedIn(url));
      }
    }
    console.log(`[PDL Source] Loaded ${existingLinkedInUrls.size} existing Job Change URLs from Airtable — will skip duplicates`);
  } catch (err) {
    console.warn('[PDL Source] Could not load Airtable cache — proceeding without dedup:', err.message);
  }

  const signals = [];
  let skippedAirtable = 0;
  // Cache Apollo enrichment results by company key — avoids duplicate API calls
  // when multiple PDL people work at the same company.
  const apolloOrgCache = new Map();

  for (const person of people) {
    const linkedinUrl = person.linkedin_url
      ? `https://${person.linkedin_url.replace(/^https?:\/\//i, '')}`
      : null;

    // Skip anyone already in Airtable — no enrichment needed
    if (linkedinUrl && existingLinkedInUrls.has(normalizeLinkedIn(linkedinUrl))) {
      skippedAirtable++;
      continue;
    }

    const companyKey = (person.job_company_website || person.job_company_name || '').toLowerCase();
    let org;
    if (apolloOrgCache.has(companyKey)) {
      org = apolloOrgCache.get(companyKey);
    } else {
      org = await enrichCompanyWithApollo(person.job_company_name, person.job_company_website);
      apolloOrgCache.set(companyKey, org);
    }
    // PDL's SQL query already confirmed $50M+ inferred revenue. Only use Apollo's
    // revenue when it returns a positive value — never overwrite with 0, which would
    // cause workflow_2 to incorrectly drop the signal.
    const apolloRevenue = sanitizeRevenue(org.annual_revenue || org.estimated_annual_revenue) ?? 0;
    const revenue    = apolloRevenue > 0 ? apolloRevenue : null;

    signals.push({
      type:       'Job Change',
      source:     'PDL',
      source_url: linkedinUrl,

      company: {
        name:           person.job_company_name     || org.name               || null,
        revenue,
        funding_total:  org.total_funding           || null,
        funding_stage:  org.latest_funding_stage    || null,
        headquarters: {
          city:    org.city    || null,
          state:   org.state   || null,
          country: org.country || 'United States'
        },
        industry:       person.industry             || org.industry           || null,
        website:        person.job_company_website  || org.website_url        || null,
        employee_count: org.estimated_num_employees || null,
        founded_year:   org.founded_year            || null,
        stock_ticker:   org.publicly_traded_symbol  || null
      },

      person: {
        first_name:     person.first_name      || null,
        last_name:      person.last_name       || null,
        title:          person.job_title       || null,
        linkedin_url:   linkedinUrl,
        email:          person.work_email      || person.email || null,
        job_started_at: person.job_last_changed || null
      },

      detected_date: todayStr,
      raw_data:      person
    });

    await new Promise(r => setTimeout(r, 300)); // buffer between Apollo enrichment calls
  }

  console.log(`[PDL Source] Produced ${signals.length} job change signals (${skippedAirtable} already in Airtable — skipped)`);
  return signals;
}

// ─── MediaStack API ───────────────────────────────────────────────────────────

// Article sources that consistently produce noise — sports, politics,
// international non-US-business, and press-release spam sites.
const MEDIASTACK_BLOCKED_DOMAINS = new Set([
  // Sports sites
  'essentiallysports.com', 'completesports.com', 'awfulannouncing.com',
  'thedenverchannel.com', 'denver7.com', 'sportskeeda.com',
  // Military / government media
  'dvidshub.net',
  // Local news — not business/brand signals
  'toledoblade.com',
  // International / non-US-business
  'cyprus-mail.com', 'modernghana.com', 'deccanchronicle.com',
  'businessdayonline.com', 'mauinow.com', 'castanet.net',
  // Press release spam / off-topic
  'send2press.com', '247wallst.com', 'wnd.com', 'polygon.com',
  // Tech hardware / gadget news — not brand/marketing signals
  'tweaktown.com',
  // Financial news / stock commentary — not brand/marketing signals
  'americanbankingnews.com'
]);

// Allow operators to block additional domains at runtime without touching source code.
// Set BLOCKED_DOMAINS_EXTRA=spam1.com,spam2.com in .env
if (process.env.BLOCKED_DOMAINS_EXTRA) {
  process.env.BLOCKED_DOMAINS_EXTRA.split(',')
    .map(d => d.trim().toLowerCase())
    .filter(d => d.length > 0)
    .forEach(d => MEDIASTACK_BLOCKED_DOMAINS.add(d));
}

// Keywords are queried one at a time because MediaStack applies AND logic when
// multiple keywords are comma-separated, making multi-keyword queries return 0.
//
// Rebrand keywords use a 90-day lookback window — Starfish rule: always check 90 days back
// for rebrand signals so a company that rebranded two months ago is still catchable.
const MEDIASTACK_REBRAND_KEYWORDS = new Set([
  'rebrand', 'brand refresh', 'brand launch', 'brand identity', 'brand repositioning'
]);

// Phrases scanned in article title + description to catch rebrand stories that
// arrived via a non-rebrand keyword (e.g. a "merger" article that also mentions a rebrand).
const REBRAND_CONTENT_PHRASES = [
  'rebrand', 'rebranding', 'rebranded',
  'brand refresh', 'brand overhaul', 'brand redesign', 'brand revamp',
  'new brand identity', 'new brand name',
  'brand launch', 'brand repositioning',
  'brand transformation', 'new visual identity',
  'new name and logo', 'new logo and name'
];

const MEDIASTACK_KEYWORDS = [
  // Rebranding / brand activity — all specific to corporate brand work
  'rebrand',
  'brand refresh',
  'brand launch',
  'brand identity',
  'brand repositioning',
  // Funding signals — "funding round" is business-specific; bare "funding" matches universities/govt
  'funding round',
  'Series A',
  'Series B',
  'Series C',
  // M&A signals — these terms are almost exclusively corporate
  'merger',
  'acquisition',
  'M&A',
  // Job change press releases — brand/marketing leadership (C-suite & VP level)
  // Generic "new CEO/COO/President" removed: too noisy (matches universities, military, sports)
  'new Chief Brand Officer',
  'new Head of Marketing',
  'appointed CMO',
  'new Chief Marketing Officer',
  'named CMO',
  // Additional job change variants — covers all positions Apollo and PDL target
  'appointed Chief Marketing Officer',
  'named Chief Marketing Officer',
  'new VP of Marketing',
  'new Head of Brand',
  'joins as Chief Marketing Officer',
  // C-suite exec (brand/strategy overhaul signals)
  'new Chief Executive Officer',
  'new Chief Operating Officer',
  'appointed Chief Executive Officer',
  'appointed Chief Operating Officer',
  // VP Brand
  'new VP of Brand',
  'appointed VP Brand',
  // SVP level
  'new SVP Marketing',
  'new SVP Brand',
  'new SVP Brand Marketing',
  'appointed SVP Marketing',
  'appointed SVP Brand',
  'appointed SVP Brand Marketing',
  // EVP level
  'new EVP Marketing',
  'new EVP Brand',
  'new EVP Brand Marketing',
  'appointed EVP Marketing',
  'appointed EVP Brand',
  'appointed EVP Brand Marketing',
  'new Executive Vice President Marketing',
  'appointed Executive Vice President Marketing',
  // VP Brand Marketing
  'new VP Brand Marketing',
  'appointed VP Brand Marketing',
  // Director level
  'new Director of Marketing',
  'new Marketing Director',
  'new Director of Brand Marketing',
  'appointed Marketing Director',
  'appointed Director of Brand Marketing'
];

// Fetch news/press signals from MediaStack.
// Makes one API call per keyword, deduplicates by URL, saves combined raw to
// .tmp/mediastack_raw_YYYYMMDD.json.
// Returns array of signal objects with type "News/Press".
async function fetchMediaStackSignals() {
  const today    = new Date().toISOString().split('T')[0].replace(/-/g, ''); // YYYYMMDD
  const todayStr = new Date().toISOString().split('T')[0];                   // YYYY-MM-DD

  const url = 'https://api.mediastack.com/v1/news';

  // ── One call per keyword, collect all articles ──────────────────────────────
  const allArticles = [];
  const seenUrls    = new Set();

  // 90-day lookback for rebrand keywords — Starfish rule: check back 90 days for rebrands.
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  for (const keyword of MEDIASTACK_KEYWORDS) {
    const isRebrandKeyword = MEDIASTACK_REBRAND_KEYWORDS.has(keyword);
    const params = {
      access_key: process.env.MEDIASTACK_API_KEY,
      countries:  'us',
      keywords:   keyword,
      limit:      isRebrandKeyword ? 50 : 5,  // rebrand: 50 articles over 90 days; others: 5 latest
      sort:       'published_desc',
      ...(isRebrandKeyword ? { date: `${ninetyDaysAgo},${todayStr}` } : {})
    };

    let raw;
    try {
      const response = await axios.get(url, { params, timeout: 30000 });
      raw = response.data;
    } catch (err) {
      const status = err.response?.status;

      if (status === 401) {
        throw new Error('MediaStack API: invalid API key (401) — check MEDIASTACK_API_KEY in .env');
      }
      if (status === 429) {
        const delay = retryDelay(30000);
        console.warn(`[MediaStack] Rate limit on "${keyword}" — waiting ${Math.round(delay / 1000)}s...`);
        await new Promise(r => setTimeout(r, delay));
        try {
          const retry = await axios.get(url, { params, timeout: 30000 });
          raw = retry.data;
        } catch (retryErr) {
          console.warn(`[MediaStack] Retry failed for "${keyword}" — skipping`);
          continue;
        }
      } else {
        console.warn(`[MediaStack] "${keyword}" failed: ${err.message} — skipping`);
        continue;
      }
    }

    for (const article of (raw.data || [])) {
      const key = article.url || article.title;
      if (key && !seenUrls.has(key)) {
        seenUrls.add(key);
        allArticles.push({ ...article, _source_keyword: keyword });
      }
    }
  }

  // ── Drop articles older than 90 days ─────────────────────────────────────────
  const cutoff90 = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const recentArticles = allArticles.filter(a => {
    if (!a.published_at) return true; // no date — keep and let downstream decide
    return new Date(a.published_at) >= cutoff90;
  });
  const droppedOld = allArticles.length - recentArticles.length;
  if (droppedOld > 0) console.log(`[MediaStack] Dropped ${droppedOld} articles older than 90 days`);

  // ── Save combined raw ────────────────────────────────────────────────────────
  fs.writeFileSync(
    path.join(TMP_DIR, `mediastack_raw_${today}.json`),
    JSON.stringify({ total: allArticles.length, data: allArticles }, null, 2)
  );

  // ── Extract signal objects ───────────────────────────────────────────────────
  const signals = [];

  for (const article of recentArticles) {
    // Skip articles from off-topic domains (sports, politics, international, spam)
    try {
      const domain = new URL(article.url || 'https://unknown.com').hostname.replace(/^www\./, '');
      if (MEDIASTACK_BLOCKED_DOMAINS.has(domain)) continue;
    } catch (_) { /* malformed URL — proceed anyway */ }

    const companyName = extractCompanyName(article);
    if (!companyName) continue;

    const articleContent = `${article.title || ''} ${article.description || ''}`.toLowerCase();
    const isRebrandArticle = MEDIASTACK_REBRAND_KEYWORDS.has(article._source_keyword) ||
      REBRAND_CONTENT_PHRASES.some(kw => articleContent.includes(kw));

    signals.push({
      type:       isRebrandArticle ? 'Rebrand' : 'News/Press',
      source:     'MediaStack',
      source_url: article.url || null,

      company: {
        name:           companyName,
        revenue:        null,
        funding_total:  null,
        funding_stage:  null,
        headquarters:   { city: null, state: null, country: null },
        industry:       null,
        website:        null,
        employee_count: null,
        founded_year:   null,
        stock_ticker:   null
      },

      ...(isRebrandArticle ? {
        rebrand: {
          new_name:   null,
          summary:    article.title || null,
          found_at:   article.published_at || null,
          confidence: null
        }
      } : {
        article: {
          title:        article.title        || null,
          description:  article.description  || null,
          source:       article.source       || null,
          category:     article.category     || null,
          published_at: article.published_at || null
        }
      }),

      detected_date: todayStr,
      raw_data:      article
    });
  }

  const rebrandCount  = signals.filter(s => s.type === 'Rebrand').length;
  const newspressCount = signals.filter(s => s.type === 'News/Press').length;
  console.log(`[MediaStack] Fetched ${signals.length} signals — ${rebrandCount} Rebrand, ${newspressCount} News/Press (${recentArticles.length - signals.length} discarded — no company name extracted)`);

  return signals;
}

// ─── PredictLeads API ─────────────────────────────────────────────────────────

// Fetch M&A signals from PredictLeads news events.
// Fetches a single page of recent events and post-filters to M&A categories
// (the category query param does not filter server-side — all event types are returned).
// Response is JSON:API format — company details live in the included[] sideload.
// Returns array of signal objects with type "M&A Activity".
async function fetchPredictLeadsSignals() {
  if (!process.env.PREDICTLEADS_API_KEY) {
    console.log('[PredictLeads] PREDICTLEADS_API_KEY not set — skipping');
    return [];
  }

  const todayStr = new Date().toISOString().split('T')[0];
  const today    = todayStr.replace(/-/g, '');

  const baseUrl = 'https://predictleads.com/api/v3';
  const headers = {
    'X-Api-Key': process.env.PREDICTLEADS_API_KEY,
    ...(process.env.PREDICTLEADS_API_TOKEN
      ? { 'X-Api-Token': process.env.PREDICTLEADS_API_TOKEN }
      : {})
  };

  // PredictLeads /discover/news_events does NOT filter by the category param —
  // it returns a mixed pool of all recent event types regardless of what category
  // is requested. The category param appears to affect ranking, not filtering.
  // Evidence: querying 'rebrands_to' returns launches, signs_new_client, recognized_as, etc.
  //
  // Strategy: query ONCE per page (no category filter) to get the broadest pool,
  // then post-filter for M&A categories and detect rebrands by keyword.
  // Previously queried 5 categories × 3 pages but received the same ~30 events deduped
  // to 90 — wasting 4× quota for zero additional unique signals.
  const PL_PAGE_SIZE = 30;
  const PL_MAX_PAGES = 5; // 5 pages × 30 = up to 150 events (was 90 from 5 deduped queries)

  const MA_CATEGORIES = new Set(['acquires', 'merges_with', 'sells_assets_to', 'receives_financing']);
  // rebrands_to: kept for when PredictLeads does return this category.
  // Keyword detection below catches rebrand events from any category (e.g. 'launches').
  const REBRAND_CATEGORIES = new Set(['rebrands_to']);
  const REBRAND_KEYWORDS   = ['rebrand', 'brand refresh', 'brand identity', 'new brand', 'brand launch', 'new logo', 'brand update', 'new name'];
  const cutoff        = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  const seenIds        = new Set();
  const seenIncluded   = new Set(); // tracks "id|type" to avoid O(n²) .find() on rawIncluded
  let rawData          = [];
  let rawIncluded      = [];

  // Single category-less query (category filter is ignored by PredictLeads API)
  for (const category of [null]) {
    for (let page = 1; page <= PL_MAX_PAGES; page++) {
      let res = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const params = { page, per_page: PL_PAGE_SIZE };
          if (category) params.category = category; // omit when null — broadest discovery feed
          res = await axios.get(`${baseUrl}/discover/news_events`, {
            params,
            headers,
            timeout: 60000
          });
          break;
        } catch (err) {
          const status = err.response?.status;
          if (status === 401) throw new Error('PredictLeads API: invalid credentials (401) — check PREDICTLEADS_API_KEY');
          if (status === 402) throw new Error('PredictLeads API: plan limit reached (402)');
          if (status === 429) {
            if (attempt === 1) {
              const delay = retryDelay(30000);
              console.warn(`[PredictLeads] Rate limit on p${page} — waiting ${Math.round(delay / 1000)}s before retry...`);
              await new Promise(r => setTimeout(r, delay));
            } else {
              console.warn(`[PredictLeads] Rate limit persisted on p${page} — skipping page`);
              break;
            }
            continue;
          }
          if (attempt === 1) {
            console.warn(`[PredictLeads] p${page} failed (${err.message}) — retrying in 5s...`);
            await new Promise(r => setTimeout(r, 5000));
          } else {
            console.warn(`[PredictLeads] p${page} failed after retry — skipping`);
          }
        }
      }
      if (!res) break;

      const pageEvents = res.data?.data || [];
      for (const event of pageEvents) {
        if (seenIds.has(event.id)) continue;
        seenIds.add(event.id);
        rawData.push(event);
      }
      for (const item of (res.data?.included || [])) {
        const key = `${item.id}|${item.type}`;
        if (!seenIncluded.has(key)) {
          seenIncluded.add(key);
          rawIncluded.push(item);
        }
      }

      // If this page returned fewer than a full page, there are no more pages.
      // Exception: a 0-result middle page may be a transient API gap — retry once before stopping.
      if (pageEvents.length < PL_PAGE_SIZE) {
        if (pageEvents.length === 0 && page > 1) {
          console.warn(`[PredictLeads] p${page} returned 0 results mid-pagination — retrying once in 3s...`);
          await new Promise(r => setTimeout(r, 3000));
          let retryRes = null;
          try {
            const retryParams = { page, per_page: PL_PAGE_SIZE };
            if (category) retryParams.category = category;
            retryRes = await axios.get(`${baseUrl}/discover/news_events`, {
              params: retryParams,
              headers,
              timeout: 60000
            });
          } catch (retryErr) {
            console.warn('[PredictLeads] Zero-result page retry also failed — stopping pagination early:', retryErr.message);
          }
          const retryEvents = retryRes?.data?.data || [];
          if (retryEvents.length > 0) {
            // Got results on retry — add them and continue pagination
            for (const event of retryEvents) {
              if (seenIds.has(event.id)) continue;
              seenIds.add(event.id);
              rawData.push(event);
            }
            for (const item of (retryRes?.data?.included || [])) {
              const key = `${item.id}|${item.type}`;
              if (!seenIncluded.has(key)) { seenIncluded.add(key); rawIncluded.push(item); }
            }
            if (retryEvents.length < PL_PAGE_SIZE) break; // retry page was partial — truly last page
            continue; // full retry page — keep going
          }
        }
        break;
      }

      // Small delay between pages to avoid rate limiting
      if (page < PL_MAX_PAGES) await new Promise(r => setTimeout(r, 1000));
    }
  }

  const maCount      = rawData.filter(e => MA_CATEGORIES.has(e.attributes?.category)).length;
  const rebrandCount = rawData.filter(e => {
    const cat = e.attributes?.category || '';
    const summary = (e.attributes?.summary || '').toLowerCase();
    return REBRAND_CATEGORIES.has(cat) || REBRAND_KEYWORDS.some(kw => summary.includes(kw));
  }).length;
  console.log(`[PredictLeads] ${rawData.length} unique events fetched — ${maCount} are M&A, ${rebrandCount} are Rebrands (category + keyword detection)`);

  // Save combined raw
  fs.writeFileSync(
    path.join(TMP_DIR, `predictleads_raw_${today}.json`),
    JSON.stringify({ total: rawData.length, events: rawData }, null, 2)
  );

  const signals = [];

  for (const event of rawData) {
    const attrs    = event.attributes || {};
    const category = attrs.category   || '';

    // Post-filter: only M&A event types
    if (!MA_CATEGORIES.has(category)) continue;

    const foundAt = (attrs.found_at || todayStr).split('T')[0];

    // Post-filter: drop events older than 90 days
    if (attrs.found_at && new Date(attrs.found_at) < cutoff) continue;

    // Acquiring company — relationship key is "company1" (not "company")
    const company1Id      = event.relationships?.company1?.data?.id;
    const includedCompany = company1Id
      ? rawIncluded.find(r => r.type === 'company' && r.id === company1Id)
      : null;
    const companyAttrs    = includedCompany?.attributes || {};
    const companyName     = companyAttrs.company_name || null; // field is "company_name", not "name"

    if (!companyName) continue;

    // Target/seller company — relationship key is "company2"
    const company2Id     = event.relationships?.company2?.data?.id;
    const includedTarget = company2Id
      ? rawIncluded.find(r => r.type === 'company' && r.id === company2Id)
      : null;
    const sellerName     = includedTarget?.attributes?.company_name || null;

    // Source URL — lives in a news_article record in included[], via most_relevant_source
    const articleId      = event.relationships?.most_relevant_source?.data?.id;
    const includedArticle = articleId
      ? rawIncluded.find(r => r.type === 'news_article' && r.id === articleId)
      : null;
    const sourceUrl      = includedArticle?.attributes?.url || null;

    // HQ string from PredictLeads: "San Francisco, CA, United States"
    const hqString    = companyAttrs.headquarters || companyAttrs.hq_location || null;
    const headquarters = parseHeadquarters(hqString);

    signals.push({
      type:       'M&A Activity',
      source:     'PredictLeads',
      source_url: sourceUrl,

      company: {
        name:           companyName,
        revenue:        sanitizeRevenue(companyAttrs.annual_revenue) ?? null,
        funding_total:  companyAttrs.total_funding   || null,
        funding_stage:  companyAttrs.funding_stage   || null,
        headquarters,
        industry:       companyAttrs.industry        || null,
        website:        companyAttrs.domain ? `https://${companyAttrs.domain}` : null,
        employee_count: companyAttrs.employee_count  || null,
        founded_year:   companyAttrs.founded_year    || null,
        stock_ticker:   companyAttrs.ticker          || null
      },

      deal: {
        type:   category,
        seller: sellerName,
        amount: attrs.amount || attrs.amount_normalized || null
      },

      detected_date: foundAt,
      raw_data:      event
    });
  }

  console.log(`[PredictLeads] Fetched ${signals.length} M&A signals`);

  const rebrandSignals = [];

  for (const event of rawData) {
    const attrs    = event.attributes || {};
    const category = attrs.category   || '';

    // Detect rebrands: either explicit rebrands_to category, OR any event type whose
    // summary contains rebrand language (PredictLeads often files these as 'launches').
    const summaryLower = (attrs.summary || '').toLowerCase();
    const isRebrand = REBRAND_CATEGORIES.has(category) ||
      REBRAND_KEYWORDS.some(kw => summaryLower.includes(kw));
    if (!isRebrand) continue;

    const foundAt = (attrs.found_at || todayStr).split('T')[0];
    if (attrs.found_at && new Date(attrs.found_at) < cutoff) continue;

    const company1Id      = event.relationships?.company1?.data?.id;
    const includedCompany = company1Id
      ? rawIncluded.find(r => r.type === 'company' && r.id === company1Id)
      : null;
    const companyAttrs    = includedCompany?.attributes || {};
    const companyName     = companyAttrs.company_name || null;

    if (!companyName) continue;

    // New brand name — may be in company2 or in the summary text
    const company2Id      = event.relationships?.company2?.data?.id;
    const includedNewBrand = company2Id
      ? rawIncluded.find(r => r.type === 'company' && r.id === company2Id)
      : null;
    const newBrandName    = includedNewBrand?.attributes?.company_name || null;

    const articleId       = event.relationships?.most_relevant_source?.data?.id;
    const includedArticle = articleId
      ? rawIncluded.find(r => r.type === 'news_article' && r.id === articleId)
      : null;
    const sourceUrl       = includedArticle?.attributes?.url || null;

    const hqString    = companyAttrs.headquarters || companyAttrs.hq_location || null;
    const headquarters = parseHeadquarters(hqString);

    rebrandSignals.push({
      type:       'Rebrand',
      source:     'PredictLeads',
      source_url: sourceUrl,

      company: {
        name:           companyName,
        revenue:        sanitizeRevenue(companyAttrs.annual_revenue) ?? null,
        funding_total:  companyAttrs.total_funding   || null,
        funding_stage:  companyAttrs.funding_stage   || null,
        headquarters,
        industry:       companyAttrs.industry        || null,
        website:        companyAttrs.domain ? `https://${companyAttrs.domain}` : null,
        employee_count: companyAttrs.employee_count  || null,
        founded_year:   companyAttrs.founded_year    || null,
        stock_ticker:   companyAttrs.ticker          || null
      },

      rebrand: {
        new_name:    newBrandName,
        summary:     attrs.summary || null,
        found_at:    attrs.found_at || null,
        confidence:  attrs.confidence || null
      },

      detected_date: foundAt,
      raw_data:      event
    });
  }

  console.log(`[PredictLeads] Fetched ${rebrandSignals.length} Rebrand signals`);
  return [...signals, ...rebrandSignals];
}

// ─── NewsAPI (M&A + Funding news) ─────────────────────────────────────────────

// Same domain blocking logic used in the test — strips subdomains and handles ccTLDs
function newsApiDomain(url) {
  try {
    const parts = new URL(url).hostname.split('.');
    const last  = parts[parts.length - 1];
    const prev  = parts[parts.length - 2] || '';
    return last.length === 2 && prev.length <= 3
      ? parts.slice(-3).join('.')   // ccTLD: verdict.co.uk, prnewswire.co.uk
      : parts.slice(-2).join('.');  // standard: siliconangle.com
  } catch (_) { return ''; }
}

const NEWSAPI_BLOCKED_DOMAINS = new Set([
  'beincrypto.com', 'cryptobriefing.com', 'coindesk.com', 'cointelegraph.com', 'pymnts.com',
  'nypost.com', 'breitbart.com', 'themainewire.com', 'naturalnews.com',
  'sportskeeda.com', 'espn.com', 'thehockeynews.com',
  'dramabeans.com', 'insidethemagic.net', 'yankodesign.com', 'thewrap.com', 'variety.com',
  'economictimes.indiatimes.com', 'punchng.com', 'abc.net.au', 'nzherald.co.nz',
  'dailymail.com', 'prnewswire.co.uk', 'afriwallstreet.com', 'pressbee.net',
  'verdict.co.uk', 'antaranews.com', 'ibtimes.com.au',
  'nytimesnewstoday.com', 'techmaxxing.io', 'histalk2.com', 'techechelon.com',
  'spacedaily.com', 'foxnews.com', 'thenextweb.com'
]);

const NEWSAPI_QUERIES = [
  // ── Rebrand — 90-day lookback (Starfish rule) ──────────────────────────────
  {
    label:   'Rebrand',
    q:       '("rebrand" OR "rebranding" OR "brand refresh" OR "new brand identity" OR "brand overhaul" OR "brand redesign" OR "brand revamp" OR "new visual identity" OR "new name and logo") -"rebrand fund" -"brand equity" -"brand awareness campaign" -"personal brand"',
    sortBy:  'publishedAt',
    daysBack: 90
  },
  {
    label:   'M&A',
    q:       '("definitive agreement to acquire" OR "to be acquired by" OR "completes acquisition of" OR "agreed to acquire" OR "merger agreement with") -"net income" -"per diluted share" -"financial results" -"first quarter" -"form 10-Q" -"market size" -"market dynamics" -"market research" -"shareholder news"',
    sortBy:  'relevancy',
    domains: 'prnewswire.com,businesswire.com,globenewswire.com,reuters.com,bloomberg.com'
  },
  {
    label:   'Series B/C/D',
    q:       '"Series B" raises million OR "Series C" raises million OR "Series D" raises million',
    sortBy:  'publishedAt'
  },
  {
    label:   'Series A',
    q:       '"Series A" raises million',
    sortBy:  'publishedAt'
  },
  // ── Job change queries — restricted to press release wires for clean signal quality
  // Press releases are company-issued, US-centric, and contain structured name + title data.
  // Split into 3 queries by seniority tier to match every position Apollo and PDL target.
  {
    // C-suite: CMO, CBO, CEO, COO, President
    label:   'Job Change - C-Suite',
    q:       '("appointed" OR "named" OR "joins as" OR "hired as") AND ("Chief Marketing Officer" OR "CMO" OR "Chief Brand Officer" OR "CBO" OR "Chief Executive Officer" OR "CEO" OR "Chief Operating Officer" OR "COO" OR "President")',
    sortBy:  'publishedAt',
    domains: 'prnewswire.com,businesswire.com,globenewswire.com'
  },
  {
    // VP: VP and Vice President Marketing/Brand variants
    label:   'Job Change - VP',
    q:       '("appointed" OR "named" OR "joins as" OR "hired as") AND ("VP Marketing" OR "VP of Marketing" OR "VP Brand" OR "VP of Brand" OR "VP Brand Marketing" OR "Vice President Marketing" OR "Vice President of Marketing" OR "Vice President Brand" OR "Vice President of Brand" OR "Vice President Brand Marketing")',
    sortBy:  'publishedAt',
    domains: 'prnewswire.com,businesswire.com,globenewswire.com'
  },
  {
    // SVP & EVP: Senior and Executive Vice President Marketing/Brand variants
    label:   'Job Change - SVP/EVP',
    q:       '("appointed" OR "named" OR "joins as" OR "hired as") AND ("SVP Marketing" OR "SVP Brand" OR "SVP Brand Marketing" OR "Senior Vice President Marketing" OR "Senior Vice President Brand" OR "Senior Vice President of Marketing" OR "Senior Vice President of Brand" OR "EVP Marketing" OR "EVP Brand" OR "EVP Brand Marketing" OR "Executive Vice President Marketing" OR "Executive Vice President of Marketing")',
    sortBy:  'publishedAt',
    domains: 'prnewswire.com,businesswire.com,globenewswire.com'
  },
  {
    // Director & Head: Head of Marketing, Head of Brand, Director of Marketing, Director of Brand Marketing, Marketing Director
    label:   'Job Change - Director/Head',
    q:       '("appointed" OR "named" OR "joins as" OR "hired as") AND ("Head of Marketing" OR "Head of Brand" OR "Director of Marketing" OR "Director of Brand Marketing" OR "Marketing Director")',
    sortBy:  'publishedAt',
    domains: 'prnewswire.com,businesswire.com,globenewswire.com'
  }
];

// Fetch M&A and funding news signals from NewsAPI.
// Runs 3 targeted queries, deduplicates, filters blocked domains.
// Returns signals typed as "News/Press" — same schema as MediaStack signals.
async function fetchNewsAPISignals() {
  if (!process.env.NEWSAPI_API_KEY) {
    console.log('[NewsAPI] NEWSAPI_API_KEY not set — skipping');
    return [];
  }

  const todayStr      = new Date().toISOString().split('T')[0];
  const today         = todayStr.replace(/-/g, '');
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    .toISOString().split('T')[0];
  const ninetyDaysAgoNA = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
    .toISOString().split('T')[0];

  const seenTitles = new Set();
  const allArticles = [];

  for (const { label, q, sortBy, domains, daysBack } of NEWSAPI_QUERIES) {
    const fromDate = daysBack === 90 ? ninetyDaysAgoNA : thirtyDaysAgo;
    const pageSize = daysBack === 90 ? 50 : 20;  // rebrand gets more results over the larger window

    try {
      const res = await axios.get('https://newsapi.org/v2/everything', {
        params: {
          q,
          language: 'en',
          from:     fromDate,
          sortBy,
          pageSize,
          apiKey:   process.env.NEWSAPI_API_KEY,
          ...(domains ? { domains } : {})
        },
        timeout: 30000
      });

      const articles = res.data?.articles || [];
      let kept = 0;

      for (const article of articles) {
        // Domain filter
        const domain = newsApiDomain(article.url || '');
        if (NEWSAPI_BLOCKED_DOMAINS.has(domain)) continue;

        // Deduplicate syndicated stories by BOTH URL and normalized title.
        // URL alone misses identical press releases syndicated across different sites.
        const titleKey = (article.title || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60);
        const urlKey   = article.url || '';
        if ((urlKey && seenTitles.has(urlKey)) || (titleKey && seenTitles.has(titleKey))) continue;
        if (urlKey)   seenTitles.add(urlKey);
        if (titleKey) seenTitles.add(titleKey);

        allArticles.push({ article, label });
        kept++;
      }

      console.log(`[NewsAPI] "${label}": ${articles.length} returned → ${kept} kept`);

    } catch (err) {
      const status = err.response?.status;
      const msg    = err.response?.data?.message || err.message;
      if (status === 426) {
        console.warn(`[NewsAPI] "${label}": plan limit — upgrade for full 90-day history`);
      } else {
        console.warn(`[NewsAPI] "${label}" failed (${status ?? 'network'}): ${msg}`);
      }
    }

    await new Promise(r => setTimeout(r, 300));
  }

  // Build signal objects — same schema as MediaStack (both are news articles)
  const signals = [];

  for (const { article, label } of allArticles) {
    const companyName = extractCompanyName(article);
    if (!companyName) continue;

    // Reclassify as Rebrand if from the rebrand query OR content matches rebrand phrases
    const naContent   = `${article.title || ''} ${article.description || ''}`.toLowerCase();
    const isRebrand   = label === 'Rebrand' ||
      REBRAND_CONTENT_PHRASES.some(kw => naContent.includes(kw));

    signals.push({
      type:       isRebrand ? 'Rebrand' : 'News/Press',
      source:     'NewsAPI',
      source_url: article.url || null,

      company: {
        name:           companyName,
        revenue:        null,
        funding_total:  null,
        funding_stage:  null,
        headquarters:   { city: null, state: null, country: null },
        industry:       null,
        website:        null,
        employee_count: null,
        founded_year:   null,
        stock_ticker:   null
      },

      ...(isRebrand ? {
        rebrand: {
          new_name:   null,
          summary:    article.title || null,
          found_at:   article.publishedAt || null,
          confidence: null
        }
      } : {
        article: {
          title:        article.title        || null,
          description:  article.description  || null,
          source:       article.source?.name || null,
          category:     label,
          published_at: article.publishedAt  || null
        }
      }),

      detected_date: todayStr,
      raw_data:      article
    });
  }

  fs.writeFileSync(
    path.join(TMP_DIR, `newsapi_raw_${today}.json`),
    JSON.stringify({ total: allArticles.length, articles: allArticles.map(a => a.article) }, null, 2)
  );

  const naRebrandCount   = signals.filter(s => s.type === 'Rebrand').length;
  const naNewspressCount = signals.filter(s => s.type === 'News/Press').length;
  console.log(`[NewsAPI] Fetched ${signals.length} signals — ${naRebrandCount} Rebrand, ${naNewspressCount} News/Press`);
  return signals;
}

export { fetchApolloSignals, fetchPDLSignals, fetchMediaStackSignals, fetchPredictLeadsSignals, fetchNewsAPISignals };
