/*
 * scripts/reverify_database.js  (v2 — July 2026)
 *
 * Full database audit + contact discovery.
 * Pulls EVERY Airtable record and sorts into three buckets:
 *
 *   ✅ GOOD        — contact present, title is in our approved list
 *                    → Hunter email verify only (no contact search needed)
 *
 *   ❌ WRONG ROLE  — contact present but title is NOT in approved list
 *                    → Find replacement via apolloFindExec (4-pass) + Hunter cascade
 *                    → Update Contact Info + Status = 'New'
 *                    → If nothing found: Status = 'Needs Review'
 *
 *   🔍 NO CONTACT  — no contact at all (Research Needed / Contact Needed / empty)
 *                    → Find contact via apolloFindExec (4-pass) + Hunter cascade
 *                    → Update Contact Info + Status based on signal Priority field
 *                       Priority HIGH   → Status 'High'
 *                       Priority MEDIUM → Status 'Medium'
 *                       Priority LOW    → Status 'Low'
 *                       No Priority     → Status 'New'
 *
 * MODES:
 *   --preview    No API calls, no writes.
 *                Shows full counts + every company listed per bucket.
 *                Saves a .txt report to .tmp/ for VS Code review.
 *   --dry-run    Runs Apollo + Hunter searches (spends credits), no Airtable writes.
 *   (default)    Full run — searches + writes to Airtable.
 *
 * USAGE:
 *   node scripts/reverify_database.js --preview
 *   node scripts/reverify_database.js --dry-run
 *   node scripts/reverify_database.js
 *
 * RATE LIMITS:
 *   Apollo /people/match: 600ms gap between calls
 *   Hunter endpoints:     500ms gap between calls
 *   Airtable writes:      batched in groups of 10 with built-in gap
 */

import 'dotenv/config';
import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';

import {
  isTitleApproved,
  isTitleCSuite,
  isEmailDomainValid,
  apolloFindExec,
  apolloBroadcastSearch
} from '../execution/workflow_4_save_to_airtable.js';

import { extractDomain } from '../execution/utils/email_enrichment.js';

import { getKnownDomain }                      from '../execution/utils/known_domains.js';
import { findCompanyDomain }                   from '../execution/utils/puppeteer_email_finder.js';
import { isFakeEmail, verifyEmail }            from '../execution/utils/email_validator.js';
import { query, updateRecords }                from '../execution/utils/airtable_client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── Env check ────────────────────────────────────────────────────────────────
if (
  !process.env.APOLLO_API_KEY  ||
  !process.env.HUNTER_API_KEY  ||
  !process.env.AIRTABLE_API_KEY ||
  !process.env.AIRTABLE_BASE_ID
) {
  console.error('[reverify] Missing required env vars: APOLLO_API_KEY, HUNTER_API_KEY, AIRTABLE_API_KEY, AIRTABLE_BASE_ID');
  process.exit(1);
}

const isDryRun  = process.argv.includes('--dry-run');
const isPreview = process.argv.includes('--preview');

