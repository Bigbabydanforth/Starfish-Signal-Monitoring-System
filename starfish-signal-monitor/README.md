# Starfish Signal Monitor

Automated daily intent signal monitoring system for Starfish Co. Monitors five external data sources for companies showing intent signals that indicate they might need branding or marketing services. Runs automatically every day at 5:00 AM EST.

---

## Overview

The system fetches data from PDL (job changes -- primary source), Apollo (job changes + company enrichment), MediaStack (news/press), PredictLeads (M&A activity -- bonus source), and NewsAPI (M&A + funding news + job change press releases). It filters for qualified companies ($50M+ revenue OR Series A+ funding, US-based), removes companies already in Airtable (full database check — no time limit), scores priority using Claude AI, saves qualified signals to Airtable, syncs to a client-facing Google Sheet, and sends a daily HTML email digest.

**Source notes:**
- **PDL** is the primary job change source -- accurate start dates via SQL filtering (90-day cutoff, size 50). Loads existing Airtable LinkedIn URLs before enrichment to skip already-saved people. Titles cover: marketing CXO/VP/Director + CEO/COO/President/Chief Brand Officer.
- **Apollo** is the secondary job change source (size 100); also used for company enrichment (revenue, HQ, industry) on PDL signals. Loads existing Airtable LinkedIn URLs before enrichment. Apollo date pre-filter (1-year cutoff) runs before PDL enrichment calls to avoid wasting PDL credits on stale records.
- **MediaStack** monitors news/press: rebrands, brand refreshes, funding, M&A, and press releases for senior marketing/executive appointments. Expanded keyword list (~30 keywords). Uses HTTPS (paid plan).
- **PredictLeads** tracks company M&A events (acquires, merges_with, sells_assets_to, receives_financing) and rebrands (rebrands_to). NOW PAGINATED: up to 3 pages per category (PL_PAGE_SIZE=30, PL_MAX_PAGES=3) = up to 450 events. PredictLeads confirmed their ML architecture update fixed repeated results -- verified zero repeated event IDs across 5 consecutive days. Cross-category dedup by event ID still applied.
- **NewsAPI** is the reliable M&A, funding, and job change press release source. Runs 6 queries: M&A (domain-whitelisted), Series B/C/D funding, Series A funding, plus job change press releases (C-suite, VP/SVP, Director/Head tiers -- all restricted to PRNewswire/BusinessWire/GlobeNewswire).

**Client:** Starfish Co. (David Kessler, Zack Kessler)
**Developer:** Gideon Awotuyi
**Timeline:** 10 business days (May 13-22, 2026)
**Budget:** $1,500 USD

---

## Architecture

Seven sequential workflows run each morning:

| # | Workflow | Input | Output |
|---|----------|-------|--------|
| 1 | Fetch Signals | -- (cron trigger) | 40-120 raw signals |
| 2 | Filter Signals | Raw signals | 10-40 filtered + Claude-enriched signals |
| 3 | Deduplicate (90-day window) | Filtered signals | 3-15 unique signals |
| 3b | Verify PDL (Telegram) | Deduplicated signals | Approved signals (PDL manually verified via Telegram, others auto-pass) |
| 4 | Save to Airtable | Verified signals | Records in Airtable + email enrichment |
| 4b | Sync to Google Sheets | Verified signals | Client-facing Google Sheet updated |
| 5 | Send Email | Verified signals | HTML digest email |
| 6 | Telegram Monitoring | All results | QA summary (Gideon only) |

---

## Signal Sources (5 APIs)

| Source | Type | API | Reliability |
|--------|------|-----|-------------|
| PDL (People Data Labs) | Job changes (primary) | `GET /v5/person/search` | High -- SQL-level date/title/revenue filtering |
| Apollo | Job changes (secondary) + company enrichment | `POST /v1/mixed_people/api_search` + `GET /v1/organizations/enrich` | Medium -- PDL date verification required |
| MediaStack | News/press monitoring | `GET /v1/news` (HTTPS) | Medium -- requires company name extraction |
| PredictLeads | M&A + Rebrand event tracking | `GET /v3/discover/news_events` | High -- paginated (up to 450 events), ML fix confirmed |
| NewsAPI | M&A + funding + job change press releases | `GET /v2/everything` | High -- legal language queries + wire service whitelist |

