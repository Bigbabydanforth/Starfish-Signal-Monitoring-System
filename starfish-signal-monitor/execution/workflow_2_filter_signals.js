import 'dotenv/config';
import fs from 'fs';
import axios from 'axios';
import { fileURLToPath as toPath } from 'url';
import { dirname as dirOf, resolve } from 'path';

import { enrichSignal } from './utils/claude_client.js';
import { getTodayStamp } from './utils/date_helpers.js';
import { formatRevenue, formatNumber, isGarbageName } from './utils/text_parsing.js';
import { sendErrorAlert } from './utils/telegram_client.js';

const __filename_w2 = toPath(import.meta.url);
const __dirname_w2 = dirOf(__filename_w2);
const TMP_DIR = resolve(__dirname_w2, '../.tmp');

// ── Apollo geo-verification for News/Press signals with no country data ───────
// Called ONLY when the standard geography filter auto-passes a signal due to
// missing country. Queries Apollo org enrichment to confirm US headquarters.
// Returns true (keep) or false (drop). Never throws.
async function verifyUSHeadquarters(signal) {
  try {
    const baseUrl    = process.env.APOLLO_API_URL || 'https://api.apollo.io/v1';
    const companyName = signal.company?.name;
    const website     = signal.company?.website;

    if (!companyName && !website) return true; // can't verify — give benefit of doubt

    const body = {};
    if (website) {
      body.domain = website.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/.*$/, '');
    } else {
      body.name = companyName;
    }

    const res = await axios.post(`${baseUrl}/organizations/enrich`, body, {
      headers: { 'X-Api-Key': process.env.APOLLO_API_KEY, 'Content-Type': 'application/json' },
      timeout: 15000
    });

    const org     = res.data?.organization || res.data || {};
    const country = (org.country || '').toLowerCase().trim();
    const state   = (org.state   || '').toLowerCase().trim();

    if (!country && !state) return true; // Apollo has nothing — keep signal

    const stateIsUS  = US_STATES.has(state); // shared constant defined below
    const countryIsUS = ['united states', 'usa', 'us', 'u.s.', 'u.s.a.'].includes(country);

    if (stateIsUS || countryIsUS) return true; // confirmed US

    if (!country) return true; // state not US but no country data — keep (benefit of doubt)

    // Both country and state point non-US — drop it
    console.log(`  [GeoCheck] ❌ ${companyName} — Apollo says "${org.state || ''}, ${org.country || ''}" — dropping`);
    return false;
  } catch (err) {
    // Apollo is down or rate-limited — log a warning so operators know geo-verify is bypassed
    console.warn(`  [GeoCheck] ⚠️ Apollo error for ${signal.company?.name} — keeping signal (benefit of doubt): ${err.message}`);
    return true;
  }
}

// ── Detect if a News/Press article is about an executive job change ───────────
// Looks for appointment/hire keywords in the article title and description.
// Returns true if the article is about a person being appointed/hired/promoted.
function isJobChangeArticle(signal) {
  const text = [
    signal.article?.title       || '',
    signal.article?.description || ''
  ].join(' ').toLowerCase();

  const JOB_CHANGE_KEYWORDS = [
    'appointed', 'appoints', 'names ', 'named ', 'joins as', 'hired as',
    'promoted to', 'new cmo', 'new ceo', 'new coo', 'new chief',
    'new vp ', 'new vice president', 'welcomes new', 'announces new',
    'taps ', 'brings on', 'onboards'
  ];

  return JOB_CHANGE_KEYWORDS.some(kw => text.includes(kw));
}

// ── Apollo enrichment for M&A companies (acquirer or seller) ─────────────────
// Queries Apollo by company name or website. Returns { revenue, country, state,
// industry, website } or null on failure. Never throws.
async function enrichMaCompany(companyName, websiteUrl) {
  if (!companyName && !websiteUrl) return null;
  try {
    const baseUrl = process.env.APOLLO_API_URL || 'https://api.apollo.io/v1';
    const body = {};
    if (websiteUrl) {
      body.domain = websiteUrl.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/.*$/, '');
    } else {
      body.name = companyName;
    }
    const res = await axios.post(`${baseUrl}/organizations/enrich`, body, {
      headers: { 'X-Api-Key': process.env.APOLLO_API_KEY, 'Content-Type': 'application/json' },
      timeout: 15000
    });
    const org = res.data?.organization || res.data || {};
    return {
      revenue:  org.annual_revenue || org.estimated_annual_revenue || 0,
      country:  (org.country || '').toLowerCase().trim(),
      state:    (org.state   || '').toLowerCase().trim(),
      industry: org.industry    || null,
      website:  org.website_url || null
    };
  } catch {
    return null;
  }
}

