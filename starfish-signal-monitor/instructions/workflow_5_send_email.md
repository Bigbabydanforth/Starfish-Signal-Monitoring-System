# Workflow 5: Send Email

**Purpose:** Generate an HTML email digest from the daily signals, grouped by priority, and send it to the configured recipients via SMTP.

**Implementation file:** `execution/workflow_5_send_email.js`

**Trigger:** Immediately after Workflow 4 completes

**Input:** `deduplicatedSignals` array from Workflow 3 (expected: 3–15 signals; may be empty)

**Output:**
- Return value: `emailSuccess` boolean (`true` if sent, `false` if failed)
- File: `.tmp/email_log_YYYYMMDD.txt` (always created)
- On failure only: `.tmp/unsent_email_YYYYMMDD.html`

**Expected execution time:** 30–60 seconds

---

## Process

### Step 5.1 — Group Signals by Priority and Research Status

Split `deduplicatedSignals` into four groups:
- `highPriority` — where `signal.priority === "HIGH"` and NOT `bsi_contact_needed`
- `mediumPriority` — where `signal.priority === "MEDIUM"` and NOT `bsi_contact_needed`
- `lowPriority` — where `signal.priority === "LOW"` and NOT `bsi_contact_needed`
- `researchNeeded` — where `signal.bsi_contact_needed === true` (BSI signals where no contact was found)

### Step 5.2 — Load and Populate Email Template

Load `templates/email_template.html` using Handlebars (`handlebars.compile()`).

**Template variables:**

| Variable | Value |
|----------|-------|
| `{{DATE}}` | Formatted as "Monday, May 12, 2026" |
| `{{TOTAL_COUNT}}` | `deduplicatedSignals.length` |
| `{{HIGH_COUNT}}` | `highPriority.length` |
| `{{MEDIUM_COUNT}}` | `mediumPriority.length` |
| `{{LOW_COUNT}}` | `lowPriority.length` |
| `{{RESEARCH_NEEDED_COUNT}}` | `researchNeeded.length` |
| `{{AIRTABLE_LINK}}` | `https://airtable.com/{BASE_ID}/{TABLE_NAME}` |
| `{{NO_SIGNALS}}` | `true` if total count is 0 |
| `{{#each HIGH_SIGNALS}}` | Array of formatted signal objects |
| `{{#each MEDIUM_SIGNALS}}` | Array of formatted signal objects |
| `{{#each LOW_SIGNALS}}` | Array of formatted signal objects |
| `{{#each RESEARCH_NEEDED_SIGNALS}}` | Array of BSI signals needing manual contact research |

Each signal object in the loop includes: `company_name`, `signal_type`, `signal_details`, `brief`, `contact_info`, `industry`, `source_url`.

Signal types supported: "Job Change", "News/Press", "M&A Activity", "Rebrand", "Website Visitor", "Brand Strategy Intent".

**Research Needed section:** Appears at the bottom of the email (styled in purple). Each card shows the company name, industry, website, and a note directing Carly to find the contact manually. This section only renders if `RESEARCH_NEEDED_COUNT > 0`.

Signal details are reconstructed from the signal object if not already built (supports merged signals, pipeline signals, and Airtable-loaded signals for the standalone runner).

### Step 5.3 — Determine Recipients

- If `NODE_ENV === "production"`: split `EMAIL_TO_PRODUCTION` by comma, trim each value, filter empty strings
- Otherwise: use `[EMAIL_TO_TESTING]` filtered for empty strings
- **If the resulting recipients array is empty:** log an error (`[Email] No recipients configured for NODE_ENV="{env}"`) and return `false`. Do not attempt to send.

Log which mode and recipients are being used.

### Step 5.4 — Send via SMTP

**Config:** Gmail SMTP, host `smtp.gmail.com`, port `465`, `secure: true` (SSL), app-specific password.

**Subject line format:**
`Starfish Signals - {Day}, {Month} {Date}, {Year} - {Count} New Opportunities`

**On success:** Log message ID and delivery details to `.tmp/email_log_YYYYMMDD.txt`. Return `true`.

**On failure:** Save HTML to `.tmp/unsent_email_YYYYMMDD.html`. Log failure. Retry once after 30 seconds. If retry also fails: send Telegram alert to Gideon. Return `false`.

---

## Error Handling

| Scenario | Action |
|----------|--------|
| No recipients configured | Log error, return false immediately (do not attempt send) |
| SMTP connection fails | Save HTML, alert Gideon via Telegram, return false |
| Authentication fails | Log error, alert Gideon, skip email this run, return false |
| Email too large (>10MB) | Truncate `signal_details` fields, retry |
| 0 signals in array | Send email with "No new signals today" message (do not skip) |
| Template file missing | Log error, alert Gideon, return false |
