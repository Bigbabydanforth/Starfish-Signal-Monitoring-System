/**
 * scripts/enrich_no_contact_signals.js
 *
 * Finds contacts for all unpushed Airtable records that have no real email:
 *   - Placeholder  (email_not_unlocked@domain.com)
 *   - Contact Needed / Research Needed
 *   - LinkedIn-only (has URL but no email)
 *   - Truly empty Contact Info
 *
 * Uses the same enrichment logic as the live pipeline:
 *   findBroadcastContacts() → Apollo domain search → email unlock → Hunter fallback
 *   Records grouped by company — ONE Apollo call per company
 *   Contacts matched to records by send_day
 *
 * Fields written for every record touched:
 *   - Contact Info   (Name / Title / Email only — no LinkedIn, no website)
 *   - LinkedIn URL   (separate Airtable field)
 *   - Send Day       (from matched contact title)
 *   - Industry       (from Apollo org search — only if currently empty)
 *   - AB Test Group  (BSI: 50/50 claude/starfish | All others: 25/75)
 *   - Proof Clients  (from data/proof_clients.js — field must exist in Airtable as Long text)
 *   - Acquired Company (M&A only — Claude Sonnet reads the Brief to extract it)
 *
 * If no contact is found: Contact Info is set to "⚠️ Research Needed"
 *
 * ⚠️  BEFORE RUNNING LIVE: create "Proof Clients" field in Airtable (Long text).
 *
 * Run:
 *   node --env-file=.env scripts/enrich_no_contact_signals.js              (preview)
 *   node --env-file=.env scripts/enrich_no_contact_signals.js --live       (update Airtable)
 *   node --env-file=.env scripts/enrich_no_contact_signals.js --batch=20   (limit to 20 companies)
 */

import 'dotenv/config';
import axios      from 'axios';
import Anthropic  from '@anthropic-ai/sdk';
import { query, updateRecords }      from '../execution/utils/airtable_client.js';
import { extractDomain }             from '../execution/utils/email_enrichment.js';
import { findBroadcastContacts }     from '../execution/utils/broadcast_contacts.js';
import { getKnownDomain }            from '../execution/utils/known_domains.js';
import { getProofClients }           from '../data/proof_clients.js';
import { assignAbGroup }             from '../hubspot/pushSignalToHubSpot.js';

const LIVE          = process.argv.includes('--live');
const batchArg      = process.argv.find(a => a.startsWith('--batch='));
const MAX_COMPANIES = batchArg ? parseInt(batchArg.split('=')[1], 10) : Infinity;

const PLACEHOLDER = 'email_not_unlocked@domain.com';
const APOLLO_BASE = process.env.APOLLO_API_URL || 'https://api.apollo.io/v1';

function pause(ms) { return new Promise(r => setTimeout(r, ms)); }

