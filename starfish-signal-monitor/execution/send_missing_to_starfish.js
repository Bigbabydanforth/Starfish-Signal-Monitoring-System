/**
 * send_missing_to_starfish.js
 *
 * Finds every Airtable record that is NOT yet in the Google Sheet,
 * then:
 *   → Google Sheets: appends ALL individual records (each contact gets its own row)
 *   → Email to Starfish: ONE card per company (no repeats), showing contact count for BSI
 *
 * Run (testing — sends to EMAIL_TO_TESTING):
 *   node execution/send_missing_to_starfish.js
 *
 * Run (production — sends to Starfish):
 *   NODE_ENV=production node execution/send_missing_to_starfish.js
 *
 * Dry run (no writes, no email — just shows what would happen):
 *   node execution/send_missing_to_starfish.js --dry-run
 */

import 'dotenv/config';
import { query } from './utils/airtable_client.js';
import { google, getAuth } from './utils/sheets_client.js';
import sendEmailWorkflow from './workflow_5_send_email.js';

// ── Companies already in Google Sheets (snapshot 2026-06-15) ─────────────────
const ALREADY_IN_SHEETS = [
  'Google', "Lowe's Companies, Inc.", 'ADP', 'Eli Lilly and Company', 'F&G',
  'LHH', 'Hewlett Packard Enterprise', 'Optum', 'Colgate-Palmolive', 'Exaforce',
  'Allegiant', 'Stratos', 'H.I.G. Capital', 'Dust', 'Nectar Social', 'Indicor',
  'Roadrunner', 'GridCare', 'USAA', 'Sidus Space', 'Radar', 'servicenow', 'VSXY',
  'Ferragamo', 'Nourish', 'Widmer Brothers', 'salesforce', 'The Doux', 'Aptum',
  'FLINT', 'Perseus Mining', 'Cielo', 'Verde AgriTech', 'Sylogist', 'MindBridge',
  'AMETEK', 'Greenland Mines', 'Authentic Brands Group', 'Molex', 'Artivion',
  'Siris', 'SRS Distribution', 'Motivity', 'RemotePass', 'Moment', 'Exa Labs',
  'BRAMI', 'IREN', 'Brami Protein Pasta', 'S&P Global Ratings Maalot',
  'United Site Services', 'Variational', 'LGI Homes', 'Hark', 'Convective Capital',
  'Wellness Pet Company', 'Synergis Software', 'Hermeus', 'ProphetX', 'FDH Aero',
  'Green Building Initiative', 'FleishmanHillard', 'Aleta', 'AmplifyMD', 'Boh',
  'Strength of Nature', 'greenvilleme', 'StrainX Bioworks', 'South Street Partners',
  'OpenRouter', 'Restaurant Technologies', 'LightTable', 'Experis', 'Sun Sentinel',
  'Emancipet', 'EHE Health', "Michter's", 'Owens & Minor', 'Airis Labs',
  'RevEng.AI', 'ixlayer', 'royal caribbean international', 'thrivent',
  'norwegian cruise line holdings ltd.', 'mars', 'cloudflare', 'old navy',
  'whirlpool corporation', 'mastercard', 'Trestle Studio LLC', 'CoStar Group Inc.',
  'Solstice', 'XCENA', 'Saris', 'Morgan & Morgan', 'Thea Energy', 'K92 Mining',
  'PHARMACISTS MUTUAL', 'Sprinklr', 'Burlington Stores, Inc.',
  'Dr. Matthew T. Provencher', 'Arixa Capital', 'Zenylitics', 'CREATE', 'Lanvin',
  'Ipsos', 'Gold Resource Corporation', 'Eurizon Capital SGR S.p.A',
  'Tourism Authority', 'DFNS', 'Annual Meeting Arrow Financial', 'Media That Connects',
  'AMCS Group', 'Scotch', 'Forage', 'PEAK ROCK CAPITAL AFFILIATE', 'PDW',
  'Focused Energy', 'CI Global Asset Management', 'Ona Therapeutics', 'Scispot',
  'Benchmark', 'FirstClub', 'Quobly', 'Ingenix', 'Town', 'Sekai', 'Terra AI',
  'Board', 'Tripo AI', 'Ex-Anduril engineer', 'Uncover',
  'American College of Lifestyle Medicine', 'Melanoma Research Alliance', 'Reejig',
  'Aprio', 'MobileHelp', 'Actabl', 'Jack Henry & Associates', 'Gluware',
  'Top 10 Franchises in Every Industry', 'CleanSpark', 'Flexential',
  'Origin Medical', 'Inc', 'Rhythm AI', 'Advent', 'Menopause Discussion Group',
  'Uniti Group', 'Cresset', 'Dusty Boots', 'Cabinetworks Group'
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function normalize(name) {
  if (!name) return '';
  return name.toLowerCase().trim().replace(/[^a-z0-9]/g, '');
}

const ALREADY_NORMALIZED = new Set(ALREADY_IN_SHEETS.map(normalize));

const PRIORITY_RANK = { HIGH: 3, MEDIUM: 2, LOW: 1 };

// ── Convert Airtable record → Google Sheet row ────────────────────────────────
function recordToRow(record) {
  const f = record.fields;
  const rawRevenue = Number(f['Company Revenue']);
  const revenue = f['Company Revenue'] && !isNaN(rawRevenue)
    ? `$${rawRevenue.toLocaleString()}`
    : '';
  return [
    f['Company Name']          || '',
    f['Signal Details']        || '',
    f['Signal Type']           || '',
    f['Contact Info']          || '',
    revenue,
    f['Company Funding Stage'] || '',
    f['Industry']              || '',
    f['Date Detected']         || '',
    f['Priority']              || '',
    f['Brief']                 || '',
    f['Contact Approach']      || '',
    f['Source URL']            || '',
    f['Status']                || 'New',
    f['Created At']            || '',
    f['Last Modified']         || ''
  ];
}

// ── Group records by company → one signal per company for email ───────────────
// BSI companies can have 5 rows in Airtable (one per contact/send day).
// For the email we collapse them into ONE card showing the contact count.
// Non-BSI companies are already one row each — they just get deduplicated.
function buildEmailSignals(records) {
  // Group by normalized company name
  const groups = new Map();
  for (const r of records) {
    const name = r.fields['Company Name'] || '';
    const key  = normalize(name) || name;
    if (!groups.has(key)) groups.set(key, { displayName: name, records: [] });
    groups.get(key).records.push(r);
  }

  const signals = [];

  for (const { displayName, records: group } of groups.values()) {
    // Pick the record with the highest priority as the "base" for the card
    const base = group.reduce((best, r) => {
      const rp = PRIORITY_RANK[r.fields['Priority']] || 0;
      const bp = PRIORITY_RANK[best.fields['Priority']] || 0;
      return rp > bp ? r : best;
    });

    const type         = base.fields['Signal Type'] || 'News/Press';
    const contactCount = group.length;

    // For BSI: summarise contact count instead of repeating per-contact rows.
    // Starfish can open Airtable to see the full contact list.
    let contactInfo;
    if (type === 'Brand Strategy Intent') {
      contactInfo = contactCount === 1
        ? '1 contact identified — open Airtable for full details'
        : `${contactCount} contacts identified — open Airtable for full details`;
    } else {
      contactInfo = base.fields['Contact Info'] || '';
    }

    signals.push({
      company:            { name: displayName, industry: base.fields['Industry'] || '' },
      type,
      priority:           base.fields['Priority'] || 'MEDIUM',
      brief:              base.fields['Brief']    || '',
      source_url:         base.fields['Source URL'] || '#',
      person:             null,
      contact_info_raw:   contactInfo,
      signal_details_raw: base.fields['Signal Details'] || ''
    });
  }

  // Sort: HIGH first, then MEDIUM, then LOW
  return signals.sort((a, b) =>
    (PRIORITY_RANK[b.priority] || 0) - (PRIORITY_RANK[a.priority] || 0)
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
const isDryRun = process.argv.includes('--dry-run');

(async () => {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║     Send Missing Signals → Sheets + Starfish Email   ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  if (isDryRun) console.log('⚠️  DRY RUN — no writes, no email\n');

  // ── Step 1: Fetch all Airtable records ──────────────────────────────────────
  console.log('[Step 1] Fetching all records from Airtable...');
  let allRecords;
  try {
    allRecords = await query({
      sort: [
        { field: 'Date Detected', direction: 'asc' },
        { field: 'Created At',    direction: 'asc' }
      ]
    }, 120000);
  } catch (err) {
    console.error('[Step 1] ❌ Airtable query failed:', err.message);
    process.exit(1);
  }
  console.log(`[Step 1] ✅ ${allRecords.length} total records in Airtable`);

  // ── Step 2: Filter out what's already in Sheets ──────────────────────────────
  const missingRecords = allRecords.filter(r =>
    !ALREADY_NORMALIZED.has(normalize(r.fields['Company Name'] || ''))
  );

  const emailSignals    = buildEmailSignals(missingRecords);
  const uniqueCompanies = emailSignals.length;

  console.log(`\n[Step 2] Already in Sheets : ${allRecords.length - missingRecords.length} records`);
  console.log(`[Step 2] Missing from Sheets: ${missingRecords.length} records (${uniqueCompanies} unique companies)`);

  if (missingRecords.length === 0) {
    console.log('\n✅ Sheet is already up to date — nothing to add or send.\n');
    process.exit(0);
  }

  // ── Preview ──────────────────────────────────────────────────────────────────
  console.log('\n[Preview] What will be EMAILED to Starfish (1 card per company):');
  emailSignals.forEach((s, i) => {
    const count = missingRecords.filter(
      r => normalize(r.fields['Company Name'] || '') === normalize(s.company.name)
    ).length;
    const suffix = count > 1 ? ` (${count} contacts)` : '';
    console.log(`  ${String(i + 1).padStart(3)}. [${s.priority}] ${s.company.name} — ${s.type}${suffix}`);
  });

  console.log(`\n  → ${missingRecords.length} rows will be written to Google Sheets`);
  console.log(`  → ${uniqueCompanies} company cards will appear in the email`);

  if (isDryRun) {
    console.log('\n[Dry Run] Done — no changes made.\n');
    process.exit(0);
  }

  // ── Step 3: Append ALL missing rows to Google Sheets ─────────────────────────
  // Only runs in test/development — production skips this to avoid double-writing.
  // Workflow: run test first (writes Sheets + sends to you), then run production
  // (email only → Starfish). Sheets is already up to date after the test run.
  const env = process.env.NODE_ENV || 'development';

  if (env === 'production') {
    console.log('\n[Step 3] Skipping Sheets write in production (already written during test run)');
  } else {
    console.log(`\n[Step 3] Appending ${missingRecords.length} rows to Google Sheets...`);
    try {
      const auth    = getAuth();
      const sheets  = google.sheets({ version: 'v4', auth });
      const rows    = missingRecords.map(recordToRow);

      await sheets.spreadsheets.values.append({
        spreadsheetId:    process.env.GOOGLE_SHEET_ID,
        range:            'Signals!A5',
        valueInputOption: 'USER_ENTERED',
        requestBody:      { values: rows }
      });

      console.log(`[Step 3] ✅ ${rows.length} rows appended to Google Sheet`);
    } catch (err) {
      console.error('[Step 3] ❌ Google Sheets write failed:', err.message);
      console.error('         Continuing to email step anyway...');
    }
  }

  // ── Step 4: Send deduplicated email to Starfish ───────────────────────────────
  const recipient = env === 'production'
    ? (process.env.EMAIL_TO_PRODUCTION || 'EMAIL_TO_PRODUCTION not set')
    : (process.env.EMAIL_TO_TESTING    || 'EMAIL_TO_TESTING not set');

  console.log(`\n[Step 4] Sending email (${env}) → ${recipient}`);
  console.log(`         ${uniqueCompanies} unique company cards in this email`);

  try {
    const success = await sendEmailWorkflow(emailSignals);
    if (success) {
      console.log('[Step 4] ✅ Email sent successfully');
    } else {
      console.error('[Step 4] ❌ Email failed — check logs/.tmp for details');
    }
  } catch (err) {
    console.error('[Step 4] ❌ Email threw:', err.message);
  }

  console.log('\n✅ All done.\n');
})();
