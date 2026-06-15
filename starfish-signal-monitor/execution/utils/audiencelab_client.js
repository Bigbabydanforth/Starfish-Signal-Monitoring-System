/**
 * audiencelab_client.js
 *
 * Fetches signals from AudienceLab's two segments:
 *   - Pixel / Website Visitors  → type: 'Website Visitor'   → always HIGH priority
 *   - Brand Strategy Intent Leads → type: 'Brand Strategy Intent' → Claude ranks them
 *
 * Auth: X-Api-Key header
 * API:  https://api.audiencelab.io/segments/{id}?page={n}&page_size={n}
 *
 * Deduplication: checks Airtable for existing AudienceLab company names so only
 * truly new records flow through the pipeline (avoids wasting Claude credits on repeats).
 */

import 'dotenv/config';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { query as airtableQuery } from './airtable_client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const TMP_DIR    = resolve(__dirname, '../../.tmp');

const BASE_URL      = 'https://api.audiencelab.io';
const API_KEY       = process.env.AUDIENCELAB_API_KEY;
const SEGMENT_PIXEL = process.env.AUDIENCELAB_SEGMENT_PIXEL;
const SEGMENT_LEADS = process.env.AUDIENCELAB_SEGMENT_LEADS;
const PAGE_SIZE     = 100;

// Per-run caps for each AudienceLab segment.
// Website Visitors are high-value but capped to avoid swamping the pipeline on busy days.
// Brand Strategy Intent leads are capped to keep Claude enrichment costs predictable.
// Any records not processed today will re-appear tomorrow and be picked up then.
const MAX_PIXEL_PER_RUN = Number(process.env.AUDIENCELAB_MAX_PIXEL_PER_RUN) || 300;
const MAX_LEADS_PER_RUN = Number(process.env.AUDIENCELAB_MAX_LEADS_PER_RUN) || 200;

// ── Helpers ───────────────────────────────────────────────────────────────────

// "10000+" → 10000  |  "5001 to 10000" → 5001  |  "501 to 1000" → 501
function parseEmployeeCount(str) {
  if (!str) return null;
  const match = str.match(/(\d[\d,]*)/);
  if (!match) return null;
  return parseInt(match[1].replace(/,/g, ''), 10);
}

// Normalize for dedup comparison — same logic as workflow_3
function normalizeName(name) {
  if (!name) return '';
  return name.toLowerCase().trim().replace(/[^a-z0-9]/g, '');
}

// Take the first value from a comma-separated AudienceLab field (emails or phone numbers)
function firstValue(str) {
  if (!str) return null;
  return str.split(',')[0].trim() || null;
}

// Normalize a domain/URL from AudienceLab into a clean https:// URL.
// Handles cases where COMPANY_DOMAIN already includes a protocol or www prefix.
function normalizeWebsite(domain) {
  if (!domain) return null;
  const clean = domain.trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/.*$/, '');
  return clean ? `https://${clean}` : null;
}

// ── Pagination cursor — tracks which page each segment left off at ────────────
// Saved to .tmp/audiencelab_cursor.json so each run picks up where the last stopped.
// When a segment is fully exhausted, its cursor resets to 1 for the next cycle.
const CURSOR_FILE = path.join(TMP_DIR, 'audiencelab_cursor.json');

function loadCursor() {
  try {
    if (fs.existsSync(CURSOR_FILE)) {
      return JSON.parse(fs.readFileSync(CURSOR_FILE, 'utf8'));
    }
  } catch { /* corrupt file — start fresh */ }
  return { pixel_start_page: 1, leads_start_page: 1 };
}

function saveCursor(cursor) {
  try {
    fs.writeFileSync(CURSOR_FILE, JSON.stringify(cursor, null, 2));
  } catch (err) {
    console.warn('[AudienceLab] Could not save cursor file:', err.message);
  }
}

// ── Fetch pages starting from a given page, up to maxRecords ─────────────────
// Returns { records, nextPage } where nextPage is null if the segment is exhausted.