// ── Apollo C-Suite lookup for M&A acquiring company ──────────────────────────
// After an M&A signal passes revenue verification, fetch the C-Suite of the
// acquiring company from Apollo so Starfish knows exactly who to contact.
// Returns array of { name, title, email, linkedin_url } — empty array on failure.
async function fetchMaCSuite(companyName, websiteUrl) {
  if (!companyName) return [];
  try {
    const baseUrl = process.env.APOLLO_API_URL || 'https://api.apollo.io/v1';
    const domain = websiteUrl
      ? websiteUrl.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/.*$/, '')
      : null;
    const body = {
      q_organization_name:   companyName,
      person_titles: [
        'CEO', 'Chief Executive Officer',
        'COO', 'Chief Operating Officer',
        'CMO', 'Chief Marketing Officer',
        'CFO', 'Chief Financial Officer',
        'CIO', 'Chief Information Officer',
        'CTO', 'Chief Technology Officer',
        'CHRO', 'Chief Human Resources Officer',
        'Chief People Officer',
        'Chief Brand Officer', 'CBO',
        'Chief Revenue Officer', 'CRO',
        'President',
        'Managing Director',
        'Managing Partner',
        'Partner'
      ],
      organization_locations: ['United States'],
      organization_domains:   domain ? [domain] : undefined,
      page:     1,
      per_page: 10
    };
    const res = await axios.post(`${baseUrl}/mixed_people/search`, body, {
      headers: { 'X-Api-Key': process.env.APOLLO_API_KEY, 'Content-Type': 'application/json' },
      timeout: 15000
    });
    const people = res.data?.people || [];
    return people.slice(0, 5).map(p => ({
      name:         `${p.first_name || ''} ${p.last_name || ''}`.trim(),
      title:        p.title || null,
      email:        p.email || null,
      linkedin_url: p.linkedin_url || null
    })).filter(p => p.name);
  } catch {
    return [];
  }
}

// ── Apollo company enrichment for News/Press job change articles ──────────────
// Queries Apollo by company name/website to get revenue + HQ.
// Returns { revenue, country, state } or null on failure. Never throws.
async function enrichNewsPressCompany(signal) {
  try {
    const baseUrl = process.env.APOLLO_API_URL || 'https://api.apollo.io/v1';
    const body = {};
    if (signal.company?.website) {
      body.domain = signal.company.website
        .replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/.*$/, '');
    } else {
      body.name = signal.company?.name;
    }
    if (!body.domain && !body.name) return null;

    const res = await axios.post(`${baseUrl}/organizations/enrich`, body, {
      headers: { 'X-Api-Key': process.env.APOLLO_API_KEY, 'Content-Type': 'application/json' },
      timeout: 15000
    });
    const org = res.data?.organization || res.data || {};
    return {
      revenue:  org.annual_revenue || org.estimated_annual_revenue || 0,
      country:  (org.country || '').toLowerCase().trim(),
      state:    (org.state   || '').toLowerCase().trim(),
      industry: org.industry || null,
      website:  org.website_url || null
    };
  } catch {
    return null;
  }
}

// ── US states set (reused from verifyUSHeadquarters) ─────────────────────────
const US_STATES = new Set([
  'alabama','alaska','arizona','arkansas','california','colorado','connecticut',
  'delaware','florida','georgia','hawaii','idaho','illinois','indiana','iowa',
  'kansas','kentucky','louisiana','maine','maryland','massachusetts','michigan',
  'minnesota','mississippi','missouri','montana','nebraska','nevada',
  'new hampshire','new jersey','new mexico','new york','north carolina',
  'north dakota','ohio','oklahoma','oregon','pennsylvania','rhode island',
  'south carolina','south dakota','tennessee','texas','utah','vermont',
  'virginia','washington','west virginia','wisconsin','wyoming',
  'district of columbia','washington dc','washington d.c.'
]);

// --- Filter Functions ---

// Government/municipal entities — never a Starfish branding client
const GOVERNMENT_PATTERNS = [
  /^city of /i,
  /^county of /i,
  /^state of /i,
  /^town of /i,
  /^village of /i,
  /^department of /i,
  /^office of /i,
  /^bureau of /i,
  /\bgovernment\b/i,
  /\bmunicipal\b/i,
  /\bpublic school\b/i,
  /\bschool district\b/i,
  /\bunified school\b/i,
  /\bauthority\b/i,            // Tourism Authority, Housing Authority, Port Authority
  /\bcouncil\b/i,              // City Council, County Council
  /\bdistrict\b/i,             // Water District, Transit District
];

// Non-profit / charity / religious entities — not Starfish branding clients
const NONPROFIT_PATTERNS = [
  /\bmissionary\b/i,
  /\bchurch\b/i,
  /\bministry\b/i,
  /\bministries\b/i,
  /\bcharity\b/i,
  /\bcharitable\b/i,
  /\bfoundation\b/i,
  /\bphilanthrop/i,
  /\bnonprofit\b/i,
  /\bnon-profit\b/i,
  /\b501c\b/i,
  /\brescue mission\b/i,
  /\bfood bank\b/i,
  /\bhumane society\b/i,
  /\buniversity\b/i,           // Universities (academic, not Starfish clients)
  /\bcollege of\b/i,           // "American College of Lifestyle Medicine"
  /\bresearch alliance\b/i,    // "Melanoma Research Alliance"
  /\bmedical alliance\b/i,
  /\bhealth alliance\b/i,
  /\bacademy of\b/i,           // "Academy of Arts/Sciences..."
  /\bmedical association\b/i,  // Medical professional bodies
  /\bnational league\b/i,      // Sports leagues / advocacy leagues
  /\bsupport group\b/i,
];

function isGovernmentEntity(name) {
  if (!name) return false;
  return GOVERNMENT_PATTERNS.some(p => p.test(name));
}

