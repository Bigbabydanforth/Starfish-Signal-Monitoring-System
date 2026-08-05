// Airtable client — server-side only
// Used by Express routes to read/write signals

import Airtable from 'airtable'
import { parseContactInfo } from './parseContact.js'

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
    acquired_company:          record.get('Acquired Company') || null,
    acquired_company_industry: record.get('Acquired Company Industry') || null,
    bespoke: record.get('Bespoke') === true,
    bespoke_reason: record.get('Bespoke Reason') || '',
    // Claude email generation fields
    claude_generated:    record.get('Claude Generated') === true,
    claude_generated_at: record.get('Claude Generated At') || null,
    ab_test_group:       record.get('AB Test Group') || null,
    proof_clients:       record.get('Proof Clients') || null,
    email_1_subject:     record.get('Email 1 Subject') || null,
    email_1_body:        record.get('Email 1 Body') || null,
    email_2_body:        record.get('Email 2 Body') || null,
    email_3_body:        record.get('Email 3 Body') || null,
    email_4_body:        record.get('Email 4 Body') || null,
    email_5_body:        record.get('Email 5 Body') || null,
    email_6_body:        record.get('Email 6 Body') || null,
    email_7_body:        record.get('Email 7 Body') || null,
  }
}

// ── Signals cache ──────────────────────────────────────────────────────────────
const signalsCache = new Map()
const SIGNALS_CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes
const SIGNALS_CACHE_MAX_AGE_MS = 10 * 60 * 1000 // prune entries older than 10 min

// ── In-memory cache for BSI broadcast contacts — keyed by company name ────────
const bsiCache = new Map()
const BSI_CACHE_TTL_MS = 5 * 60 * 1000
const BSI_CACHE_MAX_AGE_MS = 10 * 60 * 1000

// ── Cache pruner ───────────────────────────────────────────────────────────────
// Different filter combinations produce different cache keys. Without pruning,
// orphaned entries from prior filter combinations accumulate for the lifetime
// of the server process. Run every 10 minutes to clean stale entries.
function pruneStaleCache() {
  const now = Date.now()
  for (const [key, val] of signalsCache) {
    if (now - val.fetchedAt > SIGNALS_CACHE_MAX_AGE_MS) signalsCache.delete(key)
  }
  for (const [key, val] of bsiCache) {
    if (now - val.fetchedAt > BSI_CACHE_MAX_AGE_MS) bsiCache.delete(key)
  }
}
setInterval(pruneStaleCache, 10 * 60 * 1000).unref() // .unref() so the interval never blocks process exit

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

export async function getAllSignals({ signalTypes = [], priorities = [], limit = 10000 } = {}) {
  const key = [...signalTypes].sort().join(',') + '|' + [...priorities].sort().join(',')
  const cached = signalsCache.get(key)
  const now = Date.now()

  if (cached) {
    if (now - cached.fetchedAt < SIGNALS_CACHE_TTL_MS) {
      return cached.signals
    }
    fetchFromAirtable({ signalTypes, priorities, limit })
      .then(signals => signalsCache.set(key, { signals, fetchedAt: Date.now() }))
      .catch(err => console.error('[airtable] background refresh failed:', err))
    return cached.signals
  }

  const signals = await fetchFromAirtable({ signalTypes, priorities, limit })
  signalsCache.set(key, { signals, fetchedAt: Date.now() })
  return signals
}

export function warmSignalsCache() {
  getAllSignals().catch(err => console.error('[airtable] cache warm-up failed:', err))
}

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

export async function getSignalById(id) {
  const record = await base(TABLE).find(id)
  const signal = mapRecord(record)

  if (signal.signal_type === 'Brand Strategy Intent' && signal.company_name) {
    signal.bsi_contacts = await getBSIBroadcastContacts(signal.company_name)
  } else {
    signal.bsi_contacts = null
  }

  return signal
}

export async function updateSignalStatus(id, status) {
  await base(TABLE).update(id, { Status: status })
  signalsCache.clear()
  bsiCache.clear()
}

export async function updateHubspotPushed(id) {
  await base(TABLE).update(id, { 'HubSpot Pushed': true })
  signalsCache.clear()
  bsiCache.clear()
}

export async function updateContactInfo(id, contactInfo) {
  await base(TABLE).update(id, { 'Contact Info': contactInfo })
  signalsCache.clear()
  bsiCache.clear()
}

export async function updateAcquiredCompany(id, acquiredCompany) {
  await base(TABLE).update(id, { 'Acquired Company': acquiredCompany })
  signalsCache.clear()
  bsiCache.clear()
}

// updateSignalField — used by PATCH /api/signals/:id/field (inline edit on Signal Detail)
// Allowlisted field names only — never write arbitrary field names to Airtable.
export async function updateSignalField(id, fieldName, value) {
  const FIELD_MAP = {
    industry:                  'Industry',
    acquired_company:          'Acquired Company',
    acquired_company_industry: 'Acquired Company Industry',
  }
  const airtableField = FIELD_MAP[fieldName]
  if (!airtableField) throw new Error(`Unknown field: ${fieldName}`)
  await base(TABLE).update(id, { [airtableField]: value })
  signalsCache.clear()
  bsiCache.clear()
}

export async function createSignal(fields) {
  const record = await base(TABLE).create(fields)
  signalsCache.clear()
  bsiCache.clear()
  return mapRecord(record)
}
