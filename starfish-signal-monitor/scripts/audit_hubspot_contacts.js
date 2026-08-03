/**
 * scripts/audit_hubspot_contacts.js
 *
 * Audits all contacts pushed to HubSpot by our system.
 *
 * What it does:
 *   1. Fetches every HubSpot contact that has hubspot_pushed_date set (our marker)
 *   2. Deduplicates by email — drops any duplicate contacts
 *   3. Fetches Airtable records with HubSpot Pushed = TRUE and compares counts
 *   4. For each contact, checks and fills:
 *        - industry     : Airtable first → Apollo → Claude guess
 *        - proof_clients: looks up data/proof_clients.js using resolved industry
 *        - signal_source: derived from signal_data (signal type) using the canonical mapping
 *        - send_day     : derived from jobtitle using the same logic as the live pipeline
 *                         (also writes back to the matching Airtable record)
 *   5. Reports AB test group stats — no writes, just a count
 *
 * Run:
 *   node --env-file=.env scripts/audit_hubspot_contacts.js           # preview (no writes)
 *   node --env-file=.env scripts/audit_hubspot_contacts.js --live    # apply all fixes
 */

import 'dotenv/config';
import axios from 'axios';
import Airtable from 'airtable';
import Anthropic from '@anthropic-ai/sdk';
import { getProofClients } from '../data/proof_clients.js';
import { getSendDay } from '../execution/utils/broadcast_contacts.js';
import { updateRecords } from '../execution/utils/airtable_client.js';

const LIVE        = process.argv.includes('--live');
const APOLLO_BASE = 'https://api.apollo.io/v1';
const HS_BASE     = 'https://api.hubapi.com';
const HS_TOKEN    = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
const TABLE       = process.env.AIRTABLE_TABLE_NAME || 'Signals';

// ── Signal data (HubSpot enum stored value) → correct signal_source ───────────
// These are the exact values stored in the signal_data property in HubSpot.
// User confirmed:
//   Job Change     → PDL
//   News/Press     → MediaStack  (NewsAPI ignored)
//   Funding        → MediaStack
//   M&A            → PredictLeads
//   Website Visitor→ AudienceLab Superpixel
//   BSI            → AudienceLab Intent
const SIGNAL_DATA_TO_SOURCE = {
  job_change:            'PDL',
  m_and_a:               'PredictLeads',
  news_press_release:    'MediaStack',
  rebrand:               'MediaStack',
  funding:               'MediaStack',
  website_visitor:       'AudienceLab Superpixel',
  brand_strategy_intent: 'AudienceLab Intent',
};