---

## Email Enrichment Pipeline (7-step cascade)

When saving to Airtable (Workflow 4), each signal goes through a multi-step cascade to find a contact email. **Apollo always runs before Hunter across all signal types** — if Apollo's circuit breaker is open or returns 422 (domain not in database), the step is skipped and the cascade continues.

1. **Apollo People/Match API** (Job Change only) -- match by LinkedIn URL, return email if available. Domain mismatch check rejects old-employer emails.
2. **Puppeteer Domain Discovery** -- if no company website, Google/DuckDuckGo search to find company domain with homepage validation
3. **Hunter Email Finder** (Job Change only) -- find email by first + last + domain (score >= 70 required)
4. **Apollo Exec Search + Hunter Person Finder** (News/Press only) -- `apolloFindExec()` identifies the marketing/brand exec at the company domain. If found, immediately calls Hunter's email-finder for that specific person (targeted lookup, score >= 70). Returns early if email found.
5. **Hunter Domain Search** (News/Press & M&A only) -- search domain for best executive email, prioritizing marketing/brand titles. Only runs if Apollo exec search (step 4) found nothing.
6. **Hunter Pattern + Verify** -- construct email from pattern (e.g. `{first}.{last}@domain`), verify with Hunter email verifier. Puppeteer Google/DuckDuckGo fallback for pattern discovery.
7. **Puppeteer Web Scraping** -- Google/DuckDuckGo search + company website contact page scrape for emails

Each step only runs if the previous one returned no result. All emails validated through `isFakeEmail()` (shared in `utils/email_validator.js`). Company domains checked against `KNOWN_DOMAINS` map (shared in `utils/known_domains.js`) before API calls. Puppeteer uses a shared browser pool (pool of N Chrome processes, closed at end of pipeline). Apollo 422 responses (domain not in database) do NOT trip the circuit breaker — the breaker stays CLOSED for the next company.

---

## Google Sheets Integration

- OAuth2 authentication (client ID + secret + refresh token)
- Client-facing view -- Airtable is the source of truth
- Data starts from row 5 (rows 1-4 reserved for headers/formatting)
- Synced after Airtable save (Workflow 4b)

---

## Tech Stack

| Layer | Tool |
|-------|------|
| Runtime | Node.js 18+ (ES Modules) |
| Job Change Sources | PDL (People Data Labs) API, Apollo API |
| News/Press Source | MediaStack API (HTTPS) |
| M&A + Funding Sources | PredictLeads API, NewsAPI |
| Company Enrichment | Apollo Organizations API |
| AI Enrichment | Claude API (Anthropic SDK -- `@anthropic-ai/sdk`) |
| Email Finding | Hunter API (email-finder + domain-search + verify) |
| Web Scraping | Puppeteer (shared browser pool -- domain validation + email discovery) |
| Person Enrichment | Apollo people/match API |
| Storage | Airtable |
| Client View | Google Sheets (OAuth2) |
| Email | SMTP via Gmail (nodemailer) |
| Scheduling | node-cron |
| Monitoring | Telegram Bot API |
| Hosting | Railway |

---

## File Structure

