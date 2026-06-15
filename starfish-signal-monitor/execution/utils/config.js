/**
 * config.js — Central configuration for the Starfish Signal Monitoring pipeline.
 *
 * Every value here reads from an environment variable first, then falls back to
 * the default. This means you can tune the system from Railway's environment
 * settings without touching any code.
 *
 * Add these to your .env (or Railway variables) to override the defaults:
 *
 *   FILTER_CONCURRENCY      How many signals run geo-verify / M&A checks in parallel  (default: 5)
 *   CLAUDE_CONCURRENCY      How many signals Claude enriches at once                   (default: 3)
 *   ENRICHMENT_CONCURRENCY  How many email cascades run concurrently in workflow_4     (default: 5)
 *   PUPPETEER_CONCURRENCY   Max concurrent Puppeteer pages across all workers          (default: 5)
 *   API_TIMEOUT_MS          Timeout for short API calls (Apollo, Hunter, etc.)         (default: 15000)
 *   API_TIMEOUT_LONG_MS     Timeout for long API calls (PDL, PredictLeads)             (default: 30000)
 *   DEDUP_MAX_RECORDS       Max Airtable records loaded for deduplication per run      (default: 5000)
 */

export const FILTER_CONCURRENCY     = Number(process.env.FILTER_CONCURRENCY)     || 5;
export const CLAUDE_CONCURRENCY     = Number(process.env.CLAUDE_CONCURRENCY)     || 3;
export const ENRICHMENT_CONCURRENCY = Number(process.env.ENRICHMENT_CONCURRENCY) || 5;
export const PUPPETEER_CONCURRENCY  = Number(process.env.PUPPETEER_CONCURRENCY)  || 5;
export const API_TIMEOUT_MS         = Number(process.env.API_TIMEOUT_MS)         || 15000;
export const API_TIMEOUT_LONG_MS    = Number(process.env.API_TIMEOUT_LONG_MS)    || 30000;
export const DEDUP_MAX_RECORDS      = Number(process.env.DEDUP_MAX_RECORDS)      || 5000;