async function fetchFromPage(segmentId, segmentLabel, startPage, maxRecordsNeeded) {
  const records  = [];
  let page       = startPage;
  let totalPages = startPage; // will be updated on first response

  while (page <= totalPages && records.length < maxRecordsNeeded) {
    const url = `${BASE_URL}/segments/${segmentId}?page=${page}&page_size=${PAGE_SIZE}`;
    try {
      const res = await axios.get(url, {
        headers: { 'X-Api-Key': API_KEY },
        timeout: 15000
      });
      const data = res.data;
      totalPages = data.total_pages || 1;
      const pageRecords = data.data || [];
      records.push(...pageRecords);

      if (page === startPage) {
        console.log(`[AudienceLab] ${segmentLabel}: ${data.total_records} total records across ${totalPages} page(s) — starting at page ${startPage}`);
      }

      page++;
      if (page <= totalPages && records.length < maxRecordsNeeded) {
        await new Promise(r => setTimeout(r, 400));
      }

    } catch (err) {
      const status = err.response?.status;
      console.error(`[AudienceLab] ${segmentLabel} page ${page} failed (${status ?? err.message}) — stopping`);
      break;
    }
  }

  // If we've gone past the last page, the segment is fully exhausted this cycle — reset to 1
  const nextPage = page > totalPages ? 1 : page;
  const exhausted = page > totalPages;
  if (exhausted) {
    console.log(`[AudienceLab] ${segmentLabel}: all pages processed — cursor reset to page 1 for next cycle`);
  } else {
    console.log(`[AudienceLab] ${segmentLabel}: stopping at page ${page} — will continue from here next run`);
  }

  return { records, nextPage };
}

// ── Main export ───────────────────────────────────────────────────────────────

