# Project Specifications

This document defines what we are building, as required by Step 1 of `instructions.md`.

**Project:** Starfish Intent Signal Monitoring System (Pilot)  
**Client:** Starfish Co. (David Kessler, Zack Kessler)  
**Budget:** $1,500 USD  
**Timeline:** 10 business days (Build: Days 1-8, Test: Days 9-10)  
**Developer:** Gideon Awotuyi  
**Start Date:** May 13, 2026  
**Delivery Date:** May 22, 2026

---

## 1. Inputs

**What the user can send as input:** NONE. This system runs fully automatically with zero user interaction during the pilot phase. No Telegram commands, no web interface, no manual triggers.

### Automatic Data Sources (5 APIs)

The system fetches data from five external APIs every morning at 5:00 AM EST on a cron schedule.

| Source | Role | Reliability |
|--------|------|-------------|
| PDL | Primary job change source | High — accurate start dates via SQL filter |
| Apollo | Secondary job change + company enrichment | Medium — PDL date verification mandatory |
| MediaStack | News/press monitor | Medium — requires company name extraction |
| PredictLeads | M&A + Rebrand event tracker | High — paginated (up to 450 events), ML fix confirmed |
| NewsAPI | Reliable M&A + funding round source | High — legal language queries on wire service whitelist |
| AudienceLab | Website Visitor + Brand Strategy Intent | High — pre-filtered segments, cursor-based pagination (1,000/run) |

---

### Input Source 1: PDL API (Primary Job Change Source)

**Purpose:** Find senior marketing leaders who changed jobs in the last 90 days. PDL is the primary source — it provides accurate, verified job start dates via SQL-level filtering.

**Endpoint:** `GET https://api.peopledatalabs.com/v5/person/search`

**Authentication:** `X-Api-Key: PDL_API_KEY` header

**SQL Query:**
```sql
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
AND job_last_changed >= 'YYYY-MM-DD'  -- 90 days ago
AND job_company_size IN ('501-1000', '1001-5000', '5001-10000', '10001+')
AND job_company_inferred_revenue IN (
  '$50M to $100M', '$100M to $250M', '$250M to $500M', '$500M to $1B', '$1B to $10B', '$10B+'
)
AND location_country = 'united states'
```

Request params: `size: 50`

PDL level definitions: `cxo` = CMO, Chief Brand Officer, CEO, COO, President; `vp` = VP/SVP; `director` = Director/Head of Marketing.

**Pre-dedup against Airtable:** Before enriching any person, load all `Source URL` values from Airtable Job Change records into a Set. Skip anyone whose LinkedIn URL is already present — no Apollo enrichment credits needed.

**For each person not already in Airtable:**
- Call Apollo Organization Enrichment to get revenue, HQ, industry, employee count, funding data
- `job_last_changed` is used directly as `job_started_at` — no additional date verification needed

**Expected Daily Volume:** 10-50 job change signals

**Sample Signal Object:**
```javascript
{
  type: "Job Change",
  source: "PDL",
  source_url: person.linkedin_url,
  company: { name, revenue, funding_stage, headquarters, industry, website, employee_count, ... },
  person: { first_name, last_name, title, linkedin_url, job_started_at: job_last_changed },
  detected_date: "YYYY-MM-DD",
  raw_data: { /* full PDL response */ }
}
```

---

### Input Source 2: Apollo API (Secondary Job Change + Company Enrichment)

**Purpose:** Secondary job change source. Also used to enrich company data (revenue, HQ, industry, funding) for PDL signals via the Organizations Enrich endpoint. Apollo's `changed_job_recently` flag is unreliable — PDL date verification is mandatory on all Apollo job change results.

**API Documentation:** https://apolloio.github.io/apollo-api-docs/

**Endpoint:** `POST https://api.apollo.io/v1/people/search`

**Authentication Method:** Bearer token in Authorization header
```
Authorization: Bearer YOUR_APOLLO_API_KEY
```

**Request Headers:**
```
Content-Type: application/json
Authorization: Bearer YOUR_APOLLO_API_KEY
```

**Request Body (exact JSON):**
```json
{
  "person_titles": [
    "CMO", "Chief Marketing Officer", "Chief Brand Officer",
    "CEO", "Chief Executive Officer",
    "COO", "Chief Operating Officer",
    "President",
    "VP Marketing", "Vice President Marketing", "Vice President of Marketing",
    "VP Brand", "Vice President Brand",
    "SVP Brand", "SVP Marketing",
    "Senior Vice President Brand", "Senior Vice President of Brand",
    "Senior Vice President Marketing",
    "Head of Marketing", "Head of Brand",
    "Director of Marketing", "Marketing Director"
  ],
  "organization_locations": ["United States"],
  "organization_num_employees_ranges": ["501-1000", "1000-5000", "5000-10000", "10000+"],
  "changed_job_recently": true,
  "page": 1,
  "per_page": 100
}
```

**Query Logic:** Search for people with any of the 22 job titles listed above, working at companies in the United States with 500+ employees who recently changed jobs according to Apollo's internal flag.

**Pre-dedup against Airtable:** Before enriching any person, load all `Source URL` values from Airtable Job Change records into a Set. Skip anyone whose LinkedIn URL is already present — no enrichment call, no PDL credit spent.

**Apollo date pre-filter:** After fetching the full person profile, if Apollo has a start date and it is older than 1 year, skip — no PDL call needed. This prevents spending PDL credits on clearly stale records before PDL verification.

**Response Structure:**
```json
{
  "people": [
    {
      "id": "string",
      "first_name": "string",
      "last_name": "string",
      "name": "string",
      "linkedin_url": "string or null",
      "title": "string",
      "email_status": "string",
      "photo_url": "string or null",
      "twitter_url": "string or null",
      "github_url": "string or null",
      "facebook_url": "string or null",
      "organization": {
        "id": "string",
        "name": "string",
        "website_url": "string or null",
        "blog_url": "string or null",
        "angellist_url": "string or null",
        "linkedin_url": "string or null",
        "twitter_url": "string or null",
        "facebook_url": "string or null",
        "primary_phone": {
          "number": "string or null",
          "source": "string or null"
        },
        "languages": ["string"],
        "alexa_ranking": "number or null",
        "phone": "string or null",
        "linkedin_uid": "string or null",
        "founded_year": "number or null",
        "publicly_traded_symbol": "string or null",
        "publicly_traded_exchange": "string or null",
        "logo_url": "string or null",
        "crunchbase_url": "string or null",
        "primary_domain": "string or null",
        "industry": "string or null",
        "keywords": ["string"],
        "estimated_num_employees": "number or null",
        "industries": ["string"],
        "secondary_industries": ["string"],
        "snippets_loaded": "boolean",
        "industry_tag_id": "string or null",
        "industry_tag_hash": {},
        "retail_location_count": "number or null",
        "raw_address": "string or null",
        "street_address": "string or null",
        "city": "string or null",
        "state": "string or null",
        "postal_code": "string or null",
        "country": "string",
        "owned_by_organization_id": "string or null",
        "suborganizations": [],
        "num_suborganizations": "number",
        "seo_description": "string or null",
        "short_description": "string or null",
        "annual_revenue_printed": "string or null",
        "annual_revenue": "number or null",
        "estimated_annual_revenue": "number or null",
        "total_funding": "number or null",
        "total_funding_printed": "string or null",
        "latest_funding_round_date": "string or null",
        "latest_funding_stage": "string or null",
        "funding_events": []
      }
    }
  ],
  "pagination": {
    "page": "number",
    "per_page": "number",
    "total_entries": "number",
    "total_pages": "number"
  }
}
```

**Fields to Extract (17 fields):**
1. `person.first_name` (string) - Person's first name
2. `person.last_name` (string) - Person's last name
3. `person.title` (string) - Job title
4. `person.linkedin_url` (string or null) - LinkedIn profile URL
5. `organization.name` (string) - Company name
6. `organization.website_url` (string or null) - Company website
7. `organization.industry` (string or null) - Primary industry
8. `organization.estimated_num_employees` (number or null) - Employee count
9. `organization.estimated_annual_revenue` (number or null) - Annual revenue in USD
10. `organization.annual_revenue` (number or null) - Confirmed annual revenue in USD
11. `organization.total_funding` (number or null) - Total funding raised in USD
12. `organization.latest_funding_stage` (string or null) - Most recent funding stage
13. `organization.city` (string or null) - Company city
14. `organization.state` (string or null) - Company state
15. `organization.country` (string) - Company country (required field)
16. `organization.founded_year` (number or null) - Year company was founded
17. `organization.publicly_traded_symbol` (string or null) - Stock ticker if public

**Revenue Field Priority Logic:**
```javascript
// Use this exact logic to determine company revenue
const revenue = organization.annual_revenue || 
                organization.estimated_annual_revenue || 
                0;
```

**Expected Daily Volume:** 10-30 job change signals

**Rate Limits:** 5 requests per second, 10,000 requests per day

**Error Codes:**
- 401: Invalid API key
- 429: Rate limit exceeded
- 500: Server error

**Sample Signal Object Created from Apollo:**
```javascript
{
  type: "Job Change",
  source: "Apollo",
  source_url: person.linkedin_url,
  company: {
    name: organization.name,
    revenue: revenue, // calculated using priority logic above
    funding_total: organization.total_funding,
    funding_stage: organization.latest_funding_stage,
    headquarters: {
      city: organization.city,
      state: organization.state,
      country: organization.country
    },
    industry: organization.industry,
    website: organization.website_url,
    employee_count: organization.estimated_num_employees,
    founded_year: organization.founded_year,
    stock_ticker: organization.publicly_traded_symbol
  },
  person: {
    first_name: person.first_name,
    last_name: person.last_name,
    title: person.title,
    linkedin_url: person.linkedin_url
  },
  detected_date: TODAY, // YYYY-MM-DD format
  raw_data: { /* full Apollo response object for debugging */ }
}
```

---

### Input Source 3: MediaStack API (News & Press Monitoring)

**Purpose:** Track news articles about company rebranding, expansion, funding, M&A

**API Documentation:** https://mediastack.com/documentation

**Endpoint:** `GET https://api.mediastack.com/v1/news`

**Authentication Method:** API key in query parameter

**Full URL with Parameters:**
```
https://api.mediastack.com/v1/news?access_key=YOUR_MEDIASTACK_API_KEY&countries=us&keywords=rebrand,brand refresh,expansion,funding,Series A,Series B,Series C,merger,acquisition,new markets&date=YYYY-MM-DD&limit=50&sort=published_desc
```

**Query Parameters (11 parameters):**
1. `access_key` (required, string) - Your MediaStack API key
2. `countries` (optional, string) - ISO 3166-1 alpha-2 country code, value: "us"
3. `keywords` (optional, string) - Comma-separated keywords: "rebrand,brand refresh,expansion,funding,Series A,Series B,Series C,merger,acquisition,new markets"
4. `date` (optional, string) - Date in YYYY-MM-DD format, value: yesterday's date
5. `limit` (optional, number) - Number of results per page, value: 50 (max allowed)
6. `sort` (optional, string) - Sort order, value: "published_desc" (newest first)
7. `languages` (optional, string) - Not used (defaults to all)
8. `categories` (optional, string) - Not used (defaults to all)
9. `sources` (optional, string) - Not used (defaults to all)
10. `offset` (optional, number) - Pagination offset, value: 0 (first page only)
11. `exclude_keywords` (optional, string) - Not used

**Date Calculation:**
```javascript
// Calculate yesterday's date
const yesterday = new Date();
yesterday.setDate(yesterday.getDate() - 1);
const dateParam = yesterday.toISOString().split('T')[0]; // Format: YYYY-MM-DD
```

**Response Structure:**
```json
{
  "pagination": {
    "limit": 50,
    "offset": 0,
    "count": 50,
    "total": 1000
  },
  "data": [
    {
      "author": "string or null",
      "title": "string",
      "description": "string or null",
      "url": "string",
      "source": "string",
      "image": "string or null",
      "category": "string",
      "language": "string",
      "country": "string",
      "published_at": "ISO 8601 datetime string"
    }
  ]
}
```

**Fields to Extract (6 fields):**
1. `title` (string) - Article headline
2. `description` (string or null) - Article summary/excerpt
3. `url` (string) - Full article URL
4. `source` (string) - Publication name (e.g., "TechCrunch", "Wall Street Journal")
5. `published_at` (string) - Publication datetime in ISO 8601 format
6. `category` (string) - Article category (e.g., "business", "technology")

**Company Name Extraction Logic:**

MediaStack does NOT provide structured company data. Company names must be extracted from article text using pattern matching or NLP.

**Simple Extraction Method (for pilot):**
```javascript
function extractCompanyName(article) {
  // Look for common patterns in title and description
  const text = article.title + ' ' + (article.description || '');
  
  // Pattern 1: "Company Name announces..." or "Company Name has..."
  const pattern1 = /^([A-Z][A-Za-z0-9\s&.]+?)\s+(announces|has|unveils|launches|raises|acquires)/;
  const match1 = text.match(pattern1);
  if (match1) return match1[1].trim();
  
  // Pattern 2: "... at Company Name ..."
  const pattern2 = /\sat\s([A-Z][A-Za-z0-9\s&.]+?)\s/;
  const match2 = text.match(pattern2);
  if (match2) return match2[1].trim();
  
  // Pattern 3: Company name in quotes
  const pattern3 = /"([A-Z][A-Za-z0-9\s&.]+?)"/;
  const match3 = text.match(pattern3);
  if (match3) return match3[1].trim();
  
  // If no pattern matches, return first capitalized phrase (risky but better than nothing)
  const pattern4 = /([A-Z][A-Za-z0-9\s&.]{3,30})/;
  const match4 = text.match(pattern4);
  if (match4) return match4[1].trim();
  
  return null; // No company name extracted
}
```

