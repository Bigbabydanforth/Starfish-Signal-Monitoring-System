# Workflow 1: Fetch Signals

**Purpose:** Fetch raw intent signals from six external APIs (Apollo, PDL, MediaStack, PredictLeads, NewsAPI, AudienceLab) and combine them into a single array for downstream filtering.

**Implementation file:** `execution/workflow_1_fetch_signals.js`

**Trigger:** Automatic cron job, 5:00 AM EST daily (`0 5 * * *`, timezone: `America/New_York`)

**Input:** None (system-initiated)

**Output:**
- Return value: `allSignals` array
- Files written: `.tmp/apollo_raw_YYYYMMDD.json`, `.tmp/mediastack_raw_YYYYMMDD.json`, `.tmp/predictleads_raw_YYYYMMDD.json`, `.tmp/newsapi_raw_YYYYMMDD.json`, `.tmp/combined_raw_YYYYMMDD.json`

**Expected execution time:** 3–6 minutes

---

## Sources

| Source | Role | Reliability |
|--------|------|-------------|
| PDL (People Data Labs) | Primary job change detector | High — accurate start dates via SQL query |
| Apollo | Secondary job change detector + company enrichment | Medium — date verification via PDL is mandatory |
| MediaStack | News/press monitor | Medium — extracts company names from articles |
| PredictLeads | M&A + Rebrand event tracker | High — paginated feed (up to 450 events), ML architecture fix confirmed zero repeated IDs |
| NewsAPI | Reliable M&A + funding round source | High — legal language queries on wire service whitelist |
| AudienceLab | Website Visitor + Brand Strategy Intent signals | High — pre-filtered by AudienceLab, paginated with run-to-run cursor |

---

## Process

### Step 1.1 — Initialize Daily Run

Create `.tmp/` directory if it does not exist. Generate today's date stamp in `YYYYMMDD` format for filenames, and `YYYY-MM-DD` for signal objects.

---

### Step 1.2 — Fetch Apollo Signals

**Endpoint:** `POST https://api.apollo.io/v1/mixed_people/api_search`
**Auth:** `X-Api-Key: APOLLO_API_KEY` header

Search for people holding these job titles at US companies with 500+ employees who recently changed jobs:

```
person_titles: [
  'CMO', 'Chief Marketing Officer', 'Chief Brand Officer',
  'CEO', 'Chief Executive Officer',
  'COO', 'Chief Operating Officer',
  'President',
  'VP Marketing', 'Vice President Marketing', 'Vice President of Marketing',
  'VP Brand', 'Vice President Brand',
  'SVP Brand', 'SVP Marketing', 'Senior Vice President Brand',
  'Senior Vice President of Brand', 'Senior Vice President Marketing',
  'Head of Marketing', 'Head of Brand',
  'Director of Marketing', 'Marketing Director'
]
organization_locations: ['United States']
organization_num_employees_ranges: ['501-1000', '1000-5000', '5000-10000', '10000+']
changed_job_recently: true
per_page: 100, page: 1
```

**Pre-dedup against Airtable (before enrichment):**
Before processing any person, load all `Source URL` values from Airtable Job Change records into a Set. For each person in the Apollo response, check their LinkedIn URL against this Set. If already present, skip immediately — no enrichment call, no PDL credit spent.

**For each person not already in Airtable:**
1. Call `GET https://api.apollo.io/v1/people/{id}` to get full employment history and job start date
2. **Apollo date pre-filter:** If Apollo has a start date and it is older than 1 year, skip this person — no PDL call needed. This prevents spending PDL credits on clearly stale records.
3. Call PDL Person Enrich (`GET https://api.peopledatalabs.com/v5/person/enrich`) with the person's LinkedIn URL — **PDL date always overrides Apollo date when available**
4. Normalize LinkedIn URL before calling PDL: strip `http://` and `www.` prefixes (PDL expects `linkedin.com/in/username` format)
5. Find current job in PDL response: use `is_primary === true`, fall back to `end_date === null`
6. Normalize partial dates: `YYYY` → `YYYY-01-01`, `YYYY-MM` → `YYYY-MM-01`
7. Use PDL date if available; fall back to Apollo date. Include person if no date at all (flagged only).
8. Wait 200ms between enrichment calls to stay within rate limits

