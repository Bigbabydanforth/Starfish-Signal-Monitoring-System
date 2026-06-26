// HubSpot routes
// POST /api/signals/:id/push-to-hubspot

const express = require('express')
const router = express.Router()
const { getSignalById, updateHubspotPushed } = require('../lib/airtable')
const { parseContactInfo } = require('../lib/parseContact')

// POST /api/signals/:id/push-to-hubspot
router.post('/signals/:id/push-to-hubspot', async (req, res) => {
  const { id } = req.params

  if (!process.env.HUBSPOT_TOKEN) {
    return res.status(500).json({ error: 'HUBSPOT_TOKEN is not configured on the server.' })
  }

  // 1. Fetch signal from Airtable
  let signal
  try {
    signal = await getSignalById(id)
  } catch (err) {
    if (err.statusCode === 404) return res.status(404).json({ error: 'Signal not found.' })
    console.error('[HubSpot] Airtable fetch error:', err.message)
    return res.status(500).json({ error: 'Failed to fetch signal from Airtable.' })
  }

  // 2. Guard: already pushed
  if (signal.hubspot_pushed) {
    return res.status(409).json({ error: 'Contact has already been pushed to HubSpot.' })
  }

  // 3. Parse contact info
  const { email, firstName, lastName, jobTitle } = parseContactInfo(signal.contact_info)

  if (!email) {
    return res.status(422).json({ error: 'No email address found in contact_info. Cannot push to HubSpot without an email.' })
  }

  // 4. Build HubSpot properties payload
  const properties = { email }
  if (firstName)          properties.firstname   = firstName
  if (lastName)           properties.lastname    = lastName
  if (jobTitle)           properties.jobtitle    = jobTitle
  if (signal.company_name) properties.company   = signal.company_name

  // 5. Call HubSpot Contacts API
  let hubspotRes
  try {
    hubspotRes = await fetch('https://api.hubapi.com/crm/v3/objects/contacts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.HUBSPOT_TOKEN}`,
      },
      body: JSON.stringify({ properties }),
    })
  } catch (err) {
    console.error('[HubSpot] Network error calling HubSpot API:', err.message)
    return res.status(502).json({ error: 'Failed to reach HubSpot API. Check your internet connection.' })
  }

  // 6. Handle HubSpot response
  if (hubspotRes.status === 409) {
    // Contact already exists in HubSpot — still mark as pushed so button disables
    await updateHubspotPushed(id).catch(e => console.error('[HubSpot] Airtable update failed after 409:', e.message))
    return res.status(200).json({ message: 'Contact already exists in HubSpot. Marked as pushed.' })
  }

  if (!hubspotRes.ok) {
    const body = await hubspotRes.json().catch(() => ({}))
    console.error('[HubSpot] API error:', hubspotRes.status, body)
    return res.status(hubspotRes.status).json({
      error: body.message || `HubSpot returned ${hubspotRes.status}.`,
    })
  }

  // 7. Success — mark pushed in Airtable
  const data = await hubspotRes.json().catch(() => ({}))

  try {
    await updateHubspotPushed(id)
  } catch (err) {
    console.error('[HubSpot] Airtable update failed after successful push:', err.message)
    // Contact IS in HubSpot but the flag wasn't saved — return 207 so the
    // frontend knows the push worked but the record may show as un-pushed on reload.
    return res.status(207).json({
      message: 'Contact pushed to HubSpot but the pushed flag could not be saved. Refresh to confirm.',
      hubspot_id: data.id || null,
    })
  }

  return res.status(201).json({
    message: 'Contact pushed to HubSpot successfully.',
    hubspot_id: data.id || null,
  })
})

module.exports = router
