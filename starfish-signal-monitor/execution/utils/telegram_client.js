import 'dotenv/config';
import axios from 'axios';

const TELEGRAM_API_BASE = 'https://api.telegram.org';

// Send a message to Gideon's Telegram.
// text: string — the message to send
// Returns: true on success, false on any failure (never throws)
async function sendMessage(text) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.error('[Telegram] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set — skipping');
    return false;
  }

  // Truncate to Telegram's 4096-char limit
  const body = text.length > 4000 ? text.substring(0, 4000) + '...[truncated]' : text;

  try {
    await axios.post(`${TELEGRAM_API_BASE}/bot${token}/sendMessage`, {
      chat_id:    chatId,
      text:       body,
      parse_mode: 'HTML'
    }, { timeout: 10000 });
    return true;
  } catch (err) {
    const detail = err.response?.data?.description || err.message;
    console.error('[Telegram] Send failed:', detail);
    return false;
  }
}

// Send an error alert to Gideon's Telegram.
// message: string — description of the error
async function sendErrorAlert(message) {
  const text = `⚠️ Starfish Monitor Error\n\n${message}\n\n${new Date().toISOString()}`;
  return sendMessage(text);
}

// Send a PDL signal to Telegram with ✅ / ❌ inline keyboard for manual verification.
// signalIndex: 0-based index used as callback_data key (must be unique per batch).
// total: total number of signals in this verification batch.
async function sendSignalForVerification(signal, signalIndex, total, batchId) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return false;

  const p         = signal.person || {};
  const c         = signal.company || {};
  const name      = `${p.first_name || ''} ${p.last_name || ''}`.trim() || 'Unknown';
  const title     = p.title || 'Unknown title';
  const company   = c.name  || 'Unknown company';
  const industry  = c.industry || 'Unknown industry';
  const revenue   = c.revenue ? `$${(c.revenue / 1e6).toFixed(0)}M` : 'Unknown';
  const employees = c.employee_count ? c.employee_count.toLocaleString() : 'Unknown';
  const startDate = p.job_started_at || 'Unknown';
  const linkedin  = p.linkedin_url   || null;

  // Calculate how many days ago the job started
  let daysAgo = '';
  if (p.job_started_at) {
    const diff = Math.round((Date.now() - new Date(p.job_started_at)) / 86400000);
    daysAgo = ` (${diff} days ago)`;
  }

  let text = `🔍 PDL Signal ${signalIndex + 1} of ${total} — VERIFY REQUIRED\n\n`;
  text += `👤 ${name}\n`;
  text += `🏢 ${company} (${industry})\n`;
  text += `💼 ${title}\n`;
  text += `📅 Started: ${startDate}${daysAgo}\n`;
  text += `💰 Revenue: ${revenue} | ${employees} employees\n`;
  if (linkedin) text += `🔗 <a href="${linkedin}">View LinkedIn Profile</a>\n`;
  text += `\nDoes this job change look real and within the last 90 days?`;

  try {
    await axios.post(`${TELEGRAM_API_BASE}/bot${token}/sendMessage`, {
      chat_id:    chatId,
      text,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Approve', callback_data: `approve:${batchId}:${signalIndex}` },
          { text: '❌ Drop',    callback_data: `drop:${batchId}:${signalIndex}`    }
        ]]
      }
    }, { timeout: 10000 });
    return true;
  } catch (err) {
    console.error(`[Telegram] Failed to send signal ${signalIndex + 1} for verification:`, err.response?.data?.description || err.message);
    return false;
  }
}