function isNonprofitEntity(name) {
  if (!name) return false;
  return NONPROFIT_PATTERNS.some(p => p.test(name));
}

function passesCompanySizeFilter(signal) {
  // Block government/municipal entities — not Starfish clients
  if (isGovernmentEntity(signal.company?.name)) {
    console.log(`  [Filter] ❌ Dropped government entity: ${signal.company?.name}`);
    return false;
  }

  // Block non-profits / charities / religious orgs — not Starfish clients
  if (isNonprofitEntity(signal.company?.name)) {
    console.log(`  [Filter] ❌ Dropped non-profit entity: ${signal.company?.name}`);
    return false;
  }

  // Rebrand signals are always valuable — bypass size filter entirely
  if (signal.type === 'Rebrand') return true;

  const revenue      = signal.company?.revenue || 0;
  const fundingStage = (signal.company?.funding_stage || '').toLowerCase().trim();

  // Apollo/MediaStack: pre-filtered at API level, no financial data returned → auto-pass
  // NewsAPI: wire service articles contain no company financials → auto-pass
  // PredictLeads: news event feed contains no revenue data → auto-pass
  // PDL: SQL query pre-filters to $50M+ inferred revenue. If Apollo enrichment returned
  // no revenue (null/0), PDL's own filter is trusted — auto-pass instead of dropping.
  // AudienceLab revenue is stored as a human-readable string ("Under 1 Million") — auto-pass.
  // AudienceLab leads are intent-verified; size filtering happens at the AudienceLab segment level.
  const NO_FINANCIAL_DATA_SOURCES = new Set(['Apollo', 'MediaStack', 'NewsAPI', 'PredictLeads', 'PDL', 'AudienceLab']);
  if (revenue === 0 && !fundingStage && NO_FINANCIAL_DATA_SOURCES.has(signal.source)) return true;

  const meetsRevenue = Math.floor(revenue) >= 50_000_000;

  const validFundingStages = [
    'series a', 'series_a', 'seriesa',
    'series b', 'series_b', 'seriesb',
    'series c', 'series_c', 'seriesc',
    'series d', 'series_d', 'seriesd',
    'series e', 'series_e', 'seriese'
  ];
  const meetsFunding = validFundingStages.includes(fundingStage);

  if (!meetsRevenue && !meetsFunding) return false;

  return true;
}

function passesGeographyFilter(signal) {
  const country = (signal.company?.headquarters?.country || '').toLowerCase().trim();

  // Apollo: pre-filtered to US via organization_locations in the request
  // MediaStack: free plan returns no country field
  // NewsAPI: US focus enforced via wire service domain whitelist (no country on signal)
  // PredictLeads: country sometimes present, sometimes absent — auto-pass when missing
  const NO_COUNTRY_DATA_SOURCES = new Set(['Apollo', 'MediaStack', 'NewsAPI', 'PredictLeads']);
  if (!country && NO_COUNTRY_DATA_SOURCES.has(signal.source)) return true;

  return ['united states', 'usa', 'us', 'u.s.', 'u.s.a.'].includes(country);
}

// Titles that reveal the company is NOT a Starfish commercial branding client.
// If a BSI signal comes in with one of these on the triggering person, the whole signal is dropped.
const NON_COMMERCIAL_TITLE_KEYWORDS = [
  // Sports / athletics
  'coach', 'coaching', 'athletic director', 'athletic trainer', 'referee', 'umpire',
  'player', 'athlete',
  // Education
  'teacher', 'professor', 'lecturer', 'instructor', 'faculty', 'adjunct',
  'principal', 'superintendent', 'curriculum', 'librarian', 'tutor',
  'student', 'graduate student', 'phd candidate', 'postdoc',
  // Religious
  'pastor', 'reverend', 'minister', 'priest', 'deacon', 'chaplain', 'bishop',
  // Volunteer / civic
  'volunteer', 'board member', 'trustee', 'docent',
];

