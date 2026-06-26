// Airtable client — server-side only
// Used by Express routes to read/write signals

const Airtable = require('airtable')
const { parseContactInfo } = require('./parseContact')

if (!process.env.AIRTABLE_API_KEY || !process.env.AIRTABLE_BASE_ID) {
  throw new Error('Missing required env vars: AIRTABLE_API_KEY and AIRTABLE_BASE_ID must be set in server/.env')
}

const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY })
  .base(process.env.AIRTABLE_BASE_ID)

const TABLE = process.env.AIRTABLE_TABLE_NAME || 'Signals'

// Safely escape a value for use inside an Airtable formula string literal
function escapeFormula(val) {
  return String(val).replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

function mapRecord(record) {
  return {
    id: record.id,
    company_name: record.get('Company Name') || null,
    signal_type: record.get('Signal Type') || null,
    signal_details: record.get('Signal Details') || null,
    contact_info: record.get('Contact Info') || null,
    company_revenue: record.get('Company Revenue') || null,
    company_funding_stage: record.get('Company Funding Stage') || null,
    industry: record.get('Industry') || null,
    date_detected: record.get('Date Detected') || null,
    priority: record.get('Priority') || 'MEDIUM',
    brief: record.get('Brief') || null,
    contact_approach: record.get('Contact Approach') || null,
    source_url: record.get('Source URL') || null,
    status: record.get('Status') || 'New',
    hubspot_pushed: record.get('HubSpot Pushed') || false,
    send_day: record.get('Send Day') || null,
    created_at: record.get('Created At') || null,
  }
}

// ── Internal fetch — always hits Airtable, no caching logic here ───────────────
async function fetchFromAirtable({ signalTypes = [], priorities = [], limit = 10000 } = {}) {
  const conditions = []

  if (signalTypes.length > 0) {
    const clauses = signalTypes.map(t => `{Signal Type}='${escapeFormula(t)}'`)
    conditions.push(clauses.length === 1 ? clauses[0] : `OR(${clauses.join(',')})`)
  }
  if (priorities.length > 0) {
    const clauses = priorities.map(p => `{Priority}='${escapeFormula(p)}'`)
    conditions.push(clauses.length === 1 ? clauses[0] : `OR(${clauses.join(',')})`)
  }

  // Sort by Created At ascending — matches Airtable's auto-number (#) order.
  const selectOptions = {
    sort: [{ field: 'Created At', direction: 'asc' }],
    maxRecords: Math.min(limit, 10000),
  }
  if (conditions.length > 0) {
    selectOptions.filterByFormula = conditions.length === 1
      ? conditions[0]
      : `AND(${conditions.join(',')})`
  }

  const records = await base(TABLE).select(selectOptions).all()
  return records.map(mapRecord)
}

// signalTypes: string[] — filters to only those signal types (server-side)
// priorities:  string[] — filters to only those priority levels (server-side)
// limit:       max records Airtable will return (hard-capped at 10000)
//
// Caching strategy — stale-while-revalidate:
//   • Fresh cache  (< 5 min old) → return immediately, no Airtable call
//   • Stale cache  (≥ 5 min old) → return stale data immediately, refresh in background
//   • No cache yet              → wait for Airtable (first load after server start)
async function getAllSignals({ signalTypes = [], priorities = [], limit = 10000 } = {}) {
  const key = [...signalTypes].sort().join(',') + '|' + [...priorities].sort().join(',')
  const cached = signalsCache.get(key)
  const now = Date.now()

  if (cached) {
    if (now - cached.fetchedAt < SIGNALS_CACHE_TTL_MS) {
      // Fresh — return immediately
      return cached.signals
    }
    // Stale — serve immediately, refresh in background
    fetchFromAirtable({ signalTypes, priorities, limit })
      .then(signals => signalsCache.set(key, { signals, fetchedAt: Date.now() }))
      .catch(err => console.error('[airtable] background refresh failed:', err))
    return cached.signals
  }

  // No cache yet — must wait (happens once after server start)
  const signals = await fetchFromAirtable({ signalTypes, priorities, limit })
  signalsCache.set(key, { signals, fetchedAt: Date.now() })
  return signals
}

// Pre-warm the cache on server startup so the first user request is fast.
// Called from server.js after app.listen(). Best-effort — errors are logged, not thrown.
function warmSignalsCache() {
  getAllSignals().catch(err => console.error('[airtable] cache warm-up failed:', err))
}

// ── Signals cache ──────────────────────────────────────────────────────────────
// Keyed by serialised filter params. Stale-while-revalidate: if the cache is
// older than the TTL, return the stale data immediately and refresh in the
// background so the *next* request is fast.
const signalsCache = new Map()
const SIGNALS_CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

// ── In-memory cache for BSI broadcast contacts — keyed by company name.
// Expires after 5 minutes so stale data doesn't persist too long.
const bsiCache = new Map()
const BSI_CACHE_TTL_MS = 5 * 60 * 1000

// Fetch all BSI records for a company (used to build the broadcast contacts table)
async function getBSIBroadcastContacts(companyName) {
  const cached = bsiCache.get(companyName)
  if (cached && Date.now() - cached.fetchedAt < BSI_CACHE_TTL_MS) {
    return cached.contacts
  }

  const formula = `AND({Signal Type}='Brand Strategy Intent',{Company Name}='${escapeFormula(companyName)}')`
  const records = await base(TABLE)
    .select({
      filterByFormula: formula,
      sort: [{ field: 'Send Day', direction: 'asc' }],
    })
    .all()

  const contacts = records.map(r => {
    const info = parseContactInfo(r.get('Contact Info'))
    return {
      id: r.id,
      send_day: r.get('Send Day') || null,
      name: info.name,
      title: info.title,
      email: info.email,
      linkedin: info.linkedin,
    }
  })

  bsiCache.set(companyName, { contacts, fetchedAt: Date.now() })
  return contacts
}

async function getSignalById(id) {
  const record = await base(TABLE).find(id)
  const signal = mapRecord(record)

  // For BSI signals, attach all broadcast contacts as a structured array
  if (signal.signal_type === 'Brand Strategy Intent' && signal.company_name) {
    signal.bsi_contacts = await getBSIBroadcastContacts(signal.company_name)
  } else {
    signal.bsi_contacts = null
  }

  return signal
}

async function updateSignalStatus(id, status) {
  await base(TABLE).update(id, { Status: status })
  signalsCache.clear() // invalidate so next load reflects the change
}

async function updateHubspotPushed(id) {
  await base(TABLE).update(id, { 'HubSpot Pushed': true })
  signalsCache.clear()
}

module.exports = { getAllSignals, getSignalById, updateSignalStatus, updateHubspotPushed, warmSignalsCache }
