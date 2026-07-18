import 'dotenv/config';
import fs from 'fs';
import { fileURLToPath } from 'url';

import { fetchApolloSignals, fetchPDLSignals, fetchMediaStackSignals, fetchPredictLeadsSignals, fetchNewsAPISignals } from './utils/api_clients.js';
import { fetchAudienceLabSignals, saveCursor } from './utils/audiencelab_client.js';
import { getTodayStamp } from './utils/date_helpers.js';

async function fetchSignals() {
  const today = getTodayStamp();

  if (!fs.existsSync('.tmp')) fs.mkdirSync('.tmp', { recursive: true });

  let apolloSignals         = [];
  let pdlSignals            = [];
  let mediaStackSignals     = [];
  let predictLeadsSignals   = [];
  let newsApiSignals        = [];
  let audienceLabSignals    = [];
  let audienceLabPendingCursor = null; // committed by main.js AFTER Airtable save succeeds

  // --- Parallel Fetching (Step 1.2 to 1.7) ---
  const fetchTasks = [
    {
      name: 'Apollo',
      fn: fetchApolloSignals,
      onSuccess: (res) => { apolloSignals = res; },
      onFailure: (err) => {
        console.error('[Apollo] API call failed:', err.message);
        fs.appendFileSync(`.tmp/error_log_${today}.txt`,
          `[${new Date().toISOString()}] Apollo API failed: ${err.message}\n`);
      }
    },
    {
      name: 'PDL',
      fn: fetchPDLSignals,
      onSuccess: (res) => { pdlSignals = res; },
      onFailure: (err) => {
        console.error('[PDL Source] API call failed:', err.message);
        fs.appendFileSync(`.tmp/error_log_${today}.txt`,
          `[${new Date().toISOString()}] PDL Source failed: ${err.message}\n`);
      }
    },
    {
      name: 'MediaStack',
      fn: fetchMediaStackSignals,
      onSuccess: (res) => { mediaStackSignals = res; },
      onFailure: (err) => {
        console.error('[MediaStack] API call failed:', err.message);
        fs.appendFileSync(`.tmp/error_log_${today}.txt`,
          `[${new Date().toISOString()}] MediaStack API failed: ${err.message}\n`);
      }
    },
    {
      name: 'PredictLeads',
      fn: fetchPredictLeadsSignals,
      onSuccess: (res) => {
        predictLeadsSignals = res;
        const maCount      = predictLeadsSignals.filter(s => s.type === 'M&A Activity').length;
        const rebrandCount = predictLeadsSignals.filter(s => s.type === 'Rebrand').length;
        if (predictLeadsSignals.length > 0) {
          console.log(`[PredictLeads] Breakdown: ${maCount} M&A, ${rebrandCount} Rebrand`);
        }
      },
      onFailure: (err) => {
        console.error('[PredictLeads] API call failed:', err.message);
        fs.appendFileSync(`.tmp/error_log_${today}.txt`,
          `[${new Date().toISOString()}] PredictLeads API failed: ${err.message}\n`);
      }
    },
    {
      name: 'NewsAPI',
      fn: fetchNewsAPISignals,
      onSuccess: (res) => { newsApiSignals = res; },
      onFailure: (err) => {
        console.error('[NewsAPI] API call failed:', err.message);
        fs.appendFileSync(`.tmp/error_log_${today}.txt`,
          `[${new Date().toISOString()}] NewsAPI failed: ${err.message}\n`);
      }
    },
    {
      name: 'AudienceLab',
      fn: fetchAudienceLabSignals,
      onSuccess: (res) => { audienceLabSignals = res.signals; audienceLabPendingCursor = res.pendingCursor; },
      onFailure: (err) => {
        console.error('[AudienceLab] API call failed:', err.message);
        fs.appendFileSync(`.tmp/error_log_${today}.txt`,
          `[${new Date().toISOString()}] AudienceLab failed: ${err.message}\n`);
      }
    }
  ];

  await Promise.all(fetchTasks.map(async (task) => {
    try {
      const res = await task.fn();
      task.onSuccess(res);
    } catch (error) {
      task.onFailure(error);
    }
  }));

  // --- Step 1.8: Combine ---
  const allSignals = [
    ...apolloSignals,
    ...pdlSignals,
    ...mediaStackSignals,
    ...predictLeadsSignals,
    ...newsApiSignals,
    ...audienceLabSignals
  ];

  fs.writeFileSync(`.tmp/combined_raw_${today}.json`, JSON.stringify(allSignals, null, 2));

  console.log(`[Combined] Total: ${allSignals.length} (Apollo: ${apolloSignals.length}, PDL: ${pdlSignals.length}, MediaStack: ${mediaStackSignals.length}, PredictLeads: ${predictLeadsSignals.length}, NewsAPI: ${newsApiSignals.length}, AudienceLab: ${audienceLabSignals.length})`);

  if (allSignals.length === 0) {
    try {
      const { sendErrorAlert } = await import('./utils/telegram_client.js');
      await sendErrorAlert('Warning: All API sources returned 0 signals. Check API keys and rate limits.');
    } catch (_) { /* alert failure must never crash the pipeline */ }
  }

  return { signals: allSignals, audienceLabPendingCursor };
}