**Known behaviour:** Apollo's `changed_job_recently` flag is Apollo's own internal signal for recent changes. Despite this flag, date stamps stored in Apollo profiles can be stale or inaccurate — PDL date verification is the authoritative check. The 1-year pre-filter catches clearly old records before spending PDL credits; PDL verification confirms recency on survivors.

Save raw Apollo search response to `.tmp/apollo_raw_YYYYMMDD.json`.

Log: `[Apollo] Fetched N signals (X already in Airtable, Y too old, Z no date)`

**On failure:** Log to `.tmp/error_log_YYYYMMDD.txt`, set `apolloSignals = []`, continue.

---

### Step 1.3 — Fetch PDL Signals

**Endpoint:** `GET https://api.peopledatalabs.com/v5/person/search`
**Auth:** `X-Api-Key: PDL_API_KEY` header

PDL is the primary and most reliable source for job change signals. It filters by marketing role (plus senior exec titles), seniority level, company size, inferred revenue, and job change date directly in the SQL query.

**SQL query:**
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

PDL level definitions:
- `cxo` — CMO, Chief Brand Officer, Chief Growth Officer, CEO, COO, President
- `vp` — VP Marketing, SVP Brand, and all VP-level variants
- `director` — Director of Marketing, Head of Marketing, Marketing Director

**Pre-dedup against Airtable (before enrichment):**
Before processing any person, load all `Source URL` values from Airtable Job Change records into a Set. For each person returned by PDL, check their LinkedIn URL against this Set. If already present, skip immediately — no Apollo enrichment credits needed.

**For each person not already in Airtable:**
1. Call Apollo Organization Enrichment (`POST https://api.apollo.io/v1/organizations/enrich`) using the company website or name to get revenue, HQ, industry, employee count, funding data
2. Wait 300ms between Apollo enrichment calls to stay within rate limits

PDL provides `job_last_changed` as an accurate `YYYY-MM-DD` date. This is used directly as `job_started_at` on the signal object — no additional date verification needed.

Log: `[PDL Source] Produced N signals (X already in Airtable — skipped)`

**On failure:** Log error, set `pdlSignals = []`, continue.

---

### Step 1.4 — Fetch MediaStack Signals

**Endpoint:** `GET https://api.mediastack.com/v1/news`
**Auth:** `access_key` query parameter

MediaStack applies AND logic when multiple keywords are comma-separated (returns 0 results). Each keyword is queried in a separate API call.

**Keywords queried (one call each, ~30 total):**

*Rebranding / brand activity:*
- `rebrand`, `brand refresh`, `brand launch`, `brand identity`, `brand repositioning`

*Funding signals:*
- `funding round`, `Series A`, `Series B`, `Series C`

*M&A signals:*
- `merger`, `acquisition`, `M&A`

*Job change press release signals (covers all positions Apollo and PDL target):*
- `new Chief Brand Officer`, `new Head of Marketing`, `appointed CMO`, `new Chief Marketing Officer`, `named CMO`
- `appointed Chief Marketing Officer`, `named Chief Marketing Officer`, `new VP of Marketing`, `new Head of Brand`, `joins as Chief Marketing Officer`
- `new Chief Executive Officer`, `new Chief Operating Officer`, `appointed Chief Executive Officer`, `appointed Chief Operating Officer`
- `new VP of Brand`, `appointed VP Brand`
- `new SVP Marketing`, `new SVP Brand`, `appointed SVP Marketing`, `appointed SVP Brand`
- `new Director of Marketing`, `new Marketing Director`, `appointed Marketing Director`

**Blocked domains:** Sports, military, local news, international, press release spam, tech hardware, and financial commentary sites are filtered out via `MEDIASTACK_BLOCKED_DOMAINS` set.

**Per-call params:** `countries=us`, `limit=5`, `sort=published_desc`

After fetching all articles, deduplicate by URL. Drop articles older than 90 days. For each unique article, run through `extractCompanyName()` (see `utils/text_parsing.js`). Discard articles where no company name can be extracted. Build signal objects with `type: "News/Press"`, `source: "MediaStack"`.

**Note:** MediaStack uses HTTPS (paid plan).

**Signal strengthening:** If a company appears in both a PDL Job Change signal and a MediaStack News/Press signal, the company appears twice in the combined output. This is intentional — two signals for the same company increases its urgency.

Save combined raw articles to `.tmp/mediastack_raw_YYYYMMDD.json`.

**On failure:** Log error, set `mediaStackSignals = []`, continue.

---

### Step 1.5 — Fetch PredictLeads Signals

