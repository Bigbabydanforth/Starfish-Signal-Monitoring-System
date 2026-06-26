const express = require('express')
const router = express.Router()
const { getAllSignals, getSignalById, updateSignalStatus } = require('../lib/airtable')

const VALID_STATUSES = ['New', 'In Progress', 'Contacted', 'Won', 'Not a Fit']

const VALID_SIGNAL_TYPES = [
  'Job Change',
  'M&A Activity',
  'Brand Strategy Intent',
  'Website Visitor',
  'News/Press',
  'Rebrand',
]

const VALID_PRIORITIES = ['HIGH', 'MEDIUM', 'LOW']

// GET /api/signals — fetch signals with optional server-side filtering
// Query params:
//   types      — comma-separated signal types  e.g. "Job Change,Rebrand"
//   priorities — comma-separated priorities    e.g. "HIGH,MEDIUM"
//   limit      — max records to return (default 500, max 2000)
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

module.exports = router
