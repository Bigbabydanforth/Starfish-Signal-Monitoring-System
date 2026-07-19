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
    return res.status(400).json({
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

  // HubSpot push failed — return a user-friendly error, re-enable the button
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
