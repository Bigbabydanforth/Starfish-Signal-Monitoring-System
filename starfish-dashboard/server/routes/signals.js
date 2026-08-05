import express from 'express'
import { getAllSignals, getSignalById, updateSignalStatus, updateContactInfo, updateAcquiredCompany, updateSignalField } from '../lib/airtable.js'

const router = express.Router()

const VALID_STATUSES = ['New', 'In Progress', 'Contacted', 'Won', 'Not a Fit']

const VALID_SIGNAL_TYPES = [
  'Job Change',
  'M&A Activity',
  'Brand Strategy Intent',
  'Website Visitor',
  'News/Press',
  'Rebrand',
  'Funding',
]

const VALID_PRIORITIES = ['HIGH', 'MEDIUM', 'LOW']

// GET /api/signals — fetch signals with optional server-side filtering
router.get('/', async (req, res) => {
  const { types, priorities, limit } = req.query

  const signalTypes = types
    ? types.split(',').map(t => t.trim()).filter(t => VALID_SIGNAL_TYPES.includes(t))
    : []

  const priorityList = priorities
    ? priorities.split(',').map(p => p.trim()).filter(p => VALID_PRIORITIES.includes(p))
    : []

  const maxRecords = Math.min(parseInt(limit) || 10000, 10000)

  try {
    const signals = await getAllSignals({ signalTypes, priorities: priorityList, limit: maxRecords })
    res.status(200).json({ signals, total: signals.length })
  } catch (err) {
    console.error('[GET /api/signals] Airtable error:', err.message)
    res.status(500).json({ error: 'Failed to fetch signals' })
  }
})

// GET /api/signals/:id — fetch single signal by Airtable record ID
router.get('/:id', async (req, res) => {
  const { id } = req.params

  try {
    const signal = await getSignalById(id)
    res.status(200).json({ signal })
  } catch (err) {
    if (err.statusCode === 404 || err.message?.includes('Record not found')) {
      return res.status(404).json({ error: 'Signal not found' })
    }
    console.error('[GET /api/signals/:id] Airtable error:', err.message)
    res.status(500).json({ error: 'Failed to fetch signal' })
  }
})

// PATCH /api/signals/:id/status — update Status field
router.patch('/:id/status', async (req, res) => {
  const { id } = req.params
  const { status } = req.body

  if (!VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'Invalid status value' })
  }

  try {
    await updateSignalStatus(id, status)
    res.status(200).json({ success: true })
  } catch (err) {
    console.error('[PATCH /api/signals/:id/status] Airtable error:', err.message)
    res.status(500).json({ error: 'Failed to update status' })
  }
})

// PATCH /api/signals/:id/contact — save manually-entered contact info to Airtable
// Body: { name, title, email, linkedin } — all optional but at least one must be present.
// Builds the same Contact Info text format the pipeline uses so parseContactInfo() works.
router.patch('/:id/contact', async (req, res) => {
  const { id } = req.params
  const { name, title, email, linkedin } = req.body

  // Must have at least a name or email to be useful
  if (!name?.trim() && !email?.trim()) {
    return res.status(400).json({ error: 'At least a name or email is required.' })
  }

  // Basic email format check
  if (email?.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    return res.status(400).json({ error: 'Please enter a valid email address.' })
  }

  // Build Contact Info in the same format the pipeline writes
  const lines = []
  if (name?.trim())     lines.push(name.trim())
  if (title?.trim())    lines.push(title.trim())
  if (email?.trim())    lines.push(`Email: ${email.trim()}`)
  if (linkedin?.trim()) lines.push(`LinkedIn: ${linkedin.trim()}`)
  const contactInfo = lines.join('\n')

  try {
    await updateContactInfo(id, contactInfo)
    res.status(200).json({ success: true, contact_info: contactInfo })
  } catch (err) {
    if (err.statusCode === 404 || err.message?.includes('Record not found')) {
      return res.status(404).json({ error: 'Signal not found.' })
    }
    console.error('[PATCH /api/signals/:id/contact] Airtable error:', err.message)
    res.status(500).json({ error: 'Failed to save contact info.' })
  }
})

// PATCH /api/signals/:id/acquired-company — save acquired company name for M&A signals
router.patch('/:id/acquired-company', async (req, res) => {
  const { id } = req.params
  const { acquired_company } = req.body

  if (!acquired_company?.trim()) {
    return res.status(400).json({ error: 'Acquired company name is required.' })
  }

  try {
    await updateAcquiredCompany(id, acquired_company.trim())
    res.status(200).json({ success: true, acquired_company: acquired_company.trim() })
  } catch (err) {
    if (err.statusCode === 404 || err.message?.includes('Record not found')) {
      return res.status(404).json({ error: 'Signal not found.' })
    }
    console.error('[PATCH /api/signals/:id/acquired-company] Airtable error:', err.message)
    res.status(500).json({ error: 'Failed to save acquired company.' })
  }
})

// Airtable record IDs: "rec" + 10–17 alphanumeric characters
const AIRTABLE_ID_REGEX = /^rec[A-Za-z0-9]{10,17}$/

/**
 * PATCH /api/signals/:id/field
 *
 * Updates a single editable field on a signal record in Airtable.
 * Only allows specific fields — never arbitrary field names (injection risk).
 * Used by the inline edit fields on the Signal Detail validation banner.
 */
router.patch('/:id/field', async (req, res) => {
  const { id } = req.params
  const { field, value } = req.body

  console.log(`[PATCH /api/signals/${id}/field] Updating field: ${field}`)

  if (!AIRTABLE_ID_REGEX.test(id)) {
    return res.status(400).json({ success: false, error: 'Invalid signal ID format' })
  }

  // Allowlist — ONLY these fields may be updated via this endpoint
  const ALLOWED_FIELDS = ['industry', 'acquired_company', 'acquired_company_industry']
  if (!ALLOWED_FIELDS.includes(field)) {
    console.log(`[PATCH /api/signals/${id}/field] Rejected — field "${field}" not in allowlist`)
    return res.status(400).json({ success: false, error: `Field "${field}" cannot be edited` })
  }

  if (!value || typeof value !== 'string' || value.trim().length === 0) {
    return res.status(400).json({ success: false, error: 'Value must be a non-empty string' })
  }

  if (value.trim().length > 200) {
    return res.status(400).json({ success: false, error: 'Value must be 200 characters or less' })
  }

  try {
    await updateSignalField(id, field, value.trim())
    console.log(`[PATCH /api/signals/${id}/field] ✓ Updated ${field} for signal ${id}`)
    return res.json({ success: true })
  } catch (err) {
    console.log(`[PATCH /api/signals/${id}/field] Airtable update failed: ${err.message}`)
    return res.status(500).json({ success: false, error: 'Failed to save. Please try again.' })
  }
})

export default router