function passesJobTitleFilter(signal) {
  // Brand Strategy Intent: the person attached is whoever triggered the AudienceLab signal —
  // NOT the outreach target. But their title reveals what kind of organization this is.
  // Drop any BSI signal where the person's title indicates a non-commercial context
  // (school, sports team, church, etc.) — these are never Starfish branding clients.
  // AudienceLab auto-passes the size filter so this is the only gate for these org types.
  if (signal.type === 'Brand Strategy Intent') {
    const title = (signal.person?.title || '').toLowerCase().trim();
    if (title) {
      const isNonCommercial = NON_COMMERCIAL_TITLE_KEYWORDS.some(k => title.includes(k));
      if (isNonCommercial) {
        console.log(`  [Filter] ❌ BSI dropped — non-commercial title: "${signal.person.title}" at ${signal.company?.name}`);
        return false;
      }
    }
    return true;
  }

  // Website Visitors: only keep if there is a named person with a senior marketing/brand title.
  // An unknown visitor or a junior/irrelevant role is useless — drop before wasting Claude + Airtable.
  if (signal.type === 'Website Visitor') {
    const firstName = signal.person?.first_name?.trim();
    const lastName  = signal.person?.last_name?.trim();
    if (!firstName) {
      console.log(`  [Filter] ❌ WV dropped — no person identified: ${signal.company?.name}`);
      return false;
    }

    const title = (signal.person?.title || '').toLowerCase().trim();
    if (!title || title === 'unknown') {
      console.log(`  [Filter] ❌ WV dropped — unknown title: ${firstName} ${lastName || ''} at ${signal.company?.name}`);
      return false;
    }

    // Marketing/brand C-suite acronyms — inherently both senior AND relevant
    const MARKETING_CSUITE = ['cmo', 'cbo', 'cco', 'chief marketing', 'chief brand', 'chief communications'];
    if (MARKETING_CSUITE.some(k => title.includes(k))) return true;

    // All other titles: must have seniority AND explicit marketing/brand relevance.
    // VP is matched with a word-boundary regex (\bvp\b) so "VP, Marketing" (comma),
    // "VP/Brand" (slash), or "VP" at end of string all match — not just "VP " (space only).
    const hasSeniority = [
      'chief', 'ceo', 'coo', 'president',
      'vice president', 'svp', 'evp',
      'director', 'head of'
    ].some(k => title.includes(k)) || /\bvp\b/.test(title);

    const hasRelevance = ['marketing', 'brand', 'growth', 'communications'].some(k => title.includes(k));

    if (!hasSeniority || !hasRelevance) {
      console.log(`  [Filter] ❌ WV dropped — title not senior marketing/brand: "${signal.person.title}" at ${signal.company?.name}`);
      return false;
    }

    return true;
  }

  if (signal.type !== 'Job Change') return true;

  const title = (signal.person?.title || '').toLowerCase().trim();
  if (!title) return false;

  // PDL guarantees seniority level (cxo/vp/director) and job_title_role='marketing'
  // at the API level, but PDL's 'marketing' bucket is broad — it includes PR, comms,
  // content, and growth roles. Apply a keyword check so only explicit marketing/brand
  // titles pass, cutting roles like "Director of Internal Communications".
  if (signal.source === 'PDL') {
    // Use word-boundary regex for short acronyms so substrings inside other words
    // don't cause false positives (e.g. "coo" inside "coordinator", "cco" inside "account").
    const hasAcronym = acr => new RegExp(`\\b${acr}\\b`).test(title);
    return title.includes('marketing') || title.includes('brand') ||
           title.includes('communications') ||
           hasAcronym('cmo') || hasAcronym('cbo') ||
           (hasAcronym('cco') && title.includes('communications')) ||
           title.includes('chief executive') || title.includes('chief operating') ||
           hasAcronym('ceo') || hasAcronym('coo') ||
           (title.includes('president') && !title.includes('vice president'));
  }

  const validTitles = [
    // C-level marketing & brand
    'cmo',
    'chief marketing officer',
    'chief brand officer',
    'cbo',
    'chief communications officer',
    // C-level exec
    'chief executive officer',
    'ceo',
    'chief operating officer',
    'coo',
    'president',
    // VP-level
    'vp marketing',
    'vp of marketing',
    'vice president marketing',
    'vice president of marketing',
    'vp brand',
    'vice president brand',
    'vice president of brand',
    // SVP-level
    'svp brand',
    'svp marketing',
    'svp of marketing',
    'svp brand marketing',
    'senior vice president brand',
    'senior vice president of brand',
    'senior vice president marketing',
    'senior vice president of marketing',
    'senior vice president brand marketing',
    // EVP-level
    'evp marketing',
    'evp brand',
    'evp brand marketing',
    'executive vice president marketing',
    'executive vice president of marketing',
    'executive vice president brand marketing',
    // VP Brand Marketing
    'vp brand marketing',
    'vice president brand marketing',
    // Director/Head level
    'head of marketing',
    'head of brand',
    'director of marketing',
    'director of brand marketing',
    'marketing director',
    // Additional variants
    'chief growth officer',
    'brand marketing'
  ];

  if (validTitles.some(valid => title.includes(valid))) return true;

  // Catch verbose titles like "VP, Integrated Marketing" or "SVP, Customer Marketing"
  const hasSeniority = ['vice president', 'vp', 'svp', 'evp', 'chief', 'head of', 'director'].some(k => title.includes(k));
  return hasSeniority && title.includes('marketing');
}

// --- Claude Prompt Builder ---

