/**
 * clean_hubspot_contacts.js
 *
 * Deletes problem contacts from HubSpot and resets corresponding Airtable records
 * so they can be re-enriched and re-pushed cleanly.
 *
 * TWO MODES (combine with --all to run both):
 *
 *   --duplicates  : Pipeline contacts pushed in last 7 days enrolled in sequences 2+ times.
 *                   Deletes the HubSpot contact entirely, then:
 *                   - Resets the NEWEST Airtable record for that email to HubSpot Pushed = false
 *                   - Suppresses all older Airtable records (HubSpot Pushed = true) so they
 *                     don't cause another duplicate on the next push.
 *                   The push cron will re-push them once, cleanly, on the next run.
 *
 *   --placeholders: Contacts with placeholder email (email_not_unlocked@domain.com).
 *                   Deletes from HubSpot, resets Airtable records to HubSpot Pushed = false.
 *                   Run re_enrich_contacts.js next to find real emails via Apollo/Hunter.
 *
 * Excludes law-firm contacts enrolled manually (no hubspot_pushed_date).
 *
 * Run with:
 *   node --env-file=.env scripts/clean_hubspot_contacts.js --duplicates            (preview)
 *   node --env-file=.env scripts/clean_hubspot_contacts.js --duplicates --live     (delete)
 *   node --env-file=.env scripts/clean_hubspot_contacts.js --placeholders          (preview)
 *   node --env-file=.env scripts/clean_hubspot_contacts.js --placeholders --live   (delete)
 *   node --env-file=.env scripts/clean_hubspot_contacts.js --all --live            (both)
 *   node --env-file=.env scripts/clean_hubspot_contacts.js --duplicates --days=14  (extend window)
 */

import 'dotenv/config';
import axios from 'axios';
import { query, updateRecords } from '../execution/utils/airtable_client.js';

const TOKEN    = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
const BASE_URL = 'https://api.hubapi.com';
const LIVE     = process.argv.includes('--live');
const DO_DUPES = process.argv.includes('--duplicates') || process.argv.includes('--all');
const DO_PLACE = process.argv.includes('--placeholders') || process.argv.includes('--all');

const daysArg = process.argv.find(a => a.startsWith('--days='));
const DAYS    = daysArg ? parseInt(daysArg.split('=')[1], 10) : 7;

const PLACEHOLDER_EMAIL = 'email_not_unlocked@domain.com';

if (!TOKEN) {
  console.error('HUBSPOT_PRIVATE_APP_TOKEN not set in .env');
  process.exit(1);
}
if (!DO_DUPES && !DO_PLACE) {
  console.error('Specify --duplicates, --placeholders, or --all');
  process.exit(1);
}

const hsHeaders = {
  Authorization:  `Bearer ${TOKEN}`,
  'Content-Type': 'application/json',
};

// Cutoff date for duplicate window
// HubSpot date property filters require a Unix timestamp in milliseconds as the value.
const cutoff          = new Date();
cutoff.setDate(cutoff.getDate() - DAYS);
const cutoffStr       = cutoff.toISOString().split('T')[0];
const cutoffTimestamp = String(cutoff.getTime()); // HubSpot expects ms timestamp as string

// ── HubSpot helpers ───────────────────────────────────────────────────────────

async function hsSearch(body) {
  const res = await axios.post(`${BASE_URL}/crm/v3/objects/contacts/search`, body, {
    headers: hsHeaders, timeout: 15000,
  });
  return res.data;
}

async function hsDelete(contactId) {
  await axios.delete(`${BASE_URL}/crm/v3/objects/contacts/${contactId}`, {
    headers: hsHeaders, timeout: 15000,
  });
}

