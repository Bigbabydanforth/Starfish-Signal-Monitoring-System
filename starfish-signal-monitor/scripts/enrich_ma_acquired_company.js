/**
 * scripts/enrich_ma_acquired_company.js
 *
 * Enriches unpushed M&A signals with:
 *   1. Acquired Company  — Claude Sonnet reads Brief + Signal Details to extract the name
 *   2. Acquired Company Industry — Apollo /organizations/search by acquired company name
 *                                  → Hunter /domain-search fallback
 *                                  → Claude Haiku industry-guess fallback
 *
 * Targeting rules:
 *   - Signal Type = "M&A Activity"
 *   - HubSpot Pushed = FALSE / blank
 *   - Missing Acquired Company OR missing Acquired Company Industry (processes both gaps)
 *
 * Run:
 *   node --env-file=.env scripts/enrich_ma_acquired_company.js              (preview — no API calls, no writes)
 *   node --env-file=.env scripts/enrich_ma_acquired_company.js --live       (enrich + write)
 *   node --env-file=.env scripts/enrich_ma_acquired_company.js --live --batch=10  (limit to 10 records)
 */

import 'dotenv/config';
import axios     from 'axios';
import Anthropic from '@anthropic-ai/sdk';
import { query, updateRecords } from '../execution/utils/airtable_client.js';
import { extractDomain }        from '../execution/utils/email_enrichment.js';

const LIVE     = process.argv.includes('--live');
const batchArg = process.argv.find(a => a.startsWith('--batch='));
const BATCH    = batchArg ? parseInt(batchArg.split('=')[1], 10) : Infinity;

const APOLLO_BASE = process.env.APOLLO_API_URL || 'https://api.apollo.io/v1';
const HUNTER_BASE = 'https://api.hunter.io/v2';

function pause(ms) { return new Promise(r => setTimeout(r, ms)); }

let _anthropic = null;
function getAnthropic() {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}

// ── Step 1: Claude Sonnet — extract acquired company name ─────────────────────
async function extractAcquiredCompany(companyName, brief, signalDetails) {
  const context = [brief, signalDetails].filter(Boolean).join('\n\n').trim();
  if (!context) return null;

  try {
    const msg = await getAnthropic().messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 100,
      messages: [{
        role:    'user',
        content: `This is an M&A signal about "${companyName}". Read the information below and extract ONLY the exact name of the company being acquired (the target company). If you cannot clearly identify it, respond with exactly: Unknown

${context}

Respond with just the company name — nothing else. No explanation. No punctuation.`,
      }],
    });
    const result = (msg.content[0]?.text || '').trim().replace(/['"]/g, '');
    if (!result || result.toLowerCase() === 'unknown' || result.length > 150) return null;
    if (result.includes('\n') || result.split(' ').length > 8) return null;
    return result;
  } catch (err) {
    console.log(`  [Claude/extract] Error: ${err.message}`);
    return null;
  }
}

// ── Step 2a: Apollo — search by company name, get domain + industry ───────────
async function apolloLookup(acquiredCompanyName) {
  if (!process.env.APOLLO_API_KEY) return { domain: null, industry: null };
  try {
    const res = await axios.post(`${APOLLO_BASE}/organizations/search`, {
      q_organization_name: acquiredCompanyName,
      per_page: 1,
      page:     1,
    }, {
      headers: { 'X-Api-Key': process.env.APOLLO_API_KEY, 'Content-Type': 'application/json' },
      timeout: 15000,
    });
    const org = res.data?.organizations?.[0];
    if (!org) return { domain: null, industry: null };
    const domain   = extractDomain(org.website_url || org.primary_domain) || null;
    const industry = org.industry || null;
    return { domain, industry };
  } catch (err) {
    console.log(`  [Apollo] Error for "${acquiredCompanyName}": ${err.response?.status || err.message}`);
    return { domain: null, industry: null };
  }
}