```
starfish-signal-monitor/
├── instructions/                         # Workflow specifications (source of truth)
│   ├── workflow_1_fetch_signals.md
│   ├── workflow_2_filter_signals.md
│   ├── workflow_3_deduplicate.md
│   ├── workflow_3b_verify_pdl.md
│   ├── workflow_4_save_to_airtable.md
│   ├── workflow_4b_sync_sheets.md
│   ├── workflow_5_send_email.md
│   └── workflow_6_telegram_monitoring.md
├── execution/                            # Workflow implementations
│   ├── main.js                           # Orchestrator + cron + health check server
│   ├── workflow_1_fetch_signals.js       # Fetches from all 5 sources
│   ├── workflow_2_filter_signals.js      # Filters + Claude enrichment
│   ├── workflow_3_deduplicate.js         # Deduplicates against last 30 days
│   ├── workflow_3b_verify_pdl.js         # Telegram PDL verification (manual approve/drop)
│   ├── workflow_4_save_to_airtable.js    # Batch-inserts to Airtable + email finder
│   ├── workflow_4b_sync_sheets.js        # Syncs verified signals to Google Sheets
│   ├── workflow_5_send_email.js          # Sends HTML email digest
│   ├── workflow_6_telegram_monitoring.js # QA summary to Gideon (silent)
│   ├── test_verify_pdl.js               # Standalone test: Telegram PDL verify + Airtable save
│   ├── test_apollo.js                   # Standalone test: Apollo fetch only
│   ├── enrich_airtable.js               # Manual Claude enrichment for existing records
│   ├── claude_enrich_airtable.js        # Claude enrichment utility
│   ├── backfill_names.js                # One-time Hunter+Apollo name backfill
│   ├── backfill_to_sheets.js            # One-time Sheets backfill
│   ├── add_missing_to_sheets.js         # Add missing records to Sheets
│   ├── check_contacts.js               # Audit tool: prints all Contact Info fields
│   ├── send_batch_1.js                  # Sends rows 20-35 to testing email for review
│   ├── send_batch_2.js                  # Sends rows 36-52 to testing email for review
│   ├── send_batch_2_starfish.js         # Sends rows 36-52 to Starfish (production)
│   ├── send_batch_email.js              # Generic batch email sender
│   ├── verify_first72.js               # Verify first 72 records
│   ├── test_pattern_email.js            # Test email pattern detection
│   └── utils/
│       ├── api_clients.js               # Apollo, PDL, MediaStack, PredictLeads, NewsAPI
│       ├── claude_client.js             # Claude API enrichment (Anthropic SDK)
│       ├── airtable_client.js           # Airtable read/write
│       ├── email_client.js              # SMTP send
│       ├── email_validator.js           # Email validation utilities
│       ├── telegram_client.js           # Telegram Bot API
│       ├── text_parsing.js              # Company name extraction, HQ parsing
│       ├── date_helpers.js              # Date formatting, timezone helpers
│       ├── known_domains.js             # Known company domain mappings
│       ├── sheets_client.js             # Google Sheets OAuth2 client
│       └── puppeteer_email_finder.js    # Shared browser pool + domain validation + email discovery
├── templates/
│   └── email_template.html              # Handlebars HTML email template
├── .tmp/                                # Logs and raw data (not committed)
│   └── .gitkeep
├── .env                                 # API keys -- NEVER commit
├── .env.example                         # Variable names with empty values
├── package.json
└── README.md
```

---

## Setup

### Prerequisites

- Node.js 18 or higher
- API keys for: Apollo, PDL, MediaStack, PredictLeads, NewsAPI, Claude (Anthropic), Hunter
- Airtable account with a base and table named **Signals**
- Gmail account with an app-specific password enabled
- Google OAuth2 credentials for Sheets integration
- Telegram bot token and your chat ID
- Railway account for deployment

### Local Installation

```bash
# 1. Install dependencies
npm install

# 2. Create your environment file
cp .env.example .env

# 3. Fill in all variables in .env (see .env.example for reference)
```

### Environment Variables

See `.env.example` for the complete list. Variables grouped by category:

