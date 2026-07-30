/**
 * check_pipeline_stats.js
 *
 * Snapshot of the Airtable Signals table:
 *   - How many contacts pushed to HubSpot
 *   - How many ready to push (valid email, not yet pushed)
 *   - Breakdown by title tier (send_day) for contacts with real emails
 *
 * Run with:
 *   node --env-file=.env scripts/check_pipeline_stats.js
 */

import 'dotenv/config';
import Airtable from 'airtable';

const PLACEHOLDER = 'email_not_unlocked@domain.com';
const TABLE = process.env.AIRTABLE_TABLE_NAME || 'Signals';

function getBase() {
  return new Airtable({ apiKey: process.env.AIRTABLE_API_KEY })
    .base(process.env.AIRTABLE_BASE_ID);
}

function extractEmail(contactInfo) {
  if (!contactInfo) return null;
  const m = contactInfo.match(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/);
  return m ? m[0].toLowerCase() : null;
}

function extractTitle(contactInfo) {
  if (!contactInfo) return null;
  const lines = contactInfo.split('\n').map(l => l.trim()).filter(Boolean);
  let name = null;
  for (const line of lines) {
    if (line.includes('@') || /linkedin\.com/i.test(line) || line.startsWith('http') || line.startsWith('⚠️') || line.startsWith('Website:')) continue;
    if (!name) { name = line; continue; }
    // Second non-special line is title
    return line.replace(/^(name|title|email|linkedin)\s*:\s*/i, '').trim();
  }
  return null;
}

function tierLabel(sendDay) {
  switch (sendDay) {
    case 1: return 'Day 1 — CMO / VP Marketing / VP Brand';
    case 2: return 'Day 2 — CEO / President';
    case 3: return 'Day 3 — COO';
    case 4: return 'Day 4 — Head/Director of Marketing (default)';
    case 5: return 'Day 5 — Communications / Comms';
    default: return 'Day ? — No send day assigned';
  }
}

async function fetchAll() {
  const records = [];
  let offset = undefined;
  do {
    const params = {
      fields: ['Contact Info', 'HubSpot Pushed', 'Send Day', 'Signal Type', 'Company Name'],
      pageSize: 100,
    };
    if (offset) params.offset = offset;

    const page = await getBase()(TABLE).select(params).firstPage();
    records.push(...page);

    // Airtable SDK auto-paginates with .all(), but firstPage gives us offset control
    // Use .all() instead for simplicity
    break; // will use .all() below
  } while (false);
  return records;
}

async function run() {
  console.log('Fetching all records from Airtable...');

  let records;
  try {
    records = await getBase()(TABLE)
      .select({
        fields: ['Contact Info', 'HubSpot Pushed', 'Send Day', 'Signal Type', 'Company Name'],
      })
      .all();
  } catch (err) {
    console.error('Fetch failed:', err.message);
    process.exit(1);
  }

  console.log(`Total records in table: ${records.length}\n`);

  let pushed         = 0;
  let readyToPush    = 0;
  let placeholder    = 0;
  let noEmail        = 0;

  // No-email breakdown
  let noEmailContactNeeded  = 0; // ⚠️ Contact Needed — pipeline tried but found nobody
  let noEmailLinkedInOnly   = 0; // has name+LinkedIn but no email
  let noEmailTrulyEmpty     = 0; // completely blank Contact Info
  let noEmailPushed         = 0; // pushed=true but no email (bespoke/manual)

  // Signal type breakdown for no-email unpushed records
  const noEmailByType = {};

  // Tier counts for records with real emails (pushed + ready)
  const tierCounts   = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, null: 0 };
  const tierPushed   = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, null: 0 };

  // Signal type breakdown (pushed)
  const bySignalType = {};

  for (const r of records) {
    const f           = r.fields;
    const contactInfo = f['Contact Info'] || '';
    const isPushed    = f['HubSpot Pushed'] === true;
    const sendDay     = f['Send Day'] || null;
    const signalType  = f['Signal Type'] || 'Unknown';
    const email       = extractEmail(contactInfo);

    const isPlaceholder = contactInfo.includes(PLACEHOLDER);
    const hasRealEmail  = email && !isPlaceholder;

    if (isPlaceholder) {
      placeholder++;
      continue;
    }

    if (!hasRealEmail) {
      noEmail++;
      if (isPushed) {
        noEmailPushed++;
      } else {
        if (!contactInfo.trim()) {
          noEmailTrulyEmpty++;
        } else if (contactInfo.includes('⚠️ Contact Needed') || contactInfo.includes('Contact Needed')) {
          noEmailContactNeeded++;
        } else if (/linkedin\.com/i.test(contactInfo)) {
          noEmailLinkedInOnly++;
        } else {
          noEmailTrulyEmpty++;
        }
        noEmailByType[signalType] = (noEmailByType[signalType] || 0) + 1;
      }
      continue;
    }

    // Has a real email
    if (isPushed) {
      pushed++;
      const key = sendDay ?? null;
      tierPushed[key] = (tierPushed[key] || 0) + 1;
      bySignalType[signalType] = (bySignalType[signalType] || 0) + 1;
    } else {
      readyToPush++;
      const key = sendDay ?? null;
      tierCounts[key] = (tierCounts[key] || 0) + 1;
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log('══════════════════════════════════════════════════════');
  console.log('PIPELINE CONTACT STATS');
  console.log('══════════════════════════════════════════════════════');
  console.log(`✅ Pushed to HubSpot        : ${pushed}`);
  console.log(`📬 Ready to push (not yet)  : ${readyToPush}`);
  console.log(`⏳ Still placeholder email  : ${placeholder}`);
  console.log(`❌ No email at all          : ${noEmail}`);
  console.log(`   Total records            : ${records.length}`);

  console.log('\n── Pushed contacts by title tier ──────────────────────');
  for (const [day, count] of Object.entries(tierPushed)) {
    if (count === 0) continue;
    const label = day === 'null' ? 'No send day' : tierLabel(parseInt(day));
    console.log(`  ${label.padEnd(45)} : ${count}`);
  }

  console.log('\n── Ready-to-push contacts by title tier ───────────────');
  for (const [day, count] of Object.entries(tierCounts)) {
    if (count === 0) continue;
    const label = day === 'null' ? 'No send day' : tierLabel(parseInt(day));
    console.log(`  ${label.padEnd(45)} : ${count}`);
  }

  console.log('\n── Pushed contacts by signal type ─────────────────────');
  const sortedTypes = Object.entries(bySignalType).sort((a, b) => b[1] - a[1]);
  for (const [type, count] of sortedTypes) {
    console.log(`  ${type.padEnd(35)} : ${count}`);
  }

  console.log('\n── No-email records breakdown (unpushed) ──────────────');
  console.log(`  ⚠️  Contact Needed (pipeline found nobody) : ${noEmailContactNeeded}`);
  console.log(`  🔗 LinkedIn only (name+URL, no email)     : ${noEmailLinkedInOnly}`);
  console.log(`  ❌ Truly empty Contact Info               : ${noEmailTrulyEmpty}`);
  console.log(`  ✅ Already pushed (bespoke/manual)        : ${noEmailPushed}`);

  if (Object.keys(noEmailByType).length > 0) {
    console.log('\n── No-email unpushed by signal type ────────────────────');
    const sorted = Object.entries(noEmailByType).sort((a, b) => b[1] - a[1]);
    for (const [type, count] of sorted) {
      console.log(`  ${type.padEnd(35)} : ${count}`);
    }
  }

  console.log('\n══════════════════════════════════════════════════════');
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
