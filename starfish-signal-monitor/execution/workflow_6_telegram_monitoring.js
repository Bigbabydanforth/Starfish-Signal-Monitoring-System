import { sendMessage } from './utils/telegram_client.js';
import { formatDisplayDate } from './utils/date_helpers.js';

// Escape HTML entities so company names/briefs with <, >, & don't break Telegram's HTML parser
function esc(str) {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function sendTelegramMonitoring(deduplicatedSignals, airtableCount, emailSuccess, startTime) {
  try {
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    const date     = formatDisplayDate(new Date());

    const high   = deduplicatedSignals.filter(s => s.priority === 'HIGH');
    const medium = deduplicatedSignals.filter(s => s.priority === 'MEDIUM');
    const low    = deduplicatedSignals.filter(s => s.priority === 'LOW');

    let message = `🎯 Starfish Daily Run - ${esc(date)}\n\n`;
    message += `📊 Signals Detected: ${deduplicatedSignals.length}\n`;
    message += `🔴 High Priority: ${high.length}\n`;
    message += `🟡 Medium Priority: ${medium.length}\n`;
    message += `⚪ Low Priority: ${low.length}\n\n`;

    if (deduplicatedSignals.length > 0) {
      const top3 = deduplicatedSignals.slice(0, 3);
      message += `Top ${top3.length} Signal${top3.length !== 1 ? 's' : ''}:\n`;
      top3.forEach((signal, i) => {
        const brief = (signal.brief || '').length > 80
          ? signal.brief.substring(0, 77) + '...'
          : (signal.brief || '');
        message += `${i + 1}. ${esc(signal.company?.name)} - ${esc(brief)}\n`;
      });
      message += '\n';
    } else {
      message += `No new signals detected today.\n\n`;
    }

    const nodeEnv    = process.env.NODE_ENV || 'development';
    const recipients = nodeEnv === 'production'
      ? (process.env.EMAIL_TO_PRODUCTION || 'not configured')
      : (process.env.EMAIL_TO_TESTING   || 'not configured');

    message += emailSuccess
      ? `✅ Email sent to: ${recipients}\n`
      : `⚠️ Email delivery failed (see logs)\n`;

    if (airtableCount > 0) {
      message += `💾 Saved ${airtableCount} records to Airtable\n`;
    } else if (deduplicatedSignals.length > 0) {
      message += `⚠️ Airtable save failed (see logs)\n`;
    }

    // Email verification summary (excludes BSI — per-contact model, not per-signal)
    const nonBSI = deduplicatedSignals.filter(s => s.type !== 'Brand Strategy Intent');
    if (nonBSI.length > 0) {
      const verifiedCount  = nonBSI.filter(s => s.emailVerification?.valid && !s.emailVerification?.flagged).length;
      const flaggedCount   = nonBSI.filter(s => s.emailVerification?.flagged).length;
      const discardedCount = nonBSI.filter(s => !s.emailVerification?.valid).length;
      message += `\n📧 Emails verified: ${verifiedCount} clean, ${flaggedCount} flagged, ${discardedCount} discarded`;
    }

    message += `\n⏱️ Total execution time: ${duration}s`;

    // Truncate if over Telegram's 4096 char limit
    // 4070 + 14 chars for '...[truncated]' = 4084 — safely under 4096
    if (message.length > 4070) {
      message = message.substring(0, 4070) + '...[truncated]';
    }

    await sendMessage(message);
    console.log('[Telegram] Monitoring message sent');

  } catch (err) {
    // Non-critical: log only, never throw
    console.error('[Telegram] Monitoring workflow failed silently:', err.message);
  }
}

export default sendTelegramMonitoring;