**Note:** Signals with no extractable company name should be discarded during Workflow 1.

**Expected Daily Volume:** 20-50 articles (before company name extraction)

**Expected Post-Extraction Volume:** 10-30 articles with valid company names

**Rate Limits:** 100 requests per month for free tier, 500/month for paid tier

**Error Codes:**
- 101: Invalid API key
- 103: API function does not exist
- 104: Usage limit reached
- 105: HTTPS access restricted
- 106: Too many requests

**Sample Signal Object Created from MediaStack:**
```javascript
{
  type: "News/Press",
  source: "MediaStack",
  source_url: article.url,
  company: {
    name: extractedCompanyName, // from pattern matching
    revenue: null, // not available from MediaStack
    funding_total: null,
    funding_stage: null,
    headquarters: {
      city: null,
      state: null,
      country: "United States" // assumed from 'us' country filter
    },
    industry: null, // not available
    website: null,
    employee_count: null,
    founded_year: null,
    stock_ticker: null
  },
  article: {
    title: article.title,
    description: article.description,
    source: article.source,
    category: article.category,
    published_at: article.published_at
  },
  detected_date: TODAY, // YYYY-MM-DD format
  raw_data: { /* full MediaStack response object */ }
}
```

---

### Input Source 4: PredictLeads API (M&A + Rebrand Event Tracker)

**Purpose:** Track M&A, financing, and rebrand events on company pages. Now paginated with up to 3 pages per category (450 events max across all categories).

**Endpoint:** `GET https://predictleads.com/api/v3/discover/news_events`

**Authentication:** Two headers required:
```
X-Api-Key: PREDICTLEADS_API_KEY
X-Api-Token: PREDICTLEADS_API_TOKEN
```

**ML Architecture Fix (confirmed June 2026):** PredictLeads confirmed their ML architecture update now returns fully fresh events each day. Zero repeated event IDs verified across 5 consecutive days of production runs. Cross-category dedup by event ID still applied as a safety net.

**Pagination:** Each page returns up to `PL_PAGE_SIZE` (30) events. The system fetches up to `PL_MAX_PAGES` (3) pages per category. If a page returns fewer than a full page, there are no more pages and the loop breaks. 1-second delay between pages.

**Strategy:** Query each category with pagination:
```javascript
const MA_CATEGORIES = ['acquires', 'merges_with', 'sells_assets_to', 'receives_financing'];
const REBRAND_CATEGORIES = ['rebrands_to'];
// Up to 3 pages per category, deduplicate by event ID, post-filter client-side
```

**Response structure (JSON:API format):**
- Events in `data[]` array
- Company linked via `relationships.company1` (NOT `relationships.company`)
- Target/seller company via `relationships.company2`
- Company name: `company_name` attribute (NOT `name`)
- Source URL: from `included[]` array, type `news_article`, via `relationships.most_relevant_source`
- Amount: `attributes.amount || attributes.amount_normalized || null`
- HQ: `attributes.headquarters || attributes.hq_location`, parsed via `parseHeadquarters()`

**Signal types produced:**
- **M&A Activity** — acquires, merges_with, sells_assets_to, receives_financing. Includes `deal` object with `type`, `seller`, `amount`.
- **Rebrand** — rebrands_to. Includes `rebrand` object with `new_name`, `summary`, `found_at`, `confidence`. Always marked HIGH priority.

**Date filtering:** Applied client-side on `found_at` field (90-day cutoff)

**Expected Daily Volume:** 5-30 M&A signals + 0-5 Rebrand signals

**Sample M&A Signal Object:**
```javascript
{
  type: "M&A Activity",
  source: "PredictLeads",
  source_url: sourceUrlFromIncluded,
  company: {
    name: company1.attributes.company_name,
    revenue: company1.attributes.annual_revenue || null,
    funding_stage: company1.attributes.funding_stage || null,
    headquarters: parseHeadquarters(company1.attributes.headquarters),
    industry: company1.attributes.industry || null,
    website: `https://${company1.attributes.domain}` || null,
    ...
  },
  deal: {
    type: "acquires",           // acquires | merges_with | sells_assets_to | receives_financing
    seller: company2.attributes.company_name || null,
    amount: event.attributes.amount || null
  },
  detected_date: "YYYY-MM-DD",
  raw_data: { /* full event object */ }
}
```

**Sample Rebrand Signal Object:**
```javascript
{
  type: "Rebrand",
  source: "PredictLeads",
  source_url: sourceUrlFromIncluded,
  company: { /* same structure as M&A */ },
  rebrand: {
    new_name: company2.attributes.company_name || null,
    summary: event.attributes.summary || null,
    found_at: event.attributes.found_at || null,
    confidence: event.attributes.confidence || null
  },
  detected_date: "YYYY-MM-DD",
  raw_data: { /* full event object */ }
}
```

---

### Input Source 5: NewsAPI (M&A, Funding, and Job Change Press Release Source)

**Purpose:** The reliable source for M&A deals, funding rounds, and senior marketing/executive appointment press releases. Searches full article text across thousands of sources. Uses legal boilerplate language queries against a wire service domain whitelist to eliminate noise.

**Endpoint:** `GET https://newsapi.org/v2/everything`

**Authentication:** `apiKey` query parameter

**Six queries run per daily cycle:**

**Query 1 — M&A Deals (uses `sortBy: relevancy` + domain whitelist):**
```
q: '("definitive agreement to acquire" OR "to be acquired by" OR "completes acquisition of" OR "agreed to acquire" OR "merger agreement with") -"net income" -"per diluted share" -"financial results" -"first quarter" -"form 10-Q" -"market size" -"market dynamics" -"market research" -"shareholder news"'
domains: 'prnewswire.com,businesswire.com,globenewswire.com,reuters.com,bloomberg.com'
```
Legal boilerplate phrases only appear in actual M&A press releases — never in earnings reports.

**Query 2 — Series B/C/D Funding:**
```
q: '"Series B" raises million OR "Series C" raises million OR "Series D" raises million'
```

**Query 3 — Series A Funding:**
```
q: '"Series A" raises million'
```

**Query 4 — Job Change: C-Suite Press Releases (domain: wire services only):**
```
q: '("appointed" OR "named" OR "joins as" OR "hired as") AND ("Chief Marketing Officer" OR "CMO" OR "Chief Brand Officer" OR "CBO" OR "Chief Executive Officer" OR "CEO" OR "Chief Operating Officer" OR "COO" OR "President")'
domains: 'prnewswire.com,businesswire.com,globenewswire.com'
```

**Query 5 — Job Change: VP/SVP Press Releases (domain: wire services only):**
```
q: '("appointed" OR "named" OR "joins as" OR "hired as") AND ("VP Marketing" OR "VP of Marketing" OR "VP Brand" OR "Vice President Marketing" OR "Vice President of Marketing" OR "Vice President Brand" OR "SVP Marketing" OR "SVP Brand" OR "Senior Vice President Marketing" OR "Senior Vice President Brand" OR "Senior Vice President of Marketing" OR "Senior Vice President of Brand")'
domains: 'prnewswire.com,businesswire.com,globenewswire.com'
```

**Query 6 — Job Change: Director/Head Press Releases (domain: wire services only):**
```
q: '("appointed" OR "named" OR "joins as" OR "hired as") AND ("Head of Marketing" OR "Head of Brand" OR "Director of Marketing" OR "Marketing Director")'
domains: 'prnewswire.com,businesswire.com,globenewswire.com'
```

Queries 4–6 are restricted to press release wires — company-issued announcements with structured name + title data. Signal quality is high.

**Per-query params:** `language: 'en'`, `from: thirtyDaysAgo`, `pageSize: 10`

**Free plan:** 30 days max history, 100 requests/day.
**Paid plan:** Full 90-day history + commercial use.

**Post-processing per article:**
1. Block domains in `NEWSAPI_BLOCKED_DOMAINS` set (crypto, sports, entertainment, non-US news, syndication clones)
2. Deduplicate syndicated stories using normalized title chars 20–55 (fingerprints company name region, skips varying prefixes)
3. Domain extraction handles ccTLDs (.co.uk, .com.au)

**Expected Daily Volume:** 5-20 clean signals (M&A, funding, and job change press releases)

**Sample Signal Object:**
```javascript
{
  type: "News/Press",
  source: "NewsAPI",
  source_url: article.url,
  company: {
    name: null, // extracted by Claude during enrichment from article title/description
    revenue: null,
    funding_stage: null,
    headquarters: { city: null, state: null, country: "United States" },
    ...
  },
  article: {
    title: article.title,
    description: article.description,
    source: article.source?.name,
    category: query.label,  // "M&A" | "Series B/C/D" | "Series A" | "Job Change - C-Suite" | "Job Change - VP/SVP" | "Job Change - Director/Head"
    published_at: article.publishedAt
  },
  detected_date: "YYYY-MM-DD",
  raw_data: { /* full article object */ }
}
```

---

## 2. Workflows

**What workflows exist:** 8 workflows that run sequentially every day at 5:00 AM EST. Total execution time: 5-12 minutes for automated steps + up to 60 minutes for the PDL Telegram verification step (user-driven; auto-approves on timeout).

---

### Workflow 1: `fetch_signals`

**Location:** `instructions/workflow_1_fetch_signals.md` + `execution/workflow_1_fetch_signals.js`

**Trigger:** Automatic cron job at 5:00 AM EST (cron expression: `0 5 * * *`, timezone: America/New_York)

**Input:** None (system-initiated)

**Process:**

**Step 1.1: Initialize Daily Run**
```javascript
const today = new Date().toISOString().split('T')[0].replace(/-/g, ''); // Format: YYYYMMDD
const startTime = Date.now();
console.log(`[${new Date().toISOString()}] Starting daily signal fetch for ${today}`);
```

**Step 1.2: Fetch Apollo Data**
```javascript
// Apollo request body — 22 titles, 100 results, changed_job_recently flag
// Pre-dedup against Airtable before enrichment to skip already-saved people.
// Apollo date pre-filter: if start date > 1 year old, skip without calling PDL.

try {
  const apolloResponse = await apolloClient.searchPeople({
    person_titles: [
      "CMO", "Chief Marketing Officer", "Chief Brand Officer",
      "CEO", "Chief Executive Officer",
      "COO", "Chief Operating Officer",
      "President",
      "VP Marketing", "Vice President Marketing", "Vice President of Marketing",
      "VP Brand", "Vice President Brand",
      "SVP Brand", "SVP Marketing", "Senior Vice President Brand",
      "Senior Vice President of Brand", "Senior Vice President Marketing",
      "Head of Marketing", "Head of Brand",
      "Director of Marketing", "Marketing Director"
    ],
    organization_locations: ["United States"],
    organization_num_employees_ranges: ["501-1000", "1000-5000", "5000-10000", "10000+"],
    changed_job_recently: true,
    page: 1,
    per_page: 100
  });
  
  // Save raw response
  fs.writeFileSync(
    `.tmp/apollo_raw_${today}.json`,
    JSON.stringify(apolloResponse, null, 2)
  );
  
  // Parse into signal objects
  const apolloSignals = apolloResponse.people.map(person => ({
    type: "Job Change",
    source: "Apollo",
    source_url: person.linkedin_url,
    company: {
      name: person.organization.name,
      revenue: person.organization.annual_revenue || person.organization.estimated_annual_revenue || 0,
      funding_total: person.organization.total_funding,
      funding_stage: person.organization.latest_funding_stage,
      headquarters: {
        city: person.organization.city,
        state: person.organization.state,
        country: person.organization.country
      },
      industry: person.organization.industry,
      website: person.organization.website_url,
      employee_count: person.organization.estimated_num_employees,
      founded_year: person.organization.founded_year,
      stock_ticker: person.organization.publicly_traded_symbol
    },
    person: {
      first_name: person.first_name,
      last_name: person.last_name,
      title: person.title,
      linkedin_url: person.linkedin_url
    },
    detected_date: new Date().toISOString().split('T')[0],
    raw_data: person
  }));
  
  console.log(`[Apollo] Fetched ${apolloSignals.length} job changes`);
  
} catch (error) {
  console.error('[Apollo] API call failed:', error.message);
  // Log error but continue with other sources
  fs.appendFileSync(
    `.tmp/error_log_${today}.txt`,
    `[${new Date().toISOString()}] Apollo API failed: ${error.message}\n`
  );
  apolloSignals = []; // Empty array, continue with other sources
}
```

**Step 1.3: Fetch MediaStack Data**
```javascript
const mediaStackClient = require('./utils/api_clients').mediaStack;
const { extractCompanyName } = require('./utils/text_parsing');

try {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateParam = yesterday.toISOString().split('T')[0];
  
  const mediaStackResponse = await mediaStackClient.getNews({
    countries: 'us',
    keywords: 'rebrand,brand refresh,expansion,funding,Series A,Series B,Series C,merger,acquisition,new markets',
    date: dateParam,
    limit: 50,
    sort: 'published_desc'
  });
  
  // Save raw response
  fs.writeFileSync(
    `.tmp/mediastack_raw_${today}.json`,
    JSON.stringify(mediaStackResponse, null, 2)
  );
  
  // Parse into signal objects (with company name extraction)
  const mediaStackSignals = mediaStackResponse.data
    .map(article => {
      const companyName = extractCompanyName(article);
      
      if (!companyName) {
        return null; // Skip articles where we can't extract company name
      }
      
      return {
        type: "News/Press",
        source: "MediaStack",
        source_url: article.url,
        company: {
          name: companyName,
          revenue: null,
          funding_total: null,
          funding_stage: null,
          headquarters: {
            city: null,
            state: null,
            country: "United States"
          },
          industry: null,
          website: null,
          employee_count: null,
          founded_year: null,
          stock_ticker: null
        },
        article: {
          title: article.title,
          description: article.description,
          source: article.source,
          category: article.category,
          published_at: article.published_at
        },
        detected_date: new Date().toISOString().split('T')[0],
        raw_data: article
      };
    })
    .filter(signal => signal !== null); // Remove null entries
  
  console.log(`[MediaStack] Fetched ${mediaStackResponse.data.length} articles, extracted ${mediaStackSignals.length} with company names`);
  
} catch (error) {
  console.error('[MediaStack] API call failed:', error.message);
  fs.appendFileSync(
    `.tmp/error_log_${today}.txt`,
    `[${new Date().toISOString()}] MediaStack API failed: ${error.message}\n`
  );
  mediaStackSignals = [];
}
```

