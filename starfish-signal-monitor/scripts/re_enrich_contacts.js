/**
 * re_enrich_contacts.js
 *
 * Finds Airtable signal records where the email is a placeholder
 * (email_not_unlocked@domain.com) and HubSpot Pushed = false.
 * For each record, tries to find a real email, then updates Contact Info
 * in Airtable and optionally pushes to HubSpot.
 *
 * Intended to be run AFTER clean_hubspot_contacts.js --placeholders --live,
 * which resets placeholder records back to HubSpot Pushed = false.
 *
 * Enrichment logic (mirrors the live pipeline exactly):
 *   Job Change  → Apollo (LinkedIn match) → Hunter person finder
 *   All others  → findBroadcastContacts() (Apollo domain search + email unlock
 *                 + email verification + domain validation + Hunter fallback)
 *                 Records are grouped by company domain — ONE Apollo call per
 *                 company, contacts matched to Airtable records by send_day.
 *
 * Run with:
 *   node --env-file=.env scripts/re_enrich_contacts.js              (preview)
 *   node --env-file=.env scripts/re_enrich_contacts.js --live       (update Airtable)
 *   node --env-file=.env scripts/re_enrich_contacts.js --live --push (update Airtable + push to HubSpot)
 *   node --env-file=.env scripts/re_enrich_contacts.js --batch=50   (limit records processed)
 */

import 'dotenv/config';
import axios from 'axios';
import { query, updateRecords } from '../execution/utils/airtable_client.js';
import {
  findEmailWithApollo,
  findEmailWithHunterPerson,
  extractDomain,
} from '../execution/utils/email_enrichment.js';
import { findBroadcastContacts } from '../execution/utils/broadcast_contacts.js';
import { getKnownDomain } from '../execution/utils/known_domains.js';
import { pushSignalToHubSpot } from '../hubspot/pushSignalToHubSpot.js';

const LIVE     = process.argv.includes('--live');
const PUSH     = process.argv.includes('--push'); // only relevant with --live
const batchArg = process.argv.find(a => a.startsWith('--batch='));
const BATCH    = batchArg ? parseInt(batchArg.split('=')[1], 10) : Infinity;

const PLACEHOLDER = 'email_not_unlocked@domain.com';

function pause(ms) { return new Promise(r => setTimeout(r, ms)); }

const APOLLO_BASE = process.env.APOLLO_API_URL || 'https://api.apollo.io/v1';