// ── Parse the Airtable Contact Info field ────────────────────────────────────
// Returns { name, email, title, website } — any may be null.
// Handles standard pipeline format and "Contact Needed" fallback text.
function parseContactInfo(raw) {
  if (!raw) return { name: null, email: null, title: null, website: null };

  const nameMatch    = raw.match(/^Name:\s*([^\n]+)/im);
  // Strip optional "[unverified]" suffix from email line
  const emailMatch   = raw.match(/^Email:\s*([^\s\n[]+)/im);
  const titleMatch   = raw.match(/^Title:\s*([^\n]+)/im);
  // Handle both "Company Website:" (old pipeline) and "Website:" (Contact Needed fallback)
  const websiteMatch = raw.match(/^(?:Company )?Website:\s*(https?:\/\/\S+)/im);

  return {
    name:    nameMatch    ? nameMatch[1].trim()    : null,
    email:   emailMatch   ? emailMatch[1].trim()   : null,
    title:   titleMatch   ? titleMatch[1].trim()   : null,
    website: websiteMatch ? websiteMatch[1].trim() : null
  };
}

// ── Detect records with no usable contact ────────────────────────────────────
// A record has no contact if it is empty, says "Contact Needed", says "Research Needed",
// or contains no "Name:" line (only a website fallback was written by the pipeline).
function hasNoContact(contactInfo) {
  if (!contactInfo || contactInfo.trim() === '') return true;
  if (/contact needed/i.test(contactInfo))        return true;
  if (/research needed/i.test(contactInfo))       return true;
  return !/^Name:/im.test(contactInfo);
}

// ── Map signal Priority → Status value ───────────────────────────────────────
// When a Research Needed record gets a contact found, reflect the Claude-assigned
// priority from the Priority Airtable field in the Status so Carly can triage easily.
function priorityToStatus(priority) {
  if (!priority) return 'New';
  switch (priority.trim().toUpperCase()) {
    case 'HIGH':   return 'High';
    case 'MEDIUM': return 'Medium';
    case 'LOW':    return 'Low';
    default:       return 'New';
  }
}

// ── Hunter email verifier ─────────────────────────────────────────────────────
async function hunterVerify(email) {
  try {
    const res = await axios.get('https://api.hunter.io/v2/email-verifier', {
      params: { email, api_key: process.env.HUNTER_API_KEY },
      timeout: 12000
    });
    return res.data?.data?.result || 'unknown';
  } catch (err) {
    if (err.response?.status === 422) return 'undeliverable';
    if (err.response?.status === 429) {
      console.warn(`  [Hunter] ⏳ Rate limited — waiting 15s`);
      await new Promise(r => setTimeout(r, 15000));
      return 'unknown';
    }
    console.warn(`  [Hunter] ⚠️  Error for ${email}: ${err.message}`);
    return 'unknown';
  }
}

// ── Apply Hunter email pattern (mirrors pipeline's applyHunterPattern) ────────
function applyPattern(pattern, firstName, lastName, domain) {
  if (!pattern || !firstName || !domain) return null;
  const first = firstName.toLowerCase().replace(/[^a-z]/g, '');
  if (!first) return null;
  const last = (lastName || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!last && (pattern.includes('{last}') || pattern.includes('{l}'))) return null;
  const local = pattern
    .replace('{first}', first)
    .replace('{last}',  last)
    .replace('{f}',     first[0] || '')
    .replace('{l}',     last[0]  || '');
  if (!local || local.includes('{')) return null;
  return `${local}@${domain}`;
}

// ── Hunter email cascade — person-finder → pattern construction ───────────────
// Shared helper used by all three steps in findContact().
// Tries Hunter person-finder (needs first + last name), then email pattern construction.
// Returns a verified email string, or null if nothing found.
async function hunterCascade(firstName, lastName, domain) {
  if (!process.env.HUNTER_API_KEY || !firstName || !domain) return null;

  // Person-finder — requires both first and last name
  if (lastName) {
    try {
      const hRes = await axios.get('https://api.hunter.io/v2/email-finder', {
        params: { domain, first_name: firstName, last_name: lastName, api_key: process.env.HUNTER_API_KEY },
        timeout: 15000
      });
      const { email: hEmail, score } = hRes.data?.data || {};
      if (hEmail && score >= 70 && !isFakeEmail(hEmail)) {
        const { valid } = await verifyEmail(hEmail, 'hunter', null);
        await new Promise(r => setTimeout(r, 400));
        if (valid) {
          console.log(`    [Hunter/Cascade] ✅ ${firstName} ${lastName} → ${hEmail} (score ${score})`);
          return hEmail;
        }
        console.log(`    [Hunter/Cascade] ❌ ${hEmail} failed verification — trying pattern...`);
      } else if (hEmail) {
        console.log(`    [Hunter/Cascade] ⚠️  ${hEmail} rejected (score ${score || 'n/a'}) — trying pattern...`);
      } else {
        console.log(`    [Hunter/Cascade] ℹ️  No email for ${firstName} ${lastName} — trying pattern...`);
      }
    } catch (err) {
      if (err.response?.status !== 400) console.warn(`    [Hunter/Cascade] Person-finder error: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 400));
  }

  // Pattern construction — build and verify an email from Hunter's known pattern
  if (lastName) {
    try {
      const patRes = await axios.get('https://api.hunter.io/v2/domain-search', {
        params: { domain, api_key: process.env.HUNTER_API_KEY },
        timeout: 15000
      });
      const pattern = patRes.data?.data?.pattern;
      if (pattern) {
        const constructed = applyPattern(pattern, firstName, lastName, domain);
        if (constructed && !isFakeEmail(constructed)) {
          console.log(`    [Hunter/Cascade] Pattern "${pattern}" → ${constructed} — verifying...`);
          const { valid } = await verifyEmail(constructed, 'hunter', null);
          await new Promise(r => setTimeout(r, 400));
          if (valid) {
            console.log(`    [Hunter/Cascade] ✅ ${firstName} ${lastName} → ${constructed}`);
            return constructed;
          }
          console.log(`    [Hunter/Cascade] ❌ ${constructed} failed verification`);
        }
      } else {
        console.log(`    [Hunter/Cascade] ℹ️  No email pattern at ${domain}`);
      }
    } catch (err) {
      if (err.response?.status !== 429) console.warn(`    [Hunter/Cascade] Domain-search error: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 400));
  }

  return null;
}

// ── Find a contact — mirrors the live pipeline exactly ────────────────────────
//
// Step 1: apolloFindExec (4-pass selection + POST /people/match email unlock)
//         person_locations: ['United States'], q_organization_domains, per_page: 10
//         Pass 1: marketing title + has_email  → unlock + verify
//         Pass 2: marketing title, no email    → Hunter cascade
//         Pass 3: C-suite + has_email          → unlock + verify
//         Pass 4: C-suite, no email            → Hunter cascade
//
// Step 2: apolloBroadcastSearch (when apolloFindExec finds nobody)
//         Same search params as Step 1 — returns up to 10 contacts.
//         Emails already unlocked via POST /people/match inside broadcast.
//         Pick best: isTitleApproved first, isTitleCSuite fallback.
//         If email present: verify. If not: Hunter cascade.
//
// Step 3: Hunter domain-search (when both Apollo searches exhausted)
//         Uses isTitleApproved/isTitleCSuite — NOT keyword substring matching.
//
// Returns { name, title, email, linkedin_url } or null.
async function findContact(domain, _companyName, signalType) {
  if (!domain) return null;
  const type = signalType || 'Brand Strategy Intent';

  // ── Step 1: apolloFindExec ───────────────────────────────────────────────
  console.log(`  [FindContact] Step 1 — apolloFindExec at ${domain}...`);
  let exec = null;
  try { exec = await apolloFindExec(domain, type); } catch (e) { console.warn(`  [FindContact] apolloFindExec error: ${e.message}`); }
  await new Promise(r => setTimeout(r, 600));

  if (exec?.firstName) {
    const fullName = `${exec.firstName} ${exec.lastName || ''}`.trim();

    // Apollo unlocked an email via POST /people/match
    if (exec.email && !isFakeEmail(exec.email)) {
      const src = exec.emailStatus ? 'apollo' : 'hunter';
      const { valid } = await verifyEmail(exec.email, src, exec.emailStatus || null);
      await new Promise(r => setTimeout(r, 400));
      if (valid) {
        console.log(`  [FindContact] ✅ Step 1 (apolloFindExec): ${fullName} (${exec.title}) → ${exec.email}`);
        return { name: fullName, title: exec.title, email: exec.email, linkedin_url: exec.linkedin_url };
      }
      console.log(`  [FindContact] ❌ Apollo email ${exec.email} failed verification — Hunter cascade`);
    }

    // Name found but no email (or email failed) — Hunter cascade
    const hEmail = await hunterCascade(exec.firstName, exec.lastName, domain);
    if (hEmail) {
      console.log(`  [FindContact] ✅ Step 1 (Hunter cascade): ${fullName} (${exec.title}) → ${hEmail}`);
      return { name: fullName, title: exec.title, email: hEmail, linkedin_url: exec.linkedin_url };
    }

    // No email path worked — LinkedIn-only if available
    if (exec.linkedin_url) {
      console.log(`  [FindContact] ℹ️  Step 1: ${fullName} (${exec.title}) — no email, LinkedIn only`);
      return { name: fullName, title: exec.title, email: null, linkedin_url: exec.linkedin_url };
    }
  }

  // ── Step 2: apolloBroadcastSearch ────────────────────────────────────────
  // apolloFindExec found nobody — go broader.
  // Broadcast searches all approved titles + C-suite, unlocks emails via POST /people/match.
  // This is what found contacts that showed as "Research Needed" in testing.
  console.log(`  [FindContact] Step 2 — apolloBroadcastSearch at ${domain}...`);
  let broadcastContacts = [];
  try { broadcastContacts = await apolloBroadcastSearch(domain); } catch (e) { console.warn(`  [FindContact] broadcast error: ${e.message}`); }
  await new Promise(r => setTimeout(r, 600));

  if (broadcastContacts.length > 0) {
    // Prefer marketing/brand title (isTitleApproved) over C-suite (isTitleCSuite)
    const pick =
      broadcastContacts.find(c => isTitleApproved(c.title)) ||
      broadcastContacts.find(c => isTitleCSuite(c.title))   ||
      broadcastContacts[0];

    const fullName = `${pick.firstName} ${pick.lastName || ''}`.trim();

    // Broadcast already ran POST /people/match — just verify the email
    if (pick.email && !isFakeEmail(pick.email)) {
      const src = pick.email_status ? 'apollo' : 'hunter';
      const { valid } = await verifyEmail(pick.email, src, pick.email_status || null);
      await new Promise(r => setTimeout(r, 400));
      if (valid) {
        console.log(`  [FindContact] ✅ Step 2 (broadcast): ${fullName} (${pick.title}) → ${pick.email}`);
        return { name: fullName, title: pick.title, email: pick.email, linkedin_url: pick.linkedin_url };
      }
      console.log(`  [FindContact] ❌ Broadcast email ${pick.email} failed verification — Hunter cascade`);
    }

    // No email from broadcast — Hunter cascade
    const hEmail = await hunterCascade(pick.firstName, pick.lastName, domain);
    if (hEmail) {
      console.log(`  [FindContact] ✅ Step 2 (broadcast+Hunter): ${fullName} (${pick.title}) → ${hEmail}`);
      return { name: fullName, title: pick.title, email: hEmail, linkedin_url: pick.linkedin_url };
    }

    if (pick.linkedin_url) {
      console.log(`  [FindContact] ℹ️  Step 2: ${fullName} (${pick.title}) — no email, LinkedIn only`);
      return { name: fullName, title: pick.title, email: null, linkedin_url: pick.linkedin_url };
    }
  }

  // ── Step 3: Hunter domain-search ─────────────────────────────────────────
  // Both Apollo searches exhausted. Hunter domain-search as last resort.
  // Uses isTitleApproved/isTitleCSuite — NOT substring keyword matching.
  // (Old approach used HUNTER_EXEC_TITLE_KEYWORDS.includes('president') which
  //  is a substring of 'vice president', letting wrong-role contacts through.)
  if (process.env.HUNTER_API_KEY) {
    console.log(`  [FindContact] Step 3 — Hunter domain-search at ${domain}...`);
    try {
      const hDomRes = await axios.get('https://api.hunter.io/v2/domain-search', {
        params: { domain, api_key: process.env.HUNTER_API_KEY },
        timeout: 15000
      });
      const emails = hDomRes.data?.data?.emails || [];
      // Marketing/brand titles first, C-suite as fallback
      const pick =
        emails.find(e => e.first_name && isTitleApproved(e.position)) ||
        emails.find(e => e.first_name && isTitleCSuite(e.position));

      if (pick?.value && !isFakeEmail(pick.value)) {
        const { valid } = await verifyEmail(pick.value, 'hunter', null);
        await new Promise(r => setTimeout(r, 400));
        if (valid) {
          const name = `${pick.first_name} ${pick.last_name || ''}`.trim();
          console.log(`  [FindContact] ✅ Step 3 (Hunter domain): ${name} (${pick.position || 'no title'}) → ${pick.value}`);
          return { name, title: pick.position || null, email: pick.value, linkedin_url: pick.linkedin || null };
        }
      }
    } catch (err) {
      console.warn(`  [FindContact] Hunter domain-search error: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 400));
  }

  console.log(`  [FindContact] ✗ No contact found at ${domain} after all three steps`);
  return null;
}

// ── Resolve domain for a no-contact record ────────────────────────────────────
// Order: website in Contact Info → known_domains lookup → Puppeteer discovery
async function resolveDomain(companyName, website) {
  if (website) {
    const d = extractDomain(website);
    if (d) return d;
  }
  const known = getKnownDomain(companyName);
  if (known) return known;
  // Puppeteer — slower but handles companies not in known_domains
  const found = await findCompanyDomain(companyName);
  return found || null;
}

// ── Build Contact Info string (same format as pipeline) ──────────────────────
function buildContactInfo(name, title, email, linkedin_url) {
  const lines = [];
  if (name)         lines.push(`Name: ${name}`);
  if (title)        lines.push(`Title: ${title}`);
  if (email)        lines.push(`Email: ${email}`);
  if (linkedin_url) lines.push(`LinkedIn: ${linkedin_url}`);
  return lines.join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
  const modeLabel = isPreview ? 'PREVIEW (no API calls, no writes)'
                  : isDryRun  ? 'DRY RUN (API calls, no Airtable writes)'
                  :             'LIVE (writes to Airtable)';

  // Tee console.log to buffer in preview mode so the full report isn't lost to scrollback
  let previewBuffer = [];
  const origLog = console.log.bind(console);
  if (isPreview) {
    console.log = (...args) => {
      const msg = args.map(a => String(a)).join(' ');
      origLog(msg);
      previewBuffer.push(msg);
    };
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log('STARFISH DATABASE AUDIT & CONTACT DISCOVERY');
  console.log(`Mode: ${modeLabel}`);
  console.log(`${'─'.repeat(60)}\n`);

  // ── Pull ALL records from Airtable ────────────────────────────────────────
  let records;
  try {
    records = await query({
      fields: ['Company Name', 'Signal Type', 'Contact Info', 'Email Verified', 'Status', 'Priority']
    });
  } catch (err) {
    console.error(`[reverify] Failed to fetch Airtable records: ${err.message}`);
    process.exit(1);
  }

  console.log(`Total records in database: ${records.length}\n`);

  // ── Categorize every record into one of three buckets ─────────────────────
  const good      = [];  // approved title  → Hunter email verify only
  const wrongRole = [];  // unapproved title → find replacement contact
  const noContact = [];  // no contact at all → find contact from scratch

  for (const record of records) {
    const companyName = record.get('Company Name') || 'Unknown';
    const contactInfo = record.get('Contact Info') || '';
    const signalType  = record.get('Signal Type')  || '';
    const status      = record.get('Status')       || '';
    const priority    = record.get('Priority')     || '';
    const { name, email, title, website } = parseContactInfo(contactInfo);

    if (hasNoContact(contactInfo)) {
      noContact.push({ record, companyName, signalType, status, priority, website });
      continue;
    }

    if (title) {
      const approved = isTitleApproved(title) || isTitleCSuite(title);
      if (approved) {
        good.push({ record, companyName, email, title, website, signalType });
      } else {
        wrongRole.push({ record, companyName, name, email, title, website, signalType, priority });
      }
    } else {
      // Has a contact (Name: line present) but no Title: line — treat as good,
      // no title to reject. Still runs Hunter verify if email present.
      good.push({ record, companyName, email, title: null, website, signalType });
    }
  }

  // ── PREVIEW REPORT ────────────────────────────────────────────────────────
  const SEP = '─'.repeat(60);

  console.log(SEP);
  console.log(`✅ GOOD — approved title (${good.length} records)`);
  console.log(SEP);
  for (const r of good) {
    const emailVerified = r.record.get('Email Verified') || 'Unverified';
    console.log(`  ${r.companyName}${r.title ? ` | ${r.title}` : ' | (no title)'}${r.email ? ` | ${r.email}` : ' | (no email)'} | ${emailVerified}`);
  }

  console.log('');
  console.log(SEP);
  console.log(`❌ WRONG ROLE — title not in approved list (${wrongRole.length} records)`);
  console.log(SEP);
  // Group by title so you can see patterns at a glance
  const byTitle = {};
  for (const r of wrongRole) {
    const t = r.title || '(no title)';
    if (!byTitle[t]) byTitle[t] = [];
    byTitle[t].push(r.companyName);
  }
  for (const [title, companies] of Object.entries(byTitle).sort()) {
    console.log(`  "${title}":`);
    for (const c of companies) console.log(`    - ${c}`);
  }

  console.log('');
  console.log(SEP);
  console.log(`🔍 NO CONTACT — Research/Contact Needed (${noContact.length} records)`);
  console.log(SEP);
  for (const r of noContact) {
    console.log(`  ${r.companyName} | ${r.signalType || 'Unknown'} | Priority: ${r.priority || 'n/a'} | Status: ${r.status || 'n/a'}`);
  }

  console.log('');
  console.log(SEP);
  console.log('SUMMARY');
  console.log(SEP);
  console.log(`Total records:          ${records.length}`);
  console.log(`✅ Good (approved):     ${good.length}`);
  console.log(`❌ Wrong Role:          ${wrongRole.length}  ← need replacement contact`);
  console.log(`🔍 No Contact:          ${noContact.length}  ← need contact found from scratch`);
  console.log(SEP);

  // ── Save preview report to file ───────────────────────────────────────────
  if (isPreview) {
    console.log = origLog;
    const reportPath = path.resolve(__dirname, '../.tmp', `audit_report_${new Date().toISOString().split('T')[0]}.txt`);
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, previewBuffer.join('\n') + '\n');
    origLog(`\n📄 Full audit report saved to:\n   ${reportPath}\n   Open in VS Code to review every record.\n`);
    return;
  }

  // ── LIVE / DRY-RUN: process each category ────────────────────────────────
  const updates = [];

  // ── 1. WRONG ROLE — find replacement contacts ─────────────────────────────
  if (wrongRole.length > 0) {
    console.log(`\n${SEP}`);
    console.log(`PROCESSING ${wrongRole.length} WRONG-ROLE RECORD(S)...`);
    console.log(SEP);
  }

  const wrStats = { replaced: 0, needsReview: 0, skipped: 0 };

  for (const r of wrongRole) {
    console.log(`\n[WrongRole] ${r.companyName}`);
    console.log(`  Current title: "${r.title}"`);

    // Determine domain: email domain first, then website, then discovery
    let domain = null;
    if (r.email) domain = r.email.split('@')[1] || null;
    if (!domain) domain = await resolveDomain(r.companyName, r.website);
    if (!domain) {
      console.log(`  ⚠️  Cannot determine domain — skipping`);
      wrStats.skipped++;
      continue;
    }

    const contact = await findContact(domain, r.companyName, r.signalType);

    if (contact && (contact.email || contact.linkedin_url)) {
      console.log(`  ✅ Replacement: ${contact.name} (${contact.title || 'no title'}) → ${contact.email || 'LinkedIn only'}`);
      wrStats.replaced++;
      if (!isDryRun) {
        updates.push({
          id:     r.record.id,
          fields: {
            'Contact Info':   buildContactInfo(contact.name, contact.title, contact.email, contact.linkedin_url),
            'Email Verified': contact.email ? 'Unverified' : '',
            'Status':         'New'
          }
        });
      }
    } else {
      console.log(`  ✗ No replacement found — marking Needs Review`);
      wrStats.needsReview++;
      if (!isDryRun) {
        updates.push({ id: r.record.id, fields: { 'Status': 'Needs Review' } });
      }
    }
    await new Promise(r => setTimeout(r, 500));
  }

  // ── 2. NO CONTACT — find contacts from scratch ────────────────────────────
  if (noContact.length > 0) {
    console.log(`\n${SEP}`);
    console.log(`PROCESSING ${noContact.length} NO-CONTACT RECORD(S)...`);
    console.log(SEP);
  }

  const ncStats = { found: 0, notFound: 0, skipped: 0 };

  for (const r of noContact) {
    console.log(`\n[NoContact] ${r.companyName} (${r.signalType || 'Unknown type'}) | Priority: ${r.priority || 'n/a'}`);

    const domain = await resolveDomain(r.companyName, r.website);
    if (!domain) {
      console.log(`  ⚠️  Cannot determine domain — skipping`);
      ncStats.skipped++;
      continue;
    }

    const contact = await findContact(domain, r.companyName, r.signalType);

    if (contact && (contact.email || contact.linkedin_url)) {
      const newStatus = priorityToStatus(r.priority);
      console.log(`  ✅ Found: ${contact.name} (${contact.title || 'no title'}) → ${contact.email || 'LinkedIn only'}`);
      console.log(`  Status → ${newStatus} (from Priority: ${r.priority || 'none'})`);
      ncStats.found++;
      if (!isDryRun) {
        updates.push({
          id:     r.record.id,
          fields: {
            'Contact Info':   buildContactInfo(contact.name, contact.title, contact.email, contact.linkedin_url),
            'Email Verified': contact.email ? 'Unverified' : '',
            'Status':         newStatus
          }
        });
      }
    } else {
      console.log(`  ✗ No contact found — leaving as Research Needed`);
      ncStats.notFound++;
    }
    await new Promise(r => setTimeout(r, 500));
  }

  // ── 3. GOOD CONTACTS — Hunter email verification ──────────────────────────
  // Only run on contacts whose email hasn't been verified yet.
  const needsVerify = good.filter(r => r.email && r.record.get('Email Verified') !== 'Verified');

  if (needsVerify.length > 0) {
    console.log(`\n${SEP}`);
    console.log(`VERIFYING ${needsVerify.length} APPROVED CONTACT EMAIL(S)...`);
    console.log(SEP);
  }

  const vStats = { verified: 0, risky: 0, undeliverable: 0, unknown: 0 };

  for (const r of needsVerify) {
    // Domain validation first — catch emails from wrong company
    if (r.website && !isEmailDomainValid(r.email, r.website)) {
      console.log(`\n[Verify] ${r.companyName} — ✗ domain mismatch: ${r.email} vs ${r.website} — marking Needs Review`);
      if (!isDryRun) {
        updates.push({ id: r.record.id, fields: { 'Status': 'Needs Review', 'Email Verified': 'Unverified' } });
      }
      continue;
    }

    console.log(`\n[Verify] ${r.companyName} — ${r.email}`);
    const result = await hunterVerify(r.email);
    console.log(`  Hunter: ${result}`);

    let emailVerifiedValue;
    let markNeedsReview = false;
    switch (result) {
      case 'deliverable':
        emailVerifiedValue = 'Verified';
        vStats.verified++;
        break;
      case 'risky':
        emailVerifiedValue = 'Risky (Flagged)';
        vStats.risky++;
        break;
      case 'undeliverable':
        emailVerifiedValue = 'Unverified';
        markNeedsReview    = true;
        vStats.undeliverable++;
        break;
      default:
        emailVerifiedValue = 'Unverified';
        vStats.unknown++;
        break;
    }

    if (!isDryRun) {
      const fields = { 'Email Verified': emailVerifiedValue };
      if (markNeedsReview) fields['Status'] = 'Needs Review';
      updates.push({ id: r.record.id, fields });
    }
    await new Promise(r => setTimeout(r, 500));
  }

  // ── Write all Airtable updates ────────────────────────────────────────────
  if (!isDryRun && updates.length > 0) {
    console.log(`\nWriting ${updates.length} Airtable update(s)...`);
    try {
      await updateRecords(updates);
      console.log('✅ All updates written successfully');
    } catch (err) {
      console.error(`❌ Airtable write error: ${err.message}`);
      console.error('Some records may not have been updated. Re-run the script to retry.');
    }
  } else if (isDryRun) {
    console.log(`\n[DRY RUN] Would have written ${updates.length} Airtable update(s)`);
  }

  // ── Final summary ─────────────────────────────────────────────────────────
  console.log(`\n${SEP}`);
  console.log(`COMPLETE${isDryRun ? ' (DRY RUN)' : ''}`);
  console.log(SEP);
  console.log(`Total records:              ${records.length}`);
  console.log('');
  console.log(`❌ Wrong Role (${wrongRole.length}):`);
  console.log(`   Replaced:               ${wrStats.replaced}`);
  console.log(`   Needs Review:           ${wrStats.needsReview}`);
  console.log(`   Skipped (no domain):    ${wrStats.skipped}`);
  console.log('');
  console.log(`🔍 No Contact (${noContact.length}):`);
  console.log(`   Contact found:          ${ncStats.found}`);
  console.log(`   Still not found:        ${ncStats.notFound}`);
  console.log(`   Skipped (no domain):    ${ncStats.skipped}`);
  console.log('');
  console.log(`✅ Good Contacts — email verification (${needsVerify.length} ran):`);
  console.log(`   Verified:               ${vStats.verified}`);
  console.log(`   Risky (Flagged):        ${vStats.risky}`);
  console.log(`   Undeliverable:          ${vStats.undeliverable}`);
  console.log(`   Unknown:                ${vStats.unknown}`);
  console.log(SEP);
}

run().catch(err => {
  console.error('[reverify] Fatal error:', err.message);
  process.exit(1);
});
