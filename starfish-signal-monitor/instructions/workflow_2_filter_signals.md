# Workflow 2: Filter Signals

**Purpose:** Apply a 10-step sequential filter pipeline (cheapest to most expensive) to remove unqualified signals, then enrich each passing signal with Claude AI to generate priority score, brief, and contact approach.

**Implementation file:** `execution/workflow_2_filter_signals.js`

**Trigger:** Immediately after Workflow 1 completes

**Input:** `allSignals` array from Workflow 1

**Output:**
- Return value: `enrichedSignals` array
- File: `.tmp/filtered_signals_YYYYMMDD.json`

**Expected execution time:** 2–4 minutes (depends on Claude API latency + Apollo geo-verify calls)

---

## Filter Pipeline (ordered cheapest to most expensive)

### Step 2.1 — Company Size Filter (includes Government + Nonprofit filters)

The size filter function runs three checks before evaluating revenue/funding:

**1. Government Entity Filter** (runs first within `passesCompanySizeFilter`):
Drops government/municipal entities that will never be Starfish branding clients. Matches patterns like:
- `City of X`, `County of X`, `State of X`, `Town of X`, `Village of X`
- `Department of X`, `Office of X`, `Bureau of X`
- Names containing `government`, `municipal`, `public school`, `school district`, `unified school`

**2. Non-Profit/Charity Filter** (runs second):
Drops non-profit, charitable, and religious organizations. Matches names containing:
- `missionary`, `church`, `ministry`, `ministries`, `charity`, `charitable`
- `foundation`, `philanthrop*`, `nonprofit`, `non-profit`, `501c`
- `rescue mission`, `food bank`, `humane society`

**3. Revenue/Funding Rule:** Company must have EITHER `revenue >= $50,000,000` OR a valid Series A/B/C/D/E funding stage.

**Valid funding stages** (case-insensitive, all variants):
`series a`, `series_a`, `seriesa`, `series b`, `series_b`, `seriesb`, `series c`, `series_c`, `seriesc`, `series d`, `series_d`, `seriesd`, `series e`, `series_e`, `seriese`

**4. Employee Count Filter:** Companies with fewer than 250 employees are dropped (too small for Starfish). Only enforced when employee count data is available — missing count (0/null) gets benefit of the doubt. This check runs before the source-level auto-pass exceptions below, so even Apollo/MediaStack/NewsAPI/PredictLeads signals are subject to the employee filter when count data is present.

**Rebrand bypass:** Signals with `type === 'Rebrand'` always pass the size filter — a company actively rebranding is a strong signal regardless of revenue data availability.

**Source-level exceptions:**
- **Apollo, MediaStack, NewsAPI, PredictLeads signals** with no revenue and no funding stage: auto-pass. These sources do not provide company financial data at fetch time.
- **PDL signals:** PDL SQL pre-filters to `$50M+` inferred revenue. PDL auto-passes this filter when Apollo enrichment returns no revenue data (0 or null) — PDL's own SQL filter is trusted. When Apollo returns a positive revenue value, it is used for the $50M+ check.

Function: `passesCompanySizeFilter(signal)`

---

### Step 2.2 — Job Title Filter

**Rule:** Applies only to `type === "Job Change"` signals. All other types (`News/Press`, `M&A Activity`, `Rebrand`) pass automatically.

**PDL keyword check:** PDL signals pass if the title contains `marketing`, `brand`, or a matching C-suite acronym (`cmo`, `cco`, `cbo`, `ceo`, `coo`) using word-boundary regex, or `chief executive`, `chief operating`, or `president` (excluding `vice president`). This narrows PDL's broad `marketing` job_title_role bucket.

**For Apollo signals**, `person.title` must match at least one of the following (case-insensitive substring match):

*Core titles (21 entries):*
`cmo`, `chief marketing officer`, `chief brand officer`, `cbo`, `chief executive officer`, `ceo`, `chief operating officer`, `coo`, `president`, `vp marketing`, `vp of marketing`, `vice president marketing`, `vice president of marketing`, `vp brand`, `vice president brand`, `vice president of brand`, `svp brand`, `svp marketing`, `svp of marketing`, `senior vice president brand`, `senior vice president of brand`, `senior vice president marketing`, `senior vice president of marketing`, `head of marketing`, `head of brand`, `director of marketing`, `marketing director`, `chief growth officer`, `brand marketing`

*Fallback combo rule:* If none of the above match, a title passes if it contains a seniority keyword (`vice president`, `svp`, `evp`, `chief`, `head of`, `director`) OR matches the word-boundary regex `/\bvp\b/` AND also contains the word `marketing`. This catches verbose Apollo titles like "Senior Vice President, Customer Marketing" that don't match exact substrings.

> **Bug fix (2026-06-15):** The fallback previously used the string `'vp '` (with a trailing space), which silently missed titles like `"VP Marketing"` at the end of a string. Replaced with the regex `/\bvp\b/` (word boundary) so `"VP"`, `"VP Marketing"`, and `"Senior VP"` all match correctly.

Function: `passesJobTitleFilter(signal)`

---

### Step 2.3 — Start Date Filter

**Rule:** Applies only to Job Change signals. The person must have started their role within the last 90 days. Signals with no `job_started_at` date are dropped.

**Date validation (two-gate):**
1. Must match `YYYY-MM-DD` regex AND have valid month (01–12) and day (01–31) ranges
2. Must survive a round-trip parse: `isNaN(new Date(startDateStr).getTime())` catches impossible dates like Feb 30