let _anthropic = null;
function getAnthropic() {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function extractEmail(contactInfo) {
  if (!contactInfo) return null;
  const m = contactInfo.match(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/);
  return m ? m[0].toLowerCase() : null;
}

function isNoEmail(contactInfo) {
  if (!contactInfo || !contactInfo.trim()) return true;
  if (contactInfo.includes(PLACEHOLDER)) return true;
  return !extractEmail(contactInfo);
}

function extractWebsiteFromContactInfo(contactInfo) {
  if (!contactInfo) return null;
  for (const line of contactInfo.split('\n')) {
    const t = line.trim();
    if (t.startsWith('Website: '))         return t.slice('Website: '.length).trim();
    if (t.startsWith('Company Website: ')) return t.slice('Company Website: '.length).trim();
  }
  return null;
}

// Contact Info block: Name / Title / Email only.
// LinkedIn goes to its own Airtable field ("LinkedIn URL").
// No website line.
function buildContactInfo(contact) {
  const fullName = contact.name || [contact.first_name, contact.last_name].filter(Boolean).join(' ');
  const lines = [];
  if (fullName)      lines.push(fullName);
  if (contact.title) lines.push(contact.title);
  if (contact.email) lines.push(contact.email);
  return lines.join('\n');
}

function noEmailReason(contactInfo) {
  if (!contactInfo || !contactInfo.trim())    return 'Truly Empty';
  if (contactInfo.includes(PLACEHOLDER))      return 'Placeholder';
  if (/research needed/i.test(contactInfo))   return 'Research Needed';
  if (/contact needed/i.test(contactInfo))    return 'Contact Needed';
  if (/linkedin\.com/i.test(contactInfo))     return 'LinkedIn Only';
  return 'Truly Empty';
}

// ── M&A: extract acquired company from Brief using Claude Sonnet ───────────────
async function getAcquiredCompanyFromClaude(companyName, brief) {
  if (!brief || !brief.trim()) return null;
  try {
    const msg = await getAnthropic().messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 100,
      messages:   [{
        role:    'user',
        content: `This is an M&A signal about "${companyName}". Read the brief below and extract ONLY the exact name of the company being acquired (the target/acquired company). If you cannot clearly identify it, respond with exactly: Unknown

Brief: ${brief}

Respond with just the company name — nothing else. No explanation.`,
      }],
    });
    const result = (msg.content[0]?.text || '').trim();
    if (!result || result.toLowerCase() === 'unknown' || result.length > 150) return null;
    // Reject if Claude returned a long explanation instead of a name
    if (result.includes('\n') || result.split(' ').length > 8) return null;
    return result;
  } catch (err) {
    console.log(`   [Claude/M&A] Error for "${companyName}": ${err.message}`);
    return null;
  }
}

// ── Domain + industry resolution ───────────────────────────────────────────────
// Same chain as the live pipeline and re_enrich_contacts.js:
//   1. Company Website field (instant, no API)
//   2. KNOWN_DOMAINS lookup (instant, no API)
//   3. Apollo /organizations/search by name (free search — no credit cost)
// Returns { domain, industry } — both may be null.
const _companyInfoCache = new Map();

