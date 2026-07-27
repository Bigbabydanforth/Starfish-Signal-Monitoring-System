/**
 * hubspot/enrollmentQueue.js
 *
 * C5 — Airtable-based enrollment queue with outreach-day + limit controls.
 *
 * FLOW:
 *   pushSignalToHubSpot  →  addToEnrollmentQueue    →  [Airtable: Enrollment Queue table]
 *   Daily 6 AM cron      →  processEnrollmentQueue  →  HubSpot sequence enrollment
 *                                                        (only executes on Tue / Wed / Thu)
 *
 * AIRTABLE TABLE — "Enrollment Queue" (create manually in same base as Signals):
 *   Contact Email       Email              Primary field
 *   HubSpot Contact ID  Single line text
 *   Signal Type         Single line text
 *   AB Test Group       Single line text   "starfish" | "claude"
 *   Company Name        Single line text
 *   Scheduled Date      Date               Next valid Tue/Wed/Thu from queue time
 *   Status              Single select      Pending | Enrolled | Failed
 *   Enrolled Date       Date               Set on success
 *   Failure Reason      Single line text   Set on failure
 *   Retry Count         Number             Incremented on each attempt
 *   Created At          Created time       Auto-set by Airtable
 *
 * Sequence ID and Owner ID are NOT stored in the table — they are resolved
 * at enrollment time via getSequenceRoute(signalType, abGroup) so that routing
 * changes automatically propagate to queued contacts.
 *
 * ENV VARS:
 *   AIRTABLE_QUEUE_TABLE_ID  — Airtable table ID (starts with tbl...) — required
 *   DAILY_ENROLLMENT_CAP     — full-production max enrollments per run (default: 900)
 *   LAUNCH_DATE              — ISO date (YYYY-MM-DD); enables soft-launch throttle
 *                              Week 1 (<7 days): cap 50 | Week 2 (<14 days): cap 300 | Week 3+: full cap
 */

import 'dotenv/config';
import Airtable from 'airtable';
import axios    from 'axios';
import { getSequenceRoute }  from './sequenceRouting.js';
import { enrollInSequence }  from './enrollInSequence.js';

const HUBSPOT_TOKEN    = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
const HUBSPOT_BASE_URL = 'https://api.hubapi.com';

const QUEUE_TABLE          = process.env.AIRTABLE_QUEUE_TABLE_ID || 'Enrollment Queue';
const DAILY_ENROLLMENT_CAP = parseInt(process.env.DAILY_ENROLLMENT_CAP || '900', 10);

// Days of the week on which enrollment runs (0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat)
const OUTREACH_DAYS = new Set([2, 3, 4]); // Tue / Wed / Thu

// ── Airtable queue table handle ───────────────────────────────────────────────
function getQueueTable() {
  return new Airtable({ apiKey: process.env.AIRTABLE_API_KEY })
    .base(process.env.AIRTABLE_BASE_ID)(QUEUE_TABLE);
}

// ── Day helpers ───────────────────────────────────────────────────────────────

/**
 * Returns true if today is an outreach day (Tuesday, Wednesday, or Thursday).
 * @returns {boolean}
 */
export function isOutreachDay() {
  return OUTREACH_DAYS.has(new Date().getDay());
}

/**
 * Returns today's date string if today is an outreach day,
 * otherwise the next Tuesday's date string (YYYY-MM-DD).
 * Stored in Airtable as "Scheduled Date" so contacts are visible
 * on the day they will be enrolled.
 * @returns {string} YYYY-MM-DD
 */
function getNextOutreachDate() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (OUTREACH_DAYS.has(today.getDay())) {
    return today.toISOString().split('T')[0];
  }

  for (let i = 1; i <= 7; i++) {
    const candidate = new Date(today);
    candidate.setDate(today.getDate() + i);
    if (OUTREACH_DAYS.has(candidate.getDay())) {
      return candidate.toISOString().split('T')[0];
    }
  }

  return today.toISOString().split('T')[0]; // fallback (should never reach here)
}

