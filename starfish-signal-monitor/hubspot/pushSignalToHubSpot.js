/**
 * hubspot/pushSignalToHubSpot.js
 *
 * Pushes one signal contact into HubSpot CRM:
 *   Step 1 — Validate all required fields; report anything missing
 *   Step 2 — A/B group assignment + Claude email generation (25% Claude / 75% Starfish)
 *   Step 3 — Upsert Contact + Company + association
 *   Step 4 — Bespoke guard (blocks sequence enrollment permanently)
 *   Step 5 — Stage contact for enrollment queue (Prompts 31/32 will process)
 *   Step 6 — Airtable backfill for Claude-group contacts
 *
 * Routing (sequence ID + sender) is read from hubspot/sequenceRouting.js.
 * Email generation is handled by hubspot/generateClaudeEmails.js.
 *
 * CUSTOM PROPERTIES — must exist in HubSpot before this runs:
 *   Signal props:   signal_data, signal_priority, signal_brief, signal_source,
 *                   signal_date, send_day, contact_source, sequence_enrolled,
 *                   hubspot_pushed_date
 *   Proof props:    proof_clients
 *   Contact props:  bespoke, bespoke_reason, linkedinbio
 *   M&A props:      acquired_company, acquired_company_industry
 *   A/B props:      ab_test_group, claude_generated, claude_generated_at
 *   Email props:    email_1_subject, email_1_body through email_7_body (13 total)
 *
 * ENV VARS REQUIRED:
 *   HUBSPOT_PRIVATE_APP_TOKEN
 *
 * ENV VARS READ FROM sequenceRouting.js:
 *   DAVID/ZACK/ANDREW/COLE_SENDER_EMAIL
 *   DAVID/ZACK/ANDREW/COLE_HUBSPOT_OWNER_ID
 *   HS_SEQ_*_STARFISH / HS_SEQ_*_CLAUDE
 */

import 'dotenv/config';
import axios from 'axios';
import { getProofClients }    from '../data/proof_clients.js';
import { generateClaudeEmails } from './generateClaudeEmails.js';
import { getSequenceRoute, getSenderConfig } from './sequenceRouting.js';
import { updateRecords }      from '../execution/utils/airtable_client.js';

const HUBSPOT_TOKEN    = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
const HUBSPOT_BASE_URL = 'https://api.hubapi.com';

// ── Signal type → HubSpot enum value ─────────────────────────────────────────
// signal_data in HubSpot is a dropdown with fixed internal values.
const SIGNAL_TYPE_MAP = {
  'Job Change':            'job_change',
  'M&A Activity':          'm_and_a',
  'News/Press':            'news_press_release',
  'Rebrand':               'rebrand',
  'Website Visitor':       'website_visitor',
  'Brand Strategy Intent': 'brand_strategy_intent',
  'Funding':               'funding',
};

// ── Signal source → HubSpot signal_source enum value ─────────────────────────
// HubSpot signal_source allowed values: PDL, NewsAPI, MediaStack, PredictLeads,
// AudienceLab SuperPixel, AudienceLab Intent
// Apollo is an enrichment tool, not a signal source — Job Change signals sourced
// from Apollo map to PDL (both are people-data providers for job change detection).
const SIGNAL_SOURCE_MAP = {
  'Apollo':       'PDL',
  'PDL':          'PDL',
  'NewsAPI':      'NewsAPI',
  'MediaStack':   'MediaStack',
  'PredictLeads': 'PredictLeads',
  'AudienceLab':  'AudienceLab SuperPixel', // pixel segment default
};

// ── Token substitution ────────────────────────────────────────────────────────
// Replaces all HubSpot/Claude tokens in a generated email string with real values.
// HubSpot does NOT perform a second-pass substitution inside contact property values,
// so we pre-fill everything before saving — the stored email is already fully written.
function substituteTokens(text, { contactFirstName, contactCompany, senderFirstName, meetingLink }) {
  if (!text) return text;
  return text
    .replace(/\{\{\s*contact\.firstname\s*\}\}/gi,    contactFirstName || 'there')
    .replace(/\{\{\s*contact\.first_name\s*\}\}/gi,   contactFirstName || 'there')
    .replace(/\{\{\s*contact\.company\s*\}\}/gi,      contactCompany   || 'your company')
    .replace(/\{\{\s*sender\.firstname\s*\}\}/gi,     senderFirstName  || '')
    .replace(/\{\{\s*owner\.meetings_link\s*\}\}/gi,  meetingLink      || '');
}

// ── A/B group assignment ──────────────────────────────────────────────────────
// 25% Claude / 75% Starfish. Bespoke contacts are always Starfish.
// Exported for unit testing.
export function assignAbGroup(isBespoke) {
  if (isBespoke) return 'starfish';
  return Math.random() < 0.25 ? 'claude' : 'starfish';
}

