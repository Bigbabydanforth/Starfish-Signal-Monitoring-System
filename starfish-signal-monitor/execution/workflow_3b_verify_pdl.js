/**
 * workflow_3b_verify_pdl.js
 *
 * After deduplication, sends each surviving PDL Job Change signal to Gideon's
 * Telegram for manual LinkedIn verification. Non-PDL signals (News/Press, M&A)
 * pass through automatically — no verification needed.
 *
 * Flow:
 *  1. Split signals: PDL Job Changes vs everything else
 *  2. Send each PDL signal to Telegram with ✅ / ❌ buttons
 *  3. Poll for responses (1-hour timeout — auto-approve on timeout)
 *  4. Merge approved PDL signals back with the auto-passing signals
 *  5. Return final verified array to main.js
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { sendMessage, sendSignalForVerification, pollVerificationResults } from './utils/telegram_client.js';

// State file written before the 1-hour blocking poll so that a pipeline restart
// mid-poll leaves a visible trace, and the next run can warn the operator.
const POLL_STATE_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../.tmp/pdl_poll_active.json'
);

async function verifyPDLSignals(deduplicatedSignals) {
  // Check for a stale poll from a previously interrupted run.
  // If the file is < 2 hours old the previous poll was likely still running when the
  // process died — warn the operator so they know those signals were never reviewed.
  try {
    if (fs.existsSync(POLL_STATE_FILE)) {
      const stale  = JSON.parse(fs.readFileSync(POLL_STATE_FILE, 'utf8'));
      const ageMin = Math.round((Date.now() - stale.startedAt) / 60000);
      if (ageMin < 120) {
        console.warn(`[Verify] ⚠️  Found interrupted PDL poll from ${ageMin}min ago (batchId: ${stale.batchId}) — ${stale.signalCount} signal(s) were not reviewed`);
        await sendMessage(
          `⚠️ <b>PDL poll interrupted</b>\n\n` +
          `A previous verification poll was cut short (pipeline restart?) ${ageMin} min ago.\n` +
          `${stale.signalCount} signal(s) were auto-approved without review:\n` +
          stale.signalNames.map(n => `• ${n}`).join('\n')
        );
      }
      fs.unlinkSync(POLL_STATE_FILE);
    }
  } catch (_) { /* stale-check is best-effort — never block the run */ }

  // Split: PDL Job Changes need verification, everything else passes through
  const pdlSignals   = deduplicatedSignals.filter(s => s.source === 'PDL' && s.type === 'Job Change');
  const otherSignals = deduplicatedSignals.filter(s => !(s.source === 'PDL' && s.type === 'Job Change'));

  if (pdlSignals.length === 0) {
    console.log('[Verify] No PDL signals to verify — skipping');
    return deduplicatedSignals;
  }

  console.log(`[Verify] ${pdlSignals.length} PDL signals to verify, ${otherSignals.length} pass through automatically`);

  // Check if Telegram is configured — if not, skip verification and pass all through
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
    console.warn('[Verify] WARNING: Telegram not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing)');
    console.warn(`[Verify] WARNING: ${pdlSignals.length} PDL signals are passing through UNVERIFIED — LinkedIn accuracy not guaranteed`);
    return deduplicatedSignals;
  }

  // Send intro message
  await sendMessage(
    `🔍 <b>PDL Signal Verification</b>\n\n` +
    `${pdlSignals.length} new Job Change signal${pdlSignals.length > 1 ? 's' : ''} need your review.\n` +
    `${otherSignals.length} News/Press signal${otherSignals.length !== 1 ? 's' : ''} will proceed automatically.\n\n` +
    `Click each LinkedIn profile to verify the job change is real and within the last 90 days.\n` +
    `You have <b>1 hour</b> to respond — unreviewed signals are auto-approved.`
  );

  // Unique batch ID for this run — prevents old button clicks from hijacking a new poll
  const batchId = Date.now().toString(36);

  // Send each PDL signal as a separate message with buttons
  for (let i = 0; i < pdlSignals.length; i++) {
    await sendSignalForVerification(pdlSignals[i], i, pdlSignals.length, batchId);
    await new Promise(r => setTimeout(r, 500)); // small delay between messages
  }

  // Write poll state to disk before the 1-hour blocking call.
  // If the process crashes or is restarted during the poll, the file survives
  // and the next run will detect it and warn the operator (see top of this function).
  try {
    fs.writeFileSync(POLL_STATE_FILE, JSON.stringify({
      batchId,
      startedAt:   Date.now(),
      signalCount: pdlSignals.length,
      signalNames: pdlSignals.map(s =>
        `${s.person?.first_name || ''} ${s.person?.last_name || ''} @ ${s.company?.name || '?'}`.trim()
      )
    }));
  } catch (_) { /* state file is best-effort */ }

  // Poll for responses (1 hour timeout)
  let results;
  try {
    results = await pollVerificationResults(pdlSignals.length, batchId, 60 * 60 * 1000);
  } finally {
    // Clean up — if the poll completed normally, remove the state file.
    // If the process crashes before reaching here, the file stays on disk
    // as intended evidence for the next run.
    try { fs.unlinkSync(POLL_STATE_FILE); } catch (_) {}
  }

  // Filter to only approved signals — mark auto-approved ones for audit trail in Airtable
  const autoApprovedSet = new Set(results._autoApprovedIndices || []);
  const approvedPDL = pdlSignals.filter((s, i) => {
    if (results[i] !== 'approved') return false;
    if (autoApprovedSet.has(i)) {
      s._auto_approved = true;  // workflow_4 appends an audit note to their Airtable Brief
    }
    return true;
  });
  const droppedPDL = pdlSignals.filter((_, i) => results[i] === 'dropped');

  const manuallyApproved = approvedPDL.filter(s => !s._auto_approved).length;
  const autoApprovedCount = approvedPDL.filter(s => s._auto_approved).length;
  console.log(`[Verify] Approved: ${approvedPDL.length} (${manuallyApproved} manual, ${autoApprovedCount} auto) | Dropped: ${droppedPDL.length}`);

  if (droppedPDL.length > 0) {
    const droppedNames = droppedPDL.map(s =>
      `${s.person?.first_name || ''} ${s.person?.last_name || ''} @ ${s.company?.name || '?'}`.trim()
    ).join(', ');
    console.log(`[Verify] Dropped signals: ${droppedNames}`);
  }

  if (autoApprovedCount > 0) {
    const autoNames = approvedPDL
      .filter(s => s._auto_approved)
      .map(s => `${s.person?.first_name || ''} ${s.person?.last_name || ''} @ ${s.company?.name || '?'}`.trim())
      .join(', ');
    console.log(`[Verify] Auto-approved signals (not reviewed): ${autoNames}`);
  }

  // Send summary
  await sendMessage(
    `✅ <b>Verification Complete</b>\n\n` +
    `Manually approved: ${manuallyApproved} PDL signal${manuallyApproved !== 1 ? 's' : ''}\n` +
    `Auto-approved (timeout): ${autoApprovedCount} signal${autoApprovedCount !== 1 ? 's' : ''}\n` +
    `Dropped: ${droppedPDL.length} signal${droppedPDL.length !== 1 ? 's' : ''}\n` +
    `Auto-pass: ${otherSignals.length} News/Press signal${otherSignals.length !== 1 ? 's' : ''}\n\n` +
    `Total proceeding to Airtable: ${approvedPDL.length + otherSignals.length}`
  );

  // Return approved PDL + all other signals (order: approved PDL first, then others)
  return [...approvedPDL, ...otherSignals];
}

export default verifyPDLSignals;
