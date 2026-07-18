/**
 * hubspot/pushSignalToHubSpot.js
 *
 * Core function that pushes one signal contact to HubSpot:
 *   1. Creates or updates the Contact record
 *   2. Creates or updates the Company record
 *   3. Associates Contact with Company
 *   4. Sets all custom signal properties as tokens for sequences
 *
 * This function does NOT enroll the contact in a sequence.
 * Sequence enrollment happens separately from the dashboard (Prompt 15).
 * This function's job: get the right data into HubSpot so sequences
 * can reference it via tokens.
 *
 * CUSTOM PROPERTIES — must be created in HubSpot UI before this runs:
 *   Standard signal props (9):
 *     signal_type, signal_priority, signal_brief, signal_source,
 *     signal_date, send_day, contact_source, sequence_enrolled,
 *     hubspot_pushed_date
 *   Proof/portfolio props (3):
 *     proof_clients, portfolio_company, portfolio_industry
 *
 * ENV VARS REQUIRED:
 *   HUBSPOT_PRIVATE_APP_TOKEN — Private App token from HubSpot
 *   HUBSPOT_AUTO_PUSH         — "true" to enable auto-push from pipeline
 *
 * ENV VARS OPTIONAL (filled in once Zack builds sequences in HubSpot):
 *   HS_SEQ_JOB_CHANGE, HS_SEQ_NEWS_PRESS, HS_SEQ_REBRAND,
 *   HS_SEQ_MA, HS_SEQ_WEBSITE, HS_SEQ_BSI,
 *   DAVID_HUBSPOT_OWNER_ID, ZACK_HUBSPOT_OWNER_ID
 */

import 'dotenv/config';
import axios from 'axios';
import { getProofClients } from '../data/proof_clients.js';

const HUBSPOT_TOKEN    = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
const HUBSPOT_BASE_URL = 'https://api.hubapi.com';

// ── Signal type → HubSpot enum value ─────────────────────────────────────────
// signal_data in HubSpot is a dropdown with fixed internal values.
// Maps our pipeline signal type strings to those exact enum values.
const SIGNAL_TYPE_MAP = {
  'Job Change':           'job_change',
  'M&A Activity':         'm_and_a',
  'News/Press':           'news_press_release',
  'Rebrand':              'rebrand',
  'Website Visitor':      'website_visitor',
  'Brand Strategy Intent':'brand_strategy_intent',
};

// ── Sequence routing ──────────────────────────────────────────────────────────
// Maps signal type → sender + sequence ID.
// Sequence IDs are filled in after Zack builds and activates sequences in HubSpot.
// Until then, these env vars are undefined and sequence enrollment is skipped.
const SEQUENCE_ROUTING = {
  'Job Change': {
    sequenceId:  process.env.HS_SEQ_JOB_CHANGE || null,
    ownerEmail:  'david@starfishco.com',
    ownerId:     process.env.DAVID_HUBSPOT_OWNER_ID || null,
  },
  'News/Press': {
    sequenceId:  process.env.HS_SEQ_NEWS_PRESS || null,
    ownerEmail:  'david@starfishco.com',
    ownerId:     process.env.DAVID_HUBSPOT_OWNER_ID || null,
  },
  'Rebrand': {
    sequenceId:  process.env.HS_SEQ_REBRAND || null,
    ownerEmail:  'david@starfishco.com',
    ownerId:     process.env.DAVID_HUBSPOT_OWNER_ID || null,
  },
  'M&A Activity': {
    sequenceId:  process.env.HS_SEQ_MA || null,
    ownerEmail:  'zack@starfishco.com',
    ownerId:     process.env.ZACK_HUBSPOT_OWNER_ID || null,
  },
  'Website Visitor': {
    sequenceId:  process.env.HS_SEQ_WEBSITE || null,
    ownerEmail:  'zack@starfishco.com',
    ownerId:     process.env.ZACK_HUBSPOT_OWNER_ID || null,
  },
  'Brand Strategy Intent': {
    sequenceId:  process.env.HS_SEQ_BSI || null,
    ownerEmail:  'zack@starfishco.com',
    ownerId:     process.env.ZACK_HUBSPOT_OWNER_ID || null,
  },
};

