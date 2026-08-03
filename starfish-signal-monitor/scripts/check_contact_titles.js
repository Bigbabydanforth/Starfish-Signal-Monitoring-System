/**
 * scripts/check_contact_titles.js
 *
 * Checks all unpushed Airtable records that have a real contact email,
 * and classifies each contact's title against the approved position lists.
 *
 * Categories:
 *   ✅ Approved      — title matches APPROVED_TITLES (primary marketing/brand/comms roles)
 *   🔄 C-Suite Fallback — title matches CSUITE_FALLBACK_TITLES (CEO/COO/President/Partner)
 *   ⚠️  Rejected     — title matches a REJECTED_TITLE_WORDS word (wrong function)
 *   ❓ Unclassified  — title present but doesn't match any list
 *   —  No title      — contact has an email but no title on record
 *
 * Run:
 *   node --env-file=.env scripts/check_contact_titles.js
 */

import 'dotenv/config';
import { query } from '../execution/utils/airtable_client.js';
import {
  APPROVED_TITLES,
  CSUITE_FALLBACK_TITLES,
  REJECTED_TITLE_WORDS,
} from '../execution/utils/title_lists.js';

const PLACEHOLDER = 'email_not_unlocked@domain.com';

// Lowercase sets for fast matching
const APPROVED_LOWER  = APPROVED_TITLES.map(t => t.toLowerCase());
const FALLBACK_LOWER  = CSUITE_FALLBACK_TITLES.map(t => t.toLowerCase());
const REJECTED_LOWER  = REJECTED_TITLE_WORDS.map(w => w.toLowerCase());

function extractEmail(contactInfo) {
  if (!contactInfo) return null;
  const m = contactInfo.match(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/);
  return m ? m[0].toLowerCase() : null;
}

function extractTitle(contactInfo) {
  if (!contactInfo) return null;
  // Contact Info format: Name\nTitle\nEmail  (Name/Title/Email only — no labels)
  const lines = contactInfo.split('\n').map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    // Skip the email line and any warning markers
    if (line.includes('@')) continue;
    if (line.startsWith('⚠️') || line.startsWith('http') || line.startsWith('Website:')) continue;
    // First non-email, non-marker line after skipping is the name, second is title
  }
  // Name = first non-email line, Title = second non-email line
  const nonEmailLines = lines.filter(l =>
    !l.includes('@') &&
    !l.startsWith('⚠️') &&
    !l.startsWith('http') &&
    !l.startsWith('Website:') &&
    !l.startsWith('LinkedIn:')
  );
  return nonEmailLines[1] || null; // index 0 = name, index 1 = title
}

function classifyTitle(title) {
  if (!title || !title.trim()) return 'no_title';
  const lower = title.toLowerCase();

  // Check approved first
  if (APPROVED_LOWER.some(t => lower.includes(t) || t.includes(lower))) return 'approved';

  // Check fallback
  if (FALLBACK_LOWER.some(t => lower.includes(t) || t.includes(lower))) return 'fallback';

  // Check rejected
  if (REJECTED_LOWER.some(w => lower.includes(w))) return 'rejected';

  return 'unclassified';
}

async function run() {
  console.log('════════════════════════════════════════════════════════════');
  console.log('CONTACT TITLE QUALITY CHECK — Unpushed signals with emails');
  console.log('════════════════════════════════════════════════════════════\n');

  console.log('Fetching unpushed records with emails...');
  let records;
  try {
    records = await query({
      filterByFormula: `AND(
        OR({HubSpot Pushed}=FALSE(), {HubSpot Pushed}=BLANK()),
        NOT({Contact Info} = ""),
        NOT(FIND("${PLACEHOLDER}", {Contact Info}) > 0),
        NOT(FIND("Research Needed", {Contact Info}) > 0),
        NOT(FIND("Contact Needed", {Contact Info}) > 0)
      )`,
      fields: ['Company Name', 'Signal Type', 'Contact Info', 'Send Day'],
    }, 120000);
  } catch (err) {
    console.error('Airtable fetch failed:', err.message);
    process.exit(1);
  }

  // Filter to records that actually have a real email
  const withEmail = records.filter(r => {
    const email = extractEmail(r.fields['Contact Info'] || '');
    return email && !email.includes(PLACEHOLDER);
  });

  console.log(`  Records fetched with real email : ${withEmail.length}\n`);

  const buckets = {
    approved:      [],
    fallback:      [],
    rejected:      [],
    unclassified:  [],
    no_title:      [],
  };

  for (const r of withEmail) {
    const title    = extractTitle(r.fields['Contact Info'] || '');
    const category = classifyTitle(title);
    const company  = r.fields['Company Name'] || '(no company)';
    const sigType  = r.fields['Signal Type']  || '—';
    const sendDay  = r.fields['Send Day']      || '—';
    buckets[category].push({ company, sigType, title: title || '(none)', sendDay, id: r.id });
  }

  // ── Report ─────────────────────────────────────────────────────────────────
  console.log('══════════════════════════════════════════════════════');
  console.log('RESULTS');
  console.log('══════════════════════════════════════════════════════');
  console.log(`✅ Approved titles (primary targets)     : ${buckets.approved.length}`);
  console.log(`🔄 C-Suite fallback (CEO/COO/President)  : ${buckets.fallback.length}`);
  console.log(`⚠️  Rejected titles (wrong function)      : ${buckets.rejected.length}`);
  console.log(`❓ Unclassified (not in any list)         : ${buckets.unclassified.length}`);
  console.log(`—  No title on record                     : ${buckets.no_title.length}`);
  console.log(`──────────────────────────────────────────────────────`);
  console.log(`   TOTAL                                  : ${withEmail.length}`);

  // Breakdown of approved by signal type
  if (buckets.approved.length > 0) {
    const byType = {};
    for (const r of buckets.approved) byType[r.sigType] = (byType[r.sigType] || 0) + 1;
    console.log('\n── Approved — by signal type ───────────────────────');
    for (const [t, c] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${t.padEnd(35)} : ${c}`);
    }
  }

  // Sample of rejected titles so we can see what's slipping through
  if (buckets.rejected.length > 0) {
    console.log('\n── Rejected — sample titles ────────────────────────');
    const seen = new Set();
    let shown = 0;
    for (const r of buckets.rejected) {
      if (shown >= 20) break;
      if (seen.has(r.title)) continue;
      seen.add(r.title);
      console.log(`  ${r.company.padEnd(30)} | ${r.title}`);
      shown++;
    }
  }

  // Sample of unclassified
  if (buckets.unclassified.length > 0) {
    console.log('\n── Unclassified — sample titles ────────────────────');
    const seen = new Set();
    let shown = 0;
    for (const r of buckets.unclassified) {
      if (shown >= 20) break;
      if (seen.has(r.title)) continue;
      seen.add(r.title);
      console.log(`  ${r.company.padEnd(30)} | ${r.title}`);
      shown++;
    }
  }

  console.log('\n══════════════════════════════════════════════════════');
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