// ── Centralized Axios wrapper ─────────────────────────────────────────────────
async function hubspotRequest(method, endpoint, data = null) {
  if (!HUBSPOT_TOKEN) throw new Error('HUBSPOT_PRIVATE_APP_TOKEN is not set');
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
async function findOrCreateContact(email, properties) {
  let existingId = null;

  try {
    const searchRes = await hubspotRequest('POST', '/crm/v3/objects/contacts/search', {
      filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
      limit: 1,
      properties: ['email', 'firstname', 'lastname'],
    });

    if (searchRes.data.results.length > 0) {
      existingId = searchRes.data.results[0].id;
      console.log(`  [HubSpot] Found existing contact for ${email} (id: ${existingId}) — updating`);
      try {
        await hubspotRequest('PATCH', `/crm/v3/objects/contacts/${existingId}`, { properties });
      } catch (patchErr) {
        // PATCH can fail with 400 if a property value is invalid — contact still exists and is usable.
        console.log(`  [HubSpot] Update warning for ${email}: ${patchErr.message} — contact retained`);
      }
      return existingId;
    }
  } catch (searchErr) {
    console.log(`  [HubSpot] Contact search failed for ${email}: ${searchErr.message} — attempting create`);
  }

  try {
    const createRes = await hubspotRequest('POST', '/crm/v3/objects/contacts', { properties });
    const newId = createRes.data.id;
    console.log(`  [HubSpot] Created new contact for ${email} (id: ${newId})`);
    return newId;
  } catch (createErr) {
    if (createErr.response?.status === 409) {
      // Contact was created by a concurrent request between our search and create — re-search to get the ID.
      console.log(`  [HubSpot] 409 on create for ${email} — re-searching to retrieve existing ID`);
      try {
        const retryRes = await hubspotRequest('POST', '/crm/v3/objects/contacts/search', {
          filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
          limit: 1,
          properties: ['email'],
        });
        const retryId = retryRes.data.results?.[0]?.id || null;
        if (retryId) {
          console.log(`  [HubSpot] Retrieved existing contact after 409: ${email} (id: ${retryId})`);
          return retryId;
        }
      } catch (_) {}
    }
    throw createErr;
  }
}

// ── Find or create company ────────────────────────────────────────────────────
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
    console.log(`  [HubSpot] Company create/update warning for ${companyName}: ${err.message}`);
    return null;
  }
}

// ── Associate contact with company ────────────────────────────────────────────
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

// ── Parse full name ───────────────────────────────────────────────────────────
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
 * @param {object} signal          - Full signal object
 * @param {object} contact         - { name, email, title, send_day, email_source,
 *                                    linkedin_url?, linkedin? }
 * @param {string} airtableRecordId - Airtable record ID for Claude email backfill (optional)
 * @returns {Promise<{ success: boolean, contactId?, route?, reason?, error? }>}
 *   Never throws — all errors caught and returned in the result object.
 */
