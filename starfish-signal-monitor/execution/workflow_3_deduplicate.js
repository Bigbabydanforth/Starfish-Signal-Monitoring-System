import 'dotenv/config';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

import * as airtableClient from './utils/airtable_client.js';
import { normalizeCompanyName, isGarbageName } from './utils/text_parsing.js';
import { getTodayStamp, getDateDaysAgo } from './utils/date_helpers.js';
import { sendErrorAlert } from './utils/telegram_client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TMP_DIR = resolve(__dirname, '../.tmp');

// ── Merge duplicate signals within the same batch ─────────────────────────────
// When the same company appears N times in one fetch cycle:
//   - Keep one record
//   - Combine Signal Details to show all sources
//   - Mark signal count (signals seen multiple times = stronger signal)
//   - Boost priority if count >= 2
function mergeSignals(signals) {
  const groups = {};

  for (const signal of signals) {
    const key = normalizeCompanyName(signal.company.name);
    if (!groups[key]) {
      groups[key] = [];
    }
    groups[key].push(signal);
  }

  const merged = [];
  for (const [, group] of Object.entries(groups)) {
    if (group.length === 1) {
      merged.push(group[0]);
      continue;
    }

    // Multiple signals for same company — merge them.
    // Deep-copy the company object so mutations to base.company (revenue, website, etc.)
    // don't bleed back into the original signal object still held in group[0].
    const base = {
      ...group[0],
      company: {
        ...group[0].company,
        headquarters: { ...group[0].company?.headquarters }
      }
    };
    const count = group.length;

    // Combine signal details from all sources — extract from actual signal shape
    const allDetails = group
      .map((s, i) => {
        let detail = '';
        if (s.type === 'Job Change' && s.person) {
          detail = `${s.person.first_name || ''} ${s.person.last_name || ''} joined as ${s.person.title || 'Unknown title'}`.trim();
        } else if (s.type === 'News/Press' && s.article) {
          detail = s.article.title || s.article.description || '';
        } else if (s.type === 'M&A Activity' && s.deal) {
          detail = `${(s.deal.type || '').replace(/_/g, ' ').toUpperCase()}: ${s.company?.name || ''}${s.deal.seller ? ` acquiring ${s.deal.seller}` : ''}`;
        } else if (s.type === 'Rebrand') {
          detail = `${s.company?.name || ''} is rebranding${s.rebrand?.new_name ? ` to ${s.rebrand.new_name}` : ''}`;
        }
        return detail ? `[Source ${i + 1}] ${detail}` : '';
      })
      .filter(Boolean)
      .join('\n\n');

    base.signalDetails = `⚡ SIGNAL SEEN ${count}x — Multiple sources confirm this signal:\n\n${allDetails}`;

    // Combine source URLs
    const allUrls = [...new Set(group.map(s => s.source_url).filter(Boolean))];
    base.source_url = allUrls.join(' | ');

    // Boost priority one step when seen 2+ times: LOW→MEDIUM, MEDIUM→HIGH.
    // Two independent sources confirming the same company is a genuinely stronger signal.
    // HIGH stays HIGH — there is no tier above it, so no boost applies.
    if (count >= 2 && base.priority !== 'HIGH') {
      base.priority = base.priority === 'LOW' ? 'MEDIUM' : 'HIGH';
      console.log(`  [Merge] ${base.company.name} — seen ${count}x, boosted priority to ${base.priority}`);
    }

    console.log(`  [Merge] ${base.company.name} — merged ${count} signals into 1`);
    merged.push(base);
  }

  return merged;
}