**Endpoint:** `GET https://predictleads.com/api/v3/discover/news_events`
**Auth:** `X-Api-Key` + `X-Api-Token` headers

PredictLeads tracks M&A, financing, and rebrand events on company pages. It returns up to `PL_PAGE_SIZE` (30) events per page. The system now fetches up to `PL_MAX_PAGES` (3) pages per category, for a maximum of 450 events across all categories.

**Categories queried (5 total):**
```javascript
const MA_CATEGORIES = ['acquires', 'merges_with', 'sells_assets_to', 'receives_financing'];
const REBRAND_CATEGORIES = ['rebrands_to'];
```

**Pagination:** For each category, the system fetches pages 1 through `PL_MAX_PAGES` (3). If a page returns fewer than `PL_PAGE_SIZE` events, no more pages remain and the loop breaks. A 1-second delay is applied between pages to avoid rate limiting.

**ML Architecture Fix (confirmed June 2026):** PredictLeads confirmed their ML architecture update now returns fully fresh events each day. Zero repeated event IDs were verified across 5 consecutive days of production runs. Cross-category dedup by event ID is still applied as a safety net (the same event can appear under multiple category queries).

**For each page/category query:**
1. Send GET request with `category=<category>`, `page=<N>`, `per_page=30` params
2. Deduplicate events by `id` across all queries (same event may appear in multiple category queries)
3. Post-filter client-side: M&A events (`MA_CATEGORIES`) are typed as `"M&A Activity"`, rebrand events (`REBRAND_CATEGORIES`) are typed as `"Rebrand"`
4. Apply 90-day cutoff client-side on `found_at` field

**Signal types produced:**
- **M&A Activity** — acquires, merges_with, sells_assets_to, receives_financing. Includes `deal` object with `type`, `seller`, `amount`.
- **Rebrand** — rebrands_to. Includes `rebrand` object with `new_name`, `summary`, `found_at`, `confidence`. Rebrand signals are always marked HIGH priority.

**Response structure (JSON:API format):**
- Events are in `data[]`
- Company relationship is under `relationships.company1` (not `company`)
- Target/seller company is under `relationships.company2`
- Company attributes: `company_name` (not `name`), `domain`, `country`
- Source URL: from `included[]` array, type `news_article`, linked via `relationships.most_relevant_source`
- Amount field: `attributes.amount || attributes.amount_normalized || null`
- HQ string: `attributes.headquarters || attributes.hq_location`, parsed via `parseHeadquarters()`

**Retry logic:** 2 attempts per request, 5-second wait between attempts on network timeout. Rate limit (429) skips the page.

Save raw events to `.tmp/predictleads_raw_YYYYMMDD.json`.

Log: `[PredictLeads] N unique events fetched — X are M&A, Y are Rebrands`

**On failure:** Log to `.tmp/error_log_YYYYMMDD.txt`, set `predictLeadsSignals = []`, continue.

---

### Step 1.6 — Fetch NewsAPI Signals

**Endpoint:** `GET https://newsapi.org/v2/everything`
**Auth:** `apiKey` query parameter

NewsAPI is the reliable M&A, funding round, and job change press release source. It searches full article text across thousands of news sources. Dates on news articles are accurate — no date verification step needed (unlike job changes).

**Six queries run sequentially:**

#### Query 1: M&A Deals
```javascript
{
  label: 'M&A',
  q: '("definitive agreement to acquire" OR "to be acquired by" OR "completes acquisition of" OR "agreed to acquire" OR "merger agreement with") -"net income" -"per diluted share" -"financial results" -"first quarter" -"form 10-Q" -"market size" -"market dynamics" -"market research" -"shareholder news"',
  sortBy: 'relevancy',
  domains: 'prnewswire.com,businesswire.com,globenewswire.com,reuters.com,bloomberg.com'
}
```
Uses legal boilerplate language that only appears in actual M&A press releases. Negative keywords eliminate earnings reports that mention acquisitions. Domain whitelist restricts to wire services.

#### Query 2: Series B/C/D Funding
```javascript
{
  label: 'Series B/C/D',
  q: '"Series B" raises million OR "Series C" raises million OR "Series D" raises million',
  sortBy: 'publishedAt'
}
```

#### Query 3: Series A Funding
```javascript
{
  label: 'Series A',
  q: '"Series A" raises million',
  sortBy: 'publishedAt'
}
```

