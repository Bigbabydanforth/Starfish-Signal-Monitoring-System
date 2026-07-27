// HubSpot routes
// POST /api/signals/:id/push-to-hubspot
//
// Fetches the full signal from Airtable, pushes the contact to HubSpot
// using the centralized pushSignalToHubSpot() function (from the signal monitor),
// then marks HubSpot Pushed = true in Airtable on success.
//
// Returns { success: true } or { success: false, error: "..." }
// The React HubSpotButton component drives its state entirely from these responses.

import express from 'express'
import { getSignalById, updateHubspotPushed } from '../lib/airtable.js'
import { parseContactInfo } from '../lib/parseContact.js'
import { pushSignalToHubSpot } from '../../../starfish-signal-monitor/hubspot/pushSignalToHubSpot.js'

const router = express.Router()

// Airtable record IDs: "rec" + 10–17 alphanumeric characters
// Validate before hitting the database to prevent malformed input
const AIRTABLE_ID_REGEX = /^rec[A-Za-z0-9]{10,17}$/

/**
 * GET /api/signals/:id/validate
 *
 * Checks whether a signal has all required fields to push to HubSpot.
 * Called by the dashboard on Signal Detail page load.
 * Returns { ready: true/false, missing_fields: string[] }
 *
 * Validation mirrors computeMissingFields() in SignalDetail.jsx so the
 * validate endpoint and the push endpoint can never be out of sync.
 */
router.get('/signals/:id/validate', async (req, res) => {
  const { id } = req.params
  console.log(`[GET /api/signals/${id}/validate] Validation requested`)

  if (!AIRTABLE_ID_REGEX.test(id)) {
    return res.status(400).json({ ready: false, missing_fields: ['Invalid signal ID format'] })
  }

  let signal
  try {
    signal = await getSignalById(id)
  } catch (err) {
    if (err.statusCode === 404 || err.message?.includes('Record not found')) {
      console.log(`[GET /api/signals/${id}/validate] Signal not found`)
      return res.status(404).json({ ready: false, missing_fields: ['Signal not found'] })
    }
    console.error(`[GET /api/signals/${id}/validate] Airtable fetch error: ${err.message}`)
    return res.status(500).json({ ready: false, missing_fields: ['Failed to fetch signal'] })
  }

  const parsed = parseContactInfo(signal.contact_info)

  // Validation mirrors computeMissingFields() in SignalDetail.jsx
  const missingFields = []

  if (!parsed.email) {
    missingFields.push('Email address not found in contact info')
  }
  if (!signal.company_name) {
    missingFields.push('Company name is missing')
  }
  if (!signal.industry || signal.industry.toLowerCase() === 'unknown' || signal.industry.trim() === '') {
    missingFields.push('Industry is missing or "Unknown" — must be a real industry')
  }
  if (signal.signal_type === 'M&A Activity' && !signal.acquired_company) {
    missingFields.push('M&A signal requires the acquired company name (for {{TargetCo}} token)')
  }
  if (signal.signal_type === 'Funding' && (!signal.industry || signal.industry.toLowerCase() === 'unknown')) {
    missingFields.push('Funding signal requires a real industry (for {{Sector}} token)')
  }

  const ready = missingFields.length === 0
  console.log(`[GET /api/signals/${id}/validate] Ready: ${ready}, Missing: ${missingFields.length}`)

  return res.json({ ready, missing_fields: missingFields })
})

/**
 * POST /api/signals/:id/push-contact
 *
 * Pushes a specific contact (from broadcast_contacts array) to HubSpot.
 * Called by ContactRow when a signal has multiple contacts — each has its own push button.
 * Body: { contactEmail, contactName, contactTitle, sendDay, linkedinUrl }
 */
router.post('/signals/:id/push-contact', async (req, res) => {
  const { id } = req.params
  const { contactEmail, contactName, contactTitle, sendDay, linkedinUrl } = req.body

  console.log(`[POST /api/signals/${id}/push-contact] Push requested for: ${contactEmail}`)

  if (!AIRTABLE_ID_REGEX.test(id)) {
    return res.status(400).json({ success: false, error: 'Invalid signal ID format' })
  }

  if (!contactEmail || !contactEmail.includes('@')) {
    return res.status(400).json({ success: false, error: 'Valid contact email is required' })
  }

  // Fetch parent signal for company + signal type context
  let signal
  try {
    signal = await getSignalById(id)
  } catch (err) {
    if (err.statusCode === 404 || err.message?.includes('Record not found')) {
      return res.status(404).json({ success: false, error: 'Signal not found' })
    }
    console.error(`[POST push-contact] Airtable fetch error: ${err.message}`)
    return res.status(500).json({ success: false, error: 'Failed to fetch signal.' })
  }

  const nameParts = (contactName || '').trim().split(/\s+/)
  const contact = {
    first_name:   nameParts[0] || '',
    last_name:    nameParts.slice(1).join(' ') || '',
    name:         contactName || '',
    email:        contactEmail.trim().toLowerCase(),
    title:        contactTitle || '',
    send_day:     sendDay || 1,
    linkedin_url: linkedinUrl || null,
    email_source: 'Apollo',
    abGroup:      signal.ab_test_group === 'claude' ? 'claude' : 'starfish',
  }

  const pushResult = await pushSignalToHubSpot(signal, contact)

  if (pushResult.success || pushResult.reason === 'already_exists') {
    console.log(`[POST push-contact] ✓ ${contactEmail} pushed (signal: ${id})`)
    return res.json({ success: true })
  }

  const errorMsg =
    pushResult.reason === 'auth_failed'   ? 'HubSpot authentication failed. Contact Gideon.' :
    pushResult.reason === 'rate_limited'  ? 'HubSpot rate limit. Try again in a minute.'     :
    pushResult.reason === 'no_token'      ? 'HubSpot is not configured. Contact Gideon.'     :
                                            'HubSpot push failed. Try again.'

  console.log(`[POST push-contact] ✗ ${contactEmail} — ${pushResult.reason}`)
  return res.status(500).json({ success: false, error: errorMsg })
})