// Poll Telegram for callback query responses (button clicks).
// signalCount: how many signals were sent for verification.
// batchId: unique ID for this run — rejects clicks from previous runs' buttons.
// timeoutMs: how long to wait before auto-approving (default 1 hour).
// Returns: object { 0: 'approved'|'dropped', 1: 'approved'|'dropped', ... }
async function pollVerificationResults(signalCount, batchId, timeoutMs = 3600000) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    // No Telegram configured — auto-approve all
    const results = {};
    for (let i = 0; i < signalCount; i++) results[i] = 'approved';
    return results;
  }

  const results  = {};
  const deadline = Date.now() + timeoutMs;
  let offset     = 0;
  // H-NEW-1: track consecutive poll failures — if Telegram is down for 5 straight attempts,
  // break out early rather than blocking the pipeline for the full timeout window
  let consecutiveErrors = 0;
  const MAX_CONSECUTIVE_ERRORS = 5;

  console.log(`[Telegram] Waiting for verification of ${signalCount} signals (timeout: ${timeoutMs / 60000} min)...`);

  // Get current update offset so we only process new updates from here on
  try {
    const init = await axios.get(`${TELEGRAM_API_BASE}/bot${token}/getUpdates`, {
      params: { limit: 1, offset: -1 }, timeout: 10000
    });
    const updates = init.data?.result || [];
    if (updates.length > 0) offset = updates[updates.length - 1].update_id + 1;
  } catch { /* ignore */ }

  while (Object.keys(results).length < signalCount && Date.now() < deadline) {
    try {
      const res = await axios.get(`${TELEGRAM_API_BASE}/bot${token}/getUpdates`, {
        params: { offset, timeout: 10, limit: 100 },
        timeout: 15000
      });

      for (const update of (res.data?.result || [])) {
        offset = update.update_id + 1;

        const cq = update.callback_query;
        if (!cq) continue;

        const [action, cbBatchId, idxStr] = (cq.data || '').split(':');
        const idx = parseInt(idxStr, 10);

        // Reject clicks from old buttons (different batchId = previous run)
        if (cbBatchId !== batchId) continue;

        if ((action === 'approve' || action === 'drop') && !isNaN(idx) && idx < signalCount) {
          results[idx] = action === 'approve' ? 'approved' : 'dropped';

          // Acknowledge the button click (removes spinner)
          await axios.post(`${TELEGRAM_API_BASE}/bot${token}/answerCallbackQuery`, {
            callback_query_id: cq.id,
            text: action === 'approve' ? '✅ Approved' : '❌ Dropped'
          }).catch(() => {});

          // Edit message to show final decision
          const icon = action === 'approve' ? '✅ APPROVED' : '❌ DROPPED';
          await axios.post(`${TELEGRAM_API_BASE}/bot${token}/editMessageReplyMarkup`, {
            chat_id:    cq.message.chat.id,
            message_id: cq.message.message_id,
            reply_markup: { inline_keyboard: [] }
          }).catch(() => {});

          const companyLine = cq.message?.text?.split('\n')?.[2]?.replace('🏢 ', '') || '';
          await sendMessage(`${icon} — Signal ${idx + 1}: ${companyLine}`).catch(() => {});

          const remaining = signalCount - Object.keys(results).length;
          console.log(`[Telegram] Signal ${idx + 1} ${results[idx]} (${remaining} remaining)`);
        }
      }
      consecutiveErrors = 0; // reset on any successful response
    } catch (err) {
      consecutiveErrors++;
      console.warn(`[Telegram] Poll error (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}):`, err.message);
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        console.error('[Telegram] ❌ 5 consecutive poll failures — Telegram appears unreachable. Auto-approving all remaining signals.');
        await sendErrorAlert('⚠️ Telegram poll failed 5 times in a row — PDL signals auto-approved without review. Check Telegram bot connectivity.').catch(() => {});
        break;
      }
    }

    if (Object.keys(results).length < signalCount) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // Auto-approve anything not responded to within timeout — track which indices were auto-approved
  const autoApprovedIndices = [];
  for (let i = 0; i < signalCount; i++) {
    if (!results[i]) {
      results[i] = 'approved';
      autoApprovedIndices.push(i);
    }
  }
  results._autoApprovedIndices = autoApprovedIndices;  // consumed by workflow_3b to flag signals

  if (autoApprovedIndices.length > 0) {
    console.log(`[Telegram] Timeout reached — auto-approved ${autoApprovedIndices.length} unreviewed signals (indices: ${autoApprovedIndices.join(', ')})`);
    await sendMessage(`⏱️ Verification timeout — ${autoApprovedIndices.length} signal${autoApprovedIndices.length > 1 ? 's' : ''} auto-approved (not manually reviewed).`).catch(() => {});
  }

  return results;
}

export { sendMessage, sendErrorAlert, sendSignalForVerification, pollVerificationResults };