- **Apollo API** (2 vars): `APOLLO_API_KEY`, `APOLLO_API_URL`
- **PDL API** (1 var): `PDL_API_KEY`
- **MediaStack API** (2 vars): `MEDIASTACK_API_KEY`, `MEDIASTACK_API_URL`
- **PredictLeads API** (3 vars): `PREDICTLEADS_API_KEY`, `PREDICTLEADS_API_TOKEN`, `PREDICTLEADS_API_URL`
- **NewsAPI** (2 vars): `NEWSAPI_API_KEY`, `NEWSAPI_API_URL`
- **Claude API** (3 vars): `CLAUDE_API_KEY`, `CLAUDE_API_URL`, `CLAUDE_MODEL`
- **Hunter API** (1 var): `HUNTER_API_KEY`
- **Airtable** (3 vars): `AIRTABLE_API_KEY`, `AIRTABLE_BASE_ID`, `AIRTABLE_TABLE_NAME`
- **Google Sheets** (5 vars): `GOOGLE_SHEET_ID`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `SKIP_SHEETS_SYNC` (optional, set to `true` to bypass sync)
- **Email/SMTP** (8 vars): `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`, `EMAIL_TO_TESTING`, `EMAIL_TO_PRODUCTION`
- **Telegram** (2 vars): `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
- **System** (3 vars): `NODE_ENV`, `TZ`, `CRON_SCHEDULE`

### Running Locally

```bash
# Start the application (cron fires at 5 AM EST)
npm start

# Run the pipeline immediately right now (test mode)
npm test
```

### Health Check

While the server is running:

```
GET http://localhost:3000/health
```

Expected response:
```json
{
  "status": "running",
  "uptime": 3600.5,
  "lastRun": "2026-05-18T10:05:30.000Z",
  "nextRun": "2026-05-19T10:00:00.000Z",
  "environment": "development",
  "version": "1.0.0"
}
```

---

## Airtable Schema

The system writes to a table called **Signals** with 15 fields:

| Field | Type | Notes |
|-------|------|-------|
| Company Name | Single line text | Required. Used for deduplication. |
| Signal Type | Single select | "Job Change" \| "News/Press" \| "M&A Activity" \| "Rebrand" |
| Signal Details | Long text | Auto-truncated at 2,000 chars |
| Contact Info | Long text | `First Last <email> (Title)` when name found; `Email: email@domain.com` when name not found |
| Company Revenue | Number | USD |
| Company Funding Stage | Single line text | e.g. "Series B" |
| Industry | Single line text | Primary industry |
| Date Detected | Date | YYYY-MM-DD |
| Priority | Single select | "HIGH" \| "MEDIUM" \| "LOW" |
| Brief | Long text | 2-sentence AI summary |
| Contact Approach | Long text | 1-sentence outreach suggestion |
| Source URL | URL | LinkedIn, article, or deal link |
| Status | Single select | Always "New" during pilot |
| Created At | Created time | Auto-populated by Airtable |
| Last Modified | Last modified time | Auto-populated by Airtable |

---

## Daily .tmp/ Output Files

Each pipeline run generates dated files in `.tmp/`:

| File | Contents |
|------|----------|
| `apollo_raw_YYYYMMDD.json` | Raw Apollo API search response |
| `pdl_raw_YYYYMMDD.json` | Raw PDL person search response |
| `mediastack_raw_YYYYMMDD.json` | Raw articles from all MediaStack keyword queries |
| `predictleads_raw_YYYYMMDD.json` | Raw PredictLeads event feed |
| `newsapi_raw_YYYYMMDD.json` | Raw NewsAPI articles (M&A + funding queries) |
| `combined_raw_YYYYMMDD.json` | All 5 sources merged -- input to Workflow 2 |
| `filtered_signals_YYYYMMDD.json` | After size/geo/title filters + Claude enrichment |
| `final_signals_YYYYMMDD.json` | After deduplication -- what gets saved to Airtable |
| `duplicates_removed_YYYYMMDD.json` | Audit trail of companies skipped as duplicates |
| `airtable_log_YYYYMMDD.txt` | Batch insertion summary |
| `airtable_failures_YYYYMMDD.json` | Records that failed to insert (if any) |
| `email_log_YYYYMMDD.txt` | SMTP delivery log |
| `unsent_email_YYYYMMDD.html` | Backup HTML if email failed |
| `claude_failures_YYYYMMDD.json` | Claude API failures (if any) |
| `error_log_YYYYMMDD.txt` | General pipeline errors across all sources |

---

## Deployment (Railway)

1. Test locally: `npm test` -- confirm all 7 workflows complete without errors
2. Push code to a private GitHub repository
3. Create a Railway project and link the repository
4. Add all environment variables in the Railway dashboard
5. Set `NODE_ENV=production` in Railway
6. Deploy: `railway up`
7. Verify: `curl https://your-project.railway.app/health`
8. Trigger a manual test run and confirm email receipt
9. Monitor for 3 consecutive automatic runs at 5 AM EST before switching to client emails