// POST /api/signals/:id/push-to-hubspot
router.post('/signals/:id/push-to-hubspot', async (req, res) => {
  const { id } = req.params
  console.log(`[POST /api/signals/${id}/push-to-hubspot] Push requested`)

  // ── Input validation ───────────────────────────────────────────────────────
  if (!AIRTABLE_ID_REGEX.test(id)) {
    return res.status(400).json({ success: false, error: 'Invalid signal ID format' })
  }

  // ── Step 1: Fetch signal from Airtable ────────────────────────────────────
  let signal
  try {
    signal = await getSignalById(id)
  } catch (err) {
    if (err.statusCode === 404 || err.message?.includes('Record not found')) {
      console.log(`[POST push-to-hubspot] Signal not found: ${id}`)
      return res.status(404).json({ success: false, error: 'Signal not found' })
    }
    console.error(`[POST push-to-hubspot] Airtable fetch error: ${err.message}`)
    return res.status(500).json({ success: false, error: 'Failed to fetch signal.' })
  }

  // ── Step 2: Guard — already pushed ────────────────────────────────────────
  if (signal.hubspot_pushed) {
    console.log(`[POST push-to-hubspot] Already pushed: ${id} — returning success`)
    return res.json({ success: true, alreadyPushed: true })
  }

  // ── Step 3: Parse contact info ────────────────────────────────────────────
  // Do NOT log the full contact_info string — log only the email and signal ID
  const parsed = parseContactInfo(signal.contact_info)

  if (!parsed.email) {
    console.log(`[POST push-to-hubspot] No email in contact_info for signal: ${id}`)
    return res.status(422).json({
      success: false,
      error: 'No email found for this signal. Contact info may be incomplete.',
    })
  }

  console.log(`[POST push-to-hubspot] Pushing ${parsed.email} (signal: ${id})`)

  // ── Step 4: Push to HubSpot ───────────────────────────────────────────────
  // contact_source must be a valid HubSpot enum: Hunter | Apollo | AudienceLab | Puppeteer
  // Dashboard pushes default to 'Apollo' — the most common pipeline source.
  const contact = {
    name:         parsed.name  || '',
    email:        parsed.email,
    title:        parsed.title || parsed.jobTitle || '',
    send_day:     signal.send_day || '1',
    email_source: 'Apollo',
    abGroup:      signal.ab_test_group === 'claude' ? 'claude' : 'starfish',
  }

  const pushResult = await pushSignalToHubSpot(signal, contact)

  // ── Step 5: Handle result ─────────────────────────────────────────────────
  if (pushResult.success || pushResult.reason === 'already_exists') {
    // Mark as pushed in Airtable — non-fatal if this fails
    await updateHubspotPushed(id).catch(err =>
      console.error(`[POST push-to-hubspot] Airtable mark-pushed failed: ${err.message}`)
    )
    console.log(`[POST push-to-hubspot] ✓ Success: ${parsed.email} pushed (signal: ${id})`)
    return res.json({ success: true })
  }

  // Validation failure — missing required fields (contact email, company name, etc.)
  // Returns 422 with the specific missing field list so the UI can display them.
  if (pushResult.reason === 'missing_fields' && pushResult.missing?.length > 0) {
    console.log(`[POST push-to-hubspot] ✗ Validation failed: ${pushResult.missing.join(', ')} (signal: ${id})`)
    return res.status(422).json({
      success: false,
      reason: 'validation_failed',
      missingFields: pushResult.missing,
      error: `Missing required fields: ${pushResult.missing.length} field(s) need attention before this contact can be pushed to HubSpot.`,
    })
  }

  // Other HubSpot errors — return a user-friendly message, re-enable the button
  const errorMessage =
    pushResult.reason === 'auth_failed'
      ? 'HubSpot authentication failed. Contact Gideon.'
      : pushResult.reason === 'rate_limited'
        ? 'HubSpot is temporarily unavailable. Try again in a few minutes.'
        : pushResult.reason === 'no_token'
          ? 'HubSpot is not configured. Contact Gideon.'
          : 'HubSpot push failed. Try again.'

  console.log(`[POST push-to-hubspot] ✗ Failed: ${parsed.email} — ${pushResult.reason}`)
  return res.status(500).json({ success: false, error: errorMessage })
})

export default router
