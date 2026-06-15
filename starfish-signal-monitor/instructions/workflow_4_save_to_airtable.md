# Workflow 4: Save to Airtable

**Purpose:** Format deduplicated signals and batch-insert them into the Airtable Signals table. Verify insertion success and log results.

**Implementation file:** `execution/workflow_4_save_to_airtable.js`

**Trigger:** Immediately after Workflow 3 completes

**Input:** `deduplicatedSignals` array from Workflow 3 (expected: 3–15 signals)

**Output:**
- Return value: `totalInserted` count (number)
- File: `.tmp/airtable_log_YYYYMMDD.txt`
- On partial failure: `.tmp/airtable_failures_YYYYMMDD.json`

**Expected execution time:** 1–3 minutes

---

## Process

### Step 4.0 — Apollo Company Enrichment (pre-step)

Before formatting, run Apollo company enrichment on signals missing revenue or website data. This fills in revenue, industry, HQ, and website so that Hunter has a domain to work with during email discovery.

**KNOWN_DOMAINS shortcut:** Before calling Apollo, check `utils/known_domains.js` for a hardcoded domain mapping. If found, set `signal.company.website` immediately with no API call. The `KNOWN_DOMAINS` map contains ~70 frequently-seen companies (e.g. `USAA` -> `usaa.com`, `Salesforce` -> `salesforce.com`).

**Apollo enrichment cache:** A per-run `Map()` prevents duplicate Apollo API calls for the same company. The cache key is the company domain (if available) or company name. If the company was already enriched earlier in the same pipeline run, the cached result is reused.

Function: `getKnownDomain()` from `utils/known_domains.js`

### Step 4.1 — Email Enrichment Cascade

**Circuit breakers:** All Apollo and Hunter API calls are protected by a per-run circuit breaker (`utils/circuit_breaker.js`). After 3 consecutive failures, the breaker OPENS and skips all further calls to that API for the rest of the run. It resets after 5 minutes (HALF_OPEN).