**Do not switch `EMAIL_TO_PRODUCTION` recipients until 3 successful test runs are confirmed.**

---

## Development Status (Phase 1)

| Component | Status | Details |
|-----------|--------|---------|
| Workflow 1: Fetch Signals | **Complete** | All 5 sources: Apollo (100/run), PDL (50/run), MediaStack (~30 keywords), PredictLeads (5 categories, paginated up to 450 events), NewsAPI (6 queries) |
| Workflow 2: Filter + Claude | **Complete** | 10-step pipeline: govt/nonprofit filters, size/title/date/geo filters, Apollo geo-verify, NewsJobCheck, M&A revenue verify, Rebrand priority boost, Claude enrichment via Anthropic SDK |
| Workflow 3: Deduplicate | **Complete** | Garbage filter + within-batch merge + Airtable 90-day rolling window (IS_AFTER uses 91 days due to exclusive comparison) |
| Workflow 3b: PDL Verify | **Complete** | PDL signals sent to Telegram for manual LinkedIn verification; batchId prevents button collision |
| Workflow 4: Save to Airtable | **Complete** | Batch-inserts + 7-step email enrichment cascade (Apollo first, then Hunter/Puppeteer); BSI strict title filter on T2/T3; Apollo 422 excluded from circuit-trip |
| Workflow 4b: Sync to Sheets | **Complete** | Google Sheets OAuth2 sync; `values.append()` (immune to column A gaps); AudienceLab separate-base path syncs from memory |
| Workflow 5: Send Email | **Complete** | HTML digest via Gmail SMTP; null-safe recipients |
| Workflow 6: Telegram Monitor | **Complete** | Silent QA alert to Gideon after each run |
| Infrastructure | **Complete** | Railway-ready, health check at /health, cron 5 AM EST daily |

### Not in Phase 1 scope (future work)

- DesignRush email parser
- React dashboard
- HubSpot CRM integration
- Automated test suite (Jest)

### Added post-pilot (live in production)

- **AudienceLab integration** — Website Visitor + Brand Strategy Intent signals via cursor-based pagination (1,000/run). Supports separate Airtable base (`AUDIENCELAB_AIRTABLE_BASE_ID`). Timestamp strict 3-gate validation. In-memory Sheets sync path for separate-base mode.
- **Apollo circuit breaker 422 fix** — 422 "not found" responses no longer trip the circuit breaker, ensuring small/niche companies never accidentally block the circuit.
- **BSI strict title filter** — `isBSIAllowedTitle()` ensures only CMO/VP Marketing/Director-level marketing contacts reach Airtable from BSI signals.
- **Apollo-first for all signal types** — News/Press now has a dedicated Apollo exec search step before Hunter domain-search.
- **Dedup IS_AFTER fix** — Uses `getDateDaysAgo(91)` so IS_AFTER's exclusive comparison correctly includes 90-day-old records.
- **Date timezone fix** — `getDateDaysAgo()` now anchors to Eastern "today" before arithmetic, preventing UTC/Eastern off-by-one between midnight and ~5 AM UTC.
- **Puppeteer dead-slot fix** — `_releaseSlot` re-queues the next waiter instead of silently discarding it when task setup fails.
- **Sheets row fix** — Replaced manual column-A counting + `values.update()` with `values.append()`, immune to blank column A gaps.

---

## Support

Questions or issues: awotuyitobiloba@gmail.com