**Step 1.4: Fetch PDL Signals**
```javascript
// PDL is the primary job change source. SQL query pre-filters for marketing seniority
// (plus CEO/COO/President/CBO), $50M+ revenue, US-based, job changed in last 90 days.
// Size: 50 results per run.
// Pre-dedup against Airtable before Apollo enrichment — skip already-saved people.
// PDL's job_last_changed date is used directly — no additional date verification needed.
pdlSignals = await fetchPDLSignals();
```

**Step 1.5: Fetch PredictLeads Signals**
Query 5 categories (`acquires`, `merges_with`, `sells_assets_to`, `receives_financing`, `rebrands_to`) with pagination (up to 3 pages per category, 30 events per page = 450 max). Deduplicate by event ID across all queries. M&A events are typed as `"M&A Activity"`, rebrand events as `"Rebrand"`. Apply 90-day cutoff on `found_at`. Save raw to `.tmp/predictleads_raw_YYYYMMDD.json`.

**Step 1.6: Fetch NewsAPI Signals**
Run 6 queries: M&A deals (wire-service domain whitelisted), Series B/C/D funding, Series A funding, plus three job change press release queries split by seniority tier (C-suite, VP/SVP, Director/Head — all restricted to PRNewswire/BusinessWire/GlobeNewswire). Apply domain blocklist, deduplicate syndicated stories via title fingerprint. Save raw to `.tmp/newsapi_raw_YYYYMMDD.json`.

**Step 1.7: Combine All Signals**
```javascript
const allSignals = [
  ...apolloSignals,
  ...pdlSignals,
  ...mediaStackSignals,
  ...predictLeadsSignals,
  ...newsApiSignals
];

fs.writeFileSync(`.tmp/combined_raw_${today}.json`, JSON.stringify(allSignals, null, 2));

console.log(`[Combined] Total: ${allSignals.length} (Apollo: ${apolloSignals.length}, PDL: ${pdlSignals.length}, MediaStack: ${mediaStackSignals.length}, PredictLeads: ${predictLeadsSignals.length}, NewsAPI: ${newsApiSignals.length})`);
```

**Output:** Array of 40-120 raw signal objects

**Output Location:** `.tmp/combined_raw_YYYYMMDD.json`

**Return Value:** `allSignals` array passed to Workflow 2

**Expected Execution Time:** 3-6 minutes

**Error Handling:**
- Each source wrapped in its own try/catch — one failure does NOT block others
- If ALL FIVE fail: Send Telegram alert to Gideon, end run gracefully
- PredictLeads returning 0 M&A events is normal — not an error

---

### Workflow 2: `filter_signals`

**Location:** `instructions/workflow_2_filter_signals.md` + `execution/workflow_2_filter_signals.js`

**Trigger:** Immediately after Workflow 1 completes

**Input:** Array of raw signals from Workflow 1 (40-110 signals)

**Process:**

**Step 2.1: Apply Company Size Filter (includes Government + Nonprofit filters)**

The size filter function runs three checks in order:

1. **Government Entity Filter** — drops government/municipal entities (City of X, County of X, Department of X, etc.)
2. **Non-Profit/Charity Filter** — drops non-profits, charities, religious organizations (missionary, church, foundation, etc.)
3. **Revenue/Funding Rule** — company must have EITHER $50M+ annual revenue OR Series A/B/C/D/E funding stage.

**Rebrand bypass:** Signals with `type === 'Rebrand'` always pass the size filter.

**Source-level exceptions:** Apollo, MediaStack, NewsAPI, PredictLeads auto-pass when no financial data is present. PDL signals also auto-pass when Apollo enrichment returns no revenue data (PDL's SQL query already confirmed $50M+ inferred revenue).

**Expected Result:** 30-50 signals remaining

**Step 2.2: Apply Job Title Filter**

**Filter Rule:** For "Job Change" signals only. All other types pass automatically.

**PDL signals:** Get a keyword check (must contain `marketing`, `brand`, or matching C-suite acronym with word-boundary regex).

**Apollo signals:** person's title must match one of 28+ titles (case-insensitive substring matching), with a fallback combo rule for verbose titles containing both a seniority keyword and "marketing".

**Step 2.3: Apply Start Date Filter**

**Filter Rule:** Job Change signals must have `person.job_started_at` within the last 90 days. Signals with no date are dropped. Non-Job-Change signals pass automatically.

**Step 2.4: Apply Geography Filter**

**Filter Rule:** Company headquarters must be in United States (case-insensitive matching). Sources without country data auto-pass.

**Step 2.5: Apollo Geo-Verification**

**Filter Rule:** Non-Job-Change signals with no country data are verified via Apollo Organization Enrichment. Job Change signals skip (pre-confirmed US at API level).

**Step 2.6: News Job Change Check**

**Filter Rule:** News/Press articles about job changes are enriched via Apollo for revenue ($50M+ threshold) and location (US only) verification.

**Step 2.7: M&A Revenue Verification**

**Filter Rule:** For M&A Activity signals — `receives_financing` gets a free pass; `acquires/merges_with/sells_assets_to` require at least one party at $50M+ revenue.

**Step 2.8: Rebrand Priority Boost**

All Rebrand signals are set to `priority: 'HIGH'` before Claude enrichment.

**Step 2.9: Apply Claude API Enrichment (most expensive, runs last)**

**Purpose:** Add priority (HIGH/MEDIUM/LOW), brief (2 sentences), and contact_approach (1 sentence) to each signal. Uses `@anthropic-ai/sdk` (official Anthropic SDK), not raw axios. Model: `CLAUDE_MODEL` env var (default `claude-haiku-4-5-20251001`).

Each signal is sent to Claude with its type, company name, industry, revenue, employee count, and signal details. Claude returns a JSON object with `priority`, `brief`, and `contact_approach`. On failure, default values are assigned (priority: MEDIUM, brief: "Signal requires manual review.").

Signal types supported: "Job Change", "News/Press", "M&A Activity", "Rebrand".

Rate limit protection: 500ms delay between calls.

**Expected Result:** 10-25 signals with enrichment data

**Step 2.10: Save Filtered Signals**

Save enriched signals to `.tmp/filtered_signals_YYYYMMDD.json`.

**Output:** Array of 10-40 filtered and enriched signals

**Output Location:** `.tmp/filtered_signals_YYYYMMDD.json`

**Return Value:** `enrichedSignals` array passed to Workflow 3

**Expected Execution Time:** 2-4 minutes (depends on Claude API latency)

**Error Handling:**
- If Claude API fails for one signal: Assign default values, continue with next signal
- If Claude API fails completely: Assign defaults to ALL signals, continue to Workflow 3
- If Claude returns malformed JSON: Parse with error handling, assign defaults if parsing fails
- If Claude rate limit hit: Wait 60 seconds, retry once, then assign defaults

---

### Workflow 3: `deduplicate`

**Location:** `instructions/workflow_3_deduplicate.md` + `execution/workflow_3_deduplicate.js`

**Trigger:** Immediately after Workflow 2 completes

**Input:** Array of filtered signals from Workflow 2 (10-40 signals)

**Process:**

**Step 3.0: Filter Garbage Names**

Before any deduplication, filter out signals where `company.name` matches known garbage patterns -- headlines or non-company strings extracted from news feeds (e.g. "HODL", "Debunking", "CEO Just", "Wheel of Fortune"). Uses `GARBAGE_PATTERNS` regex list via `isGarbageName()`. Any match is discarded and logged.

**Step 3.1: Merge Duplicates Within the Incoming Batch**

Before checking Airtable, merge signals that refer to the same company within the current batch. Groups by `normalizeCompanyName()`. For groups of 2+:
- Keep one base record (`group[0]`)
- Combine signal details: `"⚡ SIGNAL SEEN Nx — Multiple sources confirm..."`
- Combine all `source_url` values via `[...new Set(urls)]` joined with ` | `
- If seen 2+ times, boost priority: LOW → MEDIUM, MEDIUM → HIGH
- Supports all 4 signal types (Job Change, News/Press, M&A Activity, Rebrand)

**Step 3.2: Query Airtable for Recent Signals (with retry)**

Query the Airtable `Signals` table for records from the **last 90 days** using `IS_AFTER({Date Detected}, '<91 days ago>')`. Only `Company Name` field is requested. No `maxRecords` cap — the SDK paginates automatically through all results. Companies seen in the last 90 days are dropped; companies last seen more than 90 days ago are eligible to re-appear.

> **Important:** Airtable's `IS_AFTER` is **exclusive** (strictly greater than). Passing exactly 90 days ago would exclude records from that boundary date. The code uses `getDateDaysAgo(91)` so the 90-day boundary is included. (Fixed 2026-06-15 — was previously using `getDateDaysAgo(90)`.)

Dedup cap alerts: Telegram warning at 4,500 records, critical alert at 5,000 records.

Includes retry logic: 2 attempts with 2-second delay. If both fail, dedup is skipped for this run (all signals pass through) and a warning is logged.

**Step 3.3: Normalize Company Names into a Set**

Apply `normalizeCompanyName()` to all recent names and store in a `Set` for O(1) lookups. Normalization: lowercase, trim, remove all non-alphanumeric characters.

**Step 3.4: Check Each Merged Signal Against Airtable History**

For each signal:
1. Normalize its `company.name`
2. Check if normalized name exists in the Set
3. If found → move to `duplicatesFound`
4. If not found → move to `deduplicatedSignals`

If dedup was skipped due to Airtable failure, all merged signals pass through.

**Step 3.5: Save Results**

Write `deduplicatedSignals` to `.tmp/final_signals_YYYYMMDD.json`.
Write `duplicatesFound` to `.tmp/duplicates_removed_YYYYMMDD.json` (audit trail).

**Output:** Array of 3-15 deduplicated signals

**Output Location:** `.tmp/final_signals_YYYYMMDD.json`

**Return Value:** `deduplicatedSignals` array passed to Workflows 4, 5, and 6

**Expected Execution Time:** 1-2 minutes

**Error Handling:**
- If Airtable query fails: Assume no recent signals, skip deduplication (risky but allows system to continue)
- If normalization fails for a company name: Skip that comparison, continue with others
- If ALL signals are duplicates: Proceed to Workflow 3b with empty array (email will say "No new signals today")

---

### Workflow 3b: `verify_pdl`

**Location:** `instructions/workflow_3b_verify_pdl.md` + `execution/workflow_3b_verify_pdl.js`

**Trigger:** Immediately after Workflow 3 completes

**Input:** `deduplicatedSignals` array from Workflow 3

**Output:** Verified signals array — approved PDL signals + all non-PDL signals

**Purpose:** PDL Job Change signals need manual LinkedIn verification before going to Airtable. Non-PDL signals (News/Press, M&A) pass through automatically.

**Process:**

**Step 3b.0: Split Signals**
- `pdlSignals` — signals where `source === 'PDL'` AND `type === 'Job Change'`
- `otherSignals` — everything else

If `pdlSignals` is empty, return `deduplicatedSignals` unchanged.
If `TELEGRAM_BOT_TOKEN` or `TELEGRAM_CHAT_ID` is not set, auto-approve all PDL signals.

**Step 3b.1: Generate Batch ID**
`const batchId = Date.now().toString(36)` — embedded in every button's `callback_data` to prevent old buttons from hijacking a new poll session.

**Step 3b.2: Send Intro Message**
Send a summary to Telegram: number of PDL signals pending review, number of News/Press signals proceeding automatically, instructions to verify within 90 days, 1-hour auto-approve notice.

**Step 3b.3: Send Each PDL Signal**
For each PDL signal, send a Telegram message with person name, company, title, start date, revenue, employee count, and a clickable LinkedIn profile link. Inline keyboard has two buttons:
- `✅ Approve` → `callback_data: approve:{batchId}:{index}`
- `❌ Drop` → `callback_data: drop:{batchId}:{index}`

Wait 500ms between messages to avoid Telegram rate limits.

**Step 3b.4: Poll for Responses**
Long-poll `getUpdates` (10s timeout, 100 updates per poll, tracked offset). For each `callback_query`:
1. Parse `callback_data` as `{action}:{batchId}:{index}`
2. Reject any click where embedded batchId does not match current run — prevents old button clicks from registering
3. Record `approved` or `dropped` for the matching index
4. Call `answerCallbackQuery` to clear the spinner
5. Call `editMessageReplyMarkup` to remove buttons from the message
6. Send confirmation message

Continue until all signals are responded to or 1-hour deadline is reached.

**Step 3b.5: Auto-Approve on Timeout**
Any signal not responded to within 1 hour is automatically approved. A Telegram message is sent showing how many were auto-approved.

**Step 3b.6: Send Summary & Return**
Send a final summary to Telegram (approved, dropped, auto-pass, total proceeding).
Return `[...approvedPDL, ...otherSignals]`.

**Error Handling:**
- Telegram not configured: all PDL signals auto-approved, pipeline continues
- No PDL signals in batch: return input unchanged, skip all Telegram calls
- Poll network error: log warning, retry next 2s cycle
- 1-hour timeout: auto-approve all unreviewed signals
- Button from previous run: batchId mismatch — silently ignored

---

### Workflow 4: `save_to_airtable`

**Location:** `instructions/workflow_4_save_to_airtable.md` + `execution/workflow_4_save_to_airtable.js`

**Trigger:** Immediately after Workflow 3b completes

**Input:** Array of deduplicated signals from Workflow 3 (3-15 signals)

**Process:**

**Step 4.0: Apollo Company Enrichment + KNOWN_DOMAINS**

Before email enrichment, fill missing revenue, industry, and website data via Apollo Organization Enrichment. Uses a per-run `apolloCache` (`new Map()`) to avoid duplicate API calls for the same company.

**KNOWN_DOMAINS lookup** (imported from `utils/known_domains.js`): Before calling Apollo, check if the company has a known domain from a ~70-entry lookup table (case-insensitive). If found, set `signal.company.website` instantly with no API call. Examples: `"Nike" → "nike.com"`, `"Apple" → "apple.com"`.

**Apollo cache key:** extracted domain (from website) or company name. On cache hit, reuse stored enrichment data. On cache miss, call `POST /organizations/enrich` and store result. 400ms delay between calls.

**Step 4.1: Email Enrichment (7-step cascade)**

For each signal, find the best available email address using a 7-step cascade. **Apollo always runs before Hunter across all signal types.** All email candidates are validated with `isFakeEmail()` (imported from `utils/email_validator.js`) which rejects generic prefixes (info@, admin@, support@), personal email domains (gmail.com, yahoo.com), third-party search domains, and file extension patterns.

**Circuit breakers:** 3 consecutive failures → API blocked for 5 min. 401, 429, and **422** (domain not in database — "not found", not an outage) do **NOT** trip the circuit.

**BSI signals** use a separate 4-tier waterfall (see Workflow 4b in `workflow_4_save_to_airtable.md`). All BSI contacts must pass `isBSIAllowedTitle()` — only CMO/VP Marketing/Head/Director of Marketing-level roles are accepted. Contacts with irrelevant titles are dropped before Airtable.

**Cascade order for non-BSI (stops at first valid result):**

1. **Apollo people/match** (Job Change only) — uses person's LinkedIn URL. Rejects if email domain doesn't match company's known domain.
2. **Puppeteer domain discovery** — if no website exists, Google the company name and validate via title/h1 matching. Falls back from Google to DuckDuckGo if CAPTCHA detected.
3. **Hunter email-finder** (Job Change only) — first name + last name + domain lookup. Trusts results with score >= 70.
4. **Apollo exec search + Hunter person-finder** (News/Press only — added 2026-06-15) — `apolloFindExec(domain)` finds the marketing/brand exec. If found, immediately calls Hunter's email-finder for that specific person (targeted, score >= 70). Returns early if email found.
5. **Hunter domain-search** (News/Press & M&A only) — finds best marketing/exec email at domain. Only runs if step 4 found nothing. Also captures email pattern for step 6.
6. **Hunter pattern + verify** — apply Hunter's email pattern to a name (the person for Job Change; Hunter's exec or Apollo-discovered exec for other types), then verify via Hunter email-verifier. Falls back to Puppeteer Google scrape for pattern if Hunter has none.
7. **Puppeteer web scraping** — Google search + company website scrape. Validates email domain against company's known domain before accepting.

