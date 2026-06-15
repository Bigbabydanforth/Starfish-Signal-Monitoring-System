# Workflow 3: Deduplicate

**Purpose:** Remove signals for companies already in Airtable within the last 90 days by querying recent Airtable records and comparing normalized company names. Companies last seen more than 90 days ago are eligible to re-appear as fresh intent signals.

**Implementation file:** `execution/workflow_3_deduplicate.js`

**Trigger:** Immediately after Workflow 2 completes

**Input:** `enrichedSignals` array from Workflow 2 (expected: 10–40 signals)

**Output:**
- Return value: `deduplicatedSignals` array (expected: 3–15 signals)
- Files: `.tmp/final_signals_YYYYMMDD.json`, `.tmp/duplicates_removed_YYYYMMDD.json`

**Expected execution time:** 1–2 minutes

---

## Process

### Step 3.0 — Filter Garbage Names

Before any deduplication, filter out signals where `company.name` matches known garbage patterns — these are headlines or non-company strings extracted from news feeds rather than real company names (e.g. "HODL", "Debunking", "CEO Just", "Wheel of Fortune").

Apply the `GARBAGE_PATTERNS` regex list via `isGarbageName(name)`. Any signal that matches is discarded and logged.

---

### Step 3.1 — Merge Duplicates Within the Incoming Batch

Before checking Airtable, merge signals that refer to the same company within the current batch. Group signals by normalized company name.

For groups of 2+:
- Keep one base record (`group[0]`)
- Combine signal details from all sources into a multi-source string: `"⚡ SIGNAL SEEN Nx — Multiple sources confirm..."`
- Combine all `source_url` values using `source_url` (snake_case) into `base.source_url` joined with ` | `
- If seen 2+ times, boost priority: LOW → MEDIUM, MEDIUM → HIGH

**Important:** All source URL fields on signal objects use snake_case `source_url`. The merge block reads `s.source_url` and writes `base.source_url`.

---

### Step 3.2 — Query Airtable Records (90-day rolling window)

Query the Airtable `Signals` table using `IS_AFTER({Date Detected}, '<91 days ago>')`.

Extract only the `Company Name` field from each returned record.

**Why 91 days in the query (not 90):** Airtable's `IS_AFTER` is **strictly greater than** (exclusive). Passing the date exactly 90 days ago would exclude records from exactly that day. Using `getDateDaysAgo(91)` makes `IS_AFTER` include records from exactly 90 days ago.

> **Bug fix (2026-06-15):** The code previously used `getDateDaysAgo(90)`, which silently dropped the 90-day-old records from the dedup window due to IS_AFTER's exclusive comparison. Fixed to `getDateDaysAgo(91)`.

**No maxRecords cap:** The Airtable SDK paginates through all matching records automatically. There is no hard cap on results — the dedup set is always complete regardless of database size.

**Dedup cap alerts:** A Telegram alert fires at 4,500 records (warning) and 5,000 records (critical) so the team knows when the rolling window is getting large.

**On failure:** Log warning to console, set `recentCompanyNames = []`, continue without deduplication for this run. Retry once after 2 seconds before giving up.

### Step 3.3 — Normalize Company Names

Apply `normalizeCompanyName()` to ALL company names before comparison. This prevents false non-matches caused by punctuation or capitalization differences.

**Normalization steps (applied in order):**
1. Convert to lowercase
2. Trim leading/trailing whitespace
3. Remove all non-alphanumeric characters (`/[^a-z0-9]/g`)

**Examples:**
- `"Apple Inc."` → `"appleinc"`
- `"Apple, Inc"` → `"appleinc"`
- `"Coca-Cola Company"` → `"cocacolacompany"`
- `"Microsoft Corp."` → `"microsoftcorp"` ← different from `"microsoftcorporation"`

> **Note:** Normalization removes legal suffixes inconsistently. This is acceptable for the pilot. `"Microsoft Corp"` and `"Microsoft Corporation"` will NOT be caught as duplicates. Flag for improvement in full build.

### Step 3.4 — Check Each New Signal

For each signal in `enrichedSignals`:
1. Normalize its `company.name`
2. Check if normalized name exists in the normalized recent names list
3. If found → move to `duplicatesFound`, log company name
4. If not found → move to `deduplicatedSignals`

### Step 3.5 — Save Results

Write `deduplicatedSignals` to `.tmp/final_signals_YYYYMMDD.json`.
Write `duplicatesFound` to `.tmp/duplicates_removed_YYYYMMDD.json` (audit trail).

Log final count: `X signals → Y unique (removed Z duplicates)`.

---

## Error Handling

| Scenario | Action |
|----------|--------|
| Airtable query fails | Retry once after 2s. If still fails, skip dedup for this run (all signals pass through) |
| Normalization throws on bad name | Skip that comparison, treat as non-duplicate |
| All signals are duplicates | Pass empty array to Workflow 4; email sends "No new signals today" |
| Empty input array | Return empty array immediately (no Airtable query needed) |
| Garbage name matches pattern | Discard signal, log count, continue |
| Merge: `source_url` missing on a signal | `filter(Boolean)` removes undefined — merge proceeds with available URLs |
| Merge: Rebrand signal in group | Rebrand details formatted as `"{company} is rebranding to {new_name}"` |
