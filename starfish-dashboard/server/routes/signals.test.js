// Signals route — validation logic tests
// Uses Node's built-in test runner: node --test routes/signals.test.js

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')

// ── Constants mirrored from signals.js ────────────────────────────────────────

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

// ── Helpers that mirror route logic ───────────────────────────────────────────

function parseTypes(typesParam) {
  if (!typesParam) return []
  return typesParam.split(',').map(t => t.trim()).filter(t => VALID_SIGNAL_TYPES.includes(t))
}

function parsePriorities(prioritiesParam) {
  if (!prioritiesParam) return []
  return prioritiesParam.split(',').map(p => p.trim()).filter(p => VALID_PRIORITIES.includes(p))
}

function parseLimit(limitParam) {
  return Math.min(parseInt(limitParam) || 500, 2000)
}

function isValidStatus(status) {
  return VALID_STATUSES.includes(status)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/signals — query param validation', () => {

  it('returns empty array when types param is missing', () => {
    assert.deepEqual(parseTypes(undefined), [])
  })

  it('returns empty array when types param is empty string', () => {
    assert.deepEqual(parseTypes(''), [])
  })

  it('parses a single valid signal type', () => {
    assert.deepEqual(parseTypes('Rebrand'), ['Rebrand'])
  })

  it('parses multiple valid signal types', () => {
    const result = parseTypes('Job Change,Rebrand')
    assert.deepEqual(result, ['Job Change', 'Rebrand'])
  })

  it('strips out invalid signal types silently', () => {
    const result = parseTypes("Job Change,INVALID_TYPE,'; DROP TABLE--")
    assert.deepEqual(result, ['Job Change'])
  })

  it('handles types with extra whitespace', () => {
    assert.deepEqual(parseTypes('Job Change , Rebrand'), ['Job Change', 'Rebrand'])
  })

  it('returns empty array when priorities param is missing', () => {
    assert.deepEqual(parsePriorities(undefined), [])
  })

  it('parses a valid priority', () => {
    assert.deepEqual(parsePriorities('HIGH'), ['HIGH'])
  })

  it('parses multiple valid priorities', () => {
    assert.deepEqual(parsePriorities('HIGH,LOW'), ['HIGH', 'LOW'])
  })

  it('strips invalid priorities', () => {
    assert.deepEqual(parsePriorities('HIGH,URGENT,CRITICAL'), ['HIGH'])
  })

  it('defaults limit to 500 when not provided', () => {
    assert.equal(parseLimit(undefined), 500)
  })

  it('defaults limit to 500 when NaN', () => {
    assert.equal(parseLimit('abc'), 500)
  })

  it('respects a provided limit', () => {
    assert.equal(parseLimit('200'), 200)
  })

  it('hard-caps limit at 2000', () => {
    assert.equal(parseLimit('99999'), 2000)
  })

})

describe('PATCH /api/signals/:id/status — status validation', () => {

  it('accepts all valid statuses', () => {
    for (const s of VALID_STATUSES) {
      assert.equal(isValidStatus(s), true, `Expected "${s}" to be valid`)
    }
  })

  it('rejects an unknown status', () => {
    assert.equal(isValidStatus('Pending'), false)
  })

  it('rejects empty string', () => {
    assert.equal(isValidStatus(''), false)
  })

  it('rejects null', () => {
    assert.equal(isValidStatus(null), false)
  })

  it('is case-sensitive — rejects lowercase', () => {
    assert.equal(isValidStatus('new'), false)
    assert.equal(isValidStatus('won'), false)
  })

  it('rejects injection attempts', () => {
    assert.equal(isValidStatus("'; DROP TABLE signals;--"), false)
  })

})