async function deduplicateSignals(enrichedSignals) {
  const today = getTodayStamp();

  if (enrichedSignals.length === 0) {
    console.log('[Deduplication] No signals to deduplicate — skipping Airtable query');
    fs.writeFileSync(`${TMP_DIR}/final_signals_${today}.json`, '[]');
    fs.writeFileSync(`${TMP_DIR}/duplicates_removed_${today}.json`, '[]');
    return [];
  }

  // Step 3.0: Filter out garbage names (headlines, not real companies)
  const beforeGarbage = enrichedSignals.length;
  const cleanSignals = enrichedSignals.filter(s => !isGarbageName(s.company.name));
  const garbageRemoved = beforeGarbage - cleanSignals.length;
  if (garbageRemoved > 0) {
    console.log(`[Deduplication] Removed ${garbageRemoved} garbage/non-company signals`);
  }

  // Step 3.1: Merge duplicates within the incoming batch
  const mergedSignals = mergeSignals(cleanSignals);
  const mergedCount = cleanSignals.length - mergedSignals.length;
  if (mergedCount > 0) {
    console.log(`[Deduplication] Merged ${mergedCount} duplicate signals within this batch`);
  }

  // Step 3.2: Query last 90 days of Airtable records for deduplication (with retry).
  // 90 days matches the job-change signal window — no point deduplicating against
  // records older than that. Filtering here also keeps the query fast as the database grows.
  // Uses 91 days with IS_AFTER because IS_AFTER is exclusive (strictly greater than),
  // so getDateDaysAgo(91) makes IS_AFTER include records from exactly 90 days ago.
  let recentCompanyNames = [];
  let dedupSkipped = false;
  const ninetyDaysAgo = getDateDaysAgo(91);

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      // H-NEW-2: no maxRecords cap — let Airtable SDK paginate through all records.
      // The old 5000 cap caused the alert to fire AFTER dedup had already run on an
      // incomplete set, silently allowing duplicates through. Removing it ensures the
      // dedup set is always complete regardless of database growth.
      const allRecords = await airtableClient.query({
        filterByFormula: `IS_AFTER({Date Detected}, '${ninetyDaysAgo}')`,
        fields:          ['Company Name']
      });

      recentCompanyNames = allRecords
        .map(record => record.fields['Company Name'])
        .filter(name => name);

      console.log(`[Airtable] Loaded ${recentCompanyNames.length} companies from full database for dedup`);

      // Alert when the 90-day dedup window is getting very large — helps track database growth.
      // The SDK paginates automatically so there is no hard cap, but a very large dedup set
      // slows the query and signals the database may need archiving soon.
      if (recentCompanyNames.length >= 5000) {
        console.warn(`[Airtable] ⚠️  Dedup set is at ${recentCompanyNames.length} records from the last 90 days — database is growing large, consider archiving old records.`);
        try {
          await sendErrorAlert(`⚠️ Airtable dedup set is at ${recentCompanyNames.length} records from the last 90 days. No duplicates slipping through — dedup is complete — but the database is growing large. Consider archiving records older than 90 days.`);
        } catch (alertErr) {
          console.error('[Dedup] Failed to send size alert via Telegram:', alertErr.message);
        }
      } else if (recentCompanyNames.length >= 4500) {
        console.warn(`[Airtable] ⚠️  Dedup set is at ${recentCompanyNames.length} records from the last 90 days — database growth is accelerating.`);
      }

      break; // success — exit retry loop

    } catch (error) {
      if (attempt === 1) {
        console.warn(`[Airtable] Query failed (attempt 1/2) — retrying in 2s: ${error.message}`);
        await new Promise(r => setTimeout(r, 2000));
      } else {
        console.warn(`[Airtable] Query failed (attempt 2/2) — proceeding WITHOUT deduplication: ${error.message}`);
        console.warn('[Airtable] WARNING: Dedup was skipped — duplicate signals may be saved to Airtable');
        dedupSkipped = true;
        // Use try/catch so if Telegram is also down we still get a visible console error.
        // The original .catch(() => {}) silently swallowed Telegram failures, leaving no trace.
        try {
          await sendErrorAlert(`⚠️ Airtable dedup query failed after 2 attempts — deduplication was SKIPPED for this run.\n\nDuplicate signals may have been written to Airtable.\nError: ${error.message}`);
        } catch (alertErr) {
          console.error('[CRITICAL] Both Airtable dedup AND Telegram alert failed — check connectivity immediately. Dedup was skipped.');
          console.error('[Telegram] Alert send failed:', alertErr.message);
        }
      }
    }
  }

  // Step 3.3: Normalize recent names into a Set for O(1) lookups
  const normalizedRecent = new Set(recentCompanyNames.map(normalizeCompanyName));

  // Step 3.4: Check each merged signal against Airtable history
  const deduplicatedSignals = [];
  const duplicatesFound     = [];

  for (const signal of mergedSignals) {
    // If Airtable query failed, pass all signals through without dedup
    if (dedupSkipped) {
      deduplicatedSignals.push(signal);
      continue;
    }

    const normalizedName = normalizeCompanyName(signal.company.name);

    if (normalizedRecent.has(normalizedName)) {
      console.log(`[Duplicate] Skipping (already in Airtable): ${signal.company.name}`);
      duplicatesFound.push(signal);
    } else {
      deduplicatedSignals.push(signal);
    }
  }

  console.log(`[Deduplication] ${enrichedSignals.length} → ${deduplicatedSignals.length} signals (removed ${garbageRemoved} garbage, ${mergedCount} merged, ${duplicatesFound.length} already in Airtable)`);

  // Step 3.5: Save
  fs.writeFileSync(`${TMP_DIR}/final_signals_${today}.json`,         JSON.stringify(deduplicatedSignals, null, 2));
  fs.writeFileSync(`${TMP_DIR}/duplicates_removed_${today}.json`,    JSON.stringify(duplicatesFound, null, 2));

  return deduplicatedSignals;
}

export default deduplicateSignals;
