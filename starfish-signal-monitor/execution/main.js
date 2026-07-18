
import 'dotenv/config';
import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import cron from 'node-cron';
import express from 'express';

import fetchSignals from './workflow_1_fetch_signals.js';
import { saveCursor } from './utils/audiencelab_client.js';
import filterSignals from './workflow_2_filter_signals.js';
import deduplicateSignals from './workflow_3_deduplicate.js';
import verifyPDLSignals from './workflow_3b_verify_pdl.js';
import saveToAirtable from './workflow_4_save_to_airtable.js';
import syncToSheets from './workflow_4b_sync_sheets.js';
import sendEmail from './workflow_5_send_email.js';
import sendTelegramMonitoring from './workflow_6_telegram_monitoring.js';
import { closeBrowser } from './utils/puppeteer_email_finder.js';
import { resetAllBreakers } from './utils/circuit_breaker.js';

// --- Full-run Log File ---
// Mirrors every console.log/warn/error to .tmp/run_log_YYYYMMDD_HHMMSS.txt
// so the complete output is preserved even after the terminal scrolls.
// The file is created once at startup and closed on process exit.
{
  const logDir  = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.tmp');
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

  const stamp   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19); // 2026-06-13T05-00-00
  const logPath = path.join(logDir, `run_log_${stamp}.txt`);
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });

  const _write = (level, args) => {
    const line = `[${level}] ${args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')}\n`;
    logStream.write(line);
  };

  const _origLog   = console.log.bind(console);
  const _origWarn  = console.warn.bind(console);
  const _origError = console.error.bind(console);

  console.log   = (...args) => { _origLog(...args);   _write('LOG',   args); };
  console.warn  = (...args) => { _origWarn(...args);  _write('WARN',  args); };
  console.error = (...args) => { _origError(...args); _write('ERROR', args); };

  process.on('exit', () => logStream.end());

  console.log(`[Log] Full output → ${logPath}`);
}

// --- Startup Environment Validation ---
// Fail fast at boot rather than silently mid-pipeline.

const REQUIRED_ENV_VARS = [
  'AIRTABLE_API_KEY',
  'AIRTABLE_BASE_ID',
  'AIRTABLE_TABLE_NAME',
  'SMTP_USER',
  'SMTP_PASS',
];

const OPTIONAL_WARN_VARS = [
  'APOLLO_API_KEY',
  'PDL_API_KEY',
  'PREDICTLEADS_API_KEY',
  'MEDIASTACK_API_KEY',
  'NEWSAPI_API_KEY',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'GOOGLE_SHEET_ID',
  'AUDIENCELAB_API_KEY',
  'AUDIENCELAB_SEGMENT_PIXEL',
  'AUDIENCELAB_SEGMENT_LEADS',
];

const missingRequired = REQUIRED_ENV_VARS.filter(k => !process.env[k]);
if (missingRequired.length > 0) {
  console.error(`[Startup] FATAL — Missing required environment variables:\n  ${missingRequired.join('\n  ')}`);
  console.error('[Startup] Pipeline cannot run without these. Check your .env file.');
  process.exit(1);
}

const missingOptional = OPTIONAL_WARN_VARS.filter(k => !process.env[k]);
if (missingOptional.length > 0) {
  console.warn(`[Startup] WARNING — Optional env vars not set (some signal sources will be skipped):\n  ${missingOptional.join('\n  ')}`);
}

const TMP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.tmp');

// Delete .tmp files older than 7 days — runs once per daily pipeline execution.
// Prevents indefinite accumulation of raw JSON + log files on disk.
function cleanupTmpFiles() {
  const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
  try {
    if (!fs.existsSync(TMP_DIR)) return;
    const files = fs.readdirSync(TMP_DIR);
    let deleted = 0;
    for (const file of files) {
      const filePath = path.join(TMP_DIR, file);
      try {
        const { mtimeMs } = fs.statSync(filePath);
        if (Date.now() - mtimeMs > MAX_AGE_MS) {
          fs.unlinkSync(filePath);
          deleted++;
        }
      } catch (_) { /* skip files we can't stat or delete */ }
    }
    if (deleted > 0) console.log(`[Cleanup] Deleted ${deleted} .tmp file(s) older than 7 days`);
  } catch (err) {
    console.warn('[Cleanup] .tmp cleanup failed (non-critical):', err.message);
  }
}

const app = express();
let lastRunTimestamp = null;
let isRunning = false;

// --- Health Check Endpoint ---

function getNextRunTime() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(5, 0, 0, 0);
  if (now.getHours() >= 5) next.setDate(next.getDate() + 1);
  return next.toISOString();
}

