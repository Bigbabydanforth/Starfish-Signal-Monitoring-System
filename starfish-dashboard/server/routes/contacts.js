// contacts.js
// POST /api/contacts/add
//
// Creates a signal record in Airtable from manually entered contact data,
// then pushes the contact to HubSpot immediately.
//
// All fields are validated server-side — never trust client validation alone.
// Mounted at /api/contacts in app.js → full path: POST /api/contacts/add

import express from 'express'
import { createSignal, updateHubspotPushed } from '../lib/airtable.js'

const router = express.Router()

const VALID_SIGNAL_TYPES = [
  'Job Change',
  'M&A Activity',
  'Brand Strategy Intent',
  'Website Visitor',
  'News/Press',
  'Rebrand',
]

const VALID_PRIORITIES = ['HIGH', 'MEDIUM', 'LOW']

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// Maps our signal type strings to HubSpot's signal_data dropdown enum values
const SIGNAL_TYPE_MAP = {
  'Job Change':            'job_change',
  'M&A Activity':          'm_and_a',
  'News/Press':            'news_press_release',
  'Rebrand':               'rebrand',
  'Website Visitor':       'website_visitor',
  'Brand Strategy Intent': 'brand_strategy_intent',
}

// POST /api/contacts/add
router.post('/add', async (req, res) => {
  console.log('[POST /api/contacts/add] Request received')

  const {
    firstName,
    lastName,
    email,
    title,
    companyName,
    companyWebsite,
    industry,
    signalType,
    priority,
    notes,
  } = req.body

  // ── Server-side validation ────────────────────────────────────────────────
  const errors = []
  if (!firstName?.trim())                              errors.push('First Name is required')
  if (!lastName?.trim())                               errors.push('Last Name is required')
  if (!email?.trim() || !EMAIL_REGEX.test(email.trim())) errors.push('A valid email address is required')
  if (!title?.trim())                                  errors.push('Job Title is required')
  if (!companyName?.trim())                            errors.push('Company Name is required')
  if (!VALID_SIGNAL_TYPES.includes(signalType))        errors.push('A valid Signal Type is required')
  if (!VALID_PRIORITIES.includes(priority))            errors.push('A valid Priority is required')
  if (companyWebsite?.trim() && !/^https?:\/\//i.test(companyWebsite.trim())) {
    errors.push('Company Website must start with http:// or https://')
  }
  if (notes && notes.length > 2000) errors.push('Notes must be 2,000 characters or less')

  if (errors.length > 0) {
    console.log('[POST /api/contacts/add] Validation failed:', errors)
    return res.status(400).json({ success: false, errors, error: errors[0] })
  }

  const fullName = `${firstName.trim()} ${lastName.trim()}`

  // Build Contact Info in the same format the pipeline writes
  const contactInfo = [
    `Name: ${fullName}`,
    `Title: ${title.trim()}`,
    `Email: ${email.trim()}`,
    companyWebsite?.trim() ? `Website: ${companyWebsite.trim()}` : null,
  ].filter(Boolean).join('\n')

  // ── Step 1: Save to Airtable ──────────────────────────────────────────────
  let savedRecord
  try {
    savedRecord = await createSignal({
      'Company Name':    companyName.trim(),
      'Signal Type':     signalType,
      'Signal Details':  notes?.trim() || `Manually added contact: ${fullName} — ${title.trim()}`,
      'Contact Info':    contactInfo,
      'Industry':        industry?.trim()         || null,
      'Date Detected':   new Date().toISOString().split('T')[0],
      'Priority':        priority,
      'Brief':           `Manually added contact. ${fullName} is ${title.trim()} at ${companyName.trim()}.`,
      'Contact Approach': 'Manually added — reach out directly.',
      'Source URL':      companyWebsite?.trim()   || null,
      'Status':          'New',
    })
    console.log(`[POST /api/contacts/add] Saved to Airtable: id=${savedRecord.id}`)
  } catch (err) {
    console.error(`[POST /api/contacts/add] Airtable save failed: ${err.message}`)
    return res.status(500).json({ success: false, error: 'Failed to save contact to Airtable. Please try again.' })
  }

  // ── Step 2: Push to HubSpot ───────────────────────────────────────────────
  if (!process.env.HUBSPOT_TOKEN) {
    // HubSpot not configured — still return success since Airtable save worked
    console.warn('[POST /api/contacts/add] HUBSPOT_TOKEN not set — skipping HubSpot push')
    return res.status(201).json({
      success: true,
      signalId: savedRecord.id,
      hubspotWarning: 'Contact saved but HubSpot push skipped — HUBSPOT_TOKEN not configured.',
    })
  }

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${process.env.HUBSPOT_TOKEN}`,
  }

  // Search by email first to avoid duplicates.
  // If the search fails (network error or non-OK response), log it and fall through
  // to a CREATE attempt — HubSpot's own 409 response is the safety net if the
  // contact already exists.
  let existingId = null
  try {
    const searchRes = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/search', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email.trim() }] }],
        limit: 1,
        properties: ['email'],
      }),
    })
    if (searchRes.ok) {
      const searchData = await searchRes.json()
      if (searchData.results?.length > 0) existingId = searchData.results[0].id
    } else {
      // Non-OK but not a network error — log the status so it's visible in Railway logs
      console.warn(`[POST /api/contacts/add] HubSpot search returned ${searchRes.status} — falling through to create`)
    }
  } catch (err) {
    console.warn('[POST /api/contacts/add] HubSpot search network error — falling through to create:', err.message)
  }

  const properties = {
    email:               email.trim(),
    firstname:           firstName.trim(),
    lastname:            lastName.trim(),
    jobtitle:            title.trim(),
    company:             companyName.trim(),
    signal_data:         SIGNAL_TYPE_MAP[signalType] || signalType,
    signal_priority:     priority,
    hubspot_pushed_date: new Date().toISOString().split('T')[0],
  }
  if (companyWebsite?.trim()) properties.website          = companyWebsite.trim()
  if (notes?.trim())          properties.signal_brief     = notes.trim().slice(0, 1000)
  if (industry?.trim())       properties.company_industry = industry.trim()

  let hubspotRes, action
  try {
    if (existingId) {
      hubspotRes = await fetch(`https://api.hubapi.com/crm/v3/objects/contacts/${existingId}`, {
        method: 'PATCH', headers, body: JSON.stringify({ properties }),
      })
      action = 'updated'
    } else {
      hubspotRes = await fetch('https://api.hubapi.com/crm/v3/objects/contacts', {
        method: 'POST', headers, body: JSON.stringify({ properties }),
      })
      action = 'created'
    }
  } catch (err) {
    console.error('[POST /api/contacts/add] HubSpot network error:', err.message)
    return res.status(201).json({
      success: true,
      signalId: savedRecord.id,
      hubspotWarning: 'Contact saved to Airtable but HubSpot push failed. You can push manually from the signal detail page.',
    })
  }

  if (hubspotRes.status === 409) {
    // Contact already in HubSpot — mark as pushed in Airtable
    await updateHubspotPushed(savedRecord.id).catch(() => {})
    return res.status(201).json({ success: true, signalId: savedRecord.id, action: 'already_exists' })
  }

  if (!hubspotRes.ok) {
    const body = await hubspotRes.json().catch(() => ({}))
    console.error('[POST /api/contacts/add] HubSpot error:', hubspotRes.status, body)
    return res.status(201).json({
      success: true,
      signalId: savedRecord.id,
      hubspotWarning: `Contact saved to Airtable but HubSpot push failed: ${body.message || hubspotRes.status}. You can push manually from the signal detail page.`,
    })
  }

  const data = await hubspotRes.json().catch(() => ({}))
  const contactId = data.id || existingId

  // Mark as pushed in Airtable
  await updateHubspotPushed(savedRecord.id).catch(err =>
    console.error('[POST /api/contacts/add] Failed to mark hubspot_pushed in Airtable:', err.message)
  )

  console.log(`[POST /api/contacts/add] Complete: ${email} → Airtable (${savedRecord.id}) + HubSpot (${contactId}) [${action}]`)

  return res.status(201).json({
    success: true,
    signalId: savedRecord.id,
    hubspot_id: contactId,
    action,
  })
})

export default router
