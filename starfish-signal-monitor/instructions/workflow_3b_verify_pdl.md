# Workflow 3b: PDL Signal Verification (Telegram)

**Purpose:** After deduplication, send each surviving PDL Job Change signal to Gideon's Telegram for manual LinkedIn verification before it proceeds to Airtable. Non-PDL signals (News/Press, M&A) pass through automatically — no verification needed.

**Implementation file:** `execution/workflow_3b_verify_pdl.js`

**Trigger:** Immediately after Workflow 3 (Deduplicate) completes

**Input:** `deduplicatedSignals` array from Workflow 3

**Output:** Verified signals array — approved PDL signals + all non-PDL signals

**Expected execution time:** Up to 60 minutes (user-driven; auto-approves on timeout)

---

## Process

### Step 3b.0 — Split Signals

Separate signals into two groups:
- `pdlSignals` — signals where `source === 'PDL'` AND `type === 'Job Change'`
- `otherSignals` — everything else (News/Press, M&A, Apollo Job Changes)

`otherSignals` pass through automatically — no Telegram interaction required.

If `pdlSignals` is empty, return `deduplicatedSignals` unchanged immediately.

If `TELEGRAM_BOT_TOKEN` or `TELEGRAM_CHAT_ID` is not set, log a warning and auto-approve all PDL signals.

---

### Step 3b.1 — Generate Batch ID

Generate a unique `batchId` for this run using `Date.now().toString(36)`.

This ID is embedded in every button's `callback_data` to prevent button clicks from previous runs hijacking the current poll session.

---

### Step 3b.2 — Send Intro Message

Send a summary message to Telegram:
- Number of PDL signals pending review
- Number of News/Press signals proceeding automatically
- Instructions to click each LinkedIn profile and verify the job change is real and within 90 days
- Notice that unreviewed signals will be auto-approved after 1 hour

---

### Step 3b.3 — Send Each PDL Signal

For each PDL signal, send a Telegram message with:
- Person name, company, title, start date, days since start
- Revenue and employee count
- Clickable LinkedIn profile link (HTML parse mode)
- Inline keyboard with two buttons:
  - `✅ Approve` → `callback_data: approve:{batchId}:{index}`
  - `❌ Drop` → `callback_data: drop:{batchId}:{index}`

Wait 500ms between messages to avoid Telegram rate limits.

---

### Step 3b.4 — Poll for Responses

Poll `getUpdates` with long-polling (10s timeout, 100 updates per poll, tracked offset).

For each `callback_query` received:
1. Parse `callback_data` as `{action}:{batchId}:{index}`
2. **Reject** any click where the embedded batchId does not match the current run's batchId — this prevents old buttons from interfering
3. Record `approved` or `dropped` for the matching signal index
4. Call `answerCallbackQuery` to remove the spinner
5. Call `editMessageReplyMarkup` to clear the buttons from the message
6. Send a confirmation message showing the decision

Continue polling until all signals are responded to or the 1-hour deadline is reached.

---

### Step 3b.5 — Auto-Approve on Timeout

Any signal not responded to within 1 hour is automatically marked `approved`. A Telegram message is sent notifying how many were auto-approved.

---

### Step 3b.6 — Send Summary & Return

Send a final Telegram summary:
- Approved count
- Dropped count
- Auto-pass count (News/Press)
- Total proceeding to Airtable

Return `[...approvedPDL, ...otherSignals]`.

---

## Error Handling

| Scenario | Action |
|----------|--------|
| Telegram not configured | All PDL signals auto-approved, pipeline continues |
| No PDL signals in batch | Return input unchanged, skip all Telegram calls |
| Poll network error | Log warning, retry next 2s cycle |
| 1-hour timeout reached | Auto-approve all unreviewed signals |
| Button from previous run clicked | batchId mismatch — silently ignored, poll continues |