#### Query 4: Job Change — C-Suite Press Releases
```javascript
{
  label: 'Job Change - C-Suite',
  q: '("appointed" OR "named" OR "joins as" OR "hired as") AND ("Chief Marketing Officer" OR "CMO" OR "Chief Brand Officer" OR "CBO" OR "Chief Executive Officer" OR "CEO" OR "Chief Operating Officer" OR "COO" OR "President")',
  sortBy: 'publishedAt',
  domains: 'prnewswire.com,businesswire.com,globenewswire.com'
}
```

#### Query 5: Job Change — VP/SVP Press Releases
```javascript
{
  label: 'Job Change - VP/SVP',
  q: '("appointed" OR "named" OR "joins as" OR "hired as") AND ("VP Marketing" OR "VP of Marketing" OR "VP Brand" OR "VP of Brand" OR "Vice President Marketing" OR "Vice President of Marketing" OR "Vice President Brand" OR "Vice President of Brand" OR "SVP Marketing" OR "SVP Brand" OR "Senior Vice President Marketing" OR "Senior Vice President Brand" OR "Senior Vice President of Marketing" OR "Senior Vice President of Brand")',
  sortBy: 'publishedAt',
  domains: 'prnewswire.com,businesswire.com,globenewswire.com'
}
```

#### Query 6: Job Change — Director/Head Press Releases
```javascript
{
  label: 'Job Change - Director/Head',
  q: '("appointed" OR "named" OR "joins as" OR "hired as") AND ("Head of Marketing" OR "Head of Brand" OR "Director of Marketing" OR "Marketing Director")',
  sortBy: 'publishedAt',
  domains: 'prnewswire.com,businesswire.com,globenewswire.com'
}
```

Job change queries 4–6 are restricted to press release wires (PRNewswire, BusinessWire, GlobeNewswire). Press releases are company-issued, US-centric, and contain structured name + title data — signal quality is high.

**Per-query params:** `language: 'en'`, `from: thirtyDaysAgo`, `pageSize: 10`

**Free plan limit:** 30 days max history, 100 requests/day.
**Paid plan:** Full 90-day history + commercial use.

**Post-processing per article:**
1. Block domains from `NEWSAPI_BLOCKED_DOMAINS` set (crypto, sports, entertainment, non-US, syndication clones)
2. Deduplicate syndicated stories by BOTH URL and normalized title (chars 20–55). Each article adds both values to the `seenTitles` Set — this catches the same press release published under different URLs across Yahoo Finance, MarketWatch, PRNewswire, etc.
3. Domain extraction handles ccTLDs (.co.uk, .com.au): detect 2-char last part + short second-level part, take 3 parts; otherwise take 2

**Blocked domains include:** beincrypto.com, cryptobriefing.com, coindesk.com, cointelegraph.com, nypost.com, breitbart.com, sportskeeda.com, espn.com, economictimes.indiatimes.com, punchng.com, abc.net.au, nzherald.co.nz, dailymail.com, prnewswire.co.uk, nytimesnewstoday.com, spacedaily.com, foxnews.com, techechelon.com, thenextweb.com, and others.

Build signal objects with `type: "News/Press"`, `source: "NewsAPI"`.

Wait 500ms between queries (rate limit buffer).

Save raw articles to `.tmp/newsapi_raw_YYYYMMDD.json`.

**On failure:** Log to `.tmp/error_log_YYYYMMDD.txt`, set `newsApiSignals = []`, continue.

---

### Step 1.7 — Fetch AudienceLab Signals

**Endpoint:** `GET https://api.audiencelab.io/segments/{segmentId}?page={n}&page_size=100`
**Auth:** `X-Api-Key: AUDIENCELAB_API_KEY` header

AudienceLab provides two signal types from two separate segment IDs:
- **Pixel segment** (`AUDIENCELAB_SEGMENT_PIXEL`) — companies that visited the Starfish website (type: `"Website Visitor"`)
- **Leads segment** (`AUDIENCELAB_SEGMENT_LEADS`) — companies actively researching brand strategy online (type: `"Brand Strategy Intent"`)

**Pagination cursor:** A bookmark file (`.tmp/audiencelab_cursor.json`) records which page each segment left off at. Each run picks up from that page rather than restarting from page 1. When a segment is fully exhausted, the cursor resets to page 1 for the next cycle. This allows processing large backlogs (14,000+ records) at 1,000 per run without losing progress.