**Contact Info format:**
- **Job Change:** `Name: {first} {last}\nTitle: {title}\nLinkedIn: {url}\nEmail: {email}`
- **News/Press & M&A:** `Email: {email} (via {source})` or `Company Website: {url}` or `Contact info not available`

**Step 4.2: Format Signals for Airtable**

**Airtable Record Structure (15 fields):**

Signal Type field supports 6 values: `"Job Change"`, `"News/Press"`, `"M&A Activity"`, `"Rebrand"`, `"Website Visitor"`, `"Brand Strategy Intent"`.

`formatSignalDetails()` handles all 4 signal types including Rebrand (`"{company} is rebranding to {new_name}"`). If the signal was merged in Workflow 3 (starts with `"⚡ SIGNAL SEEN"`), the pre-built details are preserved. Truncated to 2000 chars.

`formatContactInfo()` includes email from enrichment cascade when available.

**Step 4.3: Batch Insert to Airtable**

**Batch Configuration:**
- **Maximum records per batch:** 10
- **Wait time between batches:** 1000ms (1 second)
- **Batch failure fallback:** If a batch insert fails, falls back to **individual record insertion** for that batch (so one bad record cannot kill 9 valid ones). 300ms delay between individual inserts.

Failed records saved to `.tmp/airtable_failures_YYYYMMDD.json` and Telegram alert sent.

**Step 4.4: Verify Insertion**

Verification query: `IS_SAME({Date Detected}, '${todayStr}', 'day')` — counts records with today's date.

**Step 4.5: Log Results**

Logs total to insert, batch count, inserted count, failed count, verification count, and SUCCESS/PARTIAL FAILURE status to `.tmp/airtable_log_YYYYMMDD.txt`.

**Output:** Count of records successfully inserted (number)

**Return Value:** `totalInserted` count passed to Workflow 5 and 6 for reporting

**Expected Execution Time:** 1-3 minutes (depends on batch count)