function buildPromptVars(signal) {
  let signalDetails;

  if (signal.type === 'Job Change') {
    signalDetails = `${signal.person.first_name} ${signal.person.last_name} joined ${signal.company.name} as ${signal.person.title}.`;
  } else if (signal.type === 'Website Visitor') {
    const name = [signal.person?.first_name, signal.person?.last_name].filter(Boolean).join(' ') || 'Unknown';
    signalDetails = `${name} (${signal.person?.title || 'Unknown Title'}) from ${signal.company.name} visited the Starfish website.`;
    if (signal.source_url && !signal.source_url.includes('api.audiencelab.io')) {
      signalDetails += ` Page visited: ${signal.source_url}.`;
    }
    if (signal.company.industry) signalDetails += ` Industry: ${signal.company.industry}.`;
    if (signal.detected_date)    signalDetails += ` Visit detected: ${signal.detected_date}.`;
  } else if (signal.type === 'Brand Strategy Intent') {
    signalDetails = `${signal.company.name} is actively researching brand strategy topics online — flagged by AudienceLab intent data.`;
    if (signal.company.industry)   signalDetails += ` Industry: ${signal.company.industry}.`;
    if (signal.company.employee_count) signalDetails += ` Size: ${signal.company.employee_count.toLocaleString()} employees.`;
    if (signal.person?.department) signalDetails += ` Signal detected via department: ${signal.person.department}.`;
    signalDetails += ` This indicates active evaluation of branding services — not just passive interest.`;
  } else if (signal.type === 'News/Press') {
    signalDetails = (signal.article?.title || '') + (signal.article?.description ? '. ' + signal.article.description : '');
  } else if (signal.type === 'M&A Activity') {
    signalDetails = `${(signal.deal?.type || 'deal').toUpperCase()}: ${signal.company.name}` +
      (signal.deal?.seller ? ` acquiring ${signal.deal.seller}` : '') +
      (signal.deal?.amount ? `. Deal value: $${formatNumber(signal.deal.amount)}` : '');
    if (signal.deal?.seller_revenue > 0) {
      signalDetails += `. Target revenue: ${formatRevenue(signal.deal.seller_revenue)}`;
    }
    if (signal.ma_contacts?.length > 0) {
      const contactList = signal.ma_contacts
        .map(c => `${c.name} (${c.title || 'Unknown Title'})`)
        .join(', ');
      signalDetails += `. Key contacts at acquirer: ${contactList}.`;
    }
  } else if (signal.type === 'Rebrand') {
    signalDetails = `${signal.company.name} is rebranding` +
      (signal.rebrand?.new_name ? ` to ${signal.rebrand.new_name}` : '') +
      (signal.rebrand?.summary ? `. ${signal.rebrand.summary}` : '');
  }

  // For Job Change signals the person is already known; for News/Press the contact
  // is found later in workflow_4 so these default to 'Not available'.
  // For Brand Strategy Intent: the AudienceLab person is NOT the outreach target —
  // the real marketing exec is found in workflow_4. Passing the AL person causes Claude
  // to either write about a non-relevant contact or hallucinate a different exec entirely.
  // Pass 'Not available' so Claude writes a company-focused brief with no phantom names.
  const isBSI = signal.type === 'Brand Strategy Intent';
  const contactName  = (!isBSI && signal.person)
    ? `${signal.person.first_name || ''} ${signal.person.last_name || ''}`.trim()
    : '';
  const contactEmail = (!isBSI && (signal.person?.email || signal.contact?.email)) || '';
  const contactTitle = (!isBSI && (signal.person?.title || signal.contact?.title)) || '';

  return {
    SIGNAL_TYPE:    signal.type,
    COMPANY_NAME:   signal.company.name,
    INDUSTRY:       signal.company.industry || 'Unknown',
    REVENUE:        signal.company.revenue ? formatRevenue(signal.company.revenue) : 'Unknown',
    EMPLOYEE_COUNT: signal.company.employee_count ? signal.company.employee_count.toLocaleString() : 'Unknown',
    SIGNAL_DETAILS: signalDetails,
    CONTACT_NAME:   contactName  || 'Not available',
    CONTACT_EMAIL:  contactEmail || 'Not available',
    CONTACT_TITLE:  contactTitle || 'Not available'
  };
}

// --- Main Workflow ---

