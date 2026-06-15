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
│   ├── backfill_to_sheets.js             # One-time: backfill Airtable records to Sheets
│   ├── add_missing_to_sheets.js          # One-time: append missing companies to Sheets
│   ├── send_batch_email.js               # One-time: send specific batch of signals via email
│   ├── verify_first72.js                 # One-time: verify Sheets matches Airtable records
│   ├── test_pdl.js                       # Standalone PDL API test
│   ├── test_predictleads.js              # Standalone PredictLeads test
│   ├── test_apollo.js                    # Standalone Apollo test
│   ├── enrich_and_save_predictleads.js   # One-time: enrich & save PredictLeads signals
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
   - OAuth2 with refresh token (no service account)
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