**Per-run caps:**
- Pixel: `AUDIENCELAB_MAX_PIXEL_PER_RUN` (default 300)
- Leads: `AUDIENCELAB_MAX_LEADS_PER_RUN` (default 1000)

**Pre-dedup against Airtable:** Loads all AudienceLab company names seen in the last 90 days before processing. Companies already in Airtable are skipped — no enrichment credits spent.

**Within-run dedup:** Pixel takes priority over Leads. If a company appears in both segments in the same run, the Pixel record is kept.

**Website Visitor — 30-day recency filter:** Only visits within the last 30 days are included. Older visits are stale intent and are skipped.

**Fields available:** Company name, domain, industry, employee count, city. Person: first name, last name, job title, LinkedIn URL, verified business email. Leads additionally include department and phone number.

**Note:** AudienceLab does not provide numeric revenue — `revenue: null` for all AudienceLab signals. Apollo enrichment in Workflow 4 fills this in.

Save raw signals to `.tmp/audiencelab_raw_YYYYMMDD.json`.

Log: `[AudienceLab] Total new: N (X Pixel Website Visitors, Y Brand Strategy Intent Leads)`

**On failure:** Log error, set `audienceLabSignals = []`, continue.

---

### Step 1.8 — Combine All Signals

Merge all source arrays into `allSignals`:
```javascript
[...apolloSignals, ...pdlSignals, ...mediaStackSignals, ...predictLeadsSignals, ...newsApiSignals, ...audienceLabSignals]
```

Save to `.tmp/combined_raw_YYYYMMDD.json`. Log total count and per-source breakdown:
```
[Combined] Total: X (Apollo: N, PDL: N, MediaStack: N, PredictLeads: N, NewsAPI: N, AudienceLab: N)
```

If `allSignals.length === 0`, send a Telegram error alert and end the run.

---

## Signal Object Schema

All signals share this base structure:

```javascript
{
  type: "Job Change" | "News/Press" | "M&A Activity" | "Rebrand" | "Website Visitor" | "Brand Strategy Intent",
  source: "Apollo" | "PDL" | "MediaStack" | "PredictLeads" | "NewsAPI" | "AudienceLab",
  source_url: string | null,
  company: {
    name: string,
    revenue: number | null,
    funding_total: number | null,
    funding_stage: string | null,
    headquarters: { city: string|null, state: string|null, country: string|null },
    industry: string | null,
    website: string | null,
    employee_count: number | null,
    founded_year: number | null,
    stock_ticker: string | null
  },
  detected_date: "YYYY-MM-DD",
  raw_data: { /* full original API response object for debugging */ }
}
```

Job Change signals also include a `person` object:
```javascript
person: {
  first_name: string | null,
  last_name: string | null,
  title: string | null,
  linkedin_url: string | null,
  job_started_at: "YYYY-MM-DD" | null   // PDL date preferred; Apollo date as fallback
}
```

News/Press signals (MediaStack, NewsAPI) also include an `article` object:
```javascript
article: {
  title: string,
  description: string | null,
  source: string | null,
  category: string | null,      // e.g. "M&A", "Funding", "acquires"
  published_at: string | null
}
```

M&A Activity signals (PredictLeads) include a `deal` object:
```javascript
deal: {
  type: string,      // "acquires" | "merges_with" | "sells_assets_to" | "receives_financing"
  seller: string | null,
  amount: number | null
}
```

Rebrand signals (PredictLeads) include a `rebrand` object:
```javascript
rebrand: {
  new_name: string | null,
  summary: string | null,
  found_at: string | null,
  confidence: number | null
}
```

---

## Error Handling

| Scenario | Action |
|----------|--------|
| One API fails | Log to error file, set signals to `[]`, continue |
| Two APIs fail | Log both, continue with remaining sources |
| All APIs fail | Send Telegram alert, end run gracefully with empty array |
| PDL enrich returns 404 | Person not in PDL database — use Apollo date as fallback |
| PDL enrich returns 402 | Credits exhausted — log warning, use Apollo date as fallback |
| Apollo enrichment fails for a company | Return `{}` silently, signal proceeds with no revenue data |
| PredictLeads returns 0 M&A events | Expected — rotating feed may not include M&A that day. Log and continue. |
| NewsAPI returns 426 | Free plan date range exceeded — `from` is already set to 30 days; check clock/timezone |
| NewsAPI rate limit (429) | Wait 60s, retry once, then set `newsApiSignals = []` |