async function filterSignals(allSignals) {
  const today = getTodayStamp();

  // Step 2.1: Size filter — cheapest, cuts the most, runs first
  const sizeFiltered = allSignals.filter(passesCompanySizeFilter);
  console.log(`[Filter: Size]      ${allSignals.length} → ${sizeFiltered.length} signals`);

  // Step 2.2: Job title filter — free, cuts bad Job Change titles early
  const titleFiltered = sizeFiltered.filter(passesJobTitleFilter);
  console.log(`[Filter: Title]     ${sizeFiltered.length} → ${titleFiltered.length} signals`);

  // Step 2.3: Start date filter — free, cuts stale Job Changes before any API call
  // Compare YYYY-MM-DD strings (UTC) to avoid local-timezone skew near the 90-day boundary.
  const cutoff90Str = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const dateFiltered = titleFiltered.filter(signal => {
    if (signal.type !== 'Job Change') return true;
    if (!signal.person?.job_started_at) return false;
    // Normalize to date-only (handles "2026-03-15" and "2026-03-15T12:00:00Z" equally)
    const startDateStr = signal.person.job_started_at.split('T')[0];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDateStr)) return false; // malformed — reject
    // Explicit range validation — JS Date() silently wraps overflow (e.g. month 13 → Jan next year)
    const [, mo, dy] = startDateStr.split('-').map(Number);
    if (mo < 1 || mo > 12 || dy < 1 || dy > 31) return false;
    // Round-trip validation — if JS wrapped the date (e.g. Feb 30 → Mar 2), the ISO string won't match
    const d = new Date(`${startDateStr}T00:00:00Z`);
    if (isNaN(d.getTime()) || d.toISOString().split('T')[0] !== startDateStr) return false;
    return startDateStr >= cutoff90Str;
  });
  console.log(`[Filter: StartDate] ${titleFiltered.length} → ${dateFiltered.length} signals`);

  // Step 2.4: Geography filter — uses data already on the signal, no API
  const geoFiltered = dateFiltered.filter(passesGeographyFilter);
  console.log(`[Filter: Geography] ${dateFiltered.length} → ${geoFiltered.length} signals`);

  // Concurrency limits — override via env vars (see execution/utils/config.js for all options)
  const FILTER_CONCURRENCY = Number(process.env.FILTER_CONCURRENCY) || 5;
  const CLAUDE_CONCURRENCY = Number(process.env.CLAUDE_CONCURRENCY) || 3;

  // Runs `fn` on all items in parallel, at most `concurrency` at a time, preserving order.
  // Uses Promise.allSettled so a single item failure never stops the remaining batches from running.
  async function runBatched(items, concurrency, fn) {
    const results = [];
    for (let i = 0; i < items.length; i += concurrency) {
      const batch = items.slice(i, i + concurrency);
      const settled = await Promise.allSettled(batch.map(fn));
      for (let j = 0; j < settled.length; j++) {
        if (settled[j].status === 'fulfilled') {
          results.push(settled[j].value);
        } else {
          const name = batch[j]?.company?.name || '?';
          console.error(`[runBatched] Item ${i + j} (${name}) threw unexpectedly — keeping signal to avoid silent loss:`, settled[j].reason?.message || settled[j].reason);
          // Return a safe pass-through: { signal, keep: true } works for both callers.
          // geo-verify: keep:true means fail-open (signal survives).
          // claudeEnrich: .signal is the item, .failure is absent (signal preserved without enrichment).
          results.push({ signal: batch[j], keep: true });
        }
      }
    }
    return results;
  }

  // Step 2.5: Apollo geo-verification — parallel, at most FILTER_CONCURRENCY at a time.
  // Only applies to News/Press / M&A signals with no country data.
  // PDL Job Changes: already confirmed US at API level — skip.
  // Apollo Job Changes: pre-filtered to US via organization_locations — skip.
  const needsGeoVerify = geoFiltered.filter(s => s.type !== 'Job Change' && !s.company?.headquarters?.country);

  const geoVerifyResults = await runBatched(needsGeoVerify, FILTER_CONCURRENCY, async (signal) => {
    const isUS = await verifyUSHeadquarters(signal);
    return { signal, keep: isUS };
  });

  // Reassemble in original order
  const geoVerifyKeepSet = new Set(
    geoVerifyResults.filter(r => r.keep).map(r => r.signal)
  );
  const geoVerified = geoFiltered.filter(s =>
    s.type === 'Job Change' || !!s.company?.headquarters?.country
      ? true
      : geoVerifyKeepSet.has(s)
  );

  // Alert if Apollo geo-verify appears to be down
  const droppedByGeo = needsGeoVerify.length - geoVerifyResults.filter(r => r.keep).length;
  if (needsGeoVerify.length > 3 && droppedByGeo === 0) {
    console.warn(`[GeoVerify] ⚠️ ${needsGeoVerify.length} signals passed geo-verify with 0 dropped — Apollo may be down or returning no country data`);
  }
  console.log(`[Filter: GeoVerify] ${geoFiltered.length} → ${geoVerified.length} signals`);

  // Step 2.6: Apollo revenue + title check for News/Press articles about job changes.
  // Funding articles → pass through untouched.
  // Job change articles → enrich with Apollo to check company revenue + confirm US HQ.
  async function newsJobCheckOne(signal) {
    if (signal.type !== 'News/Press') return { signal, keep: true };
    if (!isJobChangeArticle(signal))  return { signal, keep: true };

    console.log(`  [NewsJobCheck] "${signal.article?.title?.substring(0, 60)}..."`);
    const enriched = await enrichNewsPressCompany(signal);

    if (!enriched) {
      console.log(`  [NewsJobCheck] Apollo returned nothing for ${signal.company.name} — keeping`);
      return { signal, keep: true };
    }

    signal.company.revenue   = enriched.revenue  || signal.company.revenue;
    signal.company.industry  = enriched.industry || signal.company.industry;
    signal.company.website   = enriched.website  || signal.company.website;
    if (!signal.company.headquarters) signal.company.headquarters = { city: null, state: null, country: null };
    if (enriched.country) signal.company.headquarters.country = enriched.country;
    if (enriched.state)   signal.company.headquarters.state   = enriched.state;

    const meetsRevenue = Math.floor(enriched.revenue) >= 50_000_000;
    if (!meetsRevenue && enriched.revenue > 0) {
      console.log(`  [NewsJobCheck] ❌ ${signal.company.name} — revenue $${(enriched.revenue/1e6).toFixed(0)}M below $50M threshold — dropping`);
      return { signal, keep: false };
    }

    const countryIsUS = ['united states', 'usa', 'us', 'u.s.', 'u.s.a.'].includes(enriched.country);
    const stateIsUS   = US_STATES.has(enriched.state);
    if (enriched.country && !countryIsUS && !stateIsUS) {
      console.log(`  [NewsJobCheck] ❌ ${signal.company.name} — non-US HQ (${enriched.state}, ${enriched.country}) — dropping`);
      return { signal, keep: false };
    }

    console.log(`  [NewsJobCheck] ✅ ${signal.company.name} — revenue $${(enriched.revenue/1e6).toFixed(0)}M, US confirmed`);
    return { signal, keep: true };
  }

  const newsJobResults      = await runBatched(geoVerified, FILTER_CONCURRENCY, newsJobCheckOne);
  const newsJobChangeVerified = newsJobResults.filter(r => r.keep).map(r => r.signal);
  console.log(`[Filter: NewsJobCheck] ${geoVerified.length} → ${newsJobChangeVerified.length} signals`);

  // Step 2.7: M&A revenue verification — parallel, at most FILTER_CONCURRENCY at a time.
  // receives_financing (funding rounds) → free pass — the raise IS the signal, not their revenue
  // acquires / merges_with / sells_assets_to → call Apollo for BOTH companies;
  //   at least one must be ≥ $50M to qualify as a Starfish target
  const FUNDING_DEAL_TYPES = new Set(['receives_financing']);

  async function maVerifyOne(signal) {
    if (signal.type !== 'M&A Activity')           return { signal, keep: true };
    if (FUNDING_DEAL_TYPES.has(signal.deal?.type)) return { signal, keep: true };

    console.log(`  [M&A Revenue] Checking ${signal.company.name}...`);
    const acquirerData = await enrichMaCompany(signal.company.name, signal.company.website);

    let sellerRevenue = 0;
    if (signal.deal?.seller) {
      const sellerData = await enrichMaCompany(signal.deal.seller, null);
      if (sellerData) sellerRevenue = sellerData.revenue || 0;
      signal.deal.seller_revenue = sellerRevenue;
    }

    const acquirerRevenue = acquirerData?.revenue || 0;

    if (acquirerData) {
      signal.company.revenue  = acquirerRevenue || signal.company.revenue;
      signal.company.industry = acquirerData.industry || signal.company.industry;
      signal.company.website  = acquirerData.website  || signal.company.website;
      if (!signal.company.headquarters) signal.company.headquarters = { city: null, state: null, country: null };
      if (acquirerData.country) signal.company.headquarters.country = acquirerData.country;
      if (acquirerData.state)   signal.company.headquarters.state   = acquirerData.state;
    }

    const meetsThreshold = Math.floor(acquirerRevenue) >= 50_000_000 || Math.floor(sellerRevenue) >= 50_000_000;
    const acqLabel = acquirerRevenue > 0 ? `$${(acquirerRevenue / 1e6).toFixed(0)}M` : 'unknown';
    const selLabel = signal.deal?.seller
      ? (sellerRevenue > 0 ? `$${(sellerRevenue / 1e6).toFixed(0)}M` : 'unknown')
      : null;

    if (!meetsThreshold && (acquirerRevenue > 0 || sellerRevenue > 0)) {
      console.log(`  [M&A Revenue] ❌ ${signal.company.name} — acquirer ${acqLabel}${selLabel ? `, seller ${selLabel}` : ''} — below $50M threshold`);
      return { signal, keep: false };
    }

    console.log(`  [M&A Revenue] ✅ ${signal.company.name} — acquirer ${acqLabel}${selLabel ? `, seller ${selLabel}` : ''}`);

    const csuite = await fetchMaCSuite(signal.company.name, signal.company.website);
    if (csuite.length > 0) {
      signal.ma_contacts = csuite;
      console.log(`  [M&A C-Suite] Found ${csuite.length} contacts for ${signal.company.name}: ${csuite.map(c => c.title).join(', ')}`);
    }

    return { signal, keep: true };
  }

  const maResults  = await runBatched(newsJobChangeVerified, FILTER_CONCURRENCY, maVerifyOne);
  const maVerified = maResults.filter(r => r.keep).map(r => r.signal);
  console.log(`[Filter: M&A Revenue] ${newsJobChangeVerified.length} → ${maVerified.length} signals`);

  // Rebrand signals are always HIGH priority — forced before Claude so it can't downgrade them
  for (const signal of maVerified) {
    if (signal.type === 'Rebrand') signal.priority = 'HIGH';
  }

  // Step 2.75: Garbage name filter — remove headlines / non-company names BEFORE Claude.
  // Doing this here (not in workflow_3) avoids wasting Claude API credits on signals
  // that would be discarded anyway. workflow_3 still runs the same filter as a safety net.
  const beforeGarbage2 = maVerified.length;
  const preClaudeClean = maVerified.filter(s => !isGarbageName(s.company.name));
  const garbageRemoved2 = beforeGarbage2 - preClaudeClean.length;
  if (garbageRemoved2 > 0) {
    console.log(`[Filter: Garbage] Removed ${garbageRemoved2} garbage/non-company signals before Claude enrichment`);
  }

  // Step 2.8: Claude enrichment — parallel at CLAUDE_CONCURRENCY (3), most expensive step.
  async function claudeEnrichOne(signal) {
    try {
      const promptVars = buildPromptVars(signal);
      const enrichment = await enrichSignal(promptVars);

      signal.priority         = enrichment.priority;
      signal.brief            = enrichment.brief;
      signal.contact_approach = enrichment.contact_approach;

      // Rebrand signals are always HIGH — never let Claude downgrade them
      if (signal.type === 'Rebrand') signal.priority = 'HIGH';

      return { signal, failure: null };
    } catch (error) {
      console.error(`[Claude] Enrichment failed for ${signal.company.name}:`, error.message);

      signal.priority         = 'MEDIUM';
      signal.brief            = 'Signal requires manual review.';
      signal.contact_approach = 'Review company website and LinkedIn before outreach.';
      signal._claude_failed   = true;  // flag so workflow_4 can mark these distinctly in Airtable

      return { signal, failure: { company: signal.company.name, error: error.message } };
    }
  }

  const claudeResults   = await runBatched(preClaudeClean, CLAUDE_CONCURRENCY, claudeEnrichOne);
  const enrichedSignals = claudeResults.map(r => r.signal);
  const claudeFailures  = claudeResults.filter(r => r.failure).map(r => r.failure);

  // Write all Claude failures as a proper JSON array and alert Starfish
  if (claudeFailures.length > 0) {
    const runTs = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(
      `${TMP_DIR}/claude_failures_${today}_${runTs}.json`,
      JSON.stringify(claudeFailures, null, 2)
    );
    console.warn(`[Claude] WARNING: ${claudeFailures.length} signals failed enrichment — they will appear in the email with generic MEDIUM priority`);
    try {
      await sendErrorAlert(
        `⚠️ Claude enrichment failed for ${claudeFailures.length} signal(s).\n\nThese will appear in today's email with generic MEDIUM priority and placeholder text. Check claude_failures_${today}.json for details.\n\nAffected companies: ${claudeFailures.map(f => f.company).join(', ')}`
      );
    } catch (_) { /* Telegram alert failure must not crash the pipeline */ }
  }

  console.log(`[Claude] Enriched ${enrichedSignals.length} signals`);

  // Step 2.10: Save
  fs.writeFileSync(`${TMP_DIR}/filtered_signals_${today}.json`, JSON.stringify(enrichedSignals, null, 2));
  console.log(`[Filter Complete] ${enrichedSignals.length} signals ready for deduplication`);

  return enrichedSignals;
}