// ── Step 2b: Hunter — domain-search, infer industry from job_data or titles ───
// Hunter domain-search returns contacts + company data. We check company.industry
// if available, otherwise fall through to Claude.
async function hunterLookup(domain) {
  if (!process.env.HUNTER_API_KEY || !domain) return null;
  try {
    const res = await axios.get(`${HUNTER_BASE}/domain-search`, {
      params: { domain, api_key: process.env.HUNTER_API_KEY, limit: 1 },
      timeout: 15000,
    });
    // Hunter response: data.data.organization is sometimes present
    const data = res.data?.data;
    return data?.organization?.industry || null;
  } catch (err) {
    console.log(`  [Hunter] Error for "${domain}": ${err.response?.status || err.message}`);
    return null;
  }
}

// ── Step 2c: Claude Haiku — guess industry from company name ──────────────────
async function claudeGuessIndustry(acquiredCompanyName) {
  try {
    const msg = await getAnthropic().messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 50,
      messages: [{
        role:    'user',
        content: `What industry is "${acquiredCompanyName}" in? Respond with just the industry name — 1-5 words, no explanation.`,
      }],
    });
    const result = (msg.content[0]?.text || '').trim();
    const REFUSAL = ['i don', 'i\'m not', 'i cannot', 'i don\'t know', 'unknown', 'not sure', 'i\'m unable'];
    if (!result || result.length > 50 || REFUSAL.some(r => result.toLowerCase().includes(r))) return null;
    return result;
  } catch (err) {
    console.log(`  [Claude/industry] Error: ${err.message}`);
    return null;
  }
}