// Fetch all pipeline contacts pushed in last N days with 2+ enrollments
async function fetchDuplicateEnrolled() {
  const contacts = [];
  let after = null;
  let page  = 1;
  while (true) {
    const data = await hsSearch({
      filterGroups: [{
        filters: [
          { propertyName: 'hubspot_pushed_date',         operator: 'HAS_PROPERTY' },
          { propertyName: 'hubspot_pushed_date',         operator: 'GTE', value: cutoffTimestamp },
          { propertyName: 'hs_sequences_enrolled_count', operator: 'GT',  value: '1' },
        ],
      }],
      properties: ['email', 'firstname', 'lastname', 'company', 'signal_data',
                   'hubspot_pushed_date', 'hs_sequences_enrolled_count'],
      limit: 100,
      ...(after ? { after } : {}),
    });
    contacts.push(...data.results);
    process.stdout.write(`  [HubSpot] Fetched page ${page} — ${contacts.length} contacts so far\r`);
    if (data.paging?.next?.after) { after = data.paging.next.after; page++; await pause(300); }
    else break;
  }
  console.log();
  return contacts;
}

// Fetch contacts with placeholder email
async function fetchPlaceholders() {
  const contacts = [];
  let after = null;
  let page  = 1;
  while (true) {
    const data = await hsSearch({
      filterGroups: [{
        filters: [
          { propertyName: 'email', operator: 'EQ', value: PLACEHOLDER_EMAIL },
        ],
      }],
      properties: ['email', 'firstname', 'lastname', 'company', 'signal_data',
                   'hubspot_pushed_date'],
      limit: 100,
      ...(after ? { after } : {}),
    });
    contacts.push(...data.results);
    process.stdout.write(`  [HubSpot] Fetched page ${page} — ${contacts.length} contacts so far\r`);
    if (data.paging?.next?.after) { after = data.paging.next.after; page++; await pause(300); }
    else break;
  }
  console.log();
  return contacts;
}

// ── Airtable helpers ──────────────────────────────────────────────────────────

function extractEmail(contactInfo) {
  if (!contactInfo) return null;
  const m = contactInfo.match(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/);
  return m ? m[0].toLowerCase() : null;
}

// Fetch all pushed Airtable records, keyed by email → sorted array of records (oldest first)
async function fetchAirtableByEmail() {
  console.log('  [Airtable] Fetching pushed records...');
  const records = await query({
    filterByFormula: '{HubSpot Pushed}=TRUE()',
    fields: ['Company Name', 'Signal Type', 'Contact Info', 'Date Detected', 'HubSpot Pushed'],
    sort: [{ field: 'Date Detected', direction: 'asc' }], // oldest first
  });
  console.log(`  [Airtable] Loaded ${records.length} pushed records`);

  const byEmail = {};
  for (const r of records) {
    const email = extractEmail(r.fields['Contact Info']);
    if (!email) continue;
    if (!byEmail[email]) byEmail[email] = [];
    byEmail[email].push(r);
  }
  return byEmail;
}

// Fetch Airtable records that contain the placeholder email
async function fetchAirtablePlaceholders() {
  console.log('  [Airtable] Fetching placeholder records...');
  const records = await query({
    filterByFormula: `AND(
      FIND("${PLACEHOLDER_EMAIL}", {Contact Info}) > 0,
      {HubSpot Pushed}=TRUE()
    )`,
    fields: ['Company Name', 'Signal Type', 'Contact Info', 'Date Detected', 'HubSpot Pushed'],
    sort: [{ field: 'Date Detected', direction: 'asc' }],
  });
  console.log(`  [Airtable] Found ${records.length} placeholder records`);
  return records;
}