**Error Handling:**
- If batch insert fails: Fall back to individual record insertion for that batch (one bad record cannot kill 9 valid ones)
- If individual record fails: Save to failures file, send Telegram alert
- If ALL batches fail: Send Telegram alert to Gideon, continue to Workflow 4b/5 (email still sends)
- If verification fails: Log warning but continue (don't block email)
- If Airtable API is completely down: Save all records to `.tmp/airtable_failures_YYYYMMDD.json`, send Telegram alert, continue to Workflow 4b/5
- Apollo enrichment failure: Skip silently, not critical
- Email enrichment failure at any step: Try next step in cascade, or leave contact info empty

---

### Workflow 4b: `sync_sheets`

**Location:** `instructions/workflow_4b_sync_sheets.md` + `execution/workflow_4b_sync_sheets.js`

**Trigger:** Immediately after Workflow 4 completes

**Input:** Verified signals array from Workflow 4

**Purpose:** Sync today's Airtable records to Google Sheets. The Sheet is the client-facing view layer -- Airtable remains the source of truth. Failure here is non-critical and never blocks the email workflow.

**Process:**

**Step 4b.1: Check Prerequisites**
- If no signals to sync, skip
- If `SKIP_SHEETS_SYNC=true`, skip
- If Google Sheets env vars not configured (`GOOGLE_SHEET_ID`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`), skip with warning

**Step 4b.2: Fetch Records (two paths)**
- **Standard path** (single base): Query Airtable with `IS_SAME({Date Detected}, '${todayStr}', 'day')`, sorted by `Created At` ascending. Uses Eastern time to match cron timezone.
- **AudienceLab separate base path** (when `AUDIENCELAB_AIRTABLE_BASE_ID` env var is set): Skip the Airtable query. Instead, map in-memory `verifiedSignals` directly to rows via `signalToRow()`. This is the only way to include AudienceLab records that live in a separate Airtable base.

**Step 4b.3: Append to Google Sheet**
Uses `sheets.spreadsheets.values.append()` with range `Signals!A5` (OAuth2 auth with refresh token). The append API automatically finds the true last row of data — immune to gaps in column A. Data starts at row 5 (below client's dashboard header). Sheet name: `Signals`. 15 columns matching Airtable schema.

> **Bug fix (2026-06-15):** Replaced manual column-A row counting + `values.update()` with `values.append()`. The old approach silently overwrote existing data when any row had a blank company name.

**Output:** Count of rows appended (number)

**Expected Execution Time:** 5-15 seconds

**Error Handling:**
- Google Sheets API failure: log error, continue to Workflow 5 (non-blocking)
- Missing env vars: skip silently
- Zero Airtable records for today: skip

---

### Workflow 5: `send_email`

**Location:** `instructions/workflow_5_send_email.md` + `execution/workflow_5_send_email.js`

**Trigger:** Immediately after Workflow 4 completes

**Input:** Array of deduplicated signals from Workflow 3 (3-15 signals)

**Process:**

**Step 5.1: Group Signals by Priority**

```javascript
const highPriority = deduplicatedSignals.filter(s => s.priority === 'HIGH');
const mediumPriority = deduplicatedSignals.filter(s => s.priority === 'MEDIUM');
const lowPriority = deduplicatedSignals.filter(s => s.priority === 'LOW');

console.log(`[Email] Signal breakdown - HIGH: ${highPriority.length}, MEDIUM: ${mediumPriority.length}, LOW: ${lowPriority.length}`);
```

**Step 5.2: Load and Populate Email Template**

**Template Location:** `templates/email_template.html`

**Template Variables (16 total):**
1. `{{DATE}}` - Current date formatted as "Monday, May 12, 2026"
2. `{{TOTAL_COUNT}}` - Total number of signals
3. `{{HIGH_COUNT}}` - Number of HIGH priority signals
4. `{{MEDIUM_COUNT}}` - Number of MEDIUM priority signals
5. `{{LOW_COUNT}}` - Number of LOW priority signals
6. `{{AIRTABLE_LINK}}` - Direct link to Airtable base
7. `{{#if HIGH_SIGNALS}}...{{/if}}` - Conditional block for HIGH priority section
8. `{{#each HIGH_SIGNALS}}...{{/each}}` - Loop for HIGH priority signals
9. `{{#if MEDIUM_SIGNALS}}...{{/if}}` - Conditional block for MEDIUM priority section
10. `{{#each MEDIUM_SIGNALS}}...{{/each}}` - Loop for MEDIUM priority signals
11. `{{#if LOW_SIGNALS}}...{{/if}}` - Conditional block for LOW priority section
12. `{{#each LOW_SIGNALS}}...{{/each}}` - Loop for LOW priority signals

**Signal-specific variables within loops:**
- `{{company_name}}` - signal.company.name
- `{{signal_type}}` - signal.type
- `{{signal_details}}` - signal.Signal Details (already formatted in Workflow 4)
- `{{brief}}` - signal.brief
- `{{contact_info}}` - signal.Contact Info (already formatted in Workflow 4)
- `{{industry}}` - signal.company.industry || "Unknown"
- `{{source_url}}` - signal.source_url || "#"

**Email Template (Complete HTML):**

(This is saved in `templates/email_template.html`)

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Starfish Signals - {{DATE}}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
      line-height: 1.6;
      color: #333333;
      background-color: #f5f5f5;
    }
    .email-wrapper { 
      max-width: 600px; 
      margin: 0 auto; 
      background-color: #ffffff; 
    }
    .header { 
      background-color: #2C3E50; 
      color: #ffffff; 
      padding: 30px 20px; 
      text-align: center; 
    }
    .header h1 { 
      font-size: 28px; 
      font-weight: 600; 
      margin-bottom: 8px; 
    }
    .header p { 
      font-size: 14px; 
      opacity: 0.9; 
    }
    .summary { 
      background-color: #ECF0F1; 
      padding: 20px; 
      margin: 0; 
    }
    .summary h2 { 
      font-size: 18px; 
      font-weight: 600; 
      margin-bottom: 15px; 
      color: #2C3E50; 
    }
    .stats-grid { 
      display: flex; 
      justify-content: space-between; 
      gap: 10px; 
    }
    .stat-box { 
      flex: 1; 
      background-color: #ffffff; 
      border-radius: 8px; 
      padding: 15px 10px; 
      text-align: center; 
    }
    .stat-number { 
      font-size: 32px; 
      font-weight: 700; 
      line-height: 1; 
      margin-bottom: 5px; 
    }
    .stat-number.total { color: #3498DB; }
    .stat-number.high { color: #E74C3C; }
    .stat-number.medium { color: #F39C12; }
    .stat-number.low { color: #95A5A6; }
    .stat-label { 
      font-size: 11px; 
      color: #7F8C8D; 
      text-transform: uppercase; 
      font-weight: 600; 
      letter-spacing: 0.5px; 
    }
    .content { 
      padding: 20px; 
    }
    .priority-section { 
      margin-bottom: 30px; 
    }
    .priority-section h3 { 
      font-size: 16px; 
      font-weight: 600; 
      margin-bottom: 15px; 
      padding-bottom: 8px; 
      border-bottom: 2px solid; 
    }
    .priority-section.high h3 { color: #E74C3C; border-bottom-color: #E74C3C; }
    .priority-section.medium h3 { color: #F39C12; border-bottom-color: #F39C12; }
    .priority-section.low h3 { color: #95A5A6; border-bottom-color: #95A5A6; }
    .signal-card { 
      background-color: #ffffff; 
      border-left: 4px solid; 
      padding: 18px; 
      margin-bottom: 15px; 
      box-shadow: 0 1px 3px rgba(0,0,0,0.1); 
    }
    .signal-card.high { border-left-color: #E74C3C; }
    .signal-card.medium { border-left-color: #F39C12; }
    .signal-card.low { border-left-color: #95A5A6; }
    .signal-header { 
      display: flex; 
      justify-content: space-between; 
      align-items: flex-start; 
      margin-bottom: 12px; 
    }
    .company-name { 
      font-size: 18px; 
      font-weight: 700; 
      color: #2C3E50; 
      line-height: 1.3; 
      flex: 1; 
    }
    .priority-badge { 
      display: inline-block; 
      padding: 4px 10px; 
      border-radius: 12px; 
      font-size: 11px; 
      font-weight: 700; 
      text-transform: uppercase; 
      letter-spacing: 0.5px; 
      margin-left: 10px; 
    }
    .priority-badge.high { background-color: #E74C3C; color: #ffffff; }
    .priority-badge.medium { background-color: #F39C12; color: #ffffff; }
    .priority-badge.low { background-color: #95A5A6; color: #ffffff; }
    .signal-type { 
      font-size: 12px; 
      color: #7F8C8D; 
      text-transform: uppercase; 
      font-weight: 600; 
      letter-spacing: 0.5px; 
      margin-bottom: 10px; 
    }
    .signal-details { 
      font-size: 14px; 
      color: #555555; 
      margin-bottom: 12px; 
      line-height: 1.5; 
    }
    .signal-brief { 
      font-size: 14px; 
      color: #34495E; 
      font-style: italic; 
      margin-bottom: 12px; 
      padding-left: 12px; 
      border-left: 3px solid #BDC3C7; 
    }
    .signal-brief:before { 
      content: '💡 '; 
    }
    .signal-meta { 
      font-size: 13px; 
      color: #7F8C8D; 
      line-height: 1.6; 
    }
    .signal-meta strong { 
      color: #555555; 
      font-weight: 600; 
    }
    .signal-meta a { 
      color: #3498DB; 
      text-decoration: none; 
    }
    .signal-meta a:hover { 
      text-decoration: underline; 
    }
    .footer { 
      background-color: #F8F9FA; 
      padding: 30px 20px; 
      text-align: center; 
      border-top: 1px solid #E9ECEF; 
    }
    .cta-button { 
      display: inline-block; 
      background-color: #3498DB; 
      color: #ffffff; 
      text-decoration: none; 
      padding: 14px 28px; 
      border-radius: 6px; 
      font-weight: 600; 
      font-size: 15px; 
      margin-bottom: 20px; 
      transition: background-color 0.2s; 
    }
    .cta-button:hover { 
      background-color: #2980B9; 
    }
    .footer-text { 
      font-size: 12px; 
      color: #7F8C8D; 
      line-height: 1.8; 
    }
  </style>
</head>
<body>
  <div class="email-wrapper">
    <!-- Header -->
    <div class="header">
      <h1>🎯 Starfish Signals</h1>
      <p>{{DATE}}</p>
    </div>
    
    <!-- Summary Stats -->
    <div class="summary">
      <h2>Daily Summary</h2>
      <div class="stats-grid">
        <div class="stat-box">
          <div class="stat-number total">{{TOTAL_COUNT}}</div>
          <div class="stat-label">Total Signals</div>
        </div>
        <div class="stat-box">
          <div class="stat-number high">{{HIGH_COUNT}}</div>
          <div class="stat-label">High Priority</div>
        </div>
        <div class="stat-box">
          <div class="stat-number medium">{{MEDIUM_COUNT}}</div>
          <div class="stat-label">Medium Priority</div>
        </div>
        <div class="stat-box">
          <div class="stat-number low">{{LOW_COUNT}}</div>
          <div class="stat-label">Low Priority</div>
        </div>
      </div>
    </div>
    
    <!-- Content -->
    <div class="content">
      <!-- HIGH Priority Signals -->
      {{#if HIGH_SIGNALS}}
      <div class="priority-section high">
        <h3>🔴 High Priority Signals</h3>
        {{#each HIGH_SIGNALS}}
        <div class="signal-card high">
          <div class="signal-header">
            <div class="company-name">{{company_name}}</div>
            <span class="priority-badge high">HIGH</span>
          </div>
          <div class="signal-type">{{signal_type}}</div>
          <div class="signal-details">{{signal_details}}</div>
          <div class="signal-brief">{{brief}}</div>
          <div class="signal-meta">
            <strong>Contact:</strong> {{contact_info}}<br>
            <strong>Industry:</strong> {{industry}}<br>
            <strong>Source:</strong> <a href="{{source_url}}">View Details</a>
          </div>
        </div>
        {{/each}}
      </div>
      {{/if}}
      
      <!-- MEDIUM Priority Signals -->
      {{#if MEDIUM_SIGNALS}}
      <div class="priority-section medium">
        <h3>🟡 Medium Priority Signals</h3>
        {{#each MEDIUM_SIGNALS}}
        <div class="signal-card medium">
          <div class="signal-header">
            <div class="company-name">{{company_name}}</div>
            <span class="priority-badge medium">MEDIUM</span>
          </div>
          <div class="signal-type">{{signal_type}}</div>
          <div class="signal-details">{{signal_details}}</div>
          <div class="signal-brief">{{brief}}</div>
          <div class="signal-meta">
            <strong>Contact:</strong> {{contact_info}}<br>
            <strong>Industry:</strong> {{industry}}<br>
            <strong>Source:</strong> <a href="{{source_url}}">View Details</a>
          </div>
        </div>
        {{/each}}
      </div>
      {{/if}}
      
      <!-- LOW Priority Signals -->
      {{#if LOW_SIGNALS}}
      <div class="priority-section low">
        <h3>⚪ Low Priority Signals</h3>
        {{#each LOW_SIGNALS}}
        <div class="signal-card low">
          <div class="signal-header">
            <div class="company-name">{{company_name}}</div>
            <span class="priority-badge low">LOW</span>
          </div>
          <div class="signal-type">{{signal_type}}</div>
          <div class="signal-details">{{signal_details}}</div>
          <div class="signal-brief">{{brief}}</div>
          <div class="signal-meta">
            <strong>Contact:</strong> {{contact_info}}<br>
            <strong>Industry:</strong> {{industry}}<br>
            <strong>Source:</strong> <a href="{{source_url}}">View Details</a>
          </div>
        </div>
        {{/each}}
      </div>
      {{/if}}
    </div>
    
    <!-- Footer -->
    <div class="footer">
      <a href="{{AIRTABLE_LINK}}" class="cta-button">View All Signals in Airtable</a>
      <div class="footer-text">
        This is an automated daily digest from Starfish Signal Monitor<br>
        Questions? Contact Gideon at awotuyitobiloba@gmail.com
      </div>
    </div>
  </div>
</body>
</html>
```

**Template Population Implementation:**

```javascript
const fs = require('fs');
const Handlebars = require('handlebars');

// Register Handlebars helpers
Handlebars.registerHelper('if', function(conditional, options) {
  if (conditional && conditional.length > 0) {
    return options.fn(this);
  }
  return options.inverse(this);
});

// Load template
const templateSource = fs.readFileSync('templates/email_template.html', 'utf8');
const template = Handlebars.compile(templateSource);

// Format date
const dateFormatted = new Date().toLocaleDateString('en-US', { 
  weekday: 'long', 
  year: 'numeric', 
  month: 'long', 
  day: 'numeric' 
});

// Build Airtable link
const airtableLink = `https://airtable.com/${process.env.AIRTABLE_BASE_ID}/${process.env.AIRTABLE_TABLE_NAME}`;

// Prepare template data
const templateData = {
  DATE: dateFormatted,
  TOTAL_COUNT: deduplicatedSignals.length,
  HIGH_COUNT: highPriority.length,
  MEDIUM_COUNT: mediumPriority.length,
  LOW_COUNT: lowPriority.length,
  AIRTABLE_LINK: airtableLink,
  HIGH_SIGNALS: highPriority.map(s => ({
    company_name: s.company.name,
    signal_type: s.type,
    signal_details: formatSignalDetails(s),
    brief: s.brief,
    contact_info: formatContactInfo(s),
    industry: s.company.industry || 'Unknown',
    source_url: s.source_url || '#'
  })),
  MEDIUM_SIGNALS: mediumPriority.map(s => ({
    company_name: s.company.name,
    signal_type: s.type,
    signal_details: formatSignalDetails(s),
    brief: s.brief,
    contact_info: formatContactInfo(s),
    industry: s.company.industry || 'Unknown',
    source_url: s.source_url || '#'
  })),
  LOW_SIGNALS: lowPriority.map(s => ({
    company_name: s.company.name,
    signal_type: s.type,
    signal_details: formatSignalDetails(s),
    brief: s.brief,
    contact_info: formatContactInfo(s),
    industry: s.company.industry || 'Unknown',
    source_url: s.source_url || '#'
  }))
};

// Generate HTML
const emailHTML = template(templateData);

console.log('[Email] Template populated successfully');
```

**Step 5.3: Determine Recipients**

```javascript
const nodeEnv = process.env.NODE_ENV || 'testing';

let recipients;
if (nodeEnv === 'production') {
  recipients = process.env.EMAIL_TO_PRODUCTION.split(',').map(email => email.trim());
} else {
  recipients = [process.env.EMAIL_TO_TESTING];
}

console.log(`[Email] Recipients (${nodeEnv} mode): ${recipients.join(', ')}`);
```

**Step 5.4: Send via SMTP**

**SMTP Configuration:**
- **Host:** smtp.gmail.com
- **Port:** 587
- **Security:** TLS (secure: false for port 587)
- **Auth:** Username + app-specific password

**Implementation:**
```javascript
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT),
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

const mailOptions = {
  from: process.env.EMAIL_FROM,
  to: recipients,
  subject: `Starfish Signals - ${dateFormatted} - ${deduplicatedSignals.length} New Opportunities`,
  html: emailHTML
};

try {
  const info = await transporter.sendMail(mailOptions);
  
  console.log(`[Email] ✓ Sent successfully`);
  console.log(`[Email] Message ID: ${info.messageId}`);
  
  // Log success
  const logEntry = `
[${new Date().toISOString()}] Email Send Log
==========================================
Recipients: ${recipients.join(', ')}
Subject: ${mailOptions.subject}
Signals: ${deduplicatedSignals.length} (HIGH: ${highPriority.length}, MEDIUM: ${mediumPriority.length}, LOW: ${lowPriority.length})
Status: SUCCESS
Message ID: ${info.messageId}
==========================================
`;
  
  fs.appendFileSync(`.tmp/email_log_${today}.txt`, logEntry);
  
} catch (error) {
  console.error('[Email] ✗ Send failed:', error.message);
  
  // Save unsent email HTML for manual review
  fs.writeFileSync(
    `.tmp/unsent_email_${today}.html`,
    emailHTML
  );
  
  // Log failure
  const logEntry = `
[${new Date().toISOString()}] Email Send Log
==========================================
Recipients: ${recipients.join(', ')}
Subject: ${mailOptions.subject}
Status: FAILED
Error: ${error.message}
Unsent HTML saved to: .tmp/unsent_email_${today}.html
==========================================
`;
  
  fs.appendFileSync(`.tmp/email_log_${today}.txt`, logEntry);
  
  // Send Telegram alert to Gideon
  await sendTelegramError(`Email delivery failed: ${error.message}`);
}
```

**Output:** Email delivery status (boolean: true if successful, false if failed)

**Expected Execution Time:** 30-60 seconds

**Error Handling:**
- If SMTP connection fails: Save HTML to `.tmp/unsent_email_${today}.html`, send Telegram alert, continue to Workflow 6
- If email is too large (>10MB): Truncate signal details, try again, if still fails save HTML and alert
- If authentication fails: Log error, alert Gideon, skip email for this run

---

### Workflow 6: `telegram_monitoring`

**Location:** `instructions/workflow_6_telegram_monitoring.md` + `execution/workflow_6_telegram_monitoring.js`

**Trigger:** Immediately after Workflow 5 completes

**Input:** 
- Array of deduplicated signals from Workflow 3
- Status from Workflow 4 (Airtable insertion count)
- Status from Workflow 5 (email delivery success/failure)

**Process:**

**Step 6.1: Format Telegram Message**

**Message Template:**
```
🎯 Starfish Daily Run - {DATE}

📊 Signals Detected: {TOTAL_COUNT}
🔴 High Priority: {HIGH_COUNT}
🟡 Medium Priority: {MEDIUM_COUNT}
⚪ Low Priority: {LOW_COUNT}

Top 3 Signals:
1. {COMPANY_1} - {BRIEF_1}
2. {COMPANY_2} - {BRIEF_2}
3. {COMPANY_3} - {BRIEF_3}

✅ Email sent to: {RECIPIENTS}
💾 Saved {AIRTABLE_COUNT} records to Airtable

⏱️ Total execution time: {DURATION}s
```

**Implementation:**
```javascript
function formatTelegramMessage(signals, airtableCount, emailSuccess, duration) {
  const date = new Date().toLocaleDateString('en-US', { 
    weekday: 'long', 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric' 
  });
  
  const high = signals.filter(s => s.priority === 'HIGH');
  const medium = signals.filter(s => s.priority === 'MEDIUM');
  const low = signals.filter(s => s.priority === 'LOW');
  
  let message = `🎯 Starfish Daily Run - ${date}\n\n`;
  message += `📊 Signals Detected: ${signals.length}\n`;
  message += `🔴 High Priority: ${high.length}\n`;
  message += `🟡 Medium Priority: ${medium.length}\n`;
  message += `⚪ Low Priority: ${low.length}\n\n`;
  
  // Top 3 signals
  if (signals.length > 0) {
    message += `Top ${Math.min(3, signals.length)} Signals:\n`;
    
    const top3 = signals.slice(0, 3);
    top3.forEach((signal, index) => {
      const brief = signal.brief.length > 80 
        ? signal.brief.substring(0, 77) + '...' 
        : signal.brief;
      message += `${index + 1}. ${signal.company.name} - ${brief}\n`;
    });
    message += '\n';
  } else {
    message += `No new signals detected today.\n\n`;
  }
  
  // Email status
  if (emailSuccess) {
    const nodeEnv = process.env.NODE_ENV || 'testing';
    const recipients = nodeEnv === 'production' 
      ? 'david@starfishco.com, zack.k@starfishco.com' 
      : 'awotuyitobiloba@gmail.com';
    message += `✅ Email sent to: ${recipients}\n`;
  } else {
    message += `⚠️ Email delivery failed (see logs)\n`;
  }
  
  // Airtable status
  if (airtableCount > 0) {
    message += `💾 Saved ${airtableCount} records to Airtable\n`;
  } else if (signals.length > 0) {
    message += `⚠️ Airtable save failed (see logs)\n`;
  }
  
  // Execution time
  message += `\n⏱️ Total execution time: ${duration.toFixed(1)}s`;
  
  return message;
}

const startTime = Date.now(); // This was set at the beginning of Workflow 1
const duration = (Date.now() - startTime) / 1000;

const telegramMessage = formatTelegramMessage(
  deduplicatedSignals,
  totalInserted,
  emailSuccess,
  duration
);

console.log('[Telegram] Message formatted');
```

**Step 6.2: Send to Telegram**

**Telegram Bot API:**
- **Endpoint:** `POST https://api.telegram.org/bot{BOT_TOKEN}/sendMessage`
- **Method:** POST
- **Headers:** Content-Type: application/json

**Payload:**
```json
{
  "chat_id": "YOUR_TELEGRAM_CHAT_ID",
  "text": "message from Step 6.1",
  "parse_mode": "HTML"
}
```

**Implementation:**
```javascript
const axios = require('axios');

const telegramUrl = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;

const payload = {
  chat_id: process.env.TELEGRAM_CHAT_ID,
  text: telegramMessage,
  parse_mode: 'HTML'
};

try {
  const response = await axios.post(telegramUrl, payload);
  
  if (response.data.ok) {
    console.log('[Telegram] ✓ Message sent successfully');
  } else {
    console.error('[Telegram] ✗ Message send failed:', response.data.description);
  }
  
} catch (error) {
  console.error('[Telegram] ✗ API call failed:', error.message);
  // Do NOT block the pipeline for Telegram failures
  // This is monitoring only, not critical
}
```

**Step 6.3: Silent Logging**

**IMPORTANT:** Do NOT log Telegram activity to project files. This monitoring is invisible to the client.

If Telegram fails, only log to console (which Gideon can see in Railway logs, but client cannot).

```javascript
// NO file logging for Telegram
// Client must not know about this workflow
```

**Output:** Telegram message sent (boolean: true if successful, false if failed)

**Expected Execution Time:** 5-10 seconds

**Error Handling:**
- If Telegram API fails: Log to console only, do NOT save to `.tmp/`, do NOT alert anyone
- If bot token is invalid: Log to console, continue (will be caught in production testing)
- If chat ID is invalid: Log to console, continue
- Telegram failures are non-critical and do NOT block the pipeline

---

## 3. Tools

**What tools are being used:**

### External APIs (7 total)

1. **Apollo API**
   - **Purpose:** Secondary job change tracking + company enrichment (revenue, HQ, industry) + people/match for name lookup by email
   - **Documentation:** https://apolloio.github.io/apollo-api-docs/
   - **Authentication:** `X-Api-Key` header
   - **Rate Limits:** 5 requests/second, 10,000 requests/day
   - **Cost:** Paid tier required (credentials provided by client)

2. **PDL (People Data Labs) API**
   - **Purpose:** Primary job change source — accurate start dates via SQL-level filtering
   - **Endpoint:** `GET https://api.peopledatalabs.com/v5/person/search`
   - **Authentication:** `X-Api-Key` header
   - **Rate Limits:** Varies by plan
   - **Cost:** Paid tier (credentials provided by client)

3. **MediaStack API**
   - **Purpose:** Press release and news monitoring
   - **Documentation:** https://mediastack.com/documentation
   - **Authentication:** API key in query parameter
   - **Rate Limits:** 100-500 requests/month (tier-dependent)
   - **Cost:** Paid tier required (credentials provided by client)

4. **PredictLeads API**
   - **Purpose:** M&A + Rebrand event tracker (paginated, up to 450 events/day across 5 categories)
   - **Documentation:** https://predictleads.com/api-docs
   - **Authentication:** `X-Api-Key` + `X-Api-Token` headers
   - **Rate Limits:** 1000 requests/day
   - **Cost:** Standard tier (credentials provided by client)

5. **NewsAPI**
   - **Purpose:** Reliable M&A + funding round source via legal-language queries on wire service whitelist
   - **Endpoint:** `GET https://newsapi.org/v2/everything`
   - **Authentication:** `apiKey` query parameter
   - **Rate Limits:** 100 requests/day (free), commercial plan for production
   - **Cost:** Paid plan required for commercial use

6. **Hunter API**
   - **Purpose:** Email finder via domain search (returns exec emails + names in one call); also used for person enrichment by email address in backfill_names.js
   - **Endpoint:** `GET https://api.hunter.io/v2/domain-search` and `GET https://api.hunter.io/v2/email-enrichment`
   - **Authentication:** `api_key` query parameter (`HUNTER_API_KEY`)
   - **Rate Limits:** Varies by plan
   - **Cost:** Paid plan (Gideon's account)

7. **Claude API (Anthropic)**
   - **Purpose:** Signal enrichment, priority scoring, brief generation, contact approach personalization
   - **Documentation:** https://docs.anthropic.com/claude/reference/messages_post
   - **SDK:** `@anthropic-ai/sdk` (official Anthropic Node.js SDK)
   - **Model:** `CLAUDE_MODEL` env var (default `claude-haiku-4-5-20251001`)
   - **Rate Limits:** Varies by tier (typically 50 requests/minute)
   - **Cost:** Pay-per-token (Gideon's account)

### Web Scraping Tool (1 tool)

8. **Puppeteer**
   - **Purpose:** Domain validation (verify a discovered domain actually belongs to the target company) + executive email discovery by scraping company contact pages
   - **npm Package:** `puppeteer`
   - **Usage:** Fires only when Hunter domain search returns no useful email. Visits homepage, reads `<title>` and `<h1>` to validate domain against company name using a significant-word match + domain penalty algorithm. Falls back from Google to DuckDuckGo HTML if CAPTCHA is detected.
   - **Cost:** Free (runs locally / on Railway)

---

### Data Storage & Communication (4 tools)

9. **Airtable**
   - **Purpose:** Live signal database storage
   - **Documentation:** https://airtable.com/developers/web/api/introduction
   - **Authentication:** Personal access token
   - **SDK:** `airtable` npm package v0.12.2
   - **Rate Limits:** 5 requests/second per base
   - **Cost:** Free tier sufficient for pilot (Gideon's account, transfer to client)

10. **SMTP (Gmail)**
   - **Purpose:** Email delivery system
   - **Service:** Gmail SMTP server
   - **Host:** smtp.gmail.com
   - **Port:** 587 (TLS)
   - **Authentication:** Username + app-specific password
   - **Rate Limits:** 500 emails/day for free Gmail, 2000/day for Google Workspace
   - **Cost:** Free (using Gideon's Gmail account)

11. **Google Sheets API**
   - **Purpose:** Client-facing view layer for signals (synced from Airtable via Workflow 4b)
   - **SDK:** `googleapis` npm package (Google Sheets API v4)
   - **Authentication:** OAuth2 with refresh token (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`)
   - **Sheet:** `GOOGLE_SHEET_ID` env var, sheet name `Signals`, data starts at row 5
   - **Cost:** Free (Google API)

12. **Telegram Bot API**
   - **Purpose:** Silent monitoring notifications to Gideon
   - **Documentation:** https://core.telegram.org/bots/api
   - **Authentication:** Bot token
   - **Endpoint:** https://api.telegram.org/bot{token}/sendMessage
   - **Rate Limits:** 30 messages/second
   - **Cost:** Free

### Infrastructure & Runtime (3 tools)

13. **Node.js v18+**
   - **Purpose:** Runtime environment for all JavaScript code
   - **Version:** 18.0.0 or higher (LTS recommended)
   - **Installation:** Pre-installed on Railway

14. **Railway**
   - **Purpose:** Cloud hosting platform
   - **Region:** us-west1 (Oregon, USA)
   - **Service Type:** Node.js Express server
   - **Deployment:** Git push to main branch
   - **Cost:** Pay-as-you-go (estimated $5-10/month for pilot)
   - **Features:** Auto-deploy, environment variables, cron scheduling, logs, health checks

15. **node-cron**
    - **Purpose:** Job scheduling library for daily 5 AM EST runs
    - **npm Package:** `node-cron` v3.0.3
    - **Syntax:** Unix cron expressions
    - **Timezone Support:** Yes (America/New_York)

### Required JavaScript Packages

```json
{
  "name": "starfish-signal-monitor",
  "version": "1.0.0",
  "description": "Automated intent signal monitoring for Starfish Co.",
  "main": "execution/main.js",
  "scripts": {
    "start": "node execution/main.js",
    "test": "node execution/main.js --test"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.39.0",
    "axios": "^1.6.0",
    "node-cron": "^3.0.3",
    "airtable": "^0.12.2",
    "nodemailer": "^6.9.7",
    "dotenv": "^16.3.1",
    "googleapis": "^148.0.0",
    "handlebars": "^4.7.8",
    "puppeteer": "^21.0.0",
    "juice": "^10.0.0"
  },
  "engines": {
    "node": ">=18.0.0"
  }
}
```

---

## 4. Outputs

**What outputs are expected:**

### Output 1: Daily Email Digest

**Format:** HTML email  
**Frequency:** Once per day at approximately 5:04 AM EST  
**Recipient (Testing):** awotuyitobiloba@gmail.com  
**Recipient (Production):** david@starfishco.com, zack.k@starfishco.com  

**Subject Line Format:** 
```
Starfish Signals - {Day}, {Month} {Date}, {Year} - {Count} New Opportunities
```

**Subject Line Example:**
```
Starfish Signals - Monday, May 12, 2026 - 5 New Opportunities
```

**Content Sections:**
1. **Header:** Blue background (#2C3E50), white text, displays "🎯 Starfish Signals" and current date
2. **Summary Stats:** 4 stat boxes showing total signals, HIGH count (red), MEDIUM count (orange), LOW count (gray)
3. **HIGH Priority Signals Section:** Red border-left on cards, full details for each signal (company name, signal type, signal details, brief, contact info, industry, source link)
4. **MEDIUM Priority Signals Section:** Orange border-left on cards, same details as HIGH
5. **LOW Priority Signals Section:** Gray border-left on cards, same details as HIGH/MEDIUM
6. **Footer:** Blue "View All Signals in Airtable" button, contact info (awotuyitobiloba@gmail.com)

**Email Size:** Typically 50-150KB (depends on signal count)

**Delivery Success Rate Target:** 100% (every day without failure)

**Fallback Behavior:** If email fails, HTML is saved to `.tmp/unsent_email_YYYYMMDD.html` and Telegram alert sent to Gideon

---

### Output 2: Airtable Records

**Location:** Airtable base (owned by Gideon, transferred to client at handoff)  
**Table Name:** Signals  
**Frequency:** Once per day at approximately 5:03 AM EST  
**Record Count:** 3-15 new records per day  

**Record Structure (15 fields per record):**

| # | Field Name | Type | Sample Value |
|---|------------|------|--------------|
| 1 | Company Name | Single line text | "Acme Corporation" |
| 2 | Signal Type | Single select | "Job Change" |
| 3 | Signal Details | Long text | "John Smith joined Acme Corporation as VP Marketing. Company: Technology industry, $250M revenue, 1,500 employees." |
| 4 | Contact Info | Long text | `Name: John Smith\nTitle: VP Marketing\nLinkedIn: ...\nEmail: john@acme.com` for Job Change; `Email: john@acme.com (via Hunter)` for News/M&A |
| 5 | Company Revenue | Number | 250000000 |
| 6 | Company Funding Stage | Single line text | "Series C" |
| 7 | Industry | Single line text | "Technology" |
| 8 | Date Detected | Date | 2026-05-12 |
| 9 | Priority | Single select | "HIGH" |
| 10 | Brief | Long text | "New VP Marketing at high-growth tech company indicates potential brand refresh. Recent Series C funding suggests budget for strategic rebranding." |
| 11 | Contact Approach | Long text | "Reach out to John within first 30 days with case studies of tech rebrands post-Series C." |
| 12 | Source URL | URL | "https://linkedin.com/in/johnsmith" |
| 13 | Status | Single select | "New" |
| 14 | Created At | Created time | 2026-05-12 05:03:15 |
| 15 | Last Modified | Last modified time | 2026-05-12 05:03:15 |

**Access:** Shared with david@starfishco.com and zack.k@starfishco.com via Airtable invite

**Retention:** Permanent (no auto-deletion)

**View Configuration:** Default view shows all records sorted by Date Detected (newest first), filtered by Status = "New"

---

### Output 3: Telegram Monitoring Message

**Format:** Plain text with emoji markers  
**Frequency:** Once per day at approximately 5:05 AM EST  
**Recipient:** Gideon's Telegram (chat ID from TELEGRAM_CHAT_ID env var)  
**Purpose:** Silent QA monitoring (client doesn't know about this)

**Message Structure:**
```
🎯 Starfish Daily Run - {Full Date}

📊 Signals Detected: {Number}
🔴 High Priority: {Number}
🟡 Medium Priority: {Number}
⚪ Low Priority: {Number}

Top 3 Signals:
1. {Company Name} - {Brief (truncated to 80 chars)}
2. {Company Name} - {Brief (truncated to 80 chars)}
3. {Company Name} - {Brief (truncated to 80 chars)}

✅ Email sent to: {Recipients}
💾 Saved {Number} records to Airtable

⏱️ Total execution time: {Seconds}s
```

**Example Message:**
```
🎯 Starfish Daily Run - Monday, May 12, 2026

📊 Signals Detected: 5
🔴 High Priority: 2
🟡 Medium Priority: 3
⚪ Low Priority: 0

Top 3 Signals:
1. Acme Corporation - New VP Marketing at high-growth tech company indicates potential brand refresh...
2. Beta Industries - Company announces $50M Series B funding and market expansion plans...
3. Gamma Technologies - Merger with competitor signals need for unified brand identity...

✅ Email sent to: awotuyitobiloba@gmail.com
💾 Saved 5 records to Airtable

⏱️ Total execution time: 376.2s
```

**Error Reporting:** If errors occur, additional lines added:
```
⚠️ ERRORS:
- Apollo API failed: Rate limit exceeded
- Email delivery failed: SMTP authentication error
```

---

### Output 4: Log Files

**Location:** `.tmp/` directory (local filesystem, not committed to Git)

**Files Created Daily:**

1. **`apollo_raw_YYYYMMDD.json`**
   - Purpose: Raw Apollo API response for debugging
   - Format: JSON array
   - Retention: 7 days
   - Size: 50-200KB

2. **`mediastack_raw_YYYYMMDD.json`**
   - Purpose: Raw MediaStack API response for debugging
   - Format: JSON array
   - Retention: 7 days
   - Size: 100-400KB

3. **`predictleads_raw_YYYYMMDD.json`**
   - Purpose: Raw PredictLeads API response for debugging
   - Format: JSON array
   - Retention: 7 days
   - Size: 50-200KB

4. **`combined_raw_YYYYMMDD.json`**
   - Purpose: All signals before filtering (audit trail)
   - Format: JSON array
   - Retention: 7 days
   - Size: 200-800KB

5. **`filtered_signals_YYYYMMDD.json`**
   - Purpose: After filtering, before deduplication (audit trail)
   - Format: JSON array
   - Retention: 7 days
   - Size: 50-300KB

6. **`final_signals_YYYYMMDD.json`**
   - Purpose: Final signals sent to email and Airtable (audit trail)
   - Format: JSON array
   - Retention: 30 days
   - Size: 20-150KB

7. **`duplicates_removed_YYYYMMDD.json`**
   - Purpose: Signals removed as duplicates (audit trail)
   - Format: JSON array
   - Retention: 30 days
   - Size: 0-100KB

8. **`airtable_log_YYYYMMDD.txt`**
   - Purpose: Airtable operation logs (batch inserts, verification)
   - Format: Plain text
   - Retention: 30 days
   - Size: 1-5KB

9. **`email_log_YYYYMMDD.txt`**
   - Purpose: Email send logs (recipients, status, message ID)
   - Format: Plain text
   - Retention: 30 days
   - Size: 1-3KB

10. **`error_log_YYYYMMDD.txt`** (only created if errors occur)
    - Purpose: Error messages and stack traces
    - Format: Plain text
    - Retention: 90 days
    - Size: 0-20KB

11. **`claude_failures_YYYYMMDD.json`** (only created if Claude API fails)
    - Purpose: Signals that failed Claude enrichment
    - Format: JSON array
    - Retention: 30 days
    - Size: 0-50KB

12. **`airtable_failures_YYYYMMDD.json`** (only created if Airtable insert fails)
    - Purpose: Records that failed to insert into Airtable
    - Format: JSON array
    - Retention: 30 days
    - Size: 0-100KB

13. **`unsent_email_YYYYMMDD.html`** (only created if email send fails)
    - Purpose: Email HTML that failed to send (for manual review)
    - Format: HTML
    - Retention: 30 days
    - Size: 50-150KB

**Cleanup Policy:** Manual deletion by Gideon after retention period. No auto-cleanup during pilot.

---

## 5. Storage

**Where data is stored:**

### Primary Storage: Airtable

**Provider:** Airtable (cloud-hosted, SaaS)  
**Owner:** Gideon's Airtable account (will transfer to client at handoff)  
**Base Name:** Starfish Signal Monitor (Pilot)  
**Table Name:** Signals  
**Record Lifespan:** Permanent (no auto-deletion)  
**Expected Growth:** 3-15 records/day × 10 days = 30-150 records for pilot  
**Cost:** Free tier sufficient (up to 1,200 records per base)

**Complete Schema (15 fields):**

| Field Name | Type | Required | Default | Max Length | Validation | Notes |
|------------|------|----------|---------|------------|------------|-------|
| Company Name | Single line text | Yes | - | 255 chars | No special chars except &, ., Inc, Corp, LLC | Primary identifier for deduplication |
| Signal Type | Single select | Yes | - | - | Options: "Job Change", "News/Press", "M&A Activity", "Rebrand" | Source category |
| Signal Details | Long text | Yes | - | 2000 chars | None | Full description, auto-truncated if >2000 |
| Contact Info | Long text | No | null | 500 chars | None | Name, title, LinkedIn, email if available |
| Company Revenue | Number | No | null | - | Must be ≥ 0 | Annual revenue in USD, formatted with precision 0 |
| Company Funding Stage | Single line text | No | null | 50 chars | None | e.g., "Series A", "Series B", "Series C" |
| Industry | Single line text | No | null | 100 chars | None | Company's primary industry |
| Date Detected | Date | Yes | TODAY() | - | Format: YYYY-MM-DD | When signal was found by system |
| Priority | Single select | Yes | "MEDIUM" | - | Options: "HIGH", "MEDIUM", "LOW" | Claude API determines this |
| Brief | Long text | Yes | - | 500 chars | None | 2-sentence explanation from Claude |
| Contact Approach | Long text | No | null | 500 chars | None | Suggested outreach strategy from Claude |
| Source URL | URL | No | null | - | Must be valid URL format | Link to LinkedIn, article, or deal source |
| Status | Single select | Yes | "New" | - | Options: "New", "Reviewed", "Contacted", "Not Interested" | Workflow tracking (always "New" during pilot) |
| Created At | Created time | Auto | NOW() | - | System field | Airtable auto-populates on record creation |
| Last Modified | Last modified time | Auto | NOW() | - | System field | Airtable auto-updates on any field change |

**API Configuration:**
- **Base ID:** Format `appXXXXXXXXXXXXXX` (17 chars, stored in AIRTABLE_BASE_ID env var)
- **Table ID:** Format `tblXXXXXXXXXXXXXX` (17 chars, not used in API calls for pilot)
- **API Key:** Personal access token (stored in AIRTABLE_API_KEY env var)
- **Endpoint:** `https://api.airtable.com/v0/{BASE_ID}/{TABLE_NAME}`
- **Rate Limits:** 5 requests/second per base
- **Batch Size:** Maximum 10 records per create request

**Views (Pre-configured in Airtable UI):**
1. **All Signals** (default): All records, sorted by Date Detected descending
2. **New Signals**: Filtered by Status = "New", sorted by Priority (HIGH → MEDIUM → LOW)
3. **High Priority**: Filtered by Priority = "HIGH", sorted by Date Detected descending
4. **This Week**: Filtered by Date Detected in last 7 days

**Access Control:**
- **Gideon:** Owner (full access)
- **David Kessler:** Editor (invited via email, full access except base settings)
- **Zack Kessler:** Editor (invited via email, full access except base settings)

---

### Secondary Storage: Local Temporary Files

**Location:** `.tmp/` directory in project root  
**Purpose:** Raw data, logs, debugging, audit trail  
**Lifespan:** Varies by file type (7-90 days, see Output 4)  
**Cleanup:** Manual deletion by Gideon after retention period  
**Git:** Directory is in `.gitignore`, never committed  
**Deployment:** Not deployed to Railway (local only, Railway has separate logs)

**Directory Structure:**
```
.tmp/
├── apollo_raw_20260512.json
├── mediastack_raw_20260512.json
├── predictleads_raw_20260512.json
├── combined_raw_20260512.json
├── filtered_signals_20260512.json
├── final_signals_20260512.json
├── duplicates_removed_20260512.json
├── airtable_log_20260512.txt
├── email_log_20260512.txt
├── error_log_20260512.txt (if errors occur)
├── claude_failures_20260512.json (if Claude fails)
├── airtable_failures_20260512.json (if Airtable fails)
└── unsent_email_20260512.html (if email fails)
```

**Total Daily Storage:** 500KB - 2MB per day (depends on signal volume and errors)

**Total Pilot Storage:** 5-20MB for 10-day pilot

---

## 6. Deployment

**Where the system will be deployed:** Railway (cloud hosting platform)

### Railway Project Configuration

**Project Name:** starfish-signal-monitor  
**Owner:** Gideon's Railway account (will transfer to client at handoff)  
**Region:** us-west1 (Oregon, USA) - closest to PST timezone for 5 AM EST cron  
**Service Type:** Node.js Express server  
**Repository:** Private GitHub repo (Gideon's account)  
**Branch:** main  
**Deployment Trigger:** Git push to main branch (auto-deploy enabled)  
**Start Command:** `node execution/main.js`  
**Build Command:** `npm install` (auto-detected)  
**Estimated Monthly Cost:** $5-10 USD for pilot (based on uptime + compute)

### Environment Variables (25 total)

**CRITICAL:** All 34 variables must be set in Railway dashboard BEFORE deployment.

**Category 1: Apollo API (2 variables)**
```bash
APOLLO_API_KEY=your_apollo_api_key_from_client
APOLLO_API_URL=https://api.apollo.io/v1
```

**Category 2: MediaStack API (2 variables)**
```bash
MEDIASTACK_API_KEY=your_mediastack_api_key_from_client
MEDIASTACK_API_URL=https://api.mediastack.com/v1
```

**Category 2b: PDL API (2 variables)**
```bash
PDL_API_KEY=your_pdl_api_key_from_client
PDL_API_URL=https://api.peopledatalabs.com/v5
```

**Category 2c: NewsAPI (1 variable)**
```bash
NEWSAPI_API_KEY=your_newsapi_key
```

**Category 3: PredictLeads API (2 variables)**
```bash
PREDICTLEADS_API_KEY=your_predictleads_api_key_from_client
PREDICTLEADS_API_URL=https://api.predictleads.com/v1
```

**Category 4: Claude API (3 variables)**
```bash
CLAUDE_API_KEY=your_claude_api_key_from_client
CLAUDE_API_URL=https://api.anthropic.com/v1
CLAUDE_MODEL=claude-haiku-4-5-20251001
```

**Category 4b: Hunter API (1 variable)**
```bash
HUNTER_API_KEY=your_hunter_api_key
```

**Category 5: Airtable (3 variables)**
```bash
AIRTABLE_API_KEY=your_personal_airtable_token
AIRTABLE_BASE_ID=appXXXXXXXXXXXXXX
AIRTABLE_TABLE_NAME=Signals
```

**Category 6: Email (SMTP) (8 variables)**
```bash
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=awotuyitobiloba@gmail.com
SMTP_PASS=your_gmail_app_specific_password
EMAIL_FROM=Starfish Signal Monitor <noreply@starfishmonitor.com>
EMAIL_TO_TESTING=awotuyitobiloba@gmail.com
EMAIL_TO_PRODUCTION=david@starfishco.com,zack.k@starfishco.com
```

**Category 7: Telegram (2 variables)**
```bash
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
TELEGRAM_CHAT_ID=your_telegram_chat_id
```

**Category 8: Google Sheets (5 variables)**
```bash
GOOGLE_SHEET_ID=your_google_sheet_id
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
GOOGLE_REFRESH_TOKEN=your_google_refresh_token
SKIP_SHEETS_SYNC=false
```

**Category 9: System (3 variables)**
```bash
NODE_ENV=production
TZ=America/New_York
CRON_SCHEDULE=0 5 * * *
```

**Total:** 34 environment variables

### Cron Schedule Configuration

**Expression:** `0 5 * * *`

**Breakdown:**
- Minute: `0` (top of the hour, 0-59)
- Hour: `5` (5 AM, 0-23)
- Day of Month: `*` (every day, 1-31)
- Month: `*` (every month, 1-12)
- Day of Week: `*` (every day of week, 0-6, 0=Sunday)

**Timezone:** America/New_York (EST/EDT with automatic DST handling)

**Frequency:** Once per day, every day

**Execution Time:** 5:00 AM EST (or 5:00 AM EDT during daylight saving time)

**Implementation:**
```javascript
const cron = require('node-cron');

// Schedule task
cron.schedule('0 5 * * *', async () => {
  console.log(`[${new Date().toISOString()}] Cron triggered: Starting daily signal monitoring run`);
  await runAllWorkflows();
}, {
  timezone: "America/New_York"
});

console.log('[Cron] Scheduled to run daily at 5:00 AM EST');
console.log('[Cron] Waiting for next trigger...');
```

**Manual Trigger (for testing only):**
```bash
# SSH into Railway container and run manually
railway run node execution/main.js --manual
```

### Health Check Endpoint

**Purpose:** Verify system is running and cron is scheduled

**Endpoint:** `GET /health`

**URL:** `https://starfish-signal-monitor.up.railway.app/health`

**Response Format (JSON):**
```json
{
  "status": "running",
  "uptime": 3600.5,
  "lastRun": "2026-05-12T10:05:30.000Z",
  "nextRun": "2026-05-13T10:00:00.000Z",
  "environment": "production",
  "version": "1.0.0"
}
```

**Implementation:**
```javascript
const express = require('express');
const app = express();

let lastRunTimestamp = null;

function getNextRunTime() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(5, 0, 0, 0);
  
  // If 5 AM already passed today, set to tomorrow
  if (now.getHours() >= 5) {
    next.setDate(next.getDate() + 1);
  }
  
  return next.toISOString();
}

app.get('/health', (req, res) => {
  res.json({
    status: 'running',
    uptime: process.uptime(),
    lastRun: lastRunTimestamp,
    nextRun: getNextRunTime(),
    environment: process.env.NODE_ENV || 'development',
    version: '1.0.0'
  });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[Server] Health check endpoint running on port ${PORT}`);
  console.log(`[Server] Access at: http://localhost:${PORT}/health`);
});
```

**Health Check Schedule:** Railway automatically pings `/health` every 5 minutes

**Expected Response Time:** < 100ms

**Failure Handling:** If `/health` returns non-200 status or times out, Railway sends alert

---

## 7. Definition of Done

**What "done" looks like for pilot completion:**

### Complete Checklist (ALL items must be checked ✓)

**System Functionality (9 criteria):**
- [ ] System runs automatically at 5:00 AM EST for 3 consecutive days without manual intervention
- [ ] System produces 3-5 qualified signals per day (3-day average must be in range)
- [ ] Zero duplicate companies detected across entire 10-day test period (0 tolerance)
- [ ] Email delivers successfully to recipient(s) every day (100% delivery rate)
- [ ] All signals saved to Airtable with complete data (no null values in required fields)
- [ ] Telegram monitoring message received by Gideon every day (100% delivery rate)
- [ ] Railway logs show zero crashes or uncaught errors in final 3-day test period
- [ ] Health check endpoint returns valid JSON with status "running" every time pinged
- [ ] Complete end-to-end pipeline executes in < 15 minutes (from cron trigger to email sent)

**Data Quality (7 criteria):**
- [ ] 100% of signals meet company size filter ($50M+ revenue OR Series A/B/C/D/E funding)
- [ ] 100% of signals meet geography filter (US-based headquarters only)
- [ ] 100% of job change signals meet job title filter (one of 11 valid titles)
- [ ] All Claude enrichments have valid priority ("HIGH", "MEDIUM", or "LOW" - never null or error message)
- [ ] All Claude enrichments have 2-sentence briefs (not empty, not error messages, actually 2 sentences)
- [ ] All Airtable records have populated Company Name, Signal Type, Date Detected, Priority, and Brief fields (5 core required fields)
- [ ] All email HTML renders correctly in Gmail, Outlook, and Apple Mail (manual testing by Gideon)

**Client Acceptance (4 criteria):**
- [ ] Client (David/Zack) receives daily email for 3 consecutive days in production mode
- [ ] Client confirms email format is readable, professional, and useful (verbal/written confirmation)
- [ ] Client can access and view Airtable base (login works, data is visible)
- [ ] Client confirms signal quality meets expectations (not too noisy, not too sparse, signals are relevant)

**Technical Requirements (8 criteria):**
- [x] All 8 workflows have both .md and .js files in correct directories (`instructions/` and `execution/`)
- [ ] All 8 workflows tested independently and pass (unit test evidence documented)
- [ ] Complete end-to-end pipeline tested locally before Railway deployment
- [ ] Railway deployment stable for 72+ hours (3 days with no crashes)
- [ ] All 34 environment variables correctly set in Railway dashboard
- [ ] No API keys or secrets committed to Git (verified with `git log` search)
- [ ] `.env` file is in `.gitignore` (verified)
- [ ] `.env.example` created with all 34 variable names (values removed)

**Documentation (5 criteria):**
- [ ] README.md created with setup instructions (minimum 500 words)
- [ ] All 8 workflow .md files complete with exact specifications (each minimum 200 words)
- [ ] Handoff package prepared (zip file with all code, no `.env`, includes `.env.example`)
- [ ] Railway project ownership transfer instructions documented (step-by-step guide)
- [ ] Airtable base transfer instructions documented (step-by-step guide)

**Handoff (4 criteria):**
- [ ] Zip file delivered to client via email or file sharing service
- [ ] Railway project transferred to client's Railway account (ownership changed)
- [ ] Airtable base transferred to client's Airtable account (ownership changed)
- [ ] 48-hour support period begins (support window: May 22-24, 2026)

**Payment (1 criterion):**
- [ ] Final payment ($750 USD) invoiced and received (50% upfront already paid, 50% on completion)

**Total Criteria:** 38 items

---

### Success Metrics

**Daily Metrics (target values for each day):**
- Signal count: 3-5 per day (min: 3, max: 5, ideal: 4)
- High priority signals: 1-2 per day (at least 1)
- API success rate: 100% (all 3 APIs return data successfully)
- Email delivery rate: 100% (email sends without SMTP errors)
- System uptime: 100% (no crashes during execution)
- Execution time: < 15 minutes per run (ideally 5-10 minutes)
- Claude API success rate: > 90% (at least 9/10 signals enriched successfully)
- Airtable insertion success rate: 100% (all deduplicated signals saved)

**Weekly Metrics (target values for full week):**
- Total signals delivered: 21-35 per week (7 days × 3-5 signals)
- High priority signals: 7-14 per week (1-2 per day × 7 days)
- Duplicate rate: 0% (zero duplicates caught by deduplication filter)
- Client engagement: Client checks Airtable at least once (evidence: Airtable activity log)
- Error count: 0 errors in logs (clean execution all 7 days)
- Email open rate: > 80% (if email tracking enabled, otherwise N/A)
- System reliability: 7/7 days successful (100% uptime)

**Project Metrics (final assessment on Day 10):**
- On-time delivery: Handoff completed by May 22, 2026 (Day 10)
- Budget adherence: Total cost ≤ $1,500 USD (no overages)
- Client satisfaction: Positive feedback from David/Zack (verbal or written)
- System reliability: 3+ consecutive days without issues (Days 8-10 minimum)
- Code quality: Zero critical bugs reported during 48-hour support period
- Documentation completeness: All 5 documentation criteria met (see above)
- Handoff smoothness: Client can run system independently after handoff

---

### Specific "Done" Example

**Scenario:** System goes live on Day 9 (May 21, 2026)

**What happens:**

1. **5:00 AM EST on Day 9:** Railway cron triggers `execution/main.js`
2. **Workflow 1 (fetch_signals):** System calls Apollo, MediaStack, PredictLeads APIs. Returns 87 raw signals. Saves to `.tmp/combined_raw_20260521.json`. Execution time: 3m 42s.
3. **Workflow 2 (filter_signals):** Applies company size filter (87 → 52 signals). Applies geography filter (52 → 38 signals). Applies job title filter (38 → 31 signals). Enriches with Claude API (31 signals → 28 successful, 3 failed with defaults). Saves to `.tmp/filtered_signals_20260521.json`. Execution time: 4m 18s.
4. **Workflow 3 (deduplicate):** Queries Airtable for records from the last 90 days (IS_AFTER with 91 days for inclusive boundary). Finds existing companies. Normalizes all names. Checks new signals against 90-day history. Removes duplicates. Saves to `.tmp/final_signals_20260521.json`. Execution time: 1m 07s.
5. **Workflow 4 (save_to_airtable):** Apollo company enrichment (cache hit for 2, API call for 3). 7-step email cascade (Apollo first, then Hunter/Puppeteer) finds emails for 4/5 signals. Formats 5 signals for Airtable. Inserts 1 batch of 5 records. Verifies 5 records exist with today's date. Logs success to `.tmp/airtable_log_20260521.txt`. Execution time: 2m 15s.
5b. **Workflow 4b (sync_sheets):** Fetches 5 Airtable records, appends to Google Sheet. Execution time: 0m 08s.
6. **Workflow 5 (send_email):** Groups signals (2 HIGH, 3 MEDIUM, 0 LOW). Loads email template. Populates template with 5 signals. Determines recipients (production mode: david@starfishco.com, zack.k@starfishco.com). Sends via SMTP. Logs success to `.tmp/email_log_20260521.txt`. Execution time: 0m 38s.
7. **Workflow 6 (telegram_monitoring):** Formats summary message (5 signals, 2 HIGH, 3 MEDIUM). Sends to Gideon's Telegram. Execution time: 0m 04s.
8. **Total execution time:** 10m 41s. All workflows successful. Zero errors.
9. **5:11 AM EST:** David and Zack receive email in their inboxes. Subject: "Starfish Signals - Wednesday, May 21, 2026 - 5 New Opportunities". Email displays correctly in Outlook.
10. **5:11 AM EST:** Gideon receives Telegram message confirming successful run.
11. **Day 10 (May 22, 2026) at 5:00 AM EST:** System repeats automatically. Another successful run.
12. **Day 11 (May 23, 2026) at 5:00 AM EST:** System repeats automatically. Third consecutive successful run.
13. **May 22, 2026 at 2:00 PM EST:** Gideon sends handoff package to David/Zack. Transfers Railway and Airtable ownership. 48-hour support period begins.
14. **May 24, 2026 at 2:00 PM EST:** 48-hour support period ends. Pilot is complete. Final invoice sent for $750 USD.
15. **Pilot success:** ✓ All 38 checklist items met. Client is happy. Full build ($6,500) is approved.

---

**END OF PROJECT SPECIFICATIONS**

This document defines EXACTLY what will be built for Starfish Signal Monitor Pilot.

**Last Updated:** June 15, 2026  
**Version:** 1.5.0 (Pilot -- Phase 1 Complete + Post-Pilot Bug Fixes)  
**Status:** System built, Railway deployment ready. All 8 workflows + Google Sheets sync + AudienceLab operational.

**Phase 1 complete (as of May 29, 2026):**
- All 8 workflows built and tested (1: fetch, 2: filter, 3: deduplicate, 3b: PDL verify, 4: save to Airtable, 4b: sync to Sheets, 5: send email, 6: Telegram monitoring)
- 5 signal sources operational: Apollo, PDL, MediaStack (HTTPS), PredictLeads (paginated, M&A + Rebrand), NewsAPI
- 4 signal types: Job Change, News/Press, M&A Activity, Rebrand
- 10-step filter pipeline (cheapest to most expensive): govt filter, nonprofit filter, size filter (Rebrand bypass), title filter, start date filter, geography filter, Apollo geo-verify, NewsJobCheck, M&A revenue filter, Claude enrichment
- 6-step email enrichment cascade: Apollo people/match, Puppeteer domain discovery, Hunter email-finder, Hunter domain-search, Hunter pattern+verify, Puppeteer web scraping
- Per-run Apollo enrichment cache (Map) prevents duplicate API calls
- KNOWN_DOMAINS lookup (~70 entries) for instant domain resolution
- isFakeEmail validator rejects generic/personal/third-party email patterns
- Puppeteer refactored to shared browser pool (single Chrome instance reused, closed on shutdown)
- Claude API switched from raw axios to official @anthropic-ai/sdk
- MediaStack API URLs updated to HTTPS (paid plan)
- Google Sheets OAuth2 sync layer (client-facing view, Airtable is source of truth, data from row 5)
- Telegram bot for monitoring + PDL signal approval with batchId collision prevention
- Health check endpoint at /health
- Cron: 5 AM EST daily
- 67+ signals in Airtable with Priority, Brief, Contact Approach, and Contact Info populated
- Batch 1 (rows 20-35) and Batch 2 (rows 36-52) sent to Starfish
- Cleanup scripts (clear_bad_emails) and test_chrome.mjs removed

**Post-pilot additions and bug fixes (as of June 15, 2026):**
- **AudienceLab integration** — 6th signal source. Website Visitor + Brand Strategy Intent signals via cursor-based pagination (1,000/run). Supports optional separate Airtable base (`AUDIENCELAB_AIRTABLE_BASE_ID`). Strict 3-gate timestamp validation (missing → drop, garbled → drop, older than 30 days → drop).
- **6 signal types** — added Website Visitor + Brand Strategy Intent (AudienceLab)
- **BSI strict title filter** — `isBSIAllowedTitle()` ensures only CMO/VP Marketing/Director-level marketing contacts pass T2 and T3 of the BSI waterfall. Non-target titles dropped and logged.
- **Apollo 422 fix** — 422 "domain not in database" no longer trips the circuit breaker. Previously caused cascading record explosions (3 small companies → circuit opens → all BSI T3 → 5 contacts each → thousands of records).
- **Apollo-first for News/Press** — New "Step 2b-NP" block: `apolloFindExec()` + Hunter person-finder runs before Hunter domain-search for News/Press signals. All 5 signal types now have Apollo before Hunter.
- **7-step email enrichment cascade** (was 6-step) — step 4 is now Apollo exec search + Hunter person-finder for News/Press.
- **Dedup IS_AFTER fix** — `getDateDaysAgo(91)` used instead of `getDateDaysAgo(90)` because IS_AFTER is exclusive (strictly greater than). Ensures 90-day boundary records are included.
- **Date timezone fix** — `getDateDaysAgo()` now anchors to Eastern "today" string before arithmetic. Prevents UTC/Eastern off-by-one between midnight UTC and ~5 AM UTC.
- **VP word-boundary fix** — Filter fallback now uses `/\bvp\b/` regex instead of `'vp '` (trailing space). Catches "VP" at end of string and other edge cases.
- **Start date validation fix** — Added month (01–12) and day (01–31) range check before `Date()` constructor to prevent calendar rollover from bypassing the NaN check.
- **Puppeteer dead-slot fix** — `_releaseSlot` now re-queues failed waiters to front of queue instead of silently discarding them, preventing dead browser slots.
- **Sheets append fix** — Replaced manual column-A row counting + `values.update()` with `values.append()`. Immune to blank company name rows that previously caused silent overwrites.
- **Sheets AudienceLab path** — When `AUDIENCELAB_AIRTABLE_BASE_ID` is set, Workflow 4b syncs from in-memory signals (not Airtable query) to include AudienceLab records from the separate base.

**Not in Phase 1 scope (future full build):**
- React dashboard
- HubSpot CRM integration
- DesignRush email parser

**Remaining Next Steps:**
1. Railway deployment (cron scheduling + hosting)
2. Monitor 3 consecutive automatic runs at 5 AM EST
3. Switch EMAIL_TO_PRODUCTION to client emails if not already done
4. Handoff package and payment
5. Full build consideration ($6,500) if pilot successful