**Errors that do NOT trip the circuit breaker:** 401 (bad key — not an outage), 429 (rate limit — not an outage), and **422 Unprocessable Entity** (person/domain not in Apollo's database — a normal "not found" response, not a service failure).

> **Bug fix (2026-06-15):** Apollo was previously tripping the circuit breaker on 422 responses from small/niche companies not in its database. Three 422s in a row would open the circuit, causing ALL remaining BSI signals to skip Apollo's T2 search and fall directly to T3 Hunter domain-search — which returns 5 contacts per company, generating thousands of Airtable records in a single run. Fixed by adding a dedicated 422 exclusion in both `findEmailWithApollo` and `apolloFindExec` catch blocks.

**BSI 4-Tier Waterfall:** Brand Strategy Intent signals use a separate contact-finding process:
- **Tier 1 (AL perfect contact):** If AudienceLab provided a person with a matching title AND email → use immediately, no further search.
- **Tier 2 (Find ONE marketing person):** Search Hunter domain search for one marketing/brand decision-maker. Try Apollo BSI search if Hunter finds nothing. Contacts must have email OR LinkedIn to proceed (unreachable contacts are dropped). **The found contact must pass the BSI strict title filter** (see below) — if their title is not a Starfish target role, they are dropped and the waterfall falls through to Tier 3.
- **Tier 3 (Broadcast to 5 senior leaders):** If no single contact found, build a list of up to 5 senior executives (CEO, COO, President, CMO, VP Marketing) for broadcast outreach. Each gets their own Airtable record with `send_day: 1–5` for staggered sending. Unreachable contacts (no email, no LinkedIn) are dropped. **Before saving, every contact in the broadcast list is run through the BSI strict title filter** — contacts with irrelevant titles are dropped (logged as `[BSI/TitleFilter] ⛔ Dropping irrelevant title`).
- **Tier 4 (Contact Needed):** If all tiers fail (including if Tier 3's title filter drops all contacts), signal is flagged `bsi_contact_needed: true` and routed to the "Research Needed" section of the email for Carly to handle manually.

**BSI Strict Title Filter (`isBSIAllowedTitle`):**
Only contacts with titles matching Starfish's target roles are allowed through. The allowed list covers:
- **CXO:** CMO, Chief Marketing Officer, Chief Brand Officer, Chief Communications Officer, CEO, Chief Executive Officer, COO, Chief Operating Officer, President
- **VP:** VP Marketing, VP Brand, VP Communications, Vice President Marketing/Brand/Communications (all variants)
- **Head of:** Head of Marketing, Head of Brand, Head of Communications
- **Director:** Director of Marketing, Marketing Director, Director of Brand, Brand Director, Director of Brand Marketing, Director of Communications, Communications Director

Any contact whose title does not match one of these patterns is dropped before reaching Airtable. This ensures only decision-makers relevant to Starfish's services appear in the output.

> **Added (2026-06-15):** `isBSIAllowedTitle()` function and filter blocks added to prevent irrelevant titles (e.g. "Software Engineer", "Sales Manager", "HR Director") from appearing as BSI contacts in Airtable.

**Non-BSI email cascade:** Each non-BSI signal goes through these steps in order. Steps only run if the previous one returned no result.

**Email validation:** All discovered emails are validated through `isFakeEmail()` from `utils/email_validator.js`. This rejects:
- Fake/placeholder patterns (john.doe@, firstname.lastname@, example@, test@)
- Generic inbox prefixes (noreply, support, info, hello, contact, press, media, etc.)
- Personal/free email domains (gmail.com, yahoo.com, etc.)
- Search engine domains (duckduckgo.com, bing.com)
- URL-encoded/garbled local parts
- File extensions mistaken as TLDs (e.g. .png, .jpg)
- Short local parts (< 3 chars)
- System/department emails (2+ underscores)

**Hunter pattern guard:** `applyHunterPattern()` returns `null` if the first name strips to empty after removing non-alpha characters (e.g. non-Latin names) — prevents generating `@domain.com` with an empty local part.

**Cascade steps (non-BSI):**

**Apollo always runs before Hunter across all signal types.** If Apollo's circuit breaker is open (OPEN state), the step is skipped entirely and the cascade falls through to Hunter. A 422 response from Apollo (person/domain not in database) does NOT trip the circuit — the breaker stays CLOSED so the next company gets a fresh Apollo attempt.

1. **Apollo People/Match** (Job Change only, requires LinkedIn URL) — `POST /v1/people/match` with the person's LinkedIn URL. Domain mismatch check: rejects emails where the domain doesn't match the company's known domain.

2. **Puppeteer Domain Discovery** — If `signal.company.website` is still null, use Puppeteer to Google the company name and discover the domain. Validates each candidate domain by visiting its homepage and confirming the company name appears. Falls back to DuckDuckGo on Google CAPTCHA.

3. **Hunter Email Finder** (Job Change only) — `GET /v2/email-finder` with first name + last name + domain. Only trusts results with score >= 70.

4. **Apollo Exec Search + Hunter Person Finder** (News/Press only, runs BEFORE Hunter domain-search) — `apolloFindExec(domain)` identifies the marketing/brand exec at the company. If found, immediately calls Hunter's email-finder for that specific person (`GET /v2/email-finder` with first + last + domain, score >= 70). This is a targeted lookup vs. a broad domain sweep. Returns early if email found.

   > **Added (2026-06-15):** News/Press was the only signal type where Apollo was not being called first. Previously Apollo was only used deep in pattern construction as a last-resort name lookup. A dedicated "Step 2b-NP" block was added to give Apollo its proper first-look for News/Press contacts.

5. **Hunter Domain Search** (News/Press and M&A only) — `GET /v2/domain-search` to find the best executive email at the domain. Prioritizes marketing/brand/exec titles using `HUNTER_EXEC_TITLE_KEYWORDS`. Only runs if Apollo exec search (step 4) found nothing.

6. **Hunter Pattern + Verify** — If Hunter has no direct email but has a pattern (e.g. `{first}.{last}`), construct an email using the person's name and verify it via `GET /v2/email-verifier`. For News/Press signals, finds an exec name via Hunter results or Apollo people search. Puppeteer Google/DuckDuckGo fallback for pattern discovery if Hunter has no pattern.

7. **Puppeteer Web Scraping** — Google/DuckDuckGo search + company website contact page scrape. DuckDuckGo is the automatic fallback when Google CAPTCHAs. Emails are scored (firstname.lastname@ gets highest score). Domain mismatch check against trusted company domain.

**Contact info caching:** After enrichment, `signal._contactInfo` is set once in `formatForAirtable()` and reused by Workflow 4b and Workflow 5 — no re-computation downstream. Similarly, `signal.signalDetails` is computed once in Workflow 4 and read by all consumers.

### Step 4.2 — Format Signals for Airtable

Map each signal to an Airtable record object using `formatForAirtable(signal)`.

**14 writable fields (2 are auto-populated by Airtable):**

| Field | Type | Source |
|-------|------|--------|
| Company Name | Single line text | `signal.company.name` |
| Signal Type | Single select | `signal.type` ("Job Change" \| "News/Press" \| "M&A Activity" \| "Rebrand" \| "Website Visitor" \| "Brand Strategy Intent") |
| Signal Details | Long text | `formatSignalDetails(signal)` — max 2,000 chars |
| Contact Info | Long text | `formatContactInfo(signal)` — max 500 chars |
| Company Revenue | Number | `signal.company.revenue \|\| null` |
| Company Funding Stage | Single line text | `signal.company.funding_stage \|\| null` |
| Industry | Single line text | `signal.company.industry \|\| null` |
| Date Detected | Date (YYYY-MM-DD) | `signal.detected_date` |
| Priority | Single select | `signal.priority` |
| Brief | Long text | `signal.brief` — prefixed with `⚠️` warning if Claude or enrichment failed |
| Contact Approach | Long text | `signal.contact_approach` |
| Source URL | URL | `signal.source_url \|\| null` |
| Status | Single select | `"Needs Review"` if Claude or enrichment failed; `"New"` otherwise |
| Send Day | Number (1–5) | BSI broadcast contacts only — staggered send schedule. `null` for all other signal types. |

**`formatSignalDetails()` output by type:**
- Merged signals: preserved as-is (`"SIGNAL SEEN Nx..."` format from workflow_3)
- Job Change: `"{Name} joined {Company} as {Title}. Company: {industry}, {revenue}, {employees}. Started: {date}."`
- News/Press (MediaStack / NewsAPI): article title + description + publication source + date
- M&A Activity (PredictLeads): deal type + company name + seller + deal value + target revenue
- Rebrand (PredictLeads): `"{company} is rebranding to {new_name}. {summary}"`

**`formatContactInfo()` output by type:**
- Job Change: `First Last <email> (Title)` if email found; otherwise name + title + LinkedIn URL
- News/Press: Email found via multi-step finder (see Contact Info Finder below); written as `First Last <email> (Title)` when name is resolved, or `Email: email@domain.com (via Source)` when only an email is found

---

**Contact Info format summary:**
- Job Change (with email): `Name: First Last\nTitle: Title\nLinkedIn: url\nEmail: email`
- Job Change (Puppeteer fallback): appends `Email: email (via source)`
- News/Press/M&A (with email): `Email: email (via source)`
- News/Press/M&A (no email): `Company Website: url` or `Contact info not available`

### Step 4.3 — Batch Insert

Airtable allows maximum **10 records per create request**.

Split all records into batches of 10 using `chunkArray(records, 10)`.

For each batch:
1. Call `airtableClient.createRecords(batch)`
2. Wait 1,000ms before next batch (rate limit: 5 requests/second per base)
3. On batch failure: fall back to individual record insertion (so one bad record doesn't block 9 valid ones)
4. On individual failure: push to `failedRecords` array

After all batches: if `failedRecords.length > 0`, save to `.tmp/airtable_failures_YYYYMMDD.json` and send Telegram alert.

### Step 4.4 — Verify Insertion

Query Airtable for all records where `Date Detected` equals today's date. Compare count to expected count. Log result (warning only — do not block Workflow 5).

### Step 4.5 — Log Results

Append to `.tmp/airtable_log_YYYYMMDD.txt`:
- Total to insert, batches processed, records inserted, records failed, verification count, status (SUCCESS / PARTIAL FAILURE).

---

## Error Handling

| Scenario | Action |
|----------|--------|
| Single batch fails | Retry once after 5s, then save to failures file |
| All batches fail | Send Telegram alert to Gideon, continue to Workflow 5 |
| Verification mismatch | Log warning only, do not block email |
| Input array is empty | Skip all Airtable operations, return 0 |
| Hunter returns no useful email | Fall back to Puppeteer domain discovery |
| Puppeteer domain validation fails (wrong company) | Skip candidate, try next candidate; log rejection |
| Google CAPTCHA detected | Fall back to DuckDuckGo HTML search |
| All email discovery steps fail | Write empty Contact Info, continue |
| Apollo returns email from different domain (mismatch) | Reject email, log warning, continue without email |