// Resolves a company's bare domain using the same chain as the live pipeline:
//   1. Explicit website from Airtable / Contact Info (instant, no API)
//   2. KNOWN_DOMAINS lookup (instant, no API)
//   3. Apollo /organizations/enrich by company name (1 API call, no credit cost)
// Returns a bare domain string like "hubspot.com", or null if all steps fail.
const _domainCache = new Map();
async function resolveDomain(companyName, knownWebsite) {
  // Step 1: website already known
  const fromWebsite = extractDomain(knownWebsite);
  if (fromWebsite) return fromWebsite;

  // Step 2: hardcoded map of well-known companies
  const fromKnown = getKnownDomain(companyName);
  if (fromKnown) return fromKnown;

  // Step 3: Apollo org enrich by name (no credit cost)
  const cacheKey = `name:${companyName.toLowerCase().trim()}`;
  if (_domainCache.has(cacheKey)) return _domainCache.get(cacheKey);

  if (!process.env.APOLLO_API_KEY || !companyName) {
    if (!process.env.APOLLO_API_KEY) console.log(`   [Apollo/org] APOLLO_API_KEY not set — skipping`);
    return null;
  }
  try {
    // /organizations/search is more reliable than /organizations/enrich for name-based lookup
    const res = await axios.post(
      `${APOLLO_BASE}/organizations/search`,
      { q_organization_name: companyName, per_page: 1, page: 1 },
      { headers: { 'X-Api-Key': process.env.APOLLO_API_KEY, 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    const orgs = res.data?.organizations || [];
    const org  = orgs[0] || {};
    const domain = extractDomain(org.website_url || org.primary_domain) || null;
    if (domain) console.log(`   [Apollo/org] "${companyName}" → ${domain}`);
    _domainCache.set(cacheKey, domain);
    return domain;
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data?.message || err.message;
    console.log(`   [Apollo/org] "${companyName}" → ERROR ${status || ''}: ${detail}`);
    _domainCache.set(cacheKey, null);
    return null;
  }
}

// Extract company website embedded in Contact Info
// Format: "Website: https://..." or "Company Website: https://..."
function extractWebsiteFromContactInfo(contactInfo) {
  if (!contactInfo) return null;
  for (const line of contactInfo.split('\n')) {
    const t = line.trim();
    if (t.startsWith('Website: ')) return t.slice('Website: '.length).trim();
    if (t.startsWith('Company Website: ')) return t.slice('Company Website: '.length).trim();
  }
  return null;
}

// ── Parse Contact Info block into person fields ───────────────────────────────
function parseContactInfo(contactInfo) {
  if (!contactInfo) return {};
  const lines = contactInfo.split('\n').map(l => l.trim()).filter(Boolean);
  let name = null, title = null, linkedin = null;

  for (const line of lines) {
    if (!linkedin && /linkedin\.com/i.test(line)) {
      const m = line.match(/(https?:\/\/(?:www\.)?linkedin\.com\/\S+|(?:www\.)?linkedin\.com\/\S+)/i);
      if (m) linkedin = m[0].startsWith('http') ? m[0] : 'https://' + m[0];
      continue;
    }
    if (!name && !line.toLowerCase().startsWith('email') && !line.includes('@') && !line.startsWith('⚠️') && !line.startsWith('Website:') && !line.startsWith('http')) {
      name = line.replace(/^(name|title|email|linkedin)\s*:\s*/i, '').trim();
      continue;
    }
    if (name && !title && !line.includes('@') && !line.startsWith('http') && !/linkedin\.com/i.test(line)) {
      title = line.replace(/^(name|title|email|linkedin)\s*:\s*/i, '').trim();
    }
  }

  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  return {
    name,
    first_name:   parts[0]   || '',
    last_name:    parts.length > 1 ? parts.slice(1).join(' ') : '',
    title:        title       || '',
    linkedin_url: linkedin    || '',
  };
}

// Build a fresh Contact Info block from a contact object returned by findBroadcastContacts.
function buildContactInfo(contact) {
  const fullName = contact.name || [contact.first_name, contact.last_name].filter(Boolean).join(' ');
  const lines = [];
  if (fullName) lines.push(fullName);
  if (contact.title) lines.push(contact.title);
  if (contact.email) lines.push(contact.email);
  const linkedin = contact.linkedin_url || contact.linkedinUrl;
  if (linkedin) lines.push(linkedin);
  return lines.join('\n');
}

// Replace the placeholder email in Contact Info with a real one.
// Preserves all other lines intact (used for Job Change enrichment).
function replaceEmailInContactInfo(contactInfo, newEmail) {
  if (!contactInfo) return `Email: ${newEmail}`;
  let updated = contactInfo.replace(/email_not_unlocked@domain\.com/gi, newEmail);
  if (!updated.includes(newEmail)) {
    updated = updated.trimEnd() + `\nEmail: ${newEmail}`;
  }
  return updated;
}

// ── Push a single record to HubSpot after enrichment ─────────────────────────
async function pushRecord(record, contact, signal) {
  try {
    const result = await pushSignalToHubSpot(signal, contact, record.id);
    if (result.success) {
      console.log(`   ✓ Pushed to HubSpot (${result.contactId || 'ok'})`);
      await updateRecords([{ id: record.id, fields: { 'HubSpot Pushed': true } }]);
      return { pushed: 1, failed: 0 };
    } else {
      console.log(`   ✗ HubSpot push failed: ${result.error || result.reason}`);
      return { pushed: 0, failed: 1 };
    }
  } catch (err) {
    console.log(`   ✗ HubSpot push error: ${err.message}`);
    return { pushed: 0, failed: 1 };
  }
}

async function run() {
  console.log('════════════════════════════════════════════════════════════');
  console.log('RE-ENRICH PLACEHOLDER EMAIL CONTACTS');
  console.log('Job Change : Apollo (LinkedIn) → Hunter person');
  console.log('All others : findBroadcastContacts (Apollo domain + email unlock + Hunter fallback)');
  console.log(`Mode  : ${LIVE ? `LIVE (update Airtable${PUSH ? ' + push to HubSpot' : ''})` : 'PREVIEW (no changes)'}`);
  if (BATCH < Infinity) console.log(`Batch : ${BATCH} records max`);
  console.log('════════════════════════════════════════════════════════════\n');

  console.log('Fetching placeholder records from Airtable...');
  let records;
  try {
    records = await query({
      filterByFormula: `AND(
        FIND("${PLACEHOLDER}", {Contact Info}) > 0,
        OR({HubSpot Pushed}=FALSE(), {HubSpot Pushed}=BLANK())
      )`,
      fields: [
        'Company Name', 'Signal Type', 'Contact Info', 'Date Detected',
        'Company Website', 'Industry', 'Priority', 'Brief', 'Source URL',
        'Send Day', 'AB Test Group', 'Email Source', 'Bespoke', 'Bespoke Reason',
        'Claude Generated', 'Acquired Company',
      ],
      sort: [{ field: 'Date Detected', direction: 'asc' }],
    }, 120000); // 2-minute timeout for large result sets
  } catch (err) {
    console.error('Airtable fetch failed:', err.message);
    process.exit(1);
  }

  if (records.length === 0) {
    console.log('No un-pushed placeholder records found.');
    console.log('Run clean_hubspot_contacts.js --placeholders --live first, then re-run this script.');
    return;
  }

  const toProcess = records.slice(0, BATCH);
  console.log(`Found ${records.length} record(s) — processing ${toProcess.length}\n`);

  // ── Split: Job Change vs broadcast signals ────────────────────────────────
  const jobChangeRecords  = toProcess.filter(r => r.fields['Signal Type'] === 'Job Change');
  const broadcastRecords  = toProcess.filter(r => r.fields['Signal Type'] !== 'Job Change');

  console.log(`Job Change : ${jobChangeRecords.length} record(s) (Apollo → Hunter person)`);
  console.log(`Broadcast  : ${broadcastRecords.length} record(s) (findBroadcastContacts)`);

  // Group broadcast records by company name first (domain resolved later per-company)
  const companiesMap = new Map(); // companyName → { companyName, website, records[] }
  for (const r of broadcastRecords) {
    const contactInfo = r.fields['Contact Info'] || '';
    const website     = r.fields['Company Website'] || extractWebsiteFromContactInfo(contactInfo) || '';
    const companyName = r.fields['Company Name'] || '(unknown)';
    const key         = companyName.toLowerCase().trim();
    if (!companiesMap.has(key)) {
      companiesMap.set(key, { companyName, website, records: [] });
    }
    companiesMap.get(key).records.push(r);
  }
  console.log(`Unique companies to broadcast-enrich: ${companiesMap.size}\n`);

  let found   = 0;
  let notFound= 0;
  let pushed  = 0;
  let failed  = 0;

  // ══ Part 1: Job Change records ════════════════════════════════════════════
  if (jobChangeRecords.length > 0) {
    console.log('──────────────────────── JOB CHANGE ─────────────────────────');
    for (const record of jobChangeRecords) {
      const f           = record.fields;
      const companyName = f['Company Name'] || '';
      const signalType  = f['Signal Type']  || '';
      const contactInfo = f['Contact Info'] || '';
      const website     = f['Company Website'] || extractWebsiteFromContactInfo(contactInfo) || '';
      const industry    = f['Industry'] || '';
      const parsed      = parseContactInfo(contactInfo);

      console.log(`── ${companyName} [${signalType}]`);
      console.log(`   Record   : ${record.id}`);
      console.log(`   Contact  : ${parsed.name || '—'} | ${parsed.title || '—'}`);
      if (parsed.linkedin_url) console.log(`   LinkedIn : ${parsed.linkedin_url}`);

      const signal = {
        type:         signalType,
        company_name: companyName,
        company: { name: companyName, website },
        person: {
          first_name:   parsed.first_name,
          last_name:    parsed.last_name,
          linkedin_url: parsed.linkedin_url,
        },
      };

      if (!LIVE) {
        console.log(`   → WOULD call Apollo/Hunter to find email — skipped in preview\n`);
        continue;
      }

      let newEmail = null;

      // Apollo (needs LinkedIn URL)
      if (parsed.linkedin_url) {
        try {
          const result = await findEmailWithApollo(signal);
          if (result?.email) newEmail = result.email;
        } catch (err) {
          console.log(`   [Apollo] Error: ${err.message}`);
        }
        await pause(500);
      }

      // Hunter person finder (needs name + domain)
      if (!newEmail && parsed.first_name && parsed.last_name && website) {
        try {
          const result = await findEmailWithHunterPerson(signal);
          if (result) newEmail = result;
        } catch (err) {
          console.log(`   [Hunter/person] Error: ${err.message}`);
        }
        await pause(500);
      }

      if (!newEmail) {
        console.log(`   ✗ No email found\n`);
        notFound++;
        continue;
      }

      console.log(`   ✓ Found email: ${newEmail}`);
      found++;

      const updatedContactInfo = replaceEmailInContactInfo(contactInfo, newEmail);
      try {
        await updateRecords([{ id: record.id, fields: { 'Contact Info': updatedContactInfo } }]);
        console.log(`   ✓ Airtable updated`);
      } catch (err) {
        console.log(`   ✗ Airtable update failed: ${err.message}\n`);
        continue;
      }
      await pause(300);

      if (PUSH) {
        const contact = {
          name:         parsed.name    || '',
          first_name:   parsed.first_name,
          last_name:    parsed.last_name,
          email:        newEmail,
          title:        parsed.title   || '',
          linkedin_url: parsed.linkedin_url || '',
          send_day:     f['Send Day']  || 1,
          email_source: f['Email Source'] || 'Apollo',
          abGroup:      f['AB Test Group'] || undefined,
        };
        const fullSignal = {
          signal_type: signalType, type: signalType,
          company_name: companyName,
          company: { name: companyName, website, industry },
          industry,
          priority:       f['Priority']       || 'MEDIUM',
          brief:          f['Brief']          || '',
          source:         '',
          source_url:     f['Source URL']     || '',
          date_detected:  f['Date Detected']  || '',
          bespoke:        f['Bespoke'] === true,
          bespoke_reason: f['Bespoke Reason'] || '',
          acquired_company: f['Acquired Company'] || null,
        };
        const r = await pushRecord(record, contact, fullSignal);
        pushed += r.pushed;
        failed += r.failed;
        await pause(400);
      }

      console.log();
    }
  }

  // ══ Part 2: Broadcast signals (BSI, News/Press, M&A, etc.) ═══════════════
  if (companiesMap.size > 0) {
    console.log('──────────────────────── BROADCAST ──────────────────────────');
    for (const [, { companyName, website, records: companyRecords }] of companiesMap) {
      const industry    = companyRecords[0]?.fields['Industry'] || '';
      const signalType  = companyRecords[0]?.fields['Signal Type'] || '';

      console.log(`── ${companyName} [${signalType}] — ${companyRecords.length} record(s)`);

      // Sort records by send_day asc so we match contacts in order
      companyRecords.sort((a, b) => (a.fields['Send Day'] || 1) - (b.fields['Send Day'] || 1));

      if (!LIVE) {
        console.log(`   → WOULD resolve domain + call findBroadcastContacts (Apollo + Hunter) — skipped in preview`);
        console.log();
        continue;
      }

      // Resolve domain: website → KNOWN_DOMAINS → Apollo org enrich by name
      const domain = await resolveDomain(companyName, website);
      if (!domain) {
        console.log(`   ✗ Could not resolve domain — skipping`);
        notFound += companyRecords.length;
        console.log();
        continue;
      }
      console.log(`   Domain : ${domain}`);
      const resolvedWebsite = website || `https://${domain}`;

      let broadcastContacts = [];
      try {
        broadcastContacts = await findBroadcastContacts({
          domain,
          companyName,
          companyWebsite: resolvedWebsite,
          signalType,
        });
        await pause(600);
      } catch (err) {
        console.log(`   ✗ findBroadcastContacts error: ${err.message}`);
        notFound += companyRecords.length;
        console.log();
        continue;
      }

      // Match contacts to records by send_day.
      // contacts are already sorted by send_day by findBroadcastContacts.
      // For any record whose send_day matches a contact's send_day, use that contact.
      // Remaining records without a match are left as placeholder.
      const contactBySendDay = new Map(broadcastContacts.map(c => [c.send_day, c]));

      for (const record of companyRecords) {
        const f       = record.fields;
        const sendDay = f['Send Day'] || 1;

        // First try exact send_day match, then fall back to first available contact
        const contact = contactBySendDay.get(sendDay) || broadcastContacts[0] || null;

        if (!contact?.email) {
          console.log(`   send_day ${sendDay}: ✗ No contact found`);
          notFound++;
          continue;
        }

        console.log(`   send_day ${sendDay}: ✓ ${contact.name || [contact.first_name, contact.last_name].filter(Boolean).join(' ')} <${contact.email}> (${contact.title || '—'})`);
        found++;

        if (!LIVE) {
          console.log(`              → WOULD update Contact Info`);
          if (PUSH) console.log(`              → WOULD push to HubSpot`);
          continue;
        }

        const newContactInfo = buildContactInfo(contact);
        try {
          await updateRecords([{ id: record.id, fields: { 'Contact Info': newContactInfo } }]);
        } catch (err) {
          console.log(`              ✗ Airtable update failed: ${err.message}`);
          continue;
        }
        await pause(300);

        if (PUSH) {
          const pushContact = {
            name:         contact.name || [contact.first_name, contact.last_name].filter(Boolean).join(' '),
            first_name:   contact.first_name || '',
            last_name:    contact.last_name  || '',
            email:        contact.email,
            title:        contact.title      || '',
            linkedin_url: contact.linkedin_url || contact.linkedinUrl || '',
            send_day:     sendDay,
            email_source: contact.emailSource || contact.source || 'Apollo',
            abGroup:      f['AB Test Group']  || undefined,
          };
          const fullSignal = {
            signal_type: signalType, type: signalType,
            company_name: companyName,
            company: { name: companyName, website: resolvedWebsite, industry },
            industry,
            priority:       f['Priority']       || 'MEDIUM',
            brief:          f['Brief']          || '',
            source:         '',
            source_url:     f['Source URL']     || '',
            date_detected:  f['Date Detected']  || '',
            bespoke:        f['Bespoke'] === true,
            bespoke_reason: f['Bespoke Reason'] || '',
            acquired_company: f['Acquired Company'] || null,
          };
          const r = await pushRecord(record, pushContact, fullSignal);
          pushed += r.pushed;
          failed += r.failed;
          await pause(400);
        }
      }

      console.log();
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('════════════════════════════════════════════════════════════');
  console.log(`Records processed : ${toProcess.length}`);
  console.log(`Email found       : ${found}`);
  console.log(`Email not found   : ${notFound}`);
  if (PUSH && LIVE) {
    console.log(`Pushed to HubSpot : ${pushed}`);
    console.log(`Push failed       : ${failed}`);
  }
  if (!LIVE) {
    console.log('\nPreview only — run with --live to apply changes.');
    console.log('Add --push to also push to HubSpot immediately after enriching.');
  } else if (!PUSH && found > 0) {
    console.log(`\nAirtable updated. The push cron will pick up the ${found} enriched record(s) on the next run.`);
    console.log('Or run again with --live --push to push to HubSpot right now.');
  }
  console.log('════════════════════════════════════════════════════════════');
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