> **Bug fix (2026-06-15):** Added explicit month/day range check before the `Date()` constructor. Without it, some calendar systems construct a valid date object from out-of-range values by rolling over (e.g. month 13 becomes January of next year), bypassing the NaN check entirely.

Non-Job Change signals pass automatically.

---

### Step 2.4 — Geography Filter

**Rule:** `company.headquarters.country` must match one of (case-insensitive): `united states`, `usa`, `us`, `u.s.`, `u.s.a.`

**Source-level exceptions:**
- **Apollo, MediaStack, NewsAPI, PredictLeads signals** with no country data: auto-pass. These sources either pre-filter at the API level or do not return country data.

Function: `passesGeographyFilter(signal)`

---

### Step 2.5 — Apollo Geo-Verification

**Rule:** For non-Job-Change signals (News/Press, M&A, Rebrand) that have no country data, call Apollo Organization Enrichment to verify US headquarters. Job Change signals (both Apollo and PDL) are pre-confirmed US at the API level and skip this step.

Function: `verifyUSHeadquarters(signal)` — queries Apollo by company name or website domain, checks `country` and `state` against the `US_STATES` set.

**Benefit of doubt:** If Apollo returns no country/state data, the signal is kept.

---

### Step 2.6 — News Job Change Check

**Rule:** News/Press articles that are actually about executive job changes (appointments, hires) are verified via Apollo enrichment. This prevents job change articles from slipping through as News/Press signals without proper revenue and location checks.

Detection: `isJobChangeArticle(signal)` checks article title and description for keywords like `appointed`, `appoints`, `names`, `named`, `joins as`, `hired as`, `promoted to`, `new cmo`, etc.

For detected job change articles:
1. Enrich with Apollo to get company revenue and location
2. Check revenue meets $50M+ threshold (drop if below and revenue data is available)
3. Check US headquarters (drop if confirmed non-US)
4. Attach Apollo data (revenue, industry, website, HQ) to the signal

Non-job-change articles (funding, M&A, earnings) pass through untouched.

---

### Step 2.7 — M&A Revenue Verification

**Rule:** For M&A Activity signals only:
- **receives_financing:** Free pass — the funding raise itself is the signal, not revenue.
- **acquires / merges_with / sells_assets_to:** At least one company (acquirer or target) must have revenue >= $50M to qualify.

For qualifying deal types, Apollo is called for both the acquirer and the seller/target company. Enriched revenue, industry, website, and HQ data are attached to the signal. The seller's revenue is stored as `signal.deal.seller_revenue`.

---

### Step 2.8 — Rebrand Priority Boost

All Rebrand signals are set to `priority: 'HIGH'` before Claude enrichment. A company actively rebranding is always the strongest signal for Starfish.

---

### Step 2.9 — Claude API Enrichment (most expensive, runs last)

For each signal that passes all previous filters, call the Claude API via the Anthropic SDK (`@anthropic-ai/sdk`).

**Model:** Configurable via `CLAUDE_MODEL` env var (default: `claude-haiku-4-5-20251001`). BSI signals use a separate prompt template that does not include contact fields — Claude is instructed not to name or invent contacts for BSI.
**Max tokens:** 1000

**Prompt variables substituted per signal:**
- `SIGNAL_TYPE` — signal.type
- `COMPANY_NAME` — signal.company.name
- `INDUSTRY` — signal.company.industry || "Unknown"
- `REVENUE` — formatted revenue string or "Unknown"
- `EMPLOYEE_COUNT` — formatted count or "Unknown"
- `SIGNAL_DETAILS` — type-specific details string (see below)
- `CONTACT_NAME` — person's full name for Job Change signals; "Not available" for others
- `CONTACT_EMAIL` — contact email if already known; "Not available" otherwise
- `CONTACT_TITLE` — person's title for Job Change signals; "Not available" for others

Signal details by type:
- Job Change: `"{first_name} {last_name} joined {company.name} as {title}."`
- News/Press (MediaStack / NewsAPI): article title + description
- M&A Activity (PredictLeads): deal type + company name + seller + deal amount + seller revenue
- Rebrand (PredictLeads): company name + new brand name + summary

**Expected JSON response:**
```json
{
  "priority": "HIGH" | "MEDIUM" | "LOW",
  "brief": "Two sentence explanation here.",
  "contact_approach": "One sentence suggestion here."
}
```

Rate limit protection: wait 500ms between each Claude API call.

**On failure for one signal:** Assign `priority: "MEDIUM"`, generic brief, generic contact_approach. Log to `.tmp/claude_failures_YYYYMMDD.json`. Continue.

---

### Step 2.10 — Save Filtered Signals

Write enriched signals to `.tmp/filtered_signals_YYYYMMDD.json`.

---

## Error Handling

| Scenario | Action |
|----------|--------|
| Claude fails for one signal | Assign defaults, log to `claude_failures` file, continue |
| Claude fails completely | Assign defaults to ALL remaining signals, continue to Workflow 3 |
| Claude returns malformed JSON | Catch parse error, assign defaults |
| Claude rate limit (429) | Wait 60 seconds, retry once, then assign defaults |
| Apollo geo-verify fails | Benefit of doubt — keep the signal |
| Apollo M&A enrichment fails | Keep the signal (revenue data unavailable) |
| All signals fail filters | Proceed to Workflow 3 with empty array |
