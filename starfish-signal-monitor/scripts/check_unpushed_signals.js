/**
 * scripts/check_unpushed_signals.js
 *
 * Snapshot of all Airtable signals NOT yet pushed to HubSpot.
 *
 * Deduplication rule:
 *   - Same email address across multiple records = duplicate → keep one
 *   - Same company but DIFFERENT emails = NOT a duplicate → keep all
 *   - Records with no email are deduplicated by company name + signal type
 *     (same company + same signal type + no email = keep one)
 *
 * Reports:
 *   - Total unpushed signals (after dedup)
 *   - How many have a real contact email (ready or enrichable)
 *   - How many have no contact at all (broken down by reason)
 *   - Breakdown by signal type
 *   - Breakdown by send day tier (for records with emails)
 *
 * Run:
 *   node --env-file=.env scripts/check_unpushed_signals.js
 */

import 'dotenv/config';
import Airtable from 'airtable';

const PLACEHOLDER = 'email_not_unlocked@domain.com';
const TABLE       = process.env.AIRTABLE_TABLE_NAME || 'Signals';

function getBase() {
  return new Airtable({ apiKey: process.env.AIRTABLE_API_KEY })
    .base(process.env.AIRTABLE_BASE_ID);
}

function extractEmail(contactInfo) {
  if (!contactInfo) return null;
  const m = contactInfo.match(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/);
  return m ? m[0].toLowerCase() : null;
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

async function run() {
  console.log('Fetching all unpushed records from Airtable...');

  let allRecords;
  try {
    allRecords = await getBase()(TABLE)
      .select({
        filterByFormula: 'NOT({HubSpot Pushed} = TRUE())',
        fields: ['Contact Info', 'Company Name', 'Signal Type', 'Send Day'],
      })
      .all();
  } catch (err) {
    console.error('Fetch failed:', err.message);
    process.exit(1);
  }

  console.log(`  Raw unpushed records in Airtable: ${allRecords.length}`);

  // ── Deduplication ───────────────────────────────────────────────────────────
  // Rule 1: same real email → duplicate, keep one
  // Rule 2: same company + signal type + no email → duplicate, keep one
  // Rule 3: same company but DIFFERENT emails → keep all (not duplicates)
  const seenEmails       = new Set();
  const seenNoEmailKeys  = new Set();
  const records          = [];
  let   droppedDups      = 0;

  for (const r of allRecords) {
    const contactInfo = r.fields['Contact Info'] || '';
    const companyName = (r.fields['Company Name'] || '').toLowerCase().trim();
    const signalType  = (r.fields['Signal Type']  || '').toLowerCase().trim();
    const isPlaceholder = contactInfo.includes(PLACEHOLDER);
    const email         = isPlaceholder ? null : extractEmail(contactInfo);

    if (email) {
      // Has a real email — deduplicate by email
      if (seenEmails.has(email)) {
        droppedDups++;
        continue;
      }
      seenEmails.add(email);
    } else {
      // No real email — deduplicate by company + signal type
      const key = `${companyName}||${signalType}`;
      if (seenNoEmailKeys.has(key)) {
        droppedDups++;
        continue;
      }
      seenNoEmailKeys.add(key);
    }

    records.push(r);
  }

  console.log(`  Dropped as duplicates           : ${droppedDups}`);
  console.log(`  Unique unpushed signals (total)  : ${records.length}\n`);

  // ── Categorise ──────────────────────────────────────────────────────────────
  let withEmail        = 0;
  let withoutEmail     = 0;

  // With-email breakdown
  const tierCounts     = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, null: 0 };
  const bySignalType   = {};

  // No-email breakdown
  let noEmailPlaceholder    = 0; // email_not_unlocked — enrichment tried, not found yet
  let noEmailContactNeeded  = 0; // ⚠️ Contact Needed — pipeline couldn't find anyone
  let noEmailResearchNeeded = 0; // 🔍 Research Needed — needs manual research
  let noEmailLinkedInOnly   = 0; // has LinkedIn URL but no email
  let noEmailWebsiteOnly    = 0; // has a website URL but no email
  let noEmailTrulyEmpty     = 0; // completely blank Contact Info

  const noEmailByType = {};

  for (const r of records) {
    const contactInfo   = r.fields['Contact Info'] || '';
    const signalType    = r.fields['Signal Type']  || 'Unknown';
    const sendDay       = r.fields['Send Day']      || null;
    const isPlaceholder = contactInfo.includes(PLACEHOLDER);
    const email         = isPlaceholder ? null : extractEmail(contactInfo);

    if (email) {
      withEmail++;
      const key = sendDay ?? null;
      tierCounts[key] = (tierCounts[key] || 0) + 1;
      bySignalType[signalType] = (bySignalType[signalType] || 0) + 1;
    } else {
      withoutEmail++;
      const st = signalType;

      if (isPlaceholder) {
        noEmailPlaceholder++;
      } else if (!contactInfo.trim()) {
        noEmailTrulyEmpty++;
      } else if (/research needed/i.test(contactInfo)) {
        noEmailResearchNeeded++;
      } else if (/contact needed/i.test(contactInfo)) {
        noEmailContactNeeded++;
      } else if (/linkedin\.com/i.test(contactInfo)) {
        noEmailLinkedInOnly++;
      } else if (/https?:\/\//i.test(contactInfo)) {
        noEmailWebsiteOnly++;
      } else {
        noEmailTrulyEmpty++;
      }

      noEmailByType[st] = (noEmailByType[st] || 0) + 1;
    }
  }

  // ── Report ──────────────────────────────────────────────────────────────────
  console.log('══════════════════════════════════════════════════════');
  console.log('UNPUSHED SIGNALS — SNAPSHOT');
  console.log('══════════════════════════════════════════════════════');
  console.log(`📦 Total unpushed (unique)    : ${records.length}`);
  console.log(`✅ With contact email         : ${withEmail}`);
  console.log(`❌ Without contact email      : ${withoutEmail}`);

  console.log('\n── With email — breakdown by send day tier ─────────────');
  for (const [day, count] of Object.entries(tierCounts)) {
    if (count === 0) continue;
    const label = day === 'null' ? 'No send day assigned' : tierLabel(parseInt(day));
    console.log(`  ${label.padEnd(45)} : ${count}`);
  }

  console.log('\n── With email — breakdown by signal type ───────────────');
  const sortedTypes = Object.entries(bySignalType).sort((a, b) => b[1] - a[1]);
  for (const [type, count] of sortedTypes) {
    console.log(`  ${type.padEnd(35)} : ${count}`);
  }

  console.log('\n── Without email — breakdown by reason ─────────────────');
  console.log(`  ⏳ Placeholder (unlock pending)    : ${noEmailPlaceholder}`);
  console.log(`  ⚠️  Contact Needed (not found)     : ${noEmailContactNeeded}`);
  console.log(`  🔍 Research Needed (manual)        : ${noEmailResearchNeeded}`);
  console.log(`  🔗 LinkedIn only (no email)        : ${noEmailLinkedInOnly}`);
  console.log(`  🌐 Website only (no email)         : ${noEmailWebsiteOnly}`);
  console.log(`  ❌ Truly empty Contact Info        : ${noEmailTrulyEmpty}`);

  if (Object.keys(noEmailByType).length > 0) {
    console.log('\n── Without email — breakdown by signal type ────────────');
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
