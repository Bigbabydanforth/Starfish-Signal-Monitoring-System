# Agent Operating Guide

These instructions help turn human prompts into reliable, repeatable systems.

AI can guess.  
This system is designed to behave.

---

# How This Project Works

There are two important files:

- `instructions.md` → Defines how the system should behave.
- `project_specs.md` → Defines what we are building.

The agent must follow both.

**Project:** Starfish Intent Signal Monitoring System (Pilot)  
**Client:** Starfish Co. (David Kessler, Zack Kessler)  
**Budget:** $1,500 USD  
**Timeline:** 10 business days  
**Purpose:** Automated daily system that monitors 6 data sources (PDL, Apollo, MediaStack, PredictLeads, NewsAPI, AudienceLab) for companies showing "intent signals" that indicate they might need branding/marketing services. System filters for qualified companies ($50M+ revenue OR Series A+ funding, 250+ employees, US-based, excluding government entities and non-profits), removes duplicates, verifies PDL signals via Telegram, scores priority with Claude API, saves to Airtable, syncs to a client-facing Google Sheet, and sends daily email digest at 5:00 AM EST.

---

# Step 1: Define the Project First

Before writing any code, you must:

1. Create a file called `project_specs.md`
2. Clearly define:
   - What inputs the system receives (5 API data sources)
   - What workflows exist (8 workflows: fetch, filter, deduplicate, verify PDL, save to Airtable, sync to Sheets, email, telegram)
   - What tools are being used (PDL API, Apollo API, MediaStack API, PredictLeads API, NewsAPI, Claude API, Airtable, SMTP, Telegram Bot API, Railway, Node.js cron)
   - What outputs are expected (3-5 qualified signals per day via email + Airtable)
   - Where data is stored (Airtable for live signals, `.tmp/` for daily logs and raw data)
   - Where the system will be deployed (Railway with cron job running at 5:00 AM EST daily)
   - What "done" looks like (system runs automatically for 3+ consecutive days, produces 3-5 signals daily, zero duplicates, email delivers successfully, client confirms receipt)
3. Show the file
4. Wait for approval

No code should be written before this file is approved.

---

# How the Agent Is Structured

The system has three layers:

## How this works (simple)

- **Instructions** = what we want to happen (in `instructions/`)
- **Decision** = NO user decision needed - runs automatically on cron schedule
- **Actions** = the real work (JavaScript scripts in `execution/`)

The agent runs automatically. No user commands. No Telegram input during pilot phase.  
Everything is triggered by the cron schedule at 5:00 AM EST daily.

**Important:** This system has NO user interaction during pilot. It's fully automated.

---

# File Structure

```
starfish-signal-monitor/
├── instructions/                         # Workflow specifications
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
│   ├── workflow_2_filter_signals.js      # 10-step filter pipeline + Claude enrichment
│   ├── workflow_3_deduplicate.js         # Deduplicates against full Airtable database (no time limit)
│   ├── workflow_3b_verify_pdl.js         # Telegram PDL verification (manual approve/drop)
│   ├── workflow_4_save_to_airtable.js    # Batch-inserts to Airtable + email enrichment cascade
│   ├── workflow_4b_sync_sheets.js        # Syncs verified signals to Google Sheets
│   ├── workflow_5_send_email.js          # Sends HTML email digest
│   ├── workflow_6_telegram_monitoring.js # QA summary to Gideon (silent)
│   ├── send_missing_to_starfish.js        # One-time: find Airtable records not in Sheets → append rows + email Starfish (1 card/company)
│   ├── backfill_to_sheets.js             # One-time: rewrite all Sheets rows from Airtable (--dry-run, --date flags)
│   ├── get_refresh_token.js              # One-time: regenerate Google OAuth2 refresh token when invalid_grant error occurs
│   ├── enrich_airtable.js                # Enrich existing Airtable records
│   └── utils/
│       ├── api_clients.js                # Apollo, PDL, MediaStack, PredictLeads, NewsAPI
│       ├── claude_client.js              # Claude API enrichment (Anthropic SDK)
│       ├── airtable_client.js            # Airtable read/write/update/delete
│       ├── email_client.js               # SMTP send
│       ├── email_validator.js            # Shared isFakeEmail() validation
│       ├── telegram_client.js            # Telegram Bot API (messages + inline keyboard)
│       ├── text_parsing.js               # Company name extraction, HQ parsing, formatting
│       ├── date_helpers.js               # Date formatting, timezone helpers
│       ├── known_domains.js              # Shared KNOWN_DOMAINS map + getKnownDomain()
│       ├── sheets_client.js              # Google Sheets OAuth2 client (append + rewrite)
│       ├── puppeteer_email_finder.js     # Shared browser pool (N Chrome processes) + domain validation + email discovery
│       ├── circuit_breaker.js            # Per-run circuit breaker for Apollo + Hunter APIs
│       └── audiencelab_client.js         # AudienceLab API client (Website Visitor + Brand Strategy Intent, with cursor pagination)
├── templates/
│   └── email_template.html               # Handlebars HTML email template
├── .tmp/                                 # Logs and raw data (not committed)
│   └── .gitkeep
├── .env                                  # API keys — NEVER commit
├── .env.example                          # Variable names with empty values
├── .gitignore
├── package.json
└── README.md
```

**Key Points:**
- Every workflow has TWO files: `.md` in `instructions/` and `.js` in `execution/`
- Raw API responses saved to `.tmp/` for debugging
- Final signals saved to `.tmp/` for 30 days (audit trail)
- Logs saved to `.tmp/` for troubleshooting
- `.env` contains all API keys and secrets (NEVER commit to Git)
- Live signal data goes to Airtable only

---

# Development Rules

## Rule 1: Always Read First