export default fetchSignals;

// ── Standalone test runner ────────────────────────────────────────────────────
// Run: node execution/workflow_1_fetch_signals.js
// Saves individual raw files per source + combined_raw_test.json to .tmp/
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  (async () => {
    if (!fs.existsSync('.tmp')) fs.mkdirSync('.tmp', { recursive: true });

    let apolloSignals       = [];
    let pdlSignals          = [];
    let mediaStackSignals   = [];
    let predictLeadsSignals = [];
    let newsApiSignals      = [];
    let audienceLabSignals  = [];

    try {
      apolloSignals = await fetchApolloSignals();
    } catch (err) {
      console.error('[Apollo] fetch failed:', err.message);
    }

    try {
      pdlSignals = await fetchPDLSignals();
    } catch (err) {
      console.error('[PDL] fetch failed:', err.message);
    }

    try {
      mediaStackSignals = await fetchMediaStackSignals();
    } catch (err) {
      console.error('[MediaStack] fetch failed:', err.message);
    }

    try {
      predictLeadsSignals = await fetchPredictLeadsSignals();
    } catch (err) {
      console.error('[PredictLeads] fetch failed:', err.message);
    }

    try {
      newsApiSignals = await fetchNewsAPISignals();
    } catch (err) {
      console.error('[NewsAPI] fetch failed:', err.message);
    }

    try {
      const alResult = await fetchAudienceLabSignals();
      audienceLabSignals = alResult.signals;
      // In standalone mode, commit cursor immediately — no pipeline to crash after this
      if (alResult.pendingCursor) saveCursor(alResult.pendingCursor);
    } catch (err) {
      console.error('[AudienceLab] fetch failed:', err.message);
    }

    const combined = [
      ...apolloSignals,
      ...pdlSignals,
      ...mediaStackSignals,
      ...predictLeadsSignals,
      ...newsApiSignals,
      ...audienceLabSignals
    ];

    fs.writeFileSync('.tmp/combined_raw_test.json', JSON.stringify(combined, null, 2));

    console.log('\n=== Workflow 1 Test Results ===');
    console.log(`Apollo:        ${apolloSignals.length} signals`);
    console.log(`PDL:           ${pdlSignals.length} signals`);
    console.log(`MediaStack:    ${mediaStackSignals.length} signals`);
    console.log(`PredictLeads:  ${predictLeadsSignals.length} signals`);
    console.log(`NewsAPI:       ${newsApiSignals.length} signals`);
    console.log(`AudienceLab:   ${audienceLabSignals.length} signals`);
    console.log(`Combined:      ${combined.length} total`);
    const stamp = getTodayStamp();
    console.log(`\nFiles written to .tmp/:`);
    console.log(`  apollo_raw_${stamp}.json`);
    console.log(`  pdl_raw_${stamp}.json`);
    console.log(`  mediastack_raw_${stamp}.json`);
    console.log(`  predictleads_raw_${stamp}.json`);
    console.log(`  newsapi_raw_${stamp}.json`);
    console.log(`  combined_raw_test.json`);

    if (combined.length > 0) {
      const sample  = combined[0];
      const missing = ['type', 'source', 'company', 'detected_date', 'raw_data']
        .filter(f => !(f in sample));
      if (missing.length === 0) {
        console.log('\n[Verify] All required base fields present on signal objects');
      } else {
        console.warn('\n[Verify] Missing fields on first signal:', missing.join(', '));
      }
    }
  })();
}
