# Workflow 6: Telegram Monitoring

**Purpose:** Send a silent QA summary message to Gideon's Telegram after each daily run. This is internal developer monitoring — the client does not know this workflow exists.

**Implementation file:** `execution/workflow_6_telegram_monitoring.js`

**Trigger:** Immediately after Workflow 5 completes (runs even if earlier workflows errored)

**Input:**
- `deduplicatedSignals` — array from Workflow 3
- `airtableCount` — number of records inserted (from Workflow 4)
- `emailSuccess` — boolean (from Workflow 5)
- `startTime` — `Date.now()` timestamp from beginning of Workflow 1

**Output:**
- Return value: none (fire-and-forget)
- **No files written** — client must not know about this workflow

**Expected execution time:** 5–10 seconds

---

## Process

### Step 6.1 — Format Message

Build a plain-text message string using this structure:

```
🎯 Starfish Daily Run - {Full Date e.g. "Monday, May 12, 2026"}

📊 Signals Detected: {TOTAL_COUNT}
🔴 High Priority: {HIGH_COUNT}
🟡 Medium Priority: {MEDIUM_COUNT}
⚪ Low Priority: {LOW_COUNT}

Top {N} Signals:
1. {Company Name} - {Brief truncated to 80 chars}
2. {Company Name} - {Brief truncated to 80 chars}
3. {Company Name} - {Brief truncated to 80 chars}

✅ Email sent to: {Recipients}
💾 Saved {N} records to Airtable

⏱️ Total execution time: {Duration}s
```

Show top 3 signals (or fewer if less than 3 exist). Truncate each brief to 80 characters with `"..."`.

If no signals: replace "Top N Signals" section with `"No new signals detected today."`

If email failed: replace `✅ Email sent` line with `⚠️ Email delivery failed (see logs)`

If Airtable count is 0 but signals exist: replace `💾 Saved` line with `⚠️ Airtable save failed (see logs)`

If errors occurred during the run, append:
```
⚠️ ERRORS:
- {Error 1 description}
- {Error 2 description}
```

### Step 6.2 — Send to Telegram

**Endpoint:** `POST https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage`

**Payload:**
```json
{
  "chat_id": "TELEGRAM_CHAT_ID",
  "text": "<formatted message>",
  "parse_mode": "HTML"
}
```

Use `axios.post()` with the full URL constructed from `process.env.TELEGRAM_BOT_TOKEN`.

All string values are passed through `esc()` before embedding in the HTML message. `esc()` escapes: `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`, `"` → `&quot;`, `'` → `&#39;`.

### Step 6.3 — Silent Logging

- Do **NOT** write any files for this workflow
- Do **NOT** save anything to `.tmp/`
- Log only to `console` (visible in Railway logs only, invisible to client)
- Telegram failures are **non-critical** — do not throw, do not alert anyone else

---

## Error Handling

| Scenario | Action |
|----------|--------|
| Telegram API fails | `console.error()` only, continue |
| Invalid bot token (401) | `console.error()` only, continue |
| Invalid chat ID | `console.error()` only, continue |
| Message too long (>4096 chars) | Truncate to 4000 chars, append `"...[truncated]"`, send |
| Network timeout | Log to console, do not retry |

> **IMPORTANT:** Telegram failures must NEVER crash the pipeline or alert anyone other than Gideon's console. This workflow is monitoring infrastructure, not business logic.