Always read:
- `instructions.md` (this file)
- `project_specs.md` (what we're building)

Before taking action.

**For Starfish specifically:**
- Check `project_specs.md` for exact API parameters
- Check `project_specs.md` for exact filtering rules ($50M+ OR Series A+, 250+ employees, US-based HQ)
- Check `project_specs.md` for exact job titles to track (CMO, VP Marketing, SVP Brand, Head of Marketing, Director of Marketing)
- Check `project_specs.md` for exact email template structure
- Check `project_specs.md` for exact Airtable field names and types

**DO NOT guess any of these details. They are ALL specified in project_specs.md.**

---

## Rule 2: JavaScript Only

All scripts must be written in JavaScript (Node.js).

**Required packages for this project:**
- `axios` - for API calls (Apollo, PDL, MediaStack, PredictLeads, NewsAPI, Hunter, Telegram)
- `@anthropic-ai/sdk` - Anthropic SDK for Claude API enrichment
- `node-cron` - for scheduling daily 5 AM EST runs
- `airtable` - official Airtable SDK
- `nodemailer` - for SMTP email sending
- `dotenv` - for loading environment variables
- `express` - for health check endpoint
- `puppeteer` - for domain discovery + email scraping (shared browser pool)
- `googleapis` - for Google Sheets OAuth2 integration
- `handlebars` - for HTML email template rendering
- `juice` - for inlining CSS in email HTML (Gmail compatibility)

**No other languages allowed.** No Python scripts. No shell scripts beyond npm commands.

---

## Rule 3: Every Workflow Has Two Files

Each workflow must include:
- A markdown file in `instructions/` (describes what the workflow does)
- A matching JavaScript file in `execution/` (implements the workflow)

Do not run code unless both exist.

**For Starfish, there are 8 workflows:**

1. **workflow_1_fetch_signals.md + workflow_1_fetch_signals.js**
   - Fetches data from all 6 sources: Apollo, PDL, MediaStack, PredictLeads, NewsAPI, AudienceLab
   - PDL is primary job change source (accurate dates via SQL filter). Apollo is secondary (requires PDL date verification; 1-year pre-filter before PDL calls).
   - Both Apollo and PDL load existing Airtable LinkedIn URLs to skip already-saved people before enrichment.
   - PredictLeads fetches M&A + Rebrand events with pagination (up to 3 pages per category, 450 max events). ML architecture fix confirmed zero repeated IDs.
   - NewsAPI is reliable M&A + funding + job change press release source (6 queries: 3 M&A/funding + 3 job change press release queries restricted to wire services).
   - MediaStack uses HTTPS (paid plan), ~30 keyword queries for rebrand, funding, M&A, and job change press releases.
   - Saves raw responses to `.tmp/`
   - Returns combined array of raw signals

2. **workflow_2_filter_signals.md + workflow_2_filter_signals.js**
   - 10-step sequential filter pipeline, ordered cheapest to most expensive:
   - Government entity filter (drops City of X, County of X, etc.)
   - Non-profit/charity filter (drops missionary unions, charities, foundations, churches)
   - Revenue/funding size filter ($50M+ OR Series A+). Rebrand signals bypass. PDL auto-passes when Apollo returns no revenue (PDL SQL already confirmed $50M+).
   - Employee count filter (250+ minimum, benefit of doubt when missing)
   - Job title filter (Job Change only; PDL gets keyword check; CCO/Chief Communications Officer added)
   - Start date filter (Job Change only; must be within 90 days)
   - Geography filter (US-based HQ)
   - Apollo geo-verification (API call for signals with missing country data)
   - News job change check (enriches job change articles via Apollo for revenue/location)
   - M&A revenue verification (at least one party must be $50M+; receives_financing gets free pass)
   - Claude enrichment (most expensive, runs last — adds priority, brief, contact_approach)
   - Returns filtered + enriched signals

3. **workflow_3_deduplicate.md + workflow_3_deduplicate.js**
   - Filters garbage names from news feeds
   - Merges within-batch duplicates (boosts priority if seen 2+ times)
   - Loads signals from Airtable for the last 90 days (rolling window — no maxRecords cap). Uses `getDateDaysAgo(91)` because IS_AFTER is exclusive (strictly greater than), so 91 days ensures the 90-day boundary is included.
   - Fires Telegram alerts at 4,500 (warning) and 5,000 (critical) records
   - Removes duplicates based on normalized company name
   - Returns deduplicated signals

3b. **workflow_3b_verify_pdl.md + workflow_3b_verify_pdl.js**
   - Runs immediately after Workflow 3 (deduplication)
   - PDL Job Change signals are sent to Gideon's Telegram for manual LinkedIn verification
   - Non-PDL signals (News/Press, M&A, Rebrand) pass through automatically — no verification needed
   - Each signal gets inline keyboard buttons with batchId to prevent session hijacking
   - Polls for responses up to 1 hour — auto-approves on timeout
   - Returns approved PDL signals + all other signals

4. **workflow_4_save_to_airtable.md + workflow_4_save_to_airtable.js**
   - Apollo company enrichment (with per-run Map cache to prevent duplicate API calls)
   - KNOWN_DOMAINS map checked before Apollo (instant, no API call)
   - Circuit breakers on all Apollo + Hunter API calls (3 failures → OPEN, 5 min reset). 401, 429, and **422** do NOT trip the breaker — 422 means "not in database", not an outage.
   - BSI 4-tier contact waterfall: AL perfect contact → find one marketing person → broadcast 5 senior leaders → Contact Needed (Carly)
   - **BSI strict title filter (`isBSIAllowedTitle`)**: All BSI contacts (T2 and T3) must have a Starfish target title (CMO/VP Marketing/Director Marketing/etc.) — non-matching titles are dropped before Airtable.
   - BSI broadcast: up to 5 contacts, each gets its own Airtable record with Send Day 1–5
   - **7-step email enrichment cascade for non-BSI**: Apollo always first — (1) Apollo people/match [Job Change], (2) Puppeteer domain discovery, (3) Hunter email-finder [Job Change], **(4) Apollo exec search + Hunter person-finder [News/Press — new]**, (5) Hunter domain-search [News/Press & M&A], (6) Hunter pattern+verify, (7) Puppeteer web scraping
   - isFakeEmail() validation on all discovered emails (shared in utils/email_validator.js)
   - Formats signals for Airtable schema (6 signal types: Job Change, News/Press, M&A Activity, Rebrand, Website Visitor, Brand Strategy Intent)
   - Batch inserts to Airtable (max 10 per batch, individual fallback on batch failure)
   - 30s timeout on all Airtable write operations
   - Verifies insertion success
   - Returns count of records saved

4b. **workflow_4b_sync_sheets.md + workflow_4b_sync_sheets.js**
   - Runs after Workflow 4
   - Standard path: fetches today's Airtable records (Eastern Time date filter) and appends to Google Sheet
   - AudienceLab separate-base path: syncs directly from in-memory pipeline signals when `AUDIENCELAB_AIRTABLE_BASE_ID` is set (the only way to include AudienceLab records when they're in a separate base)
   - Uses `values.append()` — finds the true last data row automatically, immune to blank column A gaps (replaces old manual counting + `values.update()`)
   - OAuth2 with refresh token (no service account). If Sheets write fails with `invalid_grant`, the refresh token has expired — run `node execution/get_refresh_token.js` to generate a new one and update `GOOGLE_REFRESH_TOKEN` in `.env`.
   - Data starts at row 5 (rows 1-4 = client dashboard header)
   - 15 columns matching Airtable fields
   - Non-critical — failure never blocks email workflow
   - SKIP_SHEETS_SYNC=true env var bypasses sync

5. **workflow_5_send_email.md + workflow_5_send_email.js**
   - Generates HTML email from Handlebars template
   - Groups signals by priority (HIGH, MEDIUM, LOW) plus a "Research Needed" section for BSI signals with no contact found
   - Sends via SMTP/Gmail (port 465, SSL) to configured recipients (validates recipients list before sending)
   - CSS inlined via juice for Gmail compatibility
   - Retry once on failure with 30s delay
   - Logs email delivery status

6. **workflow_6_telegram_monitoring.md + workflow_6_telegram_monitoring.js**
   - Formats summary message for Telegram
   - Sends to Gideon's Telegram (silent monitoring)
   - Always runs, even after errors in earlier workflows
   - Client doesn't know about this
   - For QA and error alerts only

**Each workflow is independent and testable on its own.**

---

## Rule 4: Build in Small Pieces

Never build everything at once.

Instead:

1. Build one small part
2. Test it locally
3. Confirm it works
4. Then move to the next piece
5. Only connect parts after both work independently

**For Starfish, build in this exact order:**

**Phase 1: API Connections (Days 1-2)**
1. Build PDL API client (`utils/api_clients.js`) — primary job change source
2. Test PDL fetch with real API key, confirm accurate job start dates
3. Build Apollo API client — secondary job change source + company enrichment
4. Test Apollo fetch; verify PDL date override logic works
5. Build MediaStack API client
6. Test MediaStack fetch; confirm company name extraction works
7. Build PredictLeads API client using real `/discover/news_events` endpoint
8. Test PredictLeads — understand rotating 30-event feed limitation
9. Build NewsAPI client with M&A and funding queries
10. Test NewsAPI — confirm legal language queries eliminate noise
11. Save test data to `.tmp/` for each source

**DO NOT move to Phase 2 until all 5 APIs are working independently.**

**Phase 2: Filtering Logic (Days 3-4)**
1. Build company size filter function
2. Test with 20 sample companies (10 should pass, 10 should fail)
3. Confirm accuracy = 100%
4. Build geography filter function
5. Test with 20 sample companies (US vs non-US)
6. Confirm accuracy = 100%
7. Build job title filter function
8. Test with 20 sample job titles (exact matches vs variations)
9. Confirm accuracy = 100%
10. Build Claude API enrichment function
11. Test with 5 sample signals
12. Confirm JSON response format is correct
13. Integrate all filters into workflow_2

**DO NOT move to Phase 3 until filtering is 100% accurate.**

**Phase 3: Database Operations (Days 5-6)**
1. Build Airtable client (`utils/airtable_client.js`)
2. Test connection to Airtable base
3. Create 1 test record manually
4. Verify all fields populate correctly
5. Build deduplication function
6. Test with 3 duplicate companies
7. Confirm all 3 are caught
8. Build batch insert function
9. Test with 15 records (should split into 2 batches)
10. Verify all 15 appear in Airtable

**DO NOT move to Phase 4 until Airtable operations are reliable.**

**Phase 4: Email System (Day 7)**
1. Build email template (`templates/email_template.html`)
2. Test template with sample data in browser
3. Confirm formatting looks professional
4. Build SMTP email client (`utils/email_client.js`)
5. Test send to YOUR email only (not client yet)
6. Confirm email received and formatting works
7. Test with 0 signals (should still send "No new signals today")
8. Test with 10 signals (should group by priority)

**DO NOT move to Phase 5 until email works perfectly.**

**Phase 5: Telegram Monitoring (Day 7)**
1. Build Telegram client (`utils/telegram_client.js`)
2. Test send to YOUR Telegram
3. Confirm message received
4. Test with error scenario
5. Confirm error alert works

**Phase 6: Integration & Orchestration (Day 8)**
1. Build main.js orchestrator
2. Connect all 7 workflows in sequence
3. Test complete pipeline end-to-end with YOUR email
4. Confirm all workflows execute without errors
5. Verify data flow: APIs → Filter → Deduplicate → Verify PDL → Airtable → Email → Telegram
6. Check all log files for completeness

**Phase 7: Deployment (Day 8)**
1. Test locally one final time
2. Add all environment variables to Railway
3. Deploy to Railway
4. Verify health check endpoint works
5. Manually trigger one test run
6. Confirm email received
7. Check Railway logs for errors

**Phase 8: Production Testing (Days 9-10)**
1. Let cron run automatically at 5 AM EST
2. Monitor from Telegram
3. Verify email received
4. Check Airtable for new signals
5. Repeat for 3 consecutive days
6. On Day 10, switch to client email addresses
7. Confirm client receives email

**Build order is strict. Do not skip phases.**

---

## Rule 5: Deployment Checklist (Railway)

Before deploying:

1. Test locally (run `node execution/main.js` and verify all 7 workflows complete)
2. Make sure all secret keys are in `.env` locally
3. Create `.env.example` with all variable names but empty values
4. Add `.env` to `.gitignore` (NEVER commit secrets)
5. Create Railway project: `railway init`
6. Add all environment variables to Railway dashboard:
   - PDL_API_KEY
   - APOLLO_API_KEY, APOLLO_API_URL
   - MEDIASTACK_API_KEY, MEDIASTACK_API_URL
   - PREDICTLEADS_API_KEY, PREDICTLEADS_API_TOKEN, PREDICTLEADS_API_URL
   - NEWSAPI_API_KEY, NEWSAPI_API_URL
   - CLAUDE_API_KEY, CLAUDE_MODEL
   - HUNTER_API_KEY (email enrichment + domain search + pattern verify)
   - AIRTABLE_API_KEY, AIRTABLE_BASE_ID, AIRTABLE_TABLE_NAME
   - GOOGLE_SHEET_ID, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
   - SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS
   - EMAIL_FROM, EMAIL_TO_TESTING, EMAIL_TO_PRODUCTION
   - TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
   - NODE_ENV=production
   - TZ=America/New_York
   - CRON_SCHEDULE=0 5 * * *
7. Show the deployment command: `railway up`
8. Wait for approval from Gideon
9. Deploy: `railway up`
10. Check Railway logs: `railway logs`
11. Test the health check endpoint: `curl https://your-project.railway.app/health`
12. Manually trigger one test run via Railway CLI or API
13. Verify email received in inbox
14. Check Airtable for test data
15. Confirm it works end-to-end

**Deploy checklist must be completed BEFORE considering deployment done.**

**For Starfish specifically:**
- Cron schedule MUST be `0 5 * * *` (5 AM EST daily)
- Timezone MUST be `America/New_York`
- Test run MUST send to YOUR email first (EMAIL_TO_TESTING)
- Only switch to client emails (EMAIL_TO_PRODUCTION) after 3 successful test days

---

# When Something Breaks

1. Fix the issue
2. Improve the script so it doesn't fail the same way again
3. Test again
4. Update instructions if needed

Errors are feedback.  
Each fix should make the system stronger.

**For Starfish specifically:**

**If PDL API fails:**
- Check API key is valid (`PDL_API_KEY`)
- Check SQL query syntax (PDL uses SQL-style filtering)
- Check that `job_last_changed` date format is YYYY-MM-DD
- Log raw error response to `.tmp/error_log_YYYYMMDD.txt`
- Retry once after 30 seconds
- If still fails, skip PDL and continue with Apollo as fallback

**If Apollo API fails:**
- Check API key is valid
- Check rate limits (5 requests/second max)
- Check request parameters match Apollo docs (`mixed_people/api_search`, not `people/search`)
- Log raw error response to `.tmp/error_log_YYYYMMDD.txt`
- Send Telegram alert to Gideon (NOT client)
- Retry once after 30 seconds
- If still fails, skip Apollo for this run and continue with other sources

**If MediaStack API fails:**
- Check API key is valid
- Check query parameters are correct
- Check date format is YYYY-MM-DD
- Log raw error response
- Send Telegram alert to Gideon
- Retry once after 30 seconds
- If still fails, skip MediaStack and continue

**If PredictLeads API fails:**
- Check API key (`PREDICTLEADS_API_KEY`) and token (`PREDICTLEADS_API_TOKEN`) are both set
- Endpoint is `GET https://predictleads.com/api/v3/companies/discover/news_events` — NOT a deals endpoint
- Auth uses two headers: `X-Api-Key` and `X-Api-Token`
- PredictLeads returns 0 M&A events often — this is normal (rotating 30-event feed). Only alert if the API itself errors.
- Log raw error response
- Retry twice (5s wait between). If still fails, skip PredictLeads and continue.

**If NewsAPI fails:**
- Check API key is valid (`NEWSAPI_API_KEY`)
- If 426 error: date range exceeds free plan limit — ensure `from` is at most 30 days ago
- If 429 error: rate limit — wait 60s and retry once
- Free plan: 100 requests/day. Paid plan: full 90-day history + commercial use.
- Log raw error response
- If still fails, skip NewsAPI and continue

**If Claude API fails:**
- Check API key is valid
- Check model name is correct: `claude-sonnet-4-20250514`
- Check prompt format is valid JSON
- Log the failing signal to `.tmp/claude_failures_YYYYMMDD.json`
- Assign default priority "MEDIUM" and generic brief
- Continue processing other signals

**If Airtable fails:**
- Check API key is valid
- Check base ID and table name are correct
- Check field names match exactly (case-sensitive)
- Check batch size is ≤ 10 records
- Log failing records to `.tmp/airtable_failures_YYYYMMDD.json`
- **Rate limit (429):** Wait 30 seconds, retry the full batch once. If still failing, fall back to individual record insertion.
- **Bad record (422/400):** Fall back immediately to individual insertion so one bad record can't block the rest.
- If still fails, send Telegram alert to Gideon
- Continue to email step (don't let Airtable failure block email)

**If Email fails:**
- Check SMTP credentials are valid
- Check recipient email addresses are correctly formatted
- Check email size is < 10MB
- Log error to `.tmp/email_log_YYYYMMDD.txt`
- Retry once after 30 seconds
- If still fails, send Telegram alert to Gideon
- Save email HTML to `.tmp/unsent_email_YYYYMMDD.html` for manual review

**If Telegram fails:**
- Log error silently (don't break the main pipeline)
- This is monitoring only, not critical
- Try again next run

**If Google Sheets fails:**
- Catch error, log it, send Telegram alert via `sendErrorAlert()`
- Never throw — Sheets failure is non-critical and must not block email
- Return 0 rows inserted

**Startup validation (main.js):**
- `AIRTABLE_API_KEY`, `AIRTABLE_BASE_ID`, `AIRTABLE_TABLE_NAME`, `SMTP_USER`, `SMTP_PASS` are **required**. Missing any of these causes immediate `process.exit(1)` at boot with a clear error message.
- `APOLLO_API_KEY`, `PDL_API_KEY`, `PREDICTLEADS_API_KEY`, `MEDIASTACK_API_KEY`, `NEWS_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `GOOGLE_SHEET_ID` are optional — a warning is logged if missing, the relevant source is skipped.

**Puppeteer browser pool:**
- Pool of `PUPPETEER_CONCURRENCY` (default 5) independent Chrome processes per pipeline run
- Pages acquired via `_acquireSlot()` and released via `_releaseSlot()` — each worker gets its own Chrome process
- `_releaseSlot()` bug fix (2026-06-15): When a task fails during setup, the next waiter is placed back at the front of the queue (`_waitQueue.unshift(next)`) and the slot is freed without being handed to anyone — preventing dead slots where a browser is occupied but never actually running a task.
- `closeBrowser()` drains the wait queue and closes all Chrome processes. Called in a `finally` block in `main.js` — runs even if the pipeline crashes.
- Override pool size: set `PUPPETEER_CONCURRENCY=2` in `.env` if running on a memory-constrained server.

**Date helpers (`utils/date_helpers.js`):**
- All date arithmetic (e.g. `getDateDaysAgo(n)`) anchors to "today in Eastern Time" first, then subtracts days in UTC. This prevents a UTC/Eastern off-by-one between midnight UTC and ~5 AM UTC where the server's UTC day is ahead of the Eastern calendar day.
- `getYesterdayString()` delegates to `getDateDaysAgo(1)` — they always agree.
- Never use `new Date().getDate() - n` for date arithmetic in this project. Always use `getDateDaysAgo(n)` from `utils/date_helpers.js`.

**Critical rule: One workflow failure should NOT break the entire pipeline.**

If Apollo fails, system should still process MediaStack and PredictLeads.  
If Airtable fails, system should still send email.  
System should be resilient to partial failures.

---

# Response Format

When replying, always use:

- **Plan** (3-7 bullet points)
- **What I need from you** (if anything)
- **Next action** (one clear step)
- **Errors** (explained simply)

**Example for Starfish:**

**Plan:**
- Build Apollo API client in `utils/api_clients.js`
- Add function `fetchApolloSignals()` that returns job change data
- Test with real API key
- Save test response to `.tmp/apollo_raw_test.json`
- Verify response contains expected fields

**What I need from you:**
- Approval to proceed with Apollo test
- Confirmation that test data looks correct

**Next action:**
- Create `utils/api_clients.js` and implement Apollo client

**Errors:**
- None yet (or if error occurs, explain in simple terms what broke and why)

---

# Core Principle

Define clearly.  
Build in small steps.  
Test before moving on.

Reliable systems are built intentionally.

**For Starfish:**
- This system handles money ($1,500 pilot → $6,500 full build)
- This system runs in production for a real client
- This system must work reliably for 3+ days before handoff
- One bug or crash could lose the full build opportunity
- Build carefully, test thoroughly, deploy confidently

**Zero tolerance for:**
- Skipping testing steps
- Assuming API responses without verification
- Hardcoding values that should be in `.env`
- Committing secrets to Git
- Deploying without local testing first
- Moving to next phase before current phase works

**Success means:**
- System runs at 5 AM EST automatically for 3+ consecutive days
- Produces 3-5 qualified signals per day
- Zero duplicates in 10-day test window
- Email delivers successfully every day
- Client is happy and approves full build

**Build with precision. This is reputation work.**

---

---

# Part 2: React Dashboard

This section covers the Starfish Signal Dashboard — a separate React application that connects to the existing signal monitor data. The signal monitor (Part 1) is already built and running. Do NOT modify it as part of the dashboard build.

**Project:** Starfish Signal Dashboard (MVP)
**Users:** Carly, David, Zack (internal Starfish Co. team)
**Purpose:** Review AI-detected intent signals, manage outreach status, and push contacts directly to HubSpot from a branded internal tool.
**Branch:** `react-dashboard` (separate from `main` which runs the signal monitor)

---

## Dashboard Design System

You are a senior UI designer and frontend developer. Build a premium, modern, data-dense operations interface rooted in Starfish Co.'s own brand identity. This is an internal tool for a branding agency — it must look like it belongs to the same world as their client-facing site. Clean, confident, teal-driven. No emoji icons in the UI chrome (priority indicators are the only exception — 🔴 🟡 ⚪ as defined). No generic gradients. No drop shadows everywhere. Every element earns its place.

**Starfish Brand Palette (use these exact hex codes — do not substitute):**

| Role | Hex | Usage |
|------|-----|-------|
| Deep Teal (primary) | `#004b5c` | Sidebar background, page header, primary buttons, active nav items |
| Light Teal (secondary) | `#6da3ab` | Hover states, secondary badges, subtle accents, dividers |
| Charcoal (text) | `#2d2d2d` | All body text, headings, table cell content |
| Pure White | `#ffffff` | Card backgrounds, modal backgrounds, text on teal surfaces |
| Off-White (base) | `#f5f7f8` | Page background, table row alternates, empty states |

**Typography:**
- **UI font:** Inter (import from Google Fonts)
- **Data/ID font:** JetBrains Mono — used for signal IDs, revenue figures, date values
- Clear type scale: headings in `#2d2d2d`, secondary labels in `#6da3ab`, white text only on `#004b5c` surfaces

**Signal Type Badges** — muted, distinct chips per type (never all the same color):
- Job Change → teal tint (`#004b5c` at 15% opacity, `#004b5c` text)
- M&A Activity → slate blue tint
- Brand Strategy Intent (BSI) → deep teal solid (`#004b5c`)
- Website Visitor → light teal tint (`#6da3ab` at 20%)
- News/Press → charcoal tint (`#2d2d2d` at 10%)
- Rebrand → amber tint

**Priority Indicators:**
- 🔴 HIGH = `#EF4444` (red chip)
- 🟡 MEDIUM = `#F59E0B` (amber chip)
- ⚪ LOW = `#9CA3AF` (gray chip)

**Status Chips:**
- New → `#004b5c` (deep teal)
- In Progress → `#F59E0B` (amber)
- Contacted → `#16A34A` (green)
- Won → `#7C3AED` (purple)
- Not a Fit → `#6B7280` (gray)

**General rules:**
- Sidebar or top nav uses `#004b5c` as the background with white text and icons
- Page body background is `#f5f7f8`
- Cards and table rows use `#ffffff`
- Primary action buttons: `#004b5c` background, white text, `#6da3ab` on hover
- Subtle hover states on table rows (`#f5f7f8` → slightly deeper on hover)
- No flashy transitions. Smooth 150ms ease on hover only. Data is the hero.

---

## Dashboard Tech Stack

- **Language:** JavaScript (no TypeScript)
- **Framework:** React.js (Vite — NOT Next.js, NOT Create React App)
- **Backend:** Node.js + Express (REST API, same Railway deployment as the signal monitor)
- **Database:** Supabase (Postgres + Auth + RLS)
- **Auth:** Supabase Auth (email + password, session persistence via `@supabase/supabase-js`)
- **Styling:** Tailwind CSS
- **Routing:** React Router v6
- **HTTP client:** Axios
- **Deployment:** Frontend → Vercel. Backend → Railway (already deployed)
- **Key libraries:** `@supabase/supabase-js`, `react-router-dom`, `axios`, `tailwindcss`

**Important:** This is a React SPA (single-page app) built with Vite. It is NOT a Next.js app. Do NOT use server components, server actions, or anything Next.js-specific.

---

## Dashboard File Structure

```
starfish-dashboard/
├── index.html                     → Google Fonts: Inter wght@300;400;500;600;700 + JetBrains Mono
├── src/
│   ├── pages/
│   │   ├── Home.jsx               → Public landing page (/) — no sidebar
│   │   ├── Login.jsx              → Premium two-column login — no sidebar
│   │   ├── SignalsTable.jsx       → Main signals list (/signals) — inside Layout
│   │   └── SignalDetail.jsx       → Full detail view (/signals/:id) — inside Layout
│   ├── components/
│   │   ├── Layout.jsx             → Sidebar shell — wraps all authenticated pages via <Outlet />
│   │   ├── StatsBar.jsx           → Today's signal count summary (top of signals table)
│   │   ├── SignalTypeBadge.jsx    → Colored chip: Job Change / M&A / BSI / etc.
│   │   ├── PriorityBadge.jsx      → 🔴 HIGH / 🟡 MEDIUM / ⚪ LOW indicator
│   │   ├── StatusDropdown.jsx     → New → In Progress → Contacted → Won → Not a Fit (optimistic update)
│   │   ├── HubSpotButton.jsx      → Push / Pushing... / Pushed ✓ — permanently disabled after push
│   │   ├── FilterBar.jsx          → Signal type + priority multi-select filter chips
│   │   └── ProtectedRoute.jsx     → Redirects unauthenticated users to /login
│   ├── lib/
│   │   ├── supabase.js            → Supabase browser client (anon key only — Auth only)
│   │   └── api.js                 → Axios instance pointed at the Express backend
│   ├── App.jsx                    → Route definitions (/ Home, /login Login, /signals+/:id inside Layout)
│   └── main.jsx                   → Entry point
├── .env                           → VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_API_URL
├── .env.example
├── .gitignore
├── package.json
└── vite.config.js
```

**Backend (Express — `server/` subfolder):**
```
server/
├── routes/
│   ├── signals.js    → GET /api/signals, GET /api/signals/:id, PATCH /api/signals/:id/status
│   └── hubspot.js    → POST /api/signals/:id/push-to-hubspot
├── lib/
│   └── airtable.js   → Airtable SDK client: mapRecord, getAllSignals, getSignalById,
│                        updateSignalStatus, updateHubspotPushed,
│                        getBSIBroadcastContacts, parseContactInfo
└── server.js         → Express entry point, CORS (allowedOrigins array)
```

**Code organisation rules:**
- Keep API routes thin — call a service or lib function, don't put business logic in the route handler
- One component per file; co-locate page-specific components with the page if they're only used once
- Supabase service-role client ONLY on the server. Browser client ONLY in React (anon key only)
- Never use the service-role key in any frontend file
- Don't create new top-level folders without asking first

---

## Dashboard Data Flow

Think of the app like a series of requests and responses:

1. Carly visits a page or clicks a button — that's the **input**
2. A React component calls the Express API via Axios
3. The Express route queries **Airtable** (for signals) or calls HubSpot
4. The result comes back to React — that's the **output**
5. If something fails, show a clear inline error — don't silently break or console.log only

**Auth flow:**
- Supabase Auth handles login/logout (Auth only — no signal data in Supabase)
- Session is persisted automatically by `@supabase/supabase-js` (localStorage)
- Protected routes check session on mount — redirect to `/login` if no session

**Data flow:**
- Signals are stored in **Airtable** (base `appqr1HuoCv37loST`), written by the Node.js signal monitor
- Dashboard reads signals via the Express API, which uses the `airtable` SDK with `AIRTABLE_API_KEY`
- Status updates (`PATCH /api/signals/:id/status`) write the `Status` field in Airtable
- HubSpot pushes (`POST /api/signals/:id/push-to-hubspot`) write `HubSpot Pushed = true` in Airtable after a successful push
- The React dashboard NEVER writes directly to Airtable — all reads/writes go through the Express API
- `SUPABASE_SERVICE_ROLE_KEY` is NOT used by the Express server — it only needed Supabase for Auth which lives in the frontend

---

## Running the Dashboard Locally

**Frontend:**
1. Ensure `.env` has all necessary keys (see dashboard project_specs.md)
2. `npm install`
3. `npm run dev`
4. Open `http://localhost:5173`

**Backend (Express):**
1. Navigate to the `/server` folder
2. Ensure `.env` has all necessary keys
3. `node server.js` (or `npm run dev` if nodemon is configured)
4. Backend runs at `http://localhost:4000`

---

## Supabase Rules

- Always use RLS — never disable it
- Server-side Supabase client (service role) for all Express API routes
- Browser client (anon key) for Auth only in the React frontend
- The React dashboard reads signals through the Express API — NOT by calling Supabase directly from the browser
- Never expose the `service_role` key in any `.jsx` or `.js` frontend file or Vite config
- Never make any Supabase storage bucket public

**RLS policy for signals table:**
- Only the service-role key (used by the Express backend) can read/write signals
- Authenticated Supabase users (Carly, David, Zack) can NOT read signals directly — they must go through the API
- This keeps the signal data secure even if someone inspects browser network calls

---

## Dashboard Feature Rules

### Login Page (`/login`)
- Single email + password form
- Uses Supabase Auth `signInWithPassword()`
- On success: redirect to `/signals`
- On failure: show inline error message ("Invalid email or password")
- Session persists — user stays logged in across page refreshes
- No "Sign Up" link — accounts are created manually by Gideon in Supabase dashboard
- No "Forgot password" link in MVP

### Signals Table (Main View — `/signals`)
- Loads all signals from `GET /api/signals` on mount
- Columns: Company Name, Signal Type (badge), Priority (badge), Contact Name + Title, Date Detected, Status (chip), HubSpot Push (button)
- Filters: Signal Type multi-select, Priority multi-select — filter client-side (no new API call)
- Sort: Date Detected (default: newest first) and Priority (HIGH → MEDIUM → LOW) — client-side
- Click any row → navigate to `/signals/:id`
- Loading state: skeleton rows
- Empty state: "No signals found for the selected filters."
- No pagination in MVP — load all and filter client-side

### Signal Detail View (`/signals/:id`)
- Loads signal by ID from `GET /api/signals/:id`
- Shows: Company Name, Industry, Revenue (formatted), Employee Count, Signal Type, trigger details, Contact Name, Title, Email (clickable mailto), LinkedIn URL (opens new tab)
- Claude Brief section — styled as a highlighted insight block
- Contact Approach section
- BSI signals: list all broadcast contacts in a table with Send Day column
- Status dropdown — on change: calls `PATCH /api/signals/:id/status`, saves instantly, shows "Saved ✓" inline confirmation
- HubSpot push button — same as table view
- Source URL — "View Source →" link, opens new tab
- Back button → returns to signals table (preserve filter state if possible)

### Status Management
- Status options: `New` | `In Progress` | `Contacted` | `Won` | `Not a Fit`
- On change: immediate optimistic UI update + API call in background
- On API failure: revert to previous status + show inline error
- No confirmation dialog — change is instant

### HubSpot Push Button
- Label: "Push to HubSpot"
- On click: calls `POST /api/signals/:id/push-to-hubspot`
- Loading state: button shows "Pushing..." and is disabled
- On success: button changes to "Pushed to HubSpot ✓" and becomes permanently disabled (grayed out)
- `hubspot_pushed` boolean field in Supabase determines initial button state on load
- On failure: show inline error "HubSpot push failed. Try again." — button re-enables
- Never push the same signal twice (disabled state is permanent once pushed)

### Stats Bar
- Shows at the top of `/signals`
- Displays: total signals today, HIGH count, MEDIUM count, LOW count
- "Today" = signals where `date_detected` equals today's date (Eastern Time)
- Updates when filters change — always shows counts for full today's dataset, not the filtered view
- Static display only — no click interaction in MVP

---

## HubSpot Integration Rules

- Use HubSpot Private App Token (stored as `HUBSPOT_TOKEN` in server `.env`)
- Never expose this token in frontend code
- Push creates or updates a Contact in HubSpot using the signal's email as the deduplication key
- After successful push: update `hubspot_pushed = true` in Supabase via the service-role client
- If HubSpot returns 409 (contact already exists): treat as success, still mark `hubspot_pushed = true`
- If HubSpot returns any other error: return 500 to the React app, do NOT mark `hubspot_pushed = true`
- Log every push attempt to the Railway console: signal ID, company, contact email, result

---

## Dashboard Build Phases

These phases follow on from the signal monitor phases (Phases 1–8 above). Build in this exact order:

**Phase 9: Supabase Setup**
1. Create Supabase project (if not already done)
2. Create `signals` table matching the Airtable schema (15 fields + `hubspot_pushed` boolean + `status` field)
3. Enable RLS on signals table
4. Create RLS policy: service-role key can read/write, authenticated users cannot read directly
5. Create Supabase Auth users for Carly, David, Zack
6. Test: verify authenticated user CANNOT query signals table directly from browser
7. Test: verify service-role key CAN query signals table from Node.js

**DO NOT move to Phase 10 until Supabase RLS is confirmed working.**

**Phase 10: Express API**
1. Build `server/server.js` (Express entry point, port 4000)
2. Build `server/lib/supabase.js` (service-role client)
3. Build `server/routes/signals.js`:
   - `GET /api/signals` — fetch all signals, sorted by date_detected desc
   - `GET /api/signals/:id` — fetch single signal by ID
   - `PATCH /api/signals/:id/status` — update status field
4. Test each route with curl or Postman before touching React
5. Add `console.log` at start and end of every route handler

**DO NOT move to Phase 11 until all 3 API routes return correct data.**

**Phase 11: React Auth**
1. Create `starfish-dashboard/` Vite project
2. Install dependencies: `@supabase/supabase-js`, `react-router-dom`, `axios`, `tailwindcss`
3. Configure Tailwind with Starfish brand colors
4. Build `src/lib/supabase.js` (anon key browser client)
5. Build `Login.jsx` — email + password form, Supabase signInWithPassword
6. Build `ProtectedRoute.jsx` — session check, redirect to /login if no session
7. Build `App.jsx` — route definitions with ProtectedRoute wrapper
8. Test: login with valid credentials → redirects to /signals
9. Test: no session → redirects to /login
10. Test: session persists after page refresh

**DO NOT move to Phase 12 until auth works end-to-end.**

**Phase 12: Signals Table**
1. Build `src/lib/api.js` (Axios instance, baseURL = Express backend)
2. Build `SignalTypeBadge.jsx` with exact brand colors
3. Build `PriorityBadge.jsx` with 🔴 🟡 ⚪ indicators
4. Build `StatusDropdown.jsx` with 5 status options
5. Build `FilterBar.jsx` — signal type + priority multi-select
6. Build `StatsBar.jsx` — today's counts
7. Build `SignalsTable.jsx` — loads from GET /api/signals, renders all components
8. Test: table loads, badges render correctly, filters work client-side
9. Test: empty state shows correctly when filters match nothing
10. Test: loading skeleton shows while data is fetching

**DO NOT move to Phase 13 until the signals table is fully working.**

**Phase 13: Signal Detail + Status** ✅ BUILT
1. `SignalDetail.jsx` — loads from GET /api/signals/:id via Axios
2. Two-column layout: left column (main content), right sidebar (contact card + actions)
3. Left: company header (name, badges, data pills for industry/revenue/funding, detected date), signal trigger box, Claude brief (teal-tinted, "AI Analysis" label), contact approach, full contact info (raw), source URL, record metadata grid
4. Right: contact card (parsed name/title/email/linkedin from `contact_info` text), separator, StatusDropdown, HubSpotButton, BSI broadcast contacts table (BSI signals only)
5. BSI contacts: fetched via `getBSIBroadcastContacts(companyName)` — sibling Airtable records, sorted by Send Day
6. All sections always visible — show "—" placeholder when data is null (no hidden sections)
7. `navigate(-1)` on "← Back to Signals" to preserve table filter state
8. Skeleton layout during loading, 404 error state with Back button

**Phase 14: HubSpot Integration** ✅ BUILT
1. `server/routes/hubspot.js` — `POST /api/signals/:id/push-to-hubspot`:
   - Fetches signal from **Airtable** (not Supabase) via `getSignalById(id)`
   - Guards: `hubspot_pushed === true` → 409 (already pushed)
   - Parses email from freeform `contact_info` text via `parseContact()` → 422 if no email
   - Calls HubSpot `POST https://api.hubapi.com/crm/v3/objects/contacts` with Bearer token
   - On success (200/201) or HubSpot 409: calls `updateHubspotPushed(id)` → sets `HubSpot Pushed = true` in **Airtable**
   - On other errors: returns error status, does NOT mark pushed
2. `HubSpotButton.jsx` — 4 states: `Push to HubSpot` → `Pushing…` → `Pushed ✓` (green, permanent) | `Retry` (red, retryable)
3. HubSpotButton used in both SignalsTable and SignalDetail
4. `server/lib/airtable.js` additions: `send_day` in mapRecord, `parseContactInfo()`, `getBSIBroadcastContacts()`, `updateHubspotPushed()`

**Phase 14b: Navigation + Layout Shell** ✅ BUILT
1. `src/components/Layout.jsx` — sidebar shell wrapping all authenticated pages via React Router `<Outlet />`
2. 240px deep teal sidebar: "STARFISH" wordmark, "Signal Dashboard" subtitle, Signals nav link with active state, user email + Sign Out at bottom
3. Sign Out: `supabase.auth.signOut()` → `navigate('/login')`
4. Mobile (< 1024px): sidebar collapses to 52px top bar + hamburger → slide-in drawer with dark overlay
5. `App.jsx` updated: ProtectedRoute wraps Layout, `/signals` and `/signals/:id` are child routes. `/` and `/login` outside Layout.

**Phase 14c: Landing Page** ✅ BUILT
1. `src/pages/Home.jsx` — public marketing page at `/`
2. Fixed top nav (`#004b5c`), Hero (full-viewport teal, headline, CTA, stat row, bounce chevron), Signal Types section (6 cards with real `<SignalTypeBadge>`), How It Works (4 steps with arrows), Footer
3. Scroll indicator fades after 100px scroll via `useEffect` + scroll event listener
4. Fully responsive via single `<style>` tag — 3-col/2-col/1-col grid, step arrows hide on mobile

**Phase 14d: Premium Login Page Rebuild** ✅ BUILT
1. `src/pages/Login.jsx` completely rebuilt — two-column layout (40% teal left, 60% white right)
2. Left: wordmark, Inter Light quote, three stats
3. Right: white card — "Welcome back." greeting, email field (Enter → focus password), password field with eye-toggle SVG (position: absolute, 44px padding-right), error mapping to friendly messages, CSS spinner in button during loading, "This is a private system." footer note
4. Mobile: left column `display: none`, card fills screen
5. `index.html` updated to include Inter weight 300 (Light) in Google Fonts import
6. Three Supabase users added: david@, zack@, carly@starfishco.com

**Phase 15: Dashboard Deployment**
1. Deploy Express backend to Railway (same project as signal monitor)
2. Add env vars to Railway: `AIRTABLE_API_KEY`, `AIRTABLE_BASE_ID`, `AIRTABLE_TABLE_NAME`, `HUBSPOT_TOKEN`, `PORT`, `FRONTEND_URL`
3. Deploy React frontend to Vercel
4. Add env vars to Vercel: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_API_URL` (set to Railway backend URL)
5. Update `FRONTEND_URL` in Railway to the Vercel deployment URL (for CORS)
6. Test full flow on production: `/` landing → `/login` → `/signals` → signal detail → status update → HubSpot push
7. Confirm Carly, David, Zack can all log in

---

## Dashboard Error Handling

**If Express API is unreachable:**
- Show banner: "Unable to connect to server. Please try again."
- Do not crash the React app

**If signal fails to load (`GET /api/signals/:id`):**
- Show: "Signal not found or failed to load."
- Provide back button to return to table

**If status update fails (`PATCH /api/signals/:id/status`):**
- Revert to previous status value in UI
- Show inline: "Failed to save status. Please try again."

**If HubSpot push fails:**
- Show inline: "HubSpot push failed. Try again."
- Re-enable the push button
- Do NOT mark `hubspot_pushed = true`

**If Supabase Auth session expires:**
- Redirect to `/login` silently
- Do not show an error — just ask them to log in again

---

## Dashboard Scope (MVP)

Only build what is described in the feature rules above. Do not add:
- Pagination (load all client-side in MVP)
- Email compose within the dashboard
- Signal creation from the dashboard
- User management UI (manage users in Supabase dashboard directly)
- Analytics or charts (future build)
- Mobile layout optimization (desktop-first in MVP)

If anything is unclear, ask before starting. The signal monitor (Railway Node.js app) is already built and running — do NOT modify it as part of this dashboard build.
