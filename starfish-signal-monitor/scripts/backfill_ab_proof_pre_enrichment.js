/**
 * scripts/backfill_ab_proof_pre_enrichment.js
 *
 * Backfills AB Test Group and Proof Clients on unpushed Airtable records
 * that have a real email + industry but are missing both AB Test Group
 * and Proof Clients. These are pre-enrichment signals that went through
 * the old pipeline before these fields existed.
 *
 * AB Test Group rules (mirrors generateEmailData in workflow_4):
 *   - Bespoke signals        → always "starfish"
 *   - Brand Strategy Intent  → 50% claude / 50% starfish
 *   - All other types        → 25% claude / 75% starfish
 *   - CLAUDE_EMAILS_ENABLED is NOT checked here — we are assigning the
 *     group only, not generating emails. Claude emails will be generated
 *     separately before push for claude-group records.
 *
 * Proof Clients:
 *   - Looked up from existing Industry value using getProofClients()
 *   - Same function used in pushSignalToHubSpot.js at push time
 *
 * Targets ONLY records that:
 *   - Are NOT pushed to HubSpot
 *   - Have a real email (not placeholder / Research Needed / blank)
 *   - Have an Industry value
 *   - Are missing AB Test Group
 *   - Are missing Proof Clients
 *
 * Run:
 *   node --env-file=.env scripts/backfill_ab_proof_pre_enrichment.js            (preview)
 *   node --env-file=.env scripts/backfill_ab_proof_pre_enrichment.js --live     (write to Airtable)
 */

import 'dotenv/config';
import { query, updateRecords } from '../execution/utils/airtable_client.js';
import { getProofClients }      from '../data/proof_clients.js';

const LIVE        = process.argv.includes('--live');
const PLACEHOLDER = 'email_not_unlocked@domain.com';

function extractEmail(ci) {
  if (!ci) return null;
  const m = ci.match(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/);
  return m ? m[0].toLowerCase() : null;
}

function assignAbGroup(isBespoke, signalType) {
  if (isBespoke) return 'starfish';
  if (signalType === 'Brand Strategy Intent') return Math.random() < 0.5 ? 'claude' : 'starfish';
  return Math.random() < 0.25 ? 'claude' : 'starfish';
}

async function run() {
  console.log('════════════════════════════════════════════════════════════');
  console.log('BACKFILL AB TEST GROUP + PROOF CLIENTS');
  console.log('Targets: unpushed, valid email, has industry, missing AB + Proof');
  console.log(`Mode: ${LIVE ? 'LIVE — writing to Airtable' : 'PREVIEW — no writes'}`);
  console.log('════════════════════════════════════════════════════════════\n');

  console.log('Fetching records...');
  let records;
  try {
    records = await query({
      filterByFormula: `AND(
        OR({HubSpot Pushed}=FALSE(), {HubSpot Pushed}=BLANK()),
        NOT({Contact Info} = ""),
        NOT(FIND("${PLACEHOLDER}", {Contact Info}) > 0),
        NOT(FIND("Research Needed", {Contact Info}) > 0),
        NOT(FIND("Contact Needed", {Contact Info}) > 0),
        NOT({Industry} = ""),
        {AB Test Group} = "",
        {Proof Clients} = ""
      )`,
      fields: ['Company Name', 'Signal Type', 'Contact Info', 'Industry', 'Bespoke'],
    }, 120000);
  } catch (err) {
    console.error('Airtable fetch failed:', err.message);
    process.exit(1);
  }

  // Filter to records with a real email
  const eligible = records.filter(r => {
    const email = extractEmail(r.fields['Contact Info'] || '');
    return email && !email.includes(PLACEHOLDER);
  });

  console.log(`  Total fetched                  : ${records.length}`);
  console.log(`  Eligible (real email + industry): ${eligible.length}\n`);

  if (eligible.length === 0) {
    console.log('Nothing to backfill.');
    return;
  }

  // Dedup by email — one AB group assignment per unique email
  const seen      = new Map(); // email → { abGroup, proofClients }
  const updates   = [];
  const abCount   = { starfish: 0, claude: 0 };

  for (const r of eligible) {
    const email      = extractEmail(r.fields['Contact Info'] || '');
    const signalType = r.fields['Signal Type'] || '';
    const industry   = r.fields['Industry']    || '';
    const isBespoke  = r.fields['Bespoke'] === true;

    let abGroup;
    if (seen.has(email)) {
      // Same contact appearing in multiple records (BSI send_day tiers) —
      // reuse the same AB group so they stay consistent
      abGroup = seen.get(email);
    } else {
      abGroup = assignAbGroup(isBespoke, signalType);
      seen.set(email, abGroup);
    }

    const proofClients = getProofClients(industry);

    updates.push({
      id: r.id,
      fields: {
        'AB Test Group': abGroup,
        'Proof Clients': proofClients,
      },
    });

    abCount[abGroup] = (abCount[abGroup] || 0) + 1;
  }

  console.log(`Records to update              : ${updates.length}`);
  console.log(`  → starfish                   : ${abCount.starfish || 0}`);
  console.log(`  → claude                     : ${abCount.claude   || 0}\n`);

  // Sample preview
  console.log('Sample (first 10):');
  for (const u of updates.slice(0, 10)) {
    const r       = eligible.find(x => x.id === u.id);
    const company = (r?.fields['Company Name'] || '(unknown)').padEnd(30);
    const type    = (r?.fields['Signal Type']  || '—').padEnd(25);
    const ind     = (r?.fields['Industry']     || '—').slice(0, 30).padEnd(30);
    console.log(`  ${company} | ${type} | ${ind} → ${u.fields['AB Test Group']}`);
  }
  if (updates.length > 10) console.log(`  ... and ${updates.length - 10} more\n`);
  else console.log('');

  if (!LIVE) {
    console.log(`PREVIEW: Would update ${updates.length} records.`);
    console.log('Run with --live to apply.');
    return;
  }

  console.log(`Writing ${updates.length} updates to Airtable...`);
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
  console.log(`  → starfish      : ${abCount.starfish || 0}`);
  console.log(`  → claude        : ${abCount.claude   || 0}`);
  console.log('════════════════════════════════════════════════════════════');
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