async function resolveCompanyInfo(companyName, knownWebsite, contactInfoWebsite) {
  const cacheKey = companyName.toLowerCase().trim();
  if (_companyInfoCache.has(cacheKey)) return _companyInfoCache.get(cacheKey);

  let domain   = extractDomain(knownWebsite)
    || extractDomain(contactInfoWebsite)
    || getKnownDomain(companyName)
    || null;
  let industry = null;

  if (domain) {
    // Have domain — enrich by domain for industry only
    try {
      const res = await axios.post(`${APOLLO_BASE}/organizations/enrich`, { domain }, {
        headers: { 'X-Api-Key': process.env.APOLLO_API_KEY, 'Content-Type': 'application/json' },
        timeout: 15000,
      });
      industry = res.data?.organization?.industry || null;
    } catch { /* silent */ }

  } else if (companyName && process.env.APOLLO_API_KEY) {
    // No domain — Apollo org search by name: returns domain + industry in one call
    try {
      const res = await axios.post(`${APOLLO_BASE}/organizations/search`, {
        q_organization_name: companyName,
        per_page: 1,
        page:     1,
      }, {
        headers: { 'X-Api-Key': process.env.APOLLO_API_KEY, 'Content-Type': 'application/json' },
        timeout: 15000,
      });
      const org = res.data?.organizations?.[0] || {};
      domain   = extractDomain(org.website_url || org.primary_domain) || null;
      industry = org.industry || null;
      if (domain) console.log(`   [Apollo/org] "${companyName}" → ${domain}`);
    } catch (err) {
      console.log(`   [Apollo/org] "${companyName}" → ERROR ${err.response?.status || err.message}`);
    }
  }

  const info = { domain, industry };
  _companyInfoCache.set(cacheKey, info);
  return info;
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function run() {
  console.log('════════════════════════════════════════════════════════════');
  console.log(`ENRICH NO-CONTACT SIGNALS [${LIVE ? 'LIVE — writing to Airtable' : 'PREVIEW — no writes'}]`);
  console.log('════════════════════════════════════════════════════════════\n');

  // ── Fetch ─────────────────────────────────────────────────────────────────────
  console.log('Fetching unpushed records from Airtable...');
  let allRecords;
  try {
    allRecords = await query({
      filterByFormula: 'NOT({HubSpot Pushed} = TRUE())',
      fields: [
        'Contact Info', 'Company Name', 'Company Website',
        'Signal Type',  'Send Day',     'Bespoke',
        'Industry',     'Acquired Company', 'AB Test Group', 'Brief',
      ],
    }, 120000);
  } catch (err) {
    console.error('Airtable fetch failed:', err.message);
    process.exit(1);
  }

  const noEmailRecords = allRecords.filter(r => isNoEmail(r.fields['Contact Info'] || ''));

  // Count by reason
  const reasonCounts = { Placeholder: 0, 'Contact Needed': 0, 'Research Needed': 0, 'LinkedIn Only': 0, 'Truly Empty': 0 };
  for (const r of noEmailRecords) {
    const reason = noEmailReason(r.fields['Contact Info'] || '');
    reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
  }

  console.log(`  Total unpushed records     : ${allRecords.length}`);
  console.log(`  Records with no real email : ${noEmailRecords.length}`);
  for (const [reason, count] of Object.entries(reasonCounts)) {
    if (count > 0) console.log(`    ${reason.padEnd(20)} : ${count}`);
  }
  console.log('');

  // ── Group by company ──────────────────────────────────────────────────────────
  const companyGroups = new Map();
  for (const r of noEmailRecords) {
    const company = (r.fields['Company Name'] || '').trim();
    if (!company) continue;
    if (!companyGroups.has(company)) companyGroups.set(company, []);
    companyGroups.get(company).push(r);
  }

  const totalCompanies = Math.min(companyGroups.size, MAX_COMPANIES);
  console.log(`  Unique companies to enrich : ${companyGroups.size}`);
  if (MAX_COMPANIES < Infinity) console.log(`  (Capped at ${MAX_COMPANIES} by --batch flag)\n`);
  else console.log('');

  // ── Enrich ────────────────────────────────────────────────────────────────────
  let companiesProcessed = 0;
  let contactsFound      = 0;
  let contactsNotFound   = 0;
  const airtableUpdates  = [];

  for (const [companyName, records] of companyGroups) {
    if (companiesProcessed >= MAX_COMPANIES) break;
    companiesProcessed++;

    const firstRecord  = records[0];
    const f            = firstRecord.fields;
    const signalType   = f['Signal Type']     || '';
    const knownWebsite = f['Company Website'] || '';
    const contactInfo  = f['Contact Info']    || '';
    const brief        = f['Brief']           || '';
    const isBespoke    = f['Bespoke'] === true || f['Bespoke'] === 'true';

    console.log(`[${companiesProcessed}/${totalCompanies}] ${companyName} (${records.length} record${records.length > 1 ? 's' : ''}) — ${signalType}`);

    // Resolve domain + industry
    const { domain, industry: apolloIndustry } = await resolveCompanyInfo(
      companyName,
      knownWebsite,
      extractWebsiteFromContactInfo(contactInfo)
    );

    if (!domain) console.log(`   ⚠️  No domain resolved — will still fill metadata fields`);

    // Find broadcast contacts
    let broadcastContacts = [];
    if (domain) {
      try {
        broadcastContacts = await findBroadcastContacts({
          domain,
          companyName,
          companyWebsite: knownWebsite || `https://${domain}`,
          signalType,
        }) || [];
      } catch (err) {
        console.log(`   ✗ Contact search error: ${err.message}`);
      }
    }

    const contactBySendDay = new Map(broadcastContacts.map(c => [c.send_day, c]));

    // M&A: extract acquired company from Brief via Claude (once per company)
    let acquiredCompany = null;
    if (signalType === 'M&A Activity' && !f['Acquired Company'] && brief) {
      acquiredCompany = await getAcquiredCompanyFromClaude(companyName, brief);
      if (acquiredCompany) console.log(`   [M&A] Acquired company: ${acquiredCompany}`);
    }

    // Build update for each record in this company group
    for (const record of records) {
      const rf       = record.fields;
      const sendDay  = rf['Send Day'] || 1;
      // Try exact send_day match first, then fall back to any contact with a real email
      const firstWithEmail = broadcastContacts.find(c => c.email) || null;
      const contact  = contactBySendDay.get(sendDay) || firstWithEmail || broadcastContacts[0] || null;
      const industry = apolloIndustry || rf['Industry'] || null;

      const fields = {};

      if (contact?.email) {
        contactsFound++;
        fields['Contact Info'] = buildContactInfo(contact);
        fields['Send Day']     = contact.send_day || sendDay;
        const linkedin = contact.linkedin_url || contact.linkedinUrl;
        if (linkedin) fields['LinkedIn URL'] = linkedin;
        console.log(`   ✓ Day ${contact.send_day || sendDay}: ${contact.name || ''} (${contact.title || ''}) → ${contact.email}`);
      } else {
        contactsNotFound++;
        fields['Contact Info'] = '⚠️ Research Needed';
        // Still write LinkedIn if contact has one but no email
        const linkedin = contact?.linkedin_url || contact?.linkedinUrl;
        if (linkedin) fields['LinkedIn URL'] = linkedin;
        if (!contact?.email) console.log(`   ✗ No contact found → marked Research Needed`);
      }

      // Industry — only fill if currently empty
      if (industry && !rf['Industry']) fields['Industry'] = industry;

      // AB Test Group — only assign if not already set
      if (!rf['AB Test Group']) {
        fields['AB Test Group'] = assignAbGroup(isBespoke, signalType);
      }

      // Proof Clients — set based on effective industry
      const effectiveIndustry = industry || rf['Industry'] || null;
      if (effectiveIndustry) {
        fields['Proof Clients'] = getProofClients(effectiveIndustry);
      }

      // Acquired Company — M&A only, only if field is currently empty
      if (signalType === 'M&A Activity' && !rf['Acquired Company'] && acquiredCompany) {
        fields['Acquired Company'] = acquiredCompany;
      }

      if (Object.keys(fields).length > 0) {
        airtableUpdates.push({ id: record.id, fields });
      }
    }

    await pause(400);
  }

  // ── Write to Airtable ─────────────────────────────────────────────────────────
  if (LIVE && airtableUpdates.length > 0) {
    console.log(`\nWriting ${airtableUpdates.length} updates to Airtable...`);
    try {
      await updateRecords(airtableUpdates);
      console.log(`  ✅ Done`);
    } catch (err) {
      if (/unknown field|proof clients/i.test(err.message)) {
        console.error(`  ❌ Field error: ${err.message}`);
        console.error(`  ⚠️  Make sure "Proof Clients" field exists in Airtable (Long text), then re-run.`);
      } else {
        console.error(`  ❌ Airtable write error: ${err.message}`);
      }
    }
  }

  // ── Report ─────────────────────────────────────────────────────────────────────
  console.log('\n════════════════════════════════════════════════════════════');
  console.log('RESULTS');
  console.log('════════════════════════════════════════════════════════════');
  console.log(`  Companies processed      : ${companiesProcessed}`);
  console.log(`  Contacts found           : ${contactsFound}`);
  console.log(`  Contacts not found       : ${contactsNotFound}`);
  console.log(`  Airtable records queued  : ${airtableUpdates.length}`);

  if (!LIVE) {
    console.log('\n  This was a PREVIEW — run with --live to apply all changes.');
    console.log('  ⚠️  Ensure "Proof Clients" field exists in Airtable before running --live.');
  }
  console.log('════════════════════════════════════════════════════════════');
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
