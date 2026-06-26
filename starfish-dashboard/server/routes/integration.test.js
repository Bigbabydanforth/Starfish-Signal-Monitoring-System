// Integration tests — fire real HTTP requests at the Express app.
// Airtable and HubSpot are mocked so tests run offline and never touch live data.
// Run: node --test routes/integration.test.js

const { describe, it, before, mock } = require('node:test')
const assert = require('node:assert/strict')

// ── Mock Airtable before app loads ────────────────────────────────────────────
// We intercept require('airtable') so no real API calls are made.

const FAKE_SIGNAL = {
  id: 'recABC123',
  company_name: 'Acme Corp',
  signal_type: 'Job Change',
  signal_details: 'New CMO hired',
  contact_info: 'Jane Doe\nCMO\njane@acme.com\nhttps://linkedin.com/in/janedoe',
  company_revenue: '5000000',
  company_funding_stage: 'Series A',
  industry: 'Technology',
  date_detected: '2026-06-19',
  priority: 'HIGH',
  brief: 'New CMO is a brand buyer.',
  contact_approach: 'Lead with brand research.',
  source_url: 'https://example.com/news/acme',
  status: 'New',
  hubspot_pushed: false,
  send_day: null,
  created_at: '2026-06-19T00:00:00.000Z',
  bsi_contacts: null,
}

const FAKE_BSI_SIGNAL = {
  ...FAKE_SIGNAL,
  id: 'recBSI999',
  signal_type: 'Brand Strategy Intent',
  hubspot_pushed: false,
  bsi_contacts: [
    { id: 'recC1', send_day: 1, name: 'Alice Smith', title: 'VP Marketing', email: 'alice@acme.com', linkedin: null },
  ],
}

const FAKE_PUSHED_SIGNAL = {
  ...FAKE_SIGNAL,
  id: 'recPUSHED1',
  hubspot_pushed: true,
}

const FAKE_NO_EMAIL_SIGNAL = {
  ...FAKE_SIGNAL,
  id: 'recNOEMAIL',
  contact_info: 'John Doe\nCEO\nNo email here',
}

// Simple mock store — tests can swap getSignalById behaviour per-test
let signalStore = {
  recABC123:   FAKE_SIGNAL,
  recBSI999:   FAKE_BSI_SIGNAL,
  recPUSHED1:  FAKE_PUSHED_SIGNAL,
  recNOEMAIL:  FAKE_NO_EMAIL_SIGNAL,
}

// Patch require cache before importing app
const Module = require('module')
const originalLoad = Module._load.bind(Module)
Module._load = function (request, parent, isMain) {
  if (request === 'airtable') {
    // Return a constructor that satisfies: new Airtable({...}).base(id)
    function FakeAirtable() {}
    FakeAirtable.prototype.base = () => (tableName) => ({
      select: () => ({ all: async () => [buildFakeRecord(FAKE_SIGNAL)] }),
      find:   async (id) => {
        const sig = signalStore[id]
        if (!sig) {
          const err = new Error(`Record not found: ${id}`)
          err.statusCode = 404
          throw err
        }
        return buildFakeRecord(sig)
      },
      update: async () => {},
    })
    return FakeAirtable
  }
  return originalLoad(request, parent, isMain)
}

// Build a fake Airtable record object from a plain signal object
function buildFakeRecord(sig) {
  const fields = {
    'Company Name':        sig.company_name,
    'Signal Type':         sig.signal_type,
    'Signal Details':      sig.signal_details,
    'Contact Info':        sig.contact_info,
    'Company Revenue':     sig.company_revenue,
    'Company Funding Stage': sig.company_funding_stage,
    'Industry':            sig.industry,
    'Date Detected':       sig.date_detected,
    'Priority':            sig.priority,
    'Brief':               sig.brief,
    'Contact Approach':    sig.contact_approach,
    'Source URL':          sig.source_url,
    'Status':              sig.status,
    'HubSpot Pushed':      sig.hubspot_pushed,
    'Send Day':            sig.send_day,
    'Created At':          sig.created_at,
  }
  return { id: sig.id, get: (key) => fields[key] ?? null }
}

// ── Load app after mocks are in place ────────────────────────────────────────
const request = require('supertest')
const app     = require('../app')

// CSRF header required on all POST/PATCH
const CSRF = { 'X-Requested-With': 'XMLHttpRequest' }

// ── Health check ──────────────────────────────────────────────────────────────

describe('GET /health', () => {
  it('returns 200 with status ok', async () => {
    const res = await request(app).get('/health')
    assert.equal(res.status, 200)
    assert.equal(res.body.status, 'ok')
  })
})

// ── GET /api/signals ──────────────────────────────────────────────────────────

describe('GET /api/signals', () => {
  it('returns 200 with a signals array', async () => {
    const res = await request(app).get('/api/signals')
    assert.equal(res.status, 200)
    assert.ok(Array.isArray(res.body.signals))
  })

  it('response includes expected signal fields', async () => {
    const res = await request(app).get('/api/signals')
    const signal = res.body.signals[0]
    assert.ok('id' in signal)
    assert.ok('company_name' in signal)
    assert.ok('signal_type' in signal)
    assert.ok('priority' in signal)
    assert.ok('status' in signal)
    assert.ok('hubspot_pushed' in signal)
  })

  it('returns total count in response', async () => {
    const res = await request(app).get('/api/signals')
    assert.ok(typeof res.body.total === 'number')
  })

  it('ignores unknown query params safely', async () => {
    const res = await request(app).get('/api/signals?foo=bar&hack=true')
    assert.equal(res.status, 200)
  })

  it('accepts valid types filter without error', async () => {
    const res = await request(app).get('/api/signals?types=Job+Change')
    assert.equal(res.status, 200)
  })

  it('accepts valid priorities filter without error', async () => {
    const res = await request(app).get('/api/signals?priorities=HIGH')
    assert.equal(res.status, 200)
  })

  it('accepts combined type and priority filters', async () => {
    const res = await request(app).get('/api/signals?types=Rebrand&priorities=HIGH,LOW')
    assert.equal(res.status, 200)
  })
})