// ── HubSpot helpers ────────────────────────────────────────────────────────────
async function hsRequest(method, endpoint, data = null) {
  if (!HS_TOKEN) throw new Error('HUBSPOT_PRIVATE_APP_TOKEN not set');
  const cfg = {
    method,
    url: `${HS_BASE}${endpoint}`,
    headers: { Authorization: `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' },
    timeout: 30000,
  };
  if (data) cfg.data = data;
  return axios(cfg);
}

async function hsPatch(contactId, properties) {
  await hsRequest('PATCH', `/crm/v3/objects/contacts/${contactId}`, { properties });
}

// Fetches ALL contacts that have hubspot_pushed_date set (pushed by our system).
// Paginates until no more results.
async function fetchAllOurHubSpotContacts() {
  const contacts = [];
  let after = undefined;

  const PROPS = [
    'email', 'firstname', 'lastname', 'jobtitle', 'company',
    'industry', 'proof_clients', 'signal_source', 'signal_data',
    'send_day', 'ab_test_group', 'hubspot_pushed_date', 'sequence_enrolled',
  ];

  do {
    const body = {
      filterGroups: [{
        filters: [{
          propertyName: 'hubspot_pushed_date',
          operator:     'HAS_PROPERTY',
        }],
      }],
      properties: PROPS,
      limit: 100,
      ...(after ? { after } : {}),
    };

    const res = await hsRequest('POST', '/crm/v3/objects/contacts/search', body);
    contacts.push(...res.data.results);
    after = res.data.paging?.next?.after || null;

    // HubSpot rate-limit: max 4 search requests/sec with private app tokens
    await new Promise(r => setTimeout(r, 300));
  } while (after);

  return contacts;
}

// ── Airtable helpers ───────────────────────────────────────────────────────────
function getAirtableBase() {
  return new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);
}

function extractEmail(contactInfo) {
  if (!contactInfo) return null;
  const m = contactInfo.match(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/);
  return m ? m[0].toLowerCase() : null;
}

async function fetchAirtablePushedRecords() {
  console.log('Fetching Airtable records with HubSpot Pushed = TRUE...');
  const records = await getAirtableBase()(TABLE).select({
    filterByFormula: '{HubSpot Pushed} = TRUE()',
    fields: ['Contact Info', 'Company Name', 'Industry', 'Send Day', 'Signal Type', 'Company Website'],
  }).all();
  console.log(`  Airtable pushed records: ${records.length}\n`);
  return records;
}

// ── Apollo industry enrichment ─────────────────────────────────────────────────
// Uses /organizations/enrich with domain when available (most accurate),
// falls back to /organizations/search by name (reliable for name-only lookups).
async function getIndustryFromApollo(companyName, domain) {
  try {
    // Enrich by domain first (most accurate)
    if (domain) {
      const res = await axios.post(`${APOLLO_BASE}/organizations/enrich`, { domain }, {
        headers: { 'X-Api-Key': process.env.APOLLO_API_KEY, 'Content-Type': 'application/json' },
        timeout: 15000,
      });
      const industry = res.data?.organization?.industry || null;
      if (industry) return industry;
    }

    // Name-based search fallback — /organizations/search works better than /enrich for names
    if (companyName) {
      const res = await axios.post(`${APOLLO_BASE}/organizations/search`, {
        q_organization_name: companyName,
        per_page: 1,
        page: 1,
      }, {
        headers: { 'X-Api-Key': process.env.APOLLO_API_KEY, 'Content-Type': 'application/json' },
        timeout: 15000,
      });
      const org = res.data?.organizations?.[0] || {};
      return org.industry || null;
    }

    return null;
  } catch (err) {
    console.error(`  [Apollo] Error for "${companyName}": ${err.response?.status || err.message}`);
    return null;
  }
}

// ── Claude industry fallback ───────────────────────────────────────────────────
let _anthropic = null;
function getAnthropic() {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}

async function guessIndustryWithClaude(companyName) {
  try {
    const msg = await getAnthropic().messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 50,
      messages:   [{
        role:    'user',
        content: `What industry is "${companyName}" in? Reply with only the industry category in 2-5 words. No explanation, no punctuation.`,
      }],
    });
    const text = msg.content[0]?.text?.trim() || '';
    // Reject disclaimers and refusals — real industry names are short and clean
    if (!text) return null;
    if (text.length > 50) return null;
    if (/don't have|cannot|not able|no information|insufficient|uncertain|unclear|training data/i.test(text)) return null;
    return text;
  } catch (err) {
    console.error(`  [Claude] Error for "${companyName}": ${err.message}`);
    return null;
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function run() {
  if (!HS_TOKEN)       { console.error('HUBSPOT_PRIVATE_APP_TOKEN not set'); process.exit(1); }
  if (!process.env.AIRTABLE_API_KEY) { console.error('AIRTABLE_API_KEY not set'); process.exit(1); }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`HUBSPOT CONTACT AUDIT${LIVE ? ' [LIVE — writing fixes]' : ' [PREVIEW — no writes]'}`);
  console.log(`${'═'.repeat(60)}\n`);

  // ── Step 1: Fetch HubSpot contacts ────────────────────────────────────────
  console.log('Fetching all contacts pushed by our system from HubSpot...');
  const allContacts = await fetchAllOurHubSpotContacts();
  console.log(`  Total HubSpot contacts (incl. duplicates): ${allContacts.length}`);

  // Deduplicate by email
  const seen      = new Set();
  const contacts  = [];
  let   dupCount  = 0;
  for (const c of allContacts) {
    const email = (c.properties.email || '').toLowerCase().trim();
    if (!email)            { dupCount++; continue; } // skip no-email
    if (seen.has(email))   { dupCount++; continue; }
    seen.add(email);
    contacts.push(c);
  }
  console.log(`  Deduplicated: ${contacts.length} unique contacts (dropped ${dupCount} duplicates)\n`);

  // ── Step 2: Fetch Airtable pushed records ──────────────────────────────────
  const airtableRecords = await fetchAirtablePushedRecords();

  // Build email → airtable record index
  const airtableByEmail = {};
  for (const r of airtableRecords) {
    const email = extractEmail(r.fields['Contact Info'] || '');
    if (email) airtableByEmail[email] = r;
  }

  // ── Step 3: Count comparison ───────────────────────────────────────────────
  console.log('── Count comparison ────────────────────────────────────────');
  console.log(`  HubSpot contacts (our system, unique email): ${contacts.length}`);
  console.log(`  Airtable records (HubSpot Pushed = TRUE)  : ${airtableRecords.length}`);
  const diff = contacts.length - airtableRecords.length;
  if (diff === 0) {
    console.log('  ✅ Counts match perfectly');
  } else {
    console.log(`  ⚠️  Discrepancy: ${Math.abs(diff)} ${diff > 0 ? 'more in HubSpot than Airtable' : 'more in Airtable than HubSpot'}`);
    console.log('     (Dashboard manual pushes or bespoke records may explain the gap)');
  }

  // ── Step 4: Property audit ─────────────────────────────────────────────────
  console.log('\n── Property audit ──────────────────────────────────────────');

  let missingIndustry    = 0;
  let missingProof       = 0;
  let missingSource      = 0;
  let wrongSource        = 0;
  let missingSendDay     = 0;
  let fixedIndustry      = 0;
  let fixedProof         = 0;
  let fixedSource        = 0;
  let fixedSendDay       = 0;

  // AB test group stats
  let abClaude   = 0;
  let abStarfish = 0;
  let abMissing  = 0;
  let abInvalid  = 0;

  const airtableUpdateQueue = []; // batched at the end

  for (let i = 0; i < contacts.length; i++) {
    const c  = contacts[i];
    const p  = c.properties;
    const id = c.id;
    const email       = (p.email || '').toLowerCase().trim();
    const companyName = p.company || '';
    const jobtitle    = p.jobtitle || '';

    const atRecord = airtableByEmail[email] || null;
    const atFields = atRecord?.fields || {};

    const hsUpdates = {}; // properties to PATCH on this HubSpot contact

    // ── 4a: Industry ────────────────────────────────────────────────────────
    let industry = p.industry || atFields['Industry'] || null;

    if (!industry) {
      missingIndustry++;
      if (LIVE) {
        // Apollo first
        const domain = atFields['Company Website']
          ? atFields['Company Website'].replace(/https?:\/\//i, '').replace(/^www\./i, '').split('/')[0].toLowerCase().trim()
          : null;
        industry = await getIndustryFromApollo(companyName, domain);

        // Claude fallback
        if (!industry && companyName) {
          industry = await guessIndustryWithClaude(companyName);
          if (industry) console.log(`  [Claude] ${companyName} → ${industry}`);
        }

        if (industry) {
          fixedIndustry++;
          hsUpdates.industry = industry;
          // Also update Airtable if we have a record
          if (atRecord && !atFields['Industry']) {
            airtableUpdateQueue.push({ id: atRecord.id, fields: { Industry: industry } });
          }
        }
      }
    }

    // ── 4b: Proof clients ────────────────────────────────────────────────────
    if (!p.proof_clients) {
      missingProof++;
      if (LIVE && industry) {
        const proof = getProofClients(industry);
        if (proof) {
          fixedProof++;
          hsUpdates.proof_clients = proof;
        }
      }
    }

    // ── 4c: Signal source ────────────────────────────────────────────────────
    const correctSource = SIGNAL_DATA_TO_SOURCE[p.signal_data] || null;
    if (!p.signal_source) {
      missingSource++;
      if (LIVE && correctSource) {
        fixedSource++;
        hsUpdates.signal_source = correctSource;
      }
    } else if (correctSource && p.signal_source !== correctSource) {
      wrongSource++;
      if (LIVE) {
        fixedSource++;
        hsUpdates.signal_source = correctSource;
      }
    }

    // ── 4d: Send day ─────────────────────────────────────────────────────────
    const currentSendDay  = p.send_day || null;
    const airtableSendDay = atFields['Send Day'] ? String(atFields['Send Day']) : null;

    // Derive from job title (primary) or Airtable (secondary)
    const derivedSendDay  = jobtitle ? String(getSendDay(jobtitle)) : null;
    const targetSendDay   = derivedSendDay || airtableSendDay || null;

    if (!currentSendDay) {
      missingSendDay++;
      if (LIVE && targetSendDay) {
        fixedSendDay++;
        hsUpdates.send_day = targetSendDay;
        // Update Airtable if we derived from jobtitle and Airtable differs
        if (atRecord && derivedSendDay && derivedSendDay !== airtableSendDay) {
          // Only add to queue if not already queued for this record
          const existing = airtableUpdateQueue.find(u => u.id === atRecord.id);
          if (existing) {
            existing.fields['Send Day'] = parseInt(derivedSendDay, 10);
          } else {
            airtableUpdateQueue.push({ id: atRecord.id, fields: { 'Send Day': parseInt(derivedSendDay, 10) } });
          }
        }
      }
    }

    // ── 4e: AB test group (report only) ──────────────────────────────────────
    const ab = (p.ab_test_group || '').toLowerCase().trim();
    if      (ab === 'claude')   abClaude++;
    else if (ab === 'starfish') abStarfish++;
    else if (!ab)               abMissing++;
    else                        abInvalid++;  // unexpected value

    // ── Apply HubSpot updates ─────────────────────────────────────────────────
    if (LIVE && Object.keys(hsUpdates).length > 0) {
      try {
        await hsPatch(id, hsUpdates);
        // Small delay to avoid hitting HubSpot rate limits
        await new Promise(r => setTimeout(r, 150));
      } catch (err) {
        console.error(`  [HubSpot PATCH] Failed for ${email}: ${err.message}`);
      }
    }

    // Progress log every 50 contacts
    if ((i + 1) % 50 === 0 || i === contacts.length - 1) {
      process.stdout.write(`\r  Processed ${i + 1}/${contacts.length} contacts...`);
    }
  }

  console.log('\n');

  // ── Step 5: Batch-write Airtable updates ──────────────────────────────────
  if (LIVE && airtableUpdateQueue.length > 0) {
    console.log(`Writing ${airtableUpdateQueue.length} Airtable industry/send_day updates...`);
    try {
      await updateRecords(airtableUpdateQueue);
      console.log('  ✅ Airtable updates complete');
    } catch (err) {
      console.error(`  ⚠️  Airtable batch update failed: ${err.message}`);
    }
  }

  // ── Report ────────────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(60)}`);
  console.log('AUDIT RESULTS');
  console.log(`${'═'.repeat(60)}`);

  console.log('\n── Property gaps found ─────────────────────────────────────');
  console.log(`  Industry missing        : ${missingIndustry}`);
  console.log(`  Proof clients missing   : ${missingProof}`);
  console.log(`  Signal source missing   : ${missingSource}`);
  console.log(`  Signal source wrong     : ${wrongSource}`);
  console.log(`  Send day missing        : ${missingSendDay}`);

  if (LIVE) {
    console.log('\n── Fixes applied ───────────────────────────────────────────');
    console.log(`  Industry filled         : ${fixedIndustry}`);
    console.log(`  Proof clients filled    : ${fixedProof}`);
    console.log(`  Signal source set/fixed : ${fixedSource}`);
    console.log(`  Send day filled         : ${fixedSendDay}`);
    console.log(`  Airtable updates queued : ${airtableUpdateQueue.length}`);
  }

  console.log('\n── AB Test Group (our contacts only) ───────────────────────');
  console.log(`  ✅ Assigned (claude)    : ${abClaude}`);
  console.log(`  ✅ Assigned (starfish)  : ${abStarfish}`);
  console.log(`  Total with AB group     : ${abClaude + abStarfish}`);
  console.log(`  ❌ No AB group assigned : ${abMissing}`);
  if (abInvalid > 0) {
    console.log(`  ⚠️  Invalid AB value    : ${abInvalid} (not 'claude' or 'starfish')`);
  }

  console.log(`\n${'═'.repeat(60)}`);

  if (!LIVE) {
    console.log('\nThis was a PREVIEW run — no changes were made.');
    console.log('Run with --live to apply all fixes.\n');
  } else {
    console.log('\n✅ Audit complete. All fixes applied.\n');
  }
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
