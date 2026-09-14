/**
 * scripts/count_rebrand_signals.js
 *
 * Counts all Rebrand signals in Airtable and breaks them down by:
 *   - HubSpot Pushed status
 *   - Whether they have a real contact email
 *   - AB Test Group
 *
 * Run:
 *   node --env-file=.env scripts/count_rebrand_signals.js
 */

import 'dotenv/config';
import { query } from '../execution/utils/airtable_client.js';

const PLACEHOLDER = 'email_not_unlocked@domain.com';

function extractEmail(ci) {
  if (!ci) return null;
  const m = ci.match(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/);
  return m ? m[0].toLowerCase() : null;
}

function hasRealEmail(ci) {
  const email = extractEmail(ci || '');
  return email && !email.includes(PLACEHOLDER);
}

async function run() {
  console.log('Fetching Rebrand signals from Airtable...\n');

  let records;
  try {
    records = await query({
      filterByFormula: `{Signal Type} = "Rebrand"`,
      fields: ['Company Name', 'HubSpot Pushed', 'Contact Info', 'AB Test Group', 'Date Detected'],
    }, 60000);
  } catch (err) {
    console.error('Airtable fetch failed:', err.message);
    process.exit(1);
  }

  const total    = records.length;
  const pushed   = records.filter(r => r.fields['HubSpot Pushed'] === true).length;
  const unpushed = total - pushed;

  const unpushedRecords = records.filter(r => r.fields['HubSpot Pushed'] !== true);
  const withEmail    = unpushedRecords.filter(r => hasRealEmail(r.fields['Contact Info'])).length;
  const withoutEmail = unpushed - withEmail;

  const claudeGroup   = unpushedRecords.filter(r => r.fields['AB Test Group'] === 'claude').length;
  const starfishGroup = unpushedRecords.filter(r => r.fields['AB Test Group'] === 'starfish').length;
  const noGroup       = unpushed - claudeGroup - starfishGroup;

  console.log('════════════════════════════════════════════');
  console.log('REBRAND SIGNALS — Airtable Count');
  console.log('════════════════════════════════════════════');
  console.log(`  Total Rebrand records   : ${total}`);
  console.log(`  Already pushed          : ${pushed}`);
  console.log(`  Not yet pushed          : ${unpushed}`);
  console.log('');
  console.log('  — Unpushed breakdown —');
  console.log(`  With real email         : ${withEmail}`);
  console.log(`  No email yet            : ${withoutEmail}`);
  console.log('');
  console.log(`  AB group: claude        : ${claudeGroup}`);
  console.log(`  AB group: starfish      : ${starfishGroup}`);
  console.log(`  AB group: not assigned  : ${noGroup}`);
  console.log('════════════════════════════════════════════');

  if (unpushedRecords.length > 0) {
    console.log('\nSample unpushed (first 10):');
    for (const r of unpushedRecords.slice(0, 10)) {
      const company = (r.fields['Company Name'] || '(unknown)').padEnd(35);
      const date    = r.fields['Date Detected'] || '—';
      const group   = (r.fields['AB Test Group'] || 'no group').padEnd(8);
      const email   = hasRealEmail(r.fields['Contact Info']) ? '✓ email' : '✗ no email';
      console.log(`  ${company} | ${date} | ${group} | ${email}`);
    }
    if (unpushedRecords.length > 10) console.log(`  ... and ${unpushedRecords.length - 10} more`);
  }
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