// ── Centralized Axios wrapper ─────────────────────────────────────────────────
// Handles auth, content-type, and consistent error logging.
async function hubspotRequest(method, endpoint, data = null) {
  if (!HUBSPOT_TOKEN) throw new Error('HUBSPOT_PRIVATE_APP_TOKEN is not set in environment variables');
  const config = {
    method,
    url: `${HUBSPOT_BASE_URL}${endpoint}`,
    headers: {
      Authorization:  `Bearer ${HUBSPOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    timeout: 15000,
  };
  if (data) config.data = data;
  return axios(config);
}

// ── Find or create contact ────────────────────────────────────────────────────
// Searches by email. Updates if found, creates if not.
// Returns HubSpot contact ID string.
async function findOrCreateContact(email, properties) {
  try {
    const searchRes = await hubspotRequest('POST', '/crm/v3/objects/contacts/search', {
      filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
      limit: 1,
      properties: ['email', 'firstname', 'lastname'],
    });

    if (searchRes.data.results.length > 0) {
      const contactId = searchRes.data.results[0].id;
      console.log(`  [HubSpot] Found existing contact for ${email} (id: ${contactId}) — updating`);
      await hubspotRequest('PATCH', `/crm/v3/objects/contacts/${contactId}`, { properties });
      return contactId;
    }
  } catch (searchErr) {
    // Search failed — attempt to create anyway
    console.log(`  [HubSpot] Contact search failed for ${email}: ${searchErr.message} — attempting create`);
  }

  const createRes = await hubspotRequest('POST', '/crm/v3/objects/contacts', { properties });
  const newId = createRes.data.id;
  console.log(`  [HubSpot] Created new contact for ${email} (id: ${newId})`);
  return newId;
}

// ── Find or create company ────────────────────────────────────────────────────
// Searches by company name. Non-fatal — returns null on failure.
async function findOrCreateCompany(companyName, companyProperties) {
  try {
    const searchRes = await hubspotRequest('POST', '/crm/v3/objects/companies/search', {
      filterGroups: [{ filters: [{ propertyName: 'name', operator: 'EQ', value: companyName }] }],
      limit: 1,
    });

    if (searchRes.data.results.length > 0) {
      const companyId = searchRes.data.results[0].id;
      await hubspotRequest('PATCH', `/crm/v3/objects/companies/${companyId}`, { properties: companyProperties });
      console.log(`  [HubSpot] Updated existing company: ${companyName} (id: ${companyId})`);
      return companyId;
    }

    const createRes = await hubspotRequest('POST', '/crm/v3/objects/companies', { properties: companyProperties });
    const newId = createRes.data.id;
    console.log(`  [HubSpot] Created new company: ${companyName} (id: ${newId})`);
    return newId;
  } catch (err) {
    // Company failure is non-fatal — contact still lands in HubSpot without a company link
    console.log(`  [HubSpot] Company create/update warning for ${companyName}: ${err.message}`);
    return null;
  }
}

// ── Associate contact with company ────────────────────────────────────────────
// Non-fatal — logs and continues if it fails.
async function associateContactWithCompany(contactId, companyId) {
  try {
    await hubspotRequest(
      'PUT',
      `/crm/v3/objects/contacts/${contactId}/associations/companies/${companyId}/contact_to_company`
    );
    console.log(`  [HubSpot] Associated contact ${contactId} ↔ company ${companyId}`);
  } catch (err) {
    console.log(`  [HubSpot] Association warning: ${err.message}`);
  }
}

// ── Parse full name into firstname / lastname ─────────────────────────────────
function parseContactName(fullName) {
  if (!fullName || typeof fullName !== 'string') return { firstname: '', lastname: '' };
  const parts = fullName.trim().split(' ');
  if (parts.length === 1) return { firstname: parts[0], lastname: '' };
  return { firstname: parts[0], lastname: parts.slice(1).join(' ') };
}

// ── Main export ───────────────────────────────────────────────────────────────
/**
 * Pushes one signal + contact into HubSpot CRM.
 *
 * @param {object} signal  - Full signal object (supports both nested signal.company.x
 *                           and flat signal.company_name / signal.signal_type shapes)
 * @param {object} contact - { name, email, title, send_day, email_source }
 * @returns {Promise<{ success: boolean, contactId?: string, route?: object,
 *                     reason?: string, error?: string }>}
 *          Never throws — all errors are caught and returned in the result object.
 */
export async function pushSignalToHubSpot(signal, contact) {
  const companyName = signal.company_name || signal.company?.name || '';
  console.log(`  [HubSpot Push] Starting push: ${companyName} — ${contact?.email}`);

  // Guard: email required
  if (!contact?.email || typeof contact.email !== 'string') {
    console.log('  [HubSpot Push] ✗ No email provided — aborting push');
    return { success: false, reason: 'no_email' };
  }

  // Guard: token required
  if (!HUBSPOT_TOKEN) {
    console.log('  [HubSpot Push] ✗ HUBSPOT_PRIVATE_APP_TOKEN not set — aborting push');
    return { success: false, reason: 'no_token' };
  }

  const signalType = signal.signal_type || signal.type || '';
  const industry   = signal.industry    || signal.company?.industry || '';
  const { firstname, lastname } = parseContactName(contact.name);

  // ── Contact properties ────────────────────────────────────────────────────
  // Standard HubSpot fields + 9 custom signal props + 3 proof/portfolio props.
  const contactProperties = {
    // Standard
    firstname,
    lastname,
    email:    contact.email,
    jobtitle: contact.title   || '',
    company:  companyName,
    website:  signal.company_website || signal.company?.website || '',

    // Custom signal properties
    signal_data:          SIGNAL_TYPE_MAP[signalType] || signalType,  // dropdown enum
    signal_priority:      signal.priority       || 'MEDIUM',
    signal_brief:         (signal.brief         || '').slice(0, 1000), // HubSpot text field limit
    signal_source:        signal.source         || '',
    signal_date:          signal.date_detected  || new Date().toISOString().split('T')[0],
    send_day:             String(contact.send_day    || '1'),
    contact_source:       contact.email_source  || 'Apollo',
    sequence_enrolled:    'false',
    hubspot_pushed_date:  new Date().toISOString().split('T')[0],

    // Proof clients token — pre-populated for sequence use
    proof_clients: getProofClients(industry) || '',

    // M&A-specific (only set for M&A signals)
    ...(signalType === 'M&A Activity' && {
      portfolio_company:   signal.deal?.seller || signal.acquired_company || companyName,
      portfolio_property:  signal.acquired_company_industry || industry || '',  // HubSpot internal name for "portfolio_industry"
    }),
  };

  // ── Company properties ────────────────────────────────────────────────────
  // HubSpot's industry field only accepts strict enum values — omit free-text
  // industry strings to avoid 400 errors. Industry is visible in signal_brief.
  const companyProperties = {
    name:    companyName,
    website: signal.company_website || signal.company?.website || '',
    ...(signal.company_revenue || signal.company?.revenue
      ? { annualrevenue: String(Math.round(signal.company_revenue || signal.company.revenue)) }
      : {}),
    ...(signal.employee_count || signal.company?.employee_count
      ? { numberofemployees: String(signal.employee_count || signal.company.employee_count) }
      : {}),
  };

  try {
    // Step 1: Upsert contact
    const contactId = await findOrCreateContact(contact.email, contactProperties);

    // Step 2: Upsert company + associate (non-fatal)
    if (companyName) {
      const companyId = await findOrCreateCompany(companyName, companyProperties);
      if (companyId) await associateContactWithCompany(contactId, companyId);
    }

    // Step 3: Mark sequence_enrolled = true — contact is now in HubSpot and ready.
    // Actual sequence enrollment happens from the dashboard (Prompt 15).
    await hubspotRequest('PATCH', `/crm/v3/objects/contacts/${contactId}`, {
      properties: { sequence_enrolled: 'true' },
    });

    console.log(`  [HubSpot Push] ✓ Success: ${contact.email} in HubSpot (id: ${contactId})`);
    return {
      success:     true,
      contactId,
      signalType,
      route:       SEQUENCE_ROUTING[signalType] || null,
    };

  } catch (err) {
    const status  = err.response?.status;
    const hsError = err.response?.data?.message || err.message;

    if (status === 409) {
      // Contact already exists — search-first approach should prevent this,
      // but handle it gracefully
      console.log(`  [HubSpot Push] Contact already exists (409) for ${contact.email} — treating as success`);
      return { success: true, reason: 'already_exists' };
    }
    if (status === 401) {
      console.error('  [HubSpot Push] ✗ Authentication failed — check HUBSPOT_PRIVATE_APP_TOKEN');
      return { success: false, error: 'HubSpot authentication failed. Check HUBSPOT_PRIVATE_APP_TOKEN.', reason: 'auth_failed' };
    }
    if (status === 429) {
      console.error('  [HubSpot Push] ✗ Rate limit hit — try again in a few minutes');
      return { success: false, error: 'HubSpot rate limit. Try again later.', reason: 'rate_limited' };
    }

    console.error(`  [HubSpot Push] ✗ Failed for ${contact.email}: ${hsError}`);
    return { success: false, error: hsError, reason: 'hubspot_error' };
  }
}

export default pushSignalToHubSpot;