export async function pushSignalToHubSpot(signal, contact, airtableRecordId = null) {
  const companyName = signal.company_name || signal.company?.name || '';
  console.log(`  [HubSpot Push] Starting push: ${companyName} — ${contact?.email}`);

  // ── Step 1: Validate required fields ───────────────────────────────────────
  const missing = [];
  if (!contact?.email)  missing.push('contact.email');
  if (!companyName)     missing.push('company name');
  if (!HUBSPOT_TOKEN)   missing.push('HUBSPOT_PRIVATE_APP_TOKEN');

  if (missing.length > 0) {
    console.log(`  [HubSpot Push] ✗ Missing required fields: ${missing.join(', ')} — aborting`);
    return { success: false, reason: 'missing_fields', missing };
  }

  const signalType = signal.signal_type || signal.type || '';
  const industry   = signal.industry    || signal.company?.industry || '';
  const { firstname, lastname } = parseContactName(contact.name);
  const linkedinUrl = contact.linkedin_url || contact.linkedin || '';

  // ── Step 2: A/B group assignment + Claude email generation ─────────────────
  // Use contact.abGroup when explicitly set (e.g. from dashboard or test scripts).
  // Otherwise assign randomly: 75% starfish / 25% claude.
  let abGroup     = (contact.abGroup === 'starfish' || contact.abGroup === 'claude')
    ? contact.abGroup
    : assignAbGroup(signal.bespoke === true);
  let claudeEmails = null;

  // Resolve the sender route BEFORE email generation so we know the sender's
  // name and meeting link to pre-fill into the generated emails.
  const route = getSequenceRoute(signalType, abGroup);
  const senderConfig = getSenderConfig(route?.ownerEmail || '');

  if (abGroup === 'claude') {
    const emailResult = await generateClaudeEmails(signal, contact);
    if (emailResult.success) {
      // Pre-fill all tokens with real values — HubSpot does not substitute tokens
      // inside contact property values, so we do it here before saving.
      const tokenVars = {
        contactFirstName: firstname,
        contactCompany:   companyName,
        senderFirstName:  senderConfig.firstName,
        meetingLink:      senderConfig.meetingLink,
      };
      const emails = emailResult.emails;
      claudeEmails = {
        email_1_subject: substituteTokens(emails.email_1_subject, tokenVars),
        email_1_body:    substituteTokens(emails.email_1_body,    tokenVars),
        email_2_body:    substituteTokens(emails.email_2_body,    tokenVars),
        email_3_body:    substituteTokens(emails.email_3_body,    tokenVars),
        email_4_body:    substituteTokens(emails.email_4_body,    tokenVars),
        email_5_body:    substituteTokens(emails.email_5_body,    tokenVars),
        email_6_body:    substituteTokens(emails.email_6_body,    tokenVars),
        ...(emails.email_7_body ? { email_7_body: substituteTokens(emails.email_7_body, tokenVars) } : {}),
      };
      console.log(`  [HubSpot Push] Claude emails generated (${emailResult.touchCount} touches)`);
    } else {
      console.log(`  [HubSpot Push] ⚠️  Claude generation failed: ${emailResult.error} — falling back to Starfish`);
      abGroup = 'starfish';
    }
  }

  // ── Step 3: Build contact + company properties ─────────────────────────────
  const contactProperties = {
    // Standard HubSpot fields
    firstname,
    lastname,
    email:    contact.email,
    jobtitle: contact.title   || '',
    company:  companyName,
    website:  signal.company_website || signal.company?.website || '',

    // LinkedIn — hs_linkedin_url is the standard HubSpot field that renders as a clickable
    // link on the contact record. linkedinbio is a custom field used for sequence personalisation.
    // Both are populated from the same source so either lookup path works.
    // Populated from Apollo/PDL — C7 verified.
    ...(linkedinUrl ? { hs_linkedin_url: linkedinUrl } : {}),
    linkedinbio: linkedinUrl, // Populated from Apollo/PDL — C7 verified

    // Custom signal properties
    signal_data:          SIGNAL_TYPE_MAP[signalType] || signalType,
    signal_priority:      signal.priority      || 'MEDIUM',
    signal_brief:         (signal.brief        || '').slice(0, 1000),
    signal_source:        SIGNAL_SOURCE_MAP[signal.source] || signal.source || '',
    signal_date:          signal.date_detected || new Date().toISOString().split('T')[0],
    send_day:             String(contact.send_day   || '1'),
    // Map PDL → Apollo — HubSpot contact_source only allows: Apollo, Hunter, Puppeteer, AudienceLab.
    // PDL is used as a supplementary enrichment source alongside Apollo for Job Change signals.
    contact_source:       (contact.email_source === 'PDL' ? 'Apollo' : contact.email_source) || 'Apollo',
    sequence_enrolled:    'false',
    hubspot_pushed_date:  new Date().toISOString().split('T')[0],

    // Proof clients token
    proof_clients: getProofClients(industry) || '',

    // Bespoke flag
    bespoke:        signal.bespoke ? 'true' : 'false',
    bespoke_reason: signal.bespoke_reason || '',

    // A/B test group — always sent so HubSpot knows which sequence type to use.
    // 'starfish' = pre-built HubSpot sequences. 'claude' = AI-generated personalised emails.
    ab_test_group: abGroup,

    // Claude email content — only sent when Claude emails were generated (claude group).
    ...(claudeEmails ? {
      email_1_subject:     claudeEmails.email_1_subject,
      email_1_body:        claudeEmails.email_1_body,
      email_2_body:        claudeEmails.email_2_body,
      email_3_body:        claudeEmails.email_3_body,
      email_4_body:        claudeEmails.email_4_body,
      email_5_body:        claudeEmails.email_5_body,
      email_6_body:        claudeEmails.email_6_body,
      ...(claudeEmails.email_7_body ? { email_7_body: claudeEmails.email_7_body } : {}),
      claude_generated:    'true',
      claude_generated_at: new Date().toISOString(),
    } : {}),

    // M&A-specific: acquired company name + industry
    ...(signalType === 'M&A Activity' && {
      acquired_company:           signal.acquired_company || signal.deal?.seller || companyName,
      acquired_company_industry:  signal.acquired_company_industry || industry || '',
    }),
  };

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
    // Step 3a: Upsert contact
    const contactId = await findOrCreateContact(contact.email, contactProperties);

    // Step 3b: Upsert company + associate (non-fatal)
    if (companyName) {
      const companyId = await findOrCreateCompany(companyName, companyProperties);
      if (companyId) await associateContactWithCompany(contactId, companyId);
    }

    // Step 4: Bespoke guard — data pushed, but sequence enrollment permanently blocked.
    if (signal.bespoke === true) {
      await hubspotRequest('PATCH', `/crm/v3/objects/contacts/${contactId}`, {
        properties: { sequence_enrolled: 'false', bespoke: 'true' },
      });
      console.log(`  [HubSpot Push] ⚠️  Bespoke contact — enrollment blocked: ${contact.email}`);
      return { success: true, contactId, bespoke: true, reason: 'bespoke_no_enrollment' };
    }

    // Step 4b: Cross-type bespoke suppression guard.
    // This signal is not bespoke itself, but another signal for the same company IS bespoke
    // this run. Enrolling would cause double-outreach — bespoke manual touch + auto sequence.
    if (signal.bespoke_cross_type_suppressed === true) {
      await hubspotRequest('PATCH', `/crm/v3/objects/contacts/${contactId}`, {
        properties: { sequence_enrolled: 'false' },
      });
      console.log(`  [HubSpot Push] ⚠️  Cross-type bespoke suppression — enrollment blocked: ${contact.email} (company has a bespoke signal this run)`);
      return { success: true, contactId, bespoke: false, reason: 'cross_type_bespoke_suppressed' };
    }

    // Step 5: Stage for enrollment queue.
    // Prompts 31/32 build the actual queue processor that reads these staged contacts
    // and enrolls them in the correct HubSpot sequence.
    // For now: log intent — enrollment happens asynchronously.
    if (route?.sequenceId) {
      // TODO (Prompt 31): replace this log with actual queue insertion
      // e.g. await addToEnrollmentQueue({ contactId, email: contact.email, route, abGroup });
      console.log(`  [HubSpot Push] Staged for enrollment: ${contact.email} → seq ${route.sequenceId} via ${route.ownerEmail} [${abGroup}]`);
    } else {
      console.log(`  [HubSpot Push] ⚠️  No sequence ID for ${signalType}/${abGroup} — enrollment skipped until sequences are live`);
    }

    // Step 6: Airtable backfill — write Claude email fields back to the Airtable record.
    // Only when emails were generated AND we know the Airtable record ID.
    // Non-fatal — HubSpot push is already done.
    if (claudeEmails && airtableRecordId) {
      try {
        await updateRecords([{
          id: airtableRecordId,
          fields: {
            'Claude Generated':    true,
            'Claude Generated At': new Date().toISOString(),
            'AB Test Group':       'claude',
            'Email 1 Subject':     claudeEmails.email_1_subject || null,
            'Email 1 Body':        claudeEmails.email_1_body    || null,
            'Email 2 Body':        claudeEmails.email_2_body    || null,
            'Email 3 Body':        claudeEmails.email_3_body    || null,
            'Email 4 Body':        claudeEmails.email_4_body    || null,
            'Email 5 Body':        claudeEmails.email_5_body    || null,
            'Email 6 Body':        claudeEmails.email_6_body    || null,
            'Email 7 Body':        claudeEmails.email_7_body    || null,
          },
        }]);
        console.log(`  [HubSpot Push] ✓ Airtable record ${airtableRecordId} updated with Claude emails`);
      } catch (atErr) {
        console.error(`  [HubSpot Push] ⚠️  Airtable backfill failed (non-fatal): ${atErr.message}`);
      }
    }

    console.log(`  [HubSpot Push] ✓ ${contact.email} → HubSpot (id: ${contactId}) [${abGroup} group]`);
    return {
      success:   true,
      contactId,
      signalType,
      abGroup,
      route,
    };

  } catch (err) {
    const status  = err.response?.status;
    const hsError = err.response?.data?.message || err.message;

    if (status === 409) {
      console.log(`  [HubSpot Push] Contact already exists (409) for ${contact.email} — treating as success`);
      return { success: true, reason: 'already_exists' };
    }
    if (status === 401) {
      console.error('  [HubSpot Push] ✗ Auth failed — check HUBSPOT_PRIVATE_APP_TOKEN');
      return { success: false, error: 'HubSpot authentication failed.', reason: 'auth_failed' };
    }
    if (status === 429) {
      console.error('  [HubSpot Push] ✗ Rate limit — try again in a few minutes');
      return { success: false, error: 'HubSpot rate limit. Try again later.', reason: 'rate_limited' };
    }

    console.error(`  [HubSpot Push] ✗ Failed for ${contact.email}: ${hsError}`);
    return { success: false, error: hsError, reason: 'hubspot_error' };
  }
}

export default pushSignalToHubSpot;