app.get('/health', (_req, res) => {
  res.json({
    status: 'running',
    uptime: process.uptime(),
    lastRun: lastRunTimestamp,
    nextRun: getNextRunTime(),
    environment: process.env.NODE_ENV || 'development',
    version: '1.0.0'
  });
});

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Global error handler
app.use((err, _req, res, _next) => {
  console.error('[Server] Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// --- Main Orchestrator ---

async function runAllWorkflows() {
  if (isRunning) {
    console.log(`[${new Date().toISOString()}] Pipeline already running — skipping this trigger`);
    return;
  }
  isRunning = true;
  const startTime = Date.now();
  console.log(`\n[${new Date().toISOString()}] ========================================`);
  console.log(`[${new Date().toISOString()}] Starting daily signal monitoring run`);

  // Reset circuit breakers so yesterday's API failures don't block today's run.
  // Each daily run gets a clean slate — breakers only protect within a single run.
  resetAllBreakers();

  cleanupTmpFiles();
  console.log(`[${new Date().toISOString()}] ========================================`);

  let allSignals = [];
  let audienceLabPendingCursor = null;
  let filteredSignals = [];
  let deduplicatedSignals = [];
  let totalInserted = 0;
  let emailSuccess = false;

  // M6: outer try/finally guarantees isRunning always resets, even if an unexpected throw
  // escapes one of the inner catch blocks (e.g. a monkey-patched console.error in tests)
  try {

    try {
      // Workflow 1: Fetch raw signals from all 5 sources
      console.log(`\n[${new Date().toISOString()}] --- Workflow 1: Fetch Signals ---`);
      const fetchResult = await fetchSignals();
      allSignals = fetchResult.signals;
      audienceLabPendingCursor = fetchResult.audienceLabPendingCursor;
      console.log(`[${new Date().toISOString()}] Workflow 1 complete: ${allSignals.length} raw signals`);

      // Workflow 2: Filter + Claude enrichment
      console.log(`\n[${new Date().toISOString()}] --- Workflow 2: Filter Signals ---`);
      filteredSignals = await filterSignals(allSignals);
      console.log(`[${new Date().toISOString()}] Workflow 2 complete: ${filteredSignals.length} filtered signals`);

      // Workflow 3: Deduplicate against last 30 days
      console.log(`\n[${new Date().toISOString()}] --- Workflow 3: Deduplicate ---`);
      deduplicatedSignals = await deduplicateSignals(filteredSignals);
      console.log(`[${new Date().toISOString()}] Workflow 3 complete: ${deduplicatedSignals.length} unique signals`);

      // Workflow 3b: Manual PDL verification via Telegram
      console.log(`\n[${new Date().toISOString()}] --- Workflow 3b: PDL Verification ---`);
      deduplicatedSignals = await verifyPDLSignals(deduplicatedSignals);
      console.log(`[${new Date().toISOString()}] Workflow 3b complete: ${deduplicatedSignals.length} verified signals`);

      // Workflow 4: Save to Airtable
      console.log(`\n[${new Date().toISOString()}] --- Workflow 4: Save to Airtable ---`);
      totalInserted = await saveToAirtable(deduplicatedSignals);
      console.log(`[${new Date().toISOString()}] Workflow 4 complete: ${totalInserted} records saved`);

      // Commit AudienceLab cursor ONLY after Airtable save succeeds.
      // If we saved it earlier and the pipeline crashed in Workflow 2–4, those
      // signals would be permanently skipped — cursor already advanced, records never written.
      if (audienceLabPendingCursor) {
        saveCursor(audienceLabPendingCursor);
        console.log(`[${new Date().toISOString()}] AudienceLab cursor committed (Pixel: page ${audienceLabPendingCursor.pixel_start_page}, Leads: page ${audienceLabPendingCursor.leads_start_page})`);
      }

      // Workflow 4b: Sync to Google Sheets (non-critical — never blocks email)
      console.log(`\n[${new Date().toISOString()}] --- Workflow 4b: Sync to Google Sheets ---`);
      const sheetsInserted = await syncToSheets(deduplicatedSignals);
      console.log(`[${new Date().toISOString()}] Workflow 4b complete: ${sheetsInserted} rows synced to Sheets`);

      // Workflow 5: Send email digest
      console.log(`\n[${new Date().toISOString()}] --- Workflow 5: Send Email ---`);
      emailSuccess = await sendEmail(deduplicatedSignals);
      console.log(`[${new Date().toISOString()}] Workflow 5 complete: email ${emailSuccess ? 'sent ✓' : 'failed ✗'}`);

    } catch (err) {
      console.error(`\n[${new Date().toISOString()}] FATAL pipeline error:`, err.message);
      console.error(err.stack);
    }

    // Workflow 6: Telegram monitoring — always runs, even after errors
    try {
      console.log(`\n[${new Date().toISOString()}] --- Workflow 6: Telegram Monitoring ---`);
      await sendTelegramMonitoring(deduplicatedSignals, totalInserted, emailSuccess, startTime);
    } catch (err) {
      // Should never throw (telegram_client catches internally), but belt-and-suspenders
      console.error('[Telegram] Unexpected error in monitoring workflow:', err.message);
    }

    // Close the shared Puppeteer browser after all workflows complete
    try {
      await closeBrowser();
    } catch (browserErr) {
      console.error('[Puppeteer] Browser close failed — process may still be running in background:', browserErr.message);
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n[${new Date().toISOString()}] ========================================`);
    console.log(`[${new Date().toISOString()}] Daily run complete in ${duration}s`);
    console.log(`[${new Date().toISOString()}] Signals: ${deduplicatedSignals.length} | Airtable: ${totalInserted} | Email: ${emailSuccess ? 'sent' : 'failed'}`);
    console.log(`[${new Date().toISOString()}] ========================================\n`);

  } finally {
    lastRunTimestamp = new Date().toISOString();
    isRunning = false;
  }
}

// --- Cron Schedule: 5:00 AM EST daily ---

const cronSchedule = process.env.CRON_SCHEDULE || '0 5 * * *';

// Maximum time a single pipeline run is allowed before it is considered hung.
// If the pipeline exceeds this, the cron guard fires a Telegram alert and
// forcibly resets isRunning so the next scheduled run is not skipped.
const PIPELINE_TIMEOUT_MS = 90 * 60 * 1000 // 90 minutes

function pipelineTimeout() {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Pipeline timed out after 90 minutes')), PIPELINE_TIMEOUT_MS)
  )
}

// Only register the cron when running as a persistent server (not a one-shot test/manual run).
// In test/manual mode the process exits after the single run — a registered cron would fire
// unexpectedly if the process stayed alive, or confusingly appear in logs alongside the test run.
if (!process.argv.includes('--test') && !process.argv.includes('--manual')) {
  cron.schedule(cronSchedule, async () => {
    console.log(`[${new Date().toISOString()}] Cron triggered`);
    try {
      await Promise.race([runAllWorkflows(), pipelineTimeout()])
    } catch (err) {
      // Timeout path — runAllWorkflows() is STILL running in the background.
      // Do NOT reset isRunning here — the finally block inside runAllWorkflows()
      // will reset it when the run genuinely finishes. Resetting it here would
      // allow the next cron tick to start a second parallel run while the first
      // is still writing to Airtable, causing duplicate records.
      // If the pipeline hangs permanently, Railway will restart the process.
      lastRunTimestamp = new Date().toISOString()
      console.error(`[Cron] TIMEOUT: ${err.message} — pipeline still running in background, waiting for it to finish before allowing next run`)
      try {
        const { sendErrorAlert } = await import('./utils/telegram_client.js')
        await sendErrorAlert(`⚠️ Pipeline TIMED OUT after 90 minutes. Still running in background — next scheduled run will be held until this one finishes. Check Railway logs immediately.`)
      } catch (alertErr) {
        console.error('[Cron] Telegram alert also failed:', alertErr.message)
      }
    }
  }, {
    timezone: 'America/New_York'
  });
  console.log(`[Cron] Scheduled: "${cronSchedule}" (America/New_York)`);
} else {
  console.log(`[Cron] Test/manual mode — cron NOT registered (one-shot run only)`);
}

// --- Manual / Test Run ---
// Run immediately when called with: node execution/main.js --test
if (process.argv.includes('--test') || process.argv.includes('--manual')) {
  console.log('[Manual] --test flag detected — running pipeline immediately');
  runAllWorkflows().catch(err => {
    console.error('[Manual] Unhandled pipeline error:', err.message);
    process.exit(1);
  });
}

// --- Express Server (health check) ---
// Only start the HTTP server in daemon/cron mode.
// Manual/test runs are one-shot — no need to bind a port, and doing so causes
// SIGTERM conflicts when a previous server instance is already running on the same port.

const isManualRun = process.argv.includes('--manual') || process.argv.includes('--test');
const PORT = process.env.PORT || 3000;
const server = isManualRun ? null : app.listen(PORT, () => {
  console.log(`[Server] Health check available at http://localhost:${PORT}/health`);
});

// Graceful shutdown — let Railway terminate cleanly.
// If the pipeline is mid-run, skip closeBrowser() — closing the pool while enrichment
// is actively using browser slots causes partial Airtable writes with no alert.
// The pipeline's own finally block calls closeBrowser() when the run finishes.
process.on('SIGTERM', async () => {
  console.log('[Server] SIGTERM received — shutting down gracefully');
  if (!isRunning) {
    await closeBrowser();
  } else {
    console.log('[Server] Pipeline mid-run — deferring browser close to pipeline finally block');
  }
  if (server) {
    server.close(() => {
      console.log('[Server] HTTP server closed');
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000);
  } else {
    process.exit(0);
  }
});
process.on('SIGINT', () => process.emit('SIGTERM'));