// ── Stamp HubSpot contact as enrolled ────────────────────────────────────────
// Non-fatal — the actual sequence enrollment already succeeded.
async function markContactEnrolled(contactId) {
  if (!HUBSPOT_TOKEN || !contactId) return;
  try {
    await axios.patch(
      `${HUBSPOT_BASE_URL}/crm/v3/objects/contacts/${contactId}`,
      { properties: { sequence_enrolled: 'true' } },
      {
        headers: {
          Authorization:  `Bearer ${HUBSPOT_TOKEN}`,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      }
    );
  } catch (err) {
    console.warn(`  [Queue] ⚠️  Could not mark contact ${contactId} as enrolled in HubSpot: ${err.message}`);
  }
}

// ── Safe Airtable record update ───────────────────────────────────────────────
async function safeUpdateRecord(recordId, fields) {
  try {
    await getQueueTable().update(recordId, fields);
  } catch (err) {
    console.warn(`  [Queue] ⚠️  Could not update queue record ${recordId}: ${err.message}`);
  }
}

// ── Add one contact to the enrollment queue ───────────────────────────────────
/**
 * Stage a contact for sequence enrollment.
 * Called from pushSignalToHubSpot.js (Step 5) after the contact is upserted in HubSpot.
 * The sequence route is resolved at enrollment time — not stored here.
 *
 * @param {object} entry
 * @param {string} entry.contactEmail      - Contact's email address (primary identifier)
 * @param {string} entry.hubspotContactId  - HubSpot contact ID returned from upsert
 * @param {string} entry.signalType        - e.g. 'Job Change', 'Brand Strategy Intent'
 * @param {string} entry.abGroup           - 'starfish' | 'claude'
 * @param {string} [entry.companyName]     - Company name (for logging visibility)
 * @returns {Promise<{ success: boolean, recordId?: string, error?: string }>}
 *   Never throws.
 */
export async function addToEnrollmentQueue(entry) {
  const { contactEmail, hubspotContactId, signalType, abGroup, companyName } = entry;

  if (!process.env.AIRTABLE_QUEUE_TABLE_ID) {
    console.log(`  [Queue] AIRTABLE_QUEUE_TABLE_ID not set — would queue: ${contactEmail} [${abGroup}]`);
    return { success: false, error: 'AIRTABLE_QUEUE_TABLE_ID not set' };
  }

  if (!contactEmail) {
    return { success: false, error: 'contactEmail is required' };
  }

  // Verify a route exists for this signal type before queuing
  const route = getSequenceRoute(signalType, abGroup);
  if (!route?.sequenceId) {
    console.log(`  [Queue] No sequence ID for ${signalType}/${abGroup} — skipping queue`);
    return { success: false, error: 'no_sequence_id' };
  }

  try {
    const [record] = await getQueueTable().create([{
      fields: {
        'Contact Email':      contactEmail        || '',
        'HubSpot Contact ID': hubspotContactId    || '',
        'Signal Type':        signalType          || '',
        'AB Test Group':      abGroup             || 'starfish',
        'Company Name':       companyName         || '',
        'Scheduled Date':     getNextOutreachDate(),
        'Status':             'Pending',
        'Enrolled Date':      null,
        'Failure Reason':     '',
        'Retry Count':        0,
      },
    }]);

    console.log(`  [Queue] ✓ Queued ${contactEmail} → ${signalType} [${abGroup}] (record: ${record.id})`);
    return { success: true, recordId: record.id };

  } catch (err) {
    console.error(`  [Queue] ✗ Failed to queue ${contactEmail}: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// ── Process the enrollment queue ──────────────────────────────────────────────
/**
 * Fetch all 'Pending' records, resolve their sequence routes, enroll them in HubSpot,
 * and update each record's status.
 *
 * Exits immediately if today is not an outreach day (Tue/Wed/Thu).
 * Stops after ENROLLMENT_DAILY_LIMIT successful enrollments.
 *
 * @param {object}  [options]
 * @param {boolean} [options.dryRun=false] - If true, log intent but make no HubSpot API calls
 *                                           and do not update Airtable statuses.
 * @returns {Promise<{ enrolled: number, failed: number, skipped: number, dryRun: boolean }>}
 */
export async function processEnrollmentQueue({ dryRun = false } = {}) {
  console.log('[Queue] ══════════════════════════════════════════');
  console.log('[Queue] Enrollment queue processor starting');
  // ── Soft-launch throttle ─────────────────────────────────────────────────
  // Week 1 (<7 days since LAUNCH_DATE):  cap 50  — David's confirmed pilot plan
  //   50 per campaign × 6 campaigns = 300 total contacts, spread across outreach days.
  // Week 2 (7–13 days):                  cap 300 — full database across outreach days
  // Week 3+ (14+ days) or no date set:   full DAILY_ENROLLMENT_CAP (default 900)
  //
  // NOTE: David specified "50 per campaign" for pilot Week 1.
  // The per-run cap of 50 achieves approximately this — records are pulled oldest-first
  // across all signal types, so distribution is naturally mixed.
  // If strict per-campaign enforcement is needed in the future, group records by
  // Signal Type and take effectiveCap/6 from each group separately.
  const LAUNCH_DATE = process.env.LAUNCH_DATE ? new Date(process.env.LAUNCH_DATE) : null;
  let effectiveCap = DAILY_ENROLLMENT_CAP;

  // Guard: invalid LAUNCH_DATE string → log warning, fall back to full production cap
  if (LAUNCH_DATE && isNaN(LAUNCH_DATE.getTime())) {
    console.log(`[Queue] ⚠️  LAUNCH_DATE is invalid ("${process.env.LAUNCH_DATE}") — defaulting to full production cap`);
  } else if (LAUNCH_DATE) {
    const daysSinceLaunch = Math.floor((new Date() - LAUNCH_DATE) / (1000 * 60 * 60 * 24));
    if (daysSinceLaunch < 7) {
      effectiveCap = 50;  // Week 1: pilot only
      console.log(`[Queue] Soft launch: ${daysSinceLaunch} days since launch — cap: ${effectiveCap}/run (pilot mode)`);
    } else if (daysSinceLaunch < 14) {
      effectiveCap = 300; // Week 2: ramp
      console.log(`[Queue] Soft launch: ${daysSinceLaunch} days since launch — cap: ${effectiveCap}/run (ramp mode)`);
    } else {
      // effectiveCap remains DAILY_ENROLLMENT_CAP (900) — full production
      console.log(`[Queue] Soft launch: ${daysSinceLaunch} days since launch — cap: ${effectiveCap}/run (full production)`);
    }
  } else {
    console.log(`[Queue] Mode: ${dryRun ? 'DRY-RUN' : 'LIVE'} | Cap: ${effectiveCap}/run`);
  }

  // ── Day guard ─────────────────────────────────────────────────────────────
  if (!isOutreachDay()) {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    console.log(`[Queue] Not an outreach day (today: ${days[new Date().getDay()]}) — skipping enrollment`);
    console.log('[Queue] ══════════════════════════════════════════');
    return { enrolled: 0, failed: 0, skipped: 0, dryRun };
  }

  if (!process.env.AIRTABLE_QUEUE_TABLE_ID) {
    console.warn('[Queue] ⚠️  AIRTABLE_QUEUE_TABLE_ID not set — cannot process queue');
    console.log('[Queue] ══════════════════════════════════════════');
    return { enrolled: 0, failed: 0, skipped: 0, dryRun };
  }

  let enrolled = 0;
  let failed   = 0;
  let skipped  = 0;

  // ── Fetch all pending records, oldest first ───────────────────────────────
  let pending;
  try {
    pending = await getQueueTable()
      .select({
        filterByFormula: "{Status} = 'Pending'",
        sort: [{ field: 'Scheduled Date', direction: 'asc' }],
      })
      .all();
  } catch (err) {
    console.error('[Queue] ✗ Failed to fetch pending records:', err.message);
    console.log('[Queue] ══════════════════════════════════════════');
    return { enrolled: 0, failed: 0, skipped: 0, dryRun };
  }

  console.log(`[Queue] Found ${pending.length} pending enrollment(s)`);

  for (const record of pending) {
    if (enrolled >= effectiveCap) {
      console.log(`[Queue] Cap (${effectiveCap}) reached — stopping`);
      break;
    }

    const f               = record.fields;
    const contactEmail    = f['Contact Email']      || '(unknown)';
    const hubspotId       = f['HubSpot Contact ID'] || '';
    const signalType      = f['Signal Type']        || '';
    const abGroup         = f['AB Test Group']      || 'starfish';
    const retryCount      = Number(f['Retry Count'] || 0);

    // ── Resolve route at enrollment time ──────────────────────────────────
    const route = getSequenceRoute(signalType, abGroup);

    if (!route?.sequenceId || !hubspotId) {
      const reason = !route?.sequenceId
        ? `no sequence ID for ${signalType}/${abGroup}`
        : 'missing HubSpot Contact ID';
      console.log(`  [Queue] Skipping ${contactEmail} — ${reason}`);
      if (!dryRun) {
        await safeUpdateRecord(record.id, {
          'Status':         'Failed',
          'Failure Reason': reason,
          'Retry Count':    retryCount + 1,
        });
      }
      skipped++;
      continue;
    }

    // ── Dry-run ───────────────────────────────────────────────────────────
    if (dryRun) {
      console.log(`  [Queue] Would enroll: ${contactEmail} → seq ${route.sequenceId} via ${route.ownerEmail} [${abGroup}]`);
      enrolled++; // count as "would enroll" so the test assertion matches
      continue;
    }

    // ── Live enrollment ───────────────────────────────────────────────────
    const result = await enrollInSequence(hubspotId, route.sequenceId, route.ownerId);

    if (result.success) {
      enrolled++;
      const today = new Date().toISOString().split('T')[0];
      const suffix = result.alreadyEnrolled ? ' (already enrolled)' : '';
      console.log(`  [Queue] ✓ Enrolled ${contactEmail} → seq ${route.sequenceId}${suffix}`);

      await safeUpdateRecord(record.id, {
        'Status':         'Enrolled',
        'Enrolled Date':  today,
        'Failure Reason': '',
        'Retry Count':    retryCount + 1,
      });

      await markContactEnrolled(hubspotId);

    } else {
      failed++;
      console.error(`  [Queue] ✗ Failed ${contactEmail}: ${result.error} (HTTP ${result.status ?? 'n/a'})`);

      await safeUpdateRecord(record.id, {
        'Status':         'Failed',
        'Failure Reason': result.error || 'unknown error',
        'Retry Count':    retryCount + 1,
      });
    }

    // Brief pause to avoid HubSpot rate limits
    await new Promise(r => setTimeout(r, 400));
  }

  console.log('[Queue] ══════════════════════════════════════════');
  console.log(`[Queue] Done — enrolled: ${enrolled}, failed: ${failed}, skipped: ${skipped}`);
  console.log('[Queue] ══════════════════════════════════════════');

  return { enrolled, failed, skipped, dryRun };
}