async function fetchAudienceLabSignals() {
  if (!API_KEY) {
    console.log('[AudienceLab] AUDIENCELAB_API_KEY not set — skipping');
    return [];
  }
  if (!SEGMENT_PIXEL && !SEGMENT_LEADS) {
    console.log('[AudienceLab] No segment IDs set — skipping');
    return [];
  }

  const todayStr = new Date().toISOString().split('T')[0];
  const today    = todayStr.replace(/-/g, '');
  const cutoff30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  // ── Load cursor — where each segment left off last run ───────────────────────
  const cursor = loadCursor();
  console.log(`[AudienceLab] Resuming from cursor — Pixel page ${cursor.pixel_start_page}, Leads page ${cursor.leads_start_page}`);

  // ── Load existing AudienceLab company names from Airtable (last 90 days) ────
  const cutoff90Str = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const existingNames = new Set();
  try {
    const existing = await airtableQuery({
      filterByFormula: `AND(OR({Signal Type} = "Website Visitor", {Signal Type} = "Brand Strategy Intent"), IS_AFTER({Date Detected}, "${cutoff90Str}"))`,
      fields: ['Company Name']
    });
    for (const rec of existing) {
      const name = rec.fields?.['Company Name'];
      if (name) existingNames.add(normalizeName(name));
    }
    console.log(`[AudienceLab] ${existingNames.size} AudienceLab companies seen in last 90 days — will skip`);
  } catch (err) {
    console.warn('[AudienceLab] Could not load Airtable cache — proceeding without pre-dedup:', err.message);
  }

  const allSignals  = [];
  const seenThisRun = new Set();
  let pixelAdded    = 0;
  let leadsAdded    = 0;
  let nextPixelPage = cursor.pixel_start_page;
  let nextLeadsPage = cursor.leads_start_page;

  // ── Pixel segment — Website Visitors ───────────────────────────────────────
  if (SEGMENT_PIXEL) {
    const { records: pixelRecords, nextPage: afterPixel } = await fetchFromPage(
      SEGMENT_PIXEL, 'Pixel', cursor.pixel_start_page, MAX_PIXEL_PER_RUN
    );
    nextPixelPage = afterPixel;
    let pixelSkipped = 0;

    for (let pixelIdx = 0; pixelIdx < pixelRecords.length; pixelIdx++) {
      const record = pixelRecords[pixelIdx];
      if (pixelAdded >= MAX_PIXEL_PER_RUN) {
        pixelSkipped += pixelRecords.length - pixelIdx;
        break;
      }
      const companyName = (record.COMPANY_NAME || '').trim();
      if (!companyName) { pixelSkipped++; continue; }

      // Require a valid EVENT_TIMESTAMP — records with no timestamp or an invalid/garbled date
      // are dropped. Without a timestamp we cannot verify recency, so we treat them as stale.
      // This also prevents a corrupt date string from reaching Airtable's Date Detected field.
      if (!record.EVENT_TIMESTAMP) { pixelSkipped++; continue; }
      const visitDate = new Date(record.EVENT_TIMESTAMP);
      if (isNaN(visitDate.getTime())) { pixelSkipped++; continue; } // garbled date — drop
      if (visitDate < cutoff30) { pixelSkipped++; continue; }       // older than 30 days — drop

      const normalized = normalizeName(companyName);
      if (existingNames.has(normalized) || seenThisRun.has(normalized)) { pixelSkipped++; continue; }
      seenThisRun.add(normalized);

      const detectedDate = record.EVENT_TIMESTAMP.split('T')[0];

      allSignals.push({
        type:       'Website Visitor',
        source:     'AudienceLab',
        source_url: record.FULL_URL || `https://api.audiencelab.io/segments/${SEGMENT_PIXEL}`,
        company: {
          name:           companyName,
          revenue:        null,
          funding_total:  null,
          funding_stage:  null,
          headquarters:   { city: null, state: null, country: 'united states' },
          industry:       record.COMPANY_INDUSTRY || null,
          website:        normalizeWebsite(record.COMPANY_DOMAIN),
          employee_count: parseEmployeeCount(record.COMPANY_EMPLOYEE_COUNT),
          founded_year:   null,
          stock_ticker:   null
        },
        person: {
          first_name:     record.FIRST_NAME  || null,
          last_name:      record.LAST_NAME   || null,
          title:          record.JOB_TITLE   || null,
          linkedin_url:   record.INDIVIDUAL_LINKEDIN_URL || null,
          email:          firstValue(record.BUSINESS_VERIFIED_EMAILS),
          job_started_at: null
        },
        detected_date:       detectedDate,
        raw_data:            record,
        audiencelab_segment: 'pixel'
      });
      pixelAdded++;
    }

    console.log(`[AudienceLab] Pixel: ${pixelAdded} new signals (${pixelSkipped} skipped) — next run starts at page ${nextPixelPage}`);
  }

  // ── Leads segment — Brand Strategy Intent ──────────────────────────────────
  if (SEGMENT_LEADS) {
    const { records: leadsRecords, nextPage: afterLeads } = await fetchFromPage(
      SEGMENT_LEADS, 'Leads', cursor.leads_start_page, MAX_LEADS_PER_RUN
    );
    nextLeadsPage = afterLeads;
    let leadsSkipped = 0;

    for (let leadsIdx = 0; leadsIdx < leadsRecords.length; leadsIdx++) {
      const record = leadsRecords[leadsIdx];
      if (leadsAdded >= MAX_LEADS_PER_RUN) {
        leadsSkipped += leadsRecords.length - leadsIdx;
        break;
      }

      const companyName = (record.COMPANY_NAME || '').trim();
      if (!companyName) { leadsSkipped++; continue; }

      const normalized = normalizeName(companyName);
      if (existingNames.has(normalized) || seenThisRun.has(normalized)) { leadsSkipped++; continue; }
      seenThisRun.add(normalized);

      const email = firstValue(record.BUSINESS_VERIFIED_EMAILS) || firstValue(record.BUSINESS_EMAIL);

      allSignals.push({
        type:       'Brand Strategy Intent',
        source:     'AudienceLab',
        source_url: `https://api.audiencelab.io/segments/${SEGMENT_LEADS}`,
        company: {
          name:           companyName,
          revenue:        null,
          funding_total:  null,
          funding_stage:  null,
          headquarters:   { city: record.COMPANY_CITY || null, state: null, country: 'united states' },
          industry:       record.COMPANY_INDUSTRY || null,
          website:        normalizeWebsite(record.COMPANY_DOMAIN),
          employee_count: parseEmployeeCount(record.COMPANY_EMPLOYEE_COUNT),
          founded_year:   null,
          stock_ticker:   null
        },
        person: {
          first_name:     record.FIRST_NAME   || null,
          last_name:      record.LAST_NAME    || null,
          title:          record.JOB_TITLE    || null,
          linkedin_url:   record.LINKEDIN_URL || null,
          email,
          job_started_at: null,
          department:     record.DEPARTMENT   || null,
          phone:          firstValue(record.DIRECT_NUMBER)
        },
        detected_date:       todayStr,
        raw_data:            record,
        audiencelab_segment: 'leads'
      });
      leadsAdded++;
    }

    console.log(`[AudienceLab] Leads: ${leadsAdded} new signals (${leadsSkipped} skipped) — next run starts at page ${nextLeadsPage}`);
  }

  // ── Save cursor for next run ──────────────────────────────────────────────────
  saveCursor({ pixel_start_page: nextPixelPage, leads_start_page: nextLeadsPage });

  // Save raw for debugging
  fs.writeFileSync(
    path.join(TMP_DIR, `audiencelab_raw_${today}.json`),
    JSON.stringify(allSignals, null, 2)
  );

  console.log(`[AudienceLab] Total new: ${allSignals.length} (${pixelAdded} Pixel Website Visitors, ${leadsAdded} Brand Strategy Intent Leads)`);

  return allSignals;
}

export { fetchAudienceLabSignals };