// ── Resolve industry: Apollo → Hunter → Claude Haiku ─────────────────────────
async function resolveAcquiredIndustry(acquiredCompanyName) {
  console.log(`  → Looking up industry for: "${acquiredCompanyName}"`);

  // Step 2a: Apollo
  const apollo = await apolloLookup(acquiredCompanyName);
  await pause(400);
  if (apollo.industry) {
    console.log(`    [Apollo] ✓ ${apollo.industry}`);
    return { industry: apollo.industry, source: 'Apollo', domain: apollo.domain };
  }

  // Step 2b: Hunter (needs domain — use Apollo domain if found, else skip)
  if (apollo.domain) {
    const hunterIndustry = await hunterLookup(apollo.domain);
    await pause(300);
    if (hunterIndustry) {
      console.log(`    [Hunter] ✓ ${hunterIndustry}`);
      return { industry: hunterIndustry, source: 'Hunter', domain: apollo.domain };
    }
  }

  // Step 2c: Claude Haiku guess
  const guessed = await claudeGuessIndustry(acquiredCompanyName);
  await pause(300);
  if (guessed) {
    console.log(`    [Claude/Haiku] ✓ ${guessed} (guessed)`);
    return { industry: guessed, source: 'Claude', domain: apollo.domain };
  }

  console.log(`    ✗ Industry unresolved`);
  return { industry: null, source: null, domain: apollo.domain };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
  console.log('════════════════════════════════════════════════════════════');
  console.log('ENRICH M&A — Acquired Company + Acquired Company Industry');
  console.log(`Mode  : ${LIVE ? 'LIVE — calling APIs + writing to Airtable' : 'PREVIEW — no API calls, no writes'}`);
  if (BATCH < Infinity) console.log(`Batch : ${BATCH} records max`);
  console.log('════════════════════════════════════════════════════════════\n');

  console.log('Fetching unpushed M&A signals...');
  let records;
  try {
    records = await query({
      filterByFormula: `AND(
        {Signal Type} = "M&A Activity",
        OR({HubSpot Pushed}=FALSE(), {HubSpot Pushed}=BLANK())
      )`,
      fields: [
        'Company Name', 'Signal Type', 'Brief', 'Signal Details',
        'Acquired Company', 'Acquired Company Industry',
      ],
    }, 120000);
  } catch (err) {
    console.error('Airtable fetch failed:', err.message);
    process.exit(1);
  }

  console.log(`  Total unpushed M&A records: ${records.length}`);

  // Identify what needs to be done per record
  const needsName     = records.filter(r => !r.fields['Acquired Company']?.trim());
  const needsIndustry = records.filter(r => r.fields['Acquired Company']?.trim() && !r.fields['Acquired Company Industry']?.trim());

  console.log(`  Missing Acquired Company           : ${needsName.length}`);
  console.log(`  Has name but missing Industry      : ${needsIndustry.length}`);
  console.log(`  Total records to process           : ${records.filter(r => !r.fields['Acquired Company']?.trim() || !r.fields['Acquired Company Industry']?.trim()).length}\n`);

  // All records that need at least one field filled
  const toProcess = records
    .filter(r => !r.fields['Acquired Company']?.trim() || !r.fields['Acquired Company Industry']?.trim())
    .slice(0, BATCH);

  if (toProcess.length === 0) {
    console.log('Nothing to enrich — all M&A records have Acquired Company and Industry.');
    return;
  }

  if (!LIVE) {
    console.log('Sample records to process (first 10):');
    for (const r of toProcess.slice(0, 10)) {
      const company  = (r.fields['Company Name'] || '(unknown)').padEnd(35);
      const hasName  = r.fields['Acquired Company']?.trim() ? `"${r.fields['Acquired Company']}"` : '— MISSING';
      const hasInd   = r.fields['Acquired Company Industry']?.trim() ? r.fields['Acquired Company Industry'] : '— MISSING';
      console.log(`  ${company} | ${hasName.padEnd(30)} | ${hasInd}`);
    }
    if (toProcess.length > 10) console.log(`  ... and ${toProcess.length - 10} more`);
    console.log(`\nPREVIEW: Would process ${toProcess.length} records.`);
    console.log('Run with --live to apply.');
    return;
  }

  // ── LIVE: enrich and write ──────────────────────────────────────────────────
  let nameExtracted = 0, industryResolved = 0, failed = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const r          = toProcess[i];
    const f          = r.fields;
    const company    = f['Company Name'] || '(unknown)';
    let acquiredName = (f['Acquired Company'] || '').trim() || null;
    let acquiredInd  = (f['Acquired Company Industry'] || '').trim() || null;

    console.log(`[${i + 1}/${toProcess.length}] ${company}`);
    console.log(`  Acquired Company : ${acquiredName || '— missing'}`);
    console.log(`  Industry         : ${acquiredInd  || '— missing'}`);

    const updates = {};

    // Step 1: Extract acquired company name if missing
    if (!acquiredName) {
      const extracted = await extractAcquiredCompany(company, f['Brief'] || '', f['Signal Details'] || '');
      await pause(500);
      if (extracted) {
        console.log(`  [Claude/Sonnet] ✓ Acquired Company: "${extracted}"`);
        acquiredName = extracted;
        updates['Acquired Company'] = extracted;
        nameExtracted++;
      } else {
        console.log(`  [Claude/Sonnet] ✗ Could not extract acquired company name`);
        failed++;
        console.log('');
        continue; // Can't resolve industry without a name
      }
    }

    // Step 2: Resolve industry if missing
    if (!acquiredInd) {
      const { industry, source } = await resolveAcquiredIndustry(acquiredName);
      if (industry) {
        acquiredInd = industry;
        updates['Acquired Company Industry'] = industry;
        industryResolved++;
        console.log(`  [${source}] Acquired Company Industry: "${industry}"`);
      } else {
        console.log(`  ✗ Industry unresolved — will write name only`);
      }
    } else {
      console.log(`  Industry already set — skipping industry lookup`);
    }

    // Write whatever we have
    if (Object.keys(updates).length === 0) {
      console.log(`  (nothing to write)\n`);
      continue;
    }

    try {
      await updateRecords([{ id: r.id, fields: updates }]);
      const written = Object.entries(updates).map(([k, v]) => `${k}: "${v}"`).join(', ');
      console.log(`  ✓ Written: ${written}\n`);
    } catch (writeErr) {
      console.log(`  ✗ Airtable write failed: ${writeErr.message}\n`);
      failed++;
    }

    await pause(800);
  }

  console.log('════════════════════════════════════════════════════════════');
  console.log('RESULTS');
  console.log('════════════════════════════════════════════════════════════');
  console.log(`  Records processed           : ${toProcess.length}`);
  console.log(`  Acquired Company extracted  : ${nameExtracted}`);
  console.log(`  Industry resolved           : ${industryResolved}`);
  console.log(`  Failed / skipped            : ${failed}`);
  console.log('════════════════════════════════════════════════════════════');
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
