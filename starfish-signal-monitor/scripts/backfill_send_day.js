/**
 * scripts/backfill_send_day.js
 *
 * Assigns Send Day to all unpushed Airtable records that have a valid contact
 * email but are missing a Send Day value.
 *
 * Uses the exact same _assignSendDay() logic as the live pipeline (via the
 * exported getSendDay() from broadcast_contacts.js) — parses the contact title
 * from the Contact Info field and maps it to days 1–5:
 *
 *   Day 1 — CMO / VP Marketing / VP Brand
 *   Day 2 — CEO / President
 *   Day 3 — COO
 *   Day 4 — Head/Director of Marketing (default for unknown titles)
 *   Day 5 — Communications / Comms
 *
 * Run:
 *   node --env-file=.env scripts/backfill_send_day.js           (preview — no writes)
 *   node --env-file=.env scripts/backfill_send_day.js --live    (write to Airtable)
 */

import 'dotenv/config';
import { query, updateRecords } from '../execution/utils/airtable_client.js';
import { getSendDay }          from '../execution/utils/broadcast_contacts.js';

const LIVE        = process.argv.includes('--live');
const PLACEHOLDER = 'email_not_unlocked@domain.com';

function extractEmail(ci) {
  if (!ci) return null;
  const m = ci.match(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/);
  return m ? m[0].toLowerCase() : null;
}

// Parse the contact title from the Contact Info block.
// Handles both labelled ("Name: X\nTitle: Y") and plain ("Name\nTitle\nEmail") formats.
function parseTitle(ci) {
  if (!ci) return '';
  const lines = ci.split('\n').map(l => l.trim()).filter(Boolean);
  let foundName = false;

  for (const line of lines) {
    // Skip warning lines and URLs
    if (line.startsWith('⚠️') || line.startsWith('http') ||
        line.startsWith('Website:') || line.startsWith('LinkedIn:')) continue;

    // Labelled format: "Title: CMO"
    const titleMatch = line.match(/^title\s*:\s*(.+)/i);
    if (titleMatch) return titleMatch[1].trim();

    // Skip email lines
    if (/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/.test(line)) continue;

    // Plain format: first non-email non-URL line = name, second = title
    const clean = line.replace(/^(name|email|linkedin)\s*:\s*/i, '').trim();
    if (!foundName) { foundName = true; continue; } // skip name line
    return clean; // second line is the title
  }
  return '';
}

async function run() {
  console.log('════════════════════════════════════════════════════════════');
  console.log('BACKFILL SEND DAY — Unpushed records with email but no Send Day');
  console.log(`Mode  : ${LIVE ? 'LIVE — writing to Airtable' : 'PREVIEW — no writes'}`);
  console.log('════════════════════════════════════════════════════════════\n');

  console.log('Fetching records...');
  let records;
  try {
    records = await query({
      filterByFormula: `AND(
        OR({HubSpot Pushed}=FALSE(), {HubSpot Pushed}=BLANK()),
        {Send Day} = BLANK(),
        NOT({Contact Info} = ""),
        NOT(FIND("${PLACEHOLDER}", {Contact Info}) > 0),
        NOT(FIND("Research Needed", {Contact Info}) > 0),
        NOT(FIND("Contact Needed", {Contact Info}) > 0)
      )`,
      fields: ['Company Name', 'Signal Type', 'Contact Info', 'Send Day'],
    }, 60000);
  } catch (err) {
    console.error('Airtable fetch failed:', err.message);
    process.exit(1);
  }

  // Filter to records with a real email
  const eligible = records.filter(r => {
    const email = extractEmail(r.fields['Contact Info'] || '');
    return email && !email.includes(PLACEHOLDER);
  });

  console.log(`  Records fetched (no send day, valid email) : ${eligible.length}\n`);

  if (eligible.length === 0) {
    console.log('Nothing to backfill — all records with emails already have a Send Day.');
    return;
  }

  // Build updates and preview
  const dayCounts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const updates = [];

  for (const r of eligible) {
    const title   = parseTitle(r.fields['Contact Info'] || '');
    const sendDay = getSendDay(title);
    dayCounts[sendDay]++;
    updates.push({ id: r.id, fields: { 'Send Day': sendDay } });
  }

  console.log('Send Day distribution:');
  console.log(`  Day 1 — CMO / VP Marketing / VP Brand        : ${dayCounts[1]}`);
  console.log(`  Day 2 — CEO / President                      : ${dayCounts[2]}`);
  console.log(`  Day 3 — COO                                  : ${dayCounts[3]}`);
  console.log(`  Day 4 — Head/Director of Marketing (default) : ${dayCounts[4]}`);
  console.log(`  Day 5 — Communications / Comms               : ${dayCounts[5]}\n`);

  console.log('Sample (first 10):');
  for (const u of updates.slice(0, 10)) {
    const r       = eligible.find(x => x.id === u.id);
    const company = (r?.fields['Company Name'] || '(unknown)').padEnd(35);
    const title   = parseTitle(r?.fields['Contact Info'] || '') || '(no title)';
    console.log(`  ${company} | Day ${u.fields['Send Day']} | ${title}`);
  }
  if (updates.length > 10) console.log(`  ... and ${updates.length - 10} more\n`);

  if (!LIVE) {
    console.log(`\nPREVIEW: Would update ${updates.length} records.`);
    console.log('Run with --live to apply.');
    return;
  }

  console.log(`\nWriting ${updates.length} updates to Airtable...`);
  try {
    await updateRecords(updates);
    console.log('  ✅ Done.');
  } catch (err) {
    console.error(`  ❌ Airtable write error: ${err.message}`);
    process.exit(1);
  }

  console.log('\n════════════════════════════════════════════════════════════');
  console.log('RESULTS');
  console.log('════════════════════════════════════════════════════════════');
  console.log(`  Records updated : ${updates.length}`);
  console.log(`  Day 1           : ${dayCounts[1]}`);
  console.log(`  Day 2           : ${dayCounts[2]}`);
  console.log(`  Day 3           : ${dayCounts[3]}`);
  console.log(`  Day 4           : ${dayCounts[4]}`);
  console.log(`  Day 5           : ${dayCounts[5]}`);
  console.log('════════════════════════════════════════════════════════════');
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