// ── GET /api/signals/:id ──────────────────────────────────────────────────────

describe('GET /api/signals/:id', () => {
  it('returns 200 and the signal for a known id', async () => {
    const res = await request(app).get('/api/signals/recABC123')
    assert.equal(res.status, 200)
    assert.equal(res.body.signal.id, 'recABC123')
    assert.equal(res.body.signal.company_name, 'Acme Corp')
  })

  it('returns 404 for an unknown id', async () => {
    const res = await request(app).get('/api/signals/recDOESNOTEXIST')
    assert.equal(res.status, 404)
    assert.ok(res.body.error)
  })

  it('returned signal includes all expected fields', async () => {
    const res = await request(app).get('/api/signals/recABC123')
    const s = res.body.signal
    ;['id','company_name','signal_type','priority','status','hubspot_pushed','bsi_contacts'].forEach(field => {
      assert.ok(field in s, `Missing field: ${field}`)
    })
  })
})

// ── PATCH /api/signals/:id/status ────────────────────────────────────────────

describe('PATCH /api/signals/:id/status', () => {
  it('returns 200 for a valid status update', async () => {
    const res = await request(app)
      .patch('/api/signals/recABC123/status')
      .set(CSRF)
      .send({ status: 'In Progress' })
    assert.equal(res.status, 200)
    assert.equal(res.body.success, true)
  })

  it('accepts all valid statuses', async () => {
    const VALID = ['New', 'In Progress', 'Contacted', 'Won', 'Not a Fit']
    for (const status of VALID) {
      const res = await request(app)
        .patch('/api/signals/recABC123/status')
        .set(CSRF)
        .send({ status })
      assert.equal(res.status, 200, `Status "${status}" should be accepted`)
    }
  })

  it('returns 400 for an invalid status', async () => {
    const res = await request(app)
      .patch('/api/signals/recABC123/status')
      .set(CSRF)
      .send({ status: 'Pending' })
    assert.equal(res.status, 400)
    assert.ok(res.body.error)
  })

  it('returns 400 for an empty status', async () => {
    const res = await request(app)
      .patch('/api/signals/recABC123/status')
      .set(CSRF)
      .send({ status: '' })
    assert.equal(res.status, 400)
  })

  it('returns 400 for injection attempt in status', async () => {
    const res = await request(app)
      .patch('/api/signals/recABC123/status')
      .set(CSRF)
      .send({ status: "'; DROP TABLE signals;--" })
    assert.equal(res.status, 400)
  })

  it('returns 403 when CSRF header is missing', async () => {
    const res = await request(app)
      .patch('/api/signals/recABC123/status')
      .send({ status: 'New' })
    assert.equal(res.status, 403)
  })
})

// ── POST /api/signals/:id/push-to-hubspot ────────────────────────────────────

describe('POST /api/signals/:id/push-to-hubspot', () => {
  it('returns 403 when CSRF header is missing', async () => {
    const res = await request(app)
      .post('/api/signals/recABC123/push-to-hubspot')
      .send({})
    assert.equal(res.status, 403)
  })

  it('returns 404 for unknown signal id', async () => {
    const res = await request(app)
      .post('/api/signals/recDOESNOTEXIST/push-to-hubspot')
      .set(CSRF)
      .send({})
    assert.equal(res.status, 404)
  })

  it('returns 409 when signal is already pushed', async () => {
    const res = await request(app)
      .post('/api/signals/recPUSHED1/push-to-hubspot')
      .set(CSRF)
      .send({})
    assert.equal(res.status, 409)
  })

  it('returns 422 when contact_info has no email', async () => {
    const res = await request(app)
      .post('/api/signals/recNOEMAIL/push-to-hubspot')
      .set(CSRF)
      .send({})
    assert.equal(res.status, 422)
    assert.ok(res.body.error.includes('email'))
  })

  it('returns 500 when HUBSPOT_TOKEN is not configured', async () => {
    const original = process.env.HUBSPOT_TOKEN
    delete process.env.HUBSPOT_TOKEN
    const res = await request(app)
      .post('/api/signals/recABC123/push-to-hubspot')
      .set(CSRF)
      .send({})
    assert.equal(res.status, 500)
    assert.ok(res.body.error.includes('HUBSPOT_TOKEN'))
    process.env.HUBSPOT_TOKEN = original
  })
})

// ── CSRF middleware ───────────────────────────────────────────────────────────

describe('CSRF middleware', () => {
  it('allows GET requests without the CSRF header', async () => {
    const res = await request(app).get('/api/signals')
    assert.equal(res.status, 200)
  })

  it('blocks POST without X-Requested-With header', async () => {
    const res = await request(app)
      .post('/api/signals/recABC123/push-to-hubspot')
      .send({})
    assert.equal(res.status, 403)
  })

  it('blocks PATCH without X-Requested-With header', async () => {
    const res = await request(app)
      .patch('/api/signals/recABC123/status')
      .send({ status: 'New' })
    assert.equal(res.status, 403)
  })

  it('allows POST with correct X-Requested-With header', async () => {
    // Will 422 (no email) but NOT 403 — proving CSRF check passed
    const res = await request(app)
      .post('/api/signals/recNOEMAIL/push-to-hubspot')
      .set(CSRF)
      .send({})
    assert.notEqual(res.status, 403)
  })
})