function pause(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── MAIN ──────────────────────────────────────────────────────────────────────

async function run() {
  console.log('════════════════════════════════════════════════════════════');
  console.log('CLEAN HUBSPOT CONTACTS');
  if (DO_DUPES) console.log(`  --duplicates  : pipeline contacts pushed since ${cutoffStr} with 2+ enrollments`);
  if (DO_PLACE) console.log(`  --placeholders: contacts with email = ${PLACEHOLDER_EMAIL}`);
  console.log(`Mode: ${LIVE ? 'LIVE (will delete from HubSpot + reset Airtable)' : 'PREVIEW (no changes)'}`);
  console.log('════════════════════════════════════════════════════════════\n');

  // ── OPTION A: Duplicate-enrolled contacts ────────────────────────────────
  if (DO_DUPES) {
    console.log('── DUPLICATES ──────────────────────────────────────────────');
    let dupeContacts;
    try {
      dupeContacts = await fetchDuplicateEnrolled();
    } catch (err) {
      console.error('HubSpot search error (duplicates):', err.response?.data?.message || err.message);
      process.exit(1);
    }

    if (dupeContacts.length === 0) {
      console.log(`No pipeline contacts with 2+ enrollments found since ${cutoffStr}.\n`);
    } else {
      console.log(`Found ${dupeContacts.length} contact(s) with duplicate enrollments.\n`);

      // Load Airtable records for email matching
      let airtableByEmail;
      try {
        airtableByEmail = await fetchAirtableByEmail();
      } catch (err) {
        console.error('Airtable fetch error:', err.message);
        process.exit(1);
      }

      let hsDeleted     = 0;
      let hsFailed      = 0;
      let atReset       = 0;
      let atSuppressed  = 0;

      for (const contact of dupeContacts) {
        const p       = contact.properties;
        const email   = (p.email || '').toLowerCase();
        const name    = [p.firstname, p.lastname].filter(Boolean).join(' ') || '—';
        const company = p.company || '—';
        const count   = p.hs_sequences_enrolled_count || '?';
        const pushed  = p.hubspot_pushed_date || '—';
        const signal  = p.signal_data || '—';

        console.log(`  ${email} — ${name} [${company}] | signal:${signal} | pushed:${pushed} | enrollments:${count}`);

        // HubSpot deletion
        if (LIVE) {
          try {
            await hsDelete(contact.id);
            console.log(`    ✓ Deleted from HubSpot (id: ${contact.id})`);
            hsDeleted++;
            await pause(300);
          } catch (err) {
            if (err.response?.status === 404) {
              console.log(`    ↳ Already deleted (404)`);
              hsDeleted++;
            } else {
              console.log(`    ✗ HubSpot delete failed: ${err.response?.data?.message || err.message}`);
              hsFailed++;
              continue;
            }
          }
        } else {
          console.log(`    → WOULD DELETE from HubSpot (id: ${contact.id})`);
        }

        // Airtable reset
        const atRecords = airtableByEmail[email] || [];
        if (atRecords.length === 0) {
          console.log(`    ↳ No Airtable records found for ${email}`);
        } else {
          // Keep newest → reset to un-pushed; suppress all older ones
          const newest = atRecords[atRecords.length - 1];
          const older  = atRecords.slice(0, -1);

          if (LIVE) {
            try {
              await updateRecords([{ id: newest.id, fields: { 'HubSpot Pushed': false } }]);
              console.log(`    ✓ Airtable reset: ${newest.id} → HubSpot Pushed = false (${newest.fields['Date Detected'] || 'no date'})`);
              atReset++;
            } catch (err) {
              console.log(`    ⚠️  Airtable reset failed for ${newest.id}: ${err.message}`);
            }
            for (const old of older) {
              try {
                await updateRecords([{ id: old.id, fields: { 'HubSpot Pushed': true } }]);
                console.log(`    ✓ Airtable suppressed: ${old.id} (${old.fields['Date Detected'] || 'no date'})`);
                atSuppressed++;
              } catch (err) {
                console.log(`    ⚠️  Airtable suppress failed for ${old.id}: ${err.message}`);
              }
            }
          } else {
            console.log(`    → WOULD RESET newest Airtable record: ${newest.id} (${newest.fields['Date Detected'] || 'no date'})`);
            for (const old of older) {
              console.log(`    → WOULD SUPPRESS older record: ${old.id} (${old.fields['Date Detected'] || 'no date'})`);
            }
          }
        }
        console.log();
      }

      console.log('── DUPLICATES SUMMARY ──────────────────────────────────────');
      if (LIVE) {
        console.log(`  HubSpot deleted  : ${hsDeleted}`);
        console.log(`  HubSpot failed   : ${hsFailed}`);
        console.log(`  Airtable reset   : ${atReset} (will be re-pushed by cron)`);
        console.log(`  Airtable suppressed: ${atSuppressed}`);
      } else {
        console.log(`  Would delete from HubSpot: ${dupeContacts.length}`);
        console.log(`  Run with --live to apply.`);
      }
      console.log();
    }
  }

  // ── OPTION B: Placeholder emails ─────────────────────────────────────────
  if (DO_PLACE) {
    console.log('── PLACEHOLDERS ────────────────────────────────────────────');
    let placeContacts;
    try {
      placeContacts = await fetchPlaceholders();
    } catch (err) {
      console.error('HubSpot search error (placeholders):', err.response?.data?.message || err.message);
      process.exit(1);
    }

    let atRecords;
    try {
      atRecords = await fetchAirtablePlaceholders();
    } catch (err) {
      console.error('Airtable fetch error:', err.message);
      process.exit(1);
    }

    if (placeContacts.length === 0 && atRecords.length === 0) {
      console.log('No placeholder contacts found in HubSpot or Airtable.\n');
    } else {
      let hsDeleted = 0;
      let hsFailed  = 0;
      let atReset   = 0;

      // Delete from HubSpot
      if (placeContacts.length > 0) {
        console.log(`Found ${placeContacts.length} HubSpot contact(s) with placeholder email.\n`);
        for (const contact of placeContacts) {
          const p       = contact.properties;
          const company = p.company || '—';
          const signal  = p.signal_data || '—';
          const pushed  = p.hubspot_pushed_date || '—';
          console.log(`  ${PLACEHOLDER_EMAIL} — [${company}] | signal:${signal} | pushed:${pushed}`);

          if (LIVE) {
            try {
              await hsDelete(contact.id);
              console.log(`    ✓ Deleted from HubSpot (id: ${contact.id})`);
              hsDeleted++;
              await pause(300);
            } catch (err) {
              if (err.response?.status === 404) {
                console.log(`    ↳ Already deleted (404)`);
                hsDeleted++;
              } else {
                console.log(`    ✗ HubSpot delete failed: ${err.response?.data?.message || err.message}`);
                hsFailed++;
              }
            }
          } else {
            console.log(`    → WOULD DELETE from HubSpot (id: ${contact.id})`);
          }
        }
        console.log();
      }

      // Reset Airtable placeholder records → needs re-enrichment
      if (atRecords.length > 0) {
        console.log(`Found ${atRecords.length} Airtable record(s) with placeholder email — resetting to un-pushed...\n`);
        const updates = atRecords.map(r => ({ id: r.id, fields: { 'HubSpot Pushed': false } }));

        for (const r of atRecords) {
          const company = r.fields['Company Name'] || '—';
          const signal  = r.fields['Signal Type']  || '—';
          const date    = r.fields['Date Detected'] || 'no date';
          console.log(`  ${r.id} — ${company} [${signal}] (${date})`);
          console.log(`    → ${LIVE ? 'RESET to HubSpot Pushed = false (needs re-enrichment)' : 'WOULD RESET to HubSpot Pushed = false'}`);
        }

        if (LIVE) {
          try {
            await updateRecords(updates);
            atReset = atRecords.length;
            console.log(`\n  ✓ ${atReset} Airtable record(s) reset.`);
          } catch (err) {
            console.error(`  ✗ Airtable update failed: ${err.message}`);
          }
        }
        console.log();
      }

      console.log('── PLACEHOLDERS SUMMARY ────────────────────────────────────');
      if (LIVE) {
        console.log(`  HubSpot deleted : ${hsDeleted}`);
        console.log(`  HubSpot failed  : ${hsFailed}`);
        console.log(`  Airtable reset  : ${atReset}`);
        if (atReset > 0) {
          console.log('\n  NEXT STEP: Run re_enrich_contacts.js to find real emails via Apollo/Hunter,');
          console.log('  then the push cron (or re_enrich_contacts.js --push) will re-push them to HubSpot.');
        }
      } else {
        console.log(`  Would delete from HubSpot : ${placeContacts.length}`);
        console.log(`  Would reset in Airtable   : ${atRecords.length}`);
        console.log('  Run with --live to apply.');
      }
      console.log();
    }
  }

  console.log('════════════════════════════════════════════════════════════');
  if (!LIVE) console.log('PREVIEW — no changes made. Run with --live to apply.');
  console.log('════════════════════════════════════════════════════════════');
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