export default filterSignals;

// ── Standalone test runner ────────────────────────────────────────────────────
// Run: node execution/workflow_2_filter_signals.js
// Loads combined_raw_test.json, applies all filters, saves filtered_test.json

if (process.argv[1] === toPath(import.meta.url)) {
  (async () => {
    const inputFile = `${TMP_DIR}/combined_raw_test.json`;
    if (!fs.existsSync(inputFile)) {
      console.error(`[Test] ${inputFile} not found — run workflow_1 first`);
      process.exit(1);
    }

    const allSignals = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
    console.log(`[Test] Loaded ${allSignals.length} signals from ${inputFile}\n`);

    // Run filters in new optimised order — cheap first, API calls last
    const sizeFiltered  = allSignals.filter(passesCompanySizeFilter);
    console.log(`[Filter 1: Size]      ${allSignals.length} → ${sizeFiltered.length} signals (removed ${allSignals.length - sizeFiltered.length})`);

    const titleFiltered = sizeFiltered.filter(passesJobTitleFilter);
    console.log(`[Filter 2: Title]     ${sizeFiltered.length} → ${titleFiltered.length} signals (removed ${sizeFiltered.length - titleFiltered.length})`);

    const cutoff90Str2  = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const dateFiltered  = titleFiltered.filter(s => {
      if (s.type !== 'Job Change') return true;
      if (!s.person?.job_started_at) return false;
      // Same strict validation as the main filterSignals() loop — month/day range check
      // + round-trip verification to catch JS Date overflow (e.g. Feb 30 → Mar 2).
      const startDateStr = s.person.job_started_at.split('T')[0];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(startDateStr)) return false;
      const [, mo, dy] = startDateStr.split('-').map(Number);
      if (mo < 1 || mo > 12 || dy < 1 || dy > 31) return false;
      const d = new Date(`${startDateStr}T00:00:00Z`);
      if (isNaN(d.getTime()) || d.toISOString().split('T')[0] !== startDateStr) return false;
      return startDateStr >= cutoff90Str2;
    });
    console.log(`[Filter 3: StartDate] ${titleFiltered.length} → ${dateFiltered.length} signals (removed ${titleFiltered.length - dateFiltered.length})`);

    const geoFiltered   = dateFiltered.filter(passesGeographyFilter);
    console.log(`[Filter 4: Geography] ${dateFiltered.length} → ${geoFiltered.length} signals (removed ${dateFiltered.length - geoFiltered.length})`);

    // Note: Apollo geo-verify (Filter 5) skipped in test runner — requires live API calls
    console.log(`[Filter 5: GeoVerify] skipped in test mode (Apollo API call)`);

    const pct = allSignals.length > 0
      ? Math.round((geoFiltered.length / allSignals.length) * 100)
      : 0;
    console.log(`\n[Summary] ${allSignals.length} → ${geoFiltered.length} signals (${pct}% remain — target: 20-50%)`);

    // Breakdown by source
    const bySource = {};
    for (const s of geoFiltered) bySource[s.source] = (bySource[s.source] || 0) + 1;
    console.log('[Breakdown]', bySource);

    // Save without Claude enrichment (skip API calls during filter-only test)
    fs.writeFileSync(`${TMP_DIR}/filtered_test.json`, JSON.stringify(geoFiltered, null, 2));
    console.log(`\n[Test] Saved ${geoFiltered.length} filtered signals → ${TMP_DIR}/filtered_test.json`);
    console.log('[Test] Note: Claude enrichment + Apollo geo-verify skipped in test mode.');
  })();
}
