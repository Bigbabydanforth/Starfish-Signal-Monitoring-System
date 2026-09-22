/**
 * scripts/enrich_rebrand_skipped.js
 *
 * Finds the 17 Rebrand contacts that were skipped during reroute (claude group,
 * no first name in Airtable Contact Info), enriches them with real names using:
 *
 *   1. HubSpot firstname/lastname  — already pushed, may have name stored
 *   2. Apollo /people/match        — email lookup, returns name + title
 *   3. Email pattern parsing       — first.last@, flast@, first@  → guessed name
 *
 * Also audits each record for missing fields (Brief, Industry, Company Website).
 *
 * In --fix mode: updates Airtable Contact Info with found name + title,
 * then re-runs enrollment into the Rebrand claude sequence.
 *
 * Run:
 *   node --env-file=.env scripts/enrich_rebrand_skipped.js              (scan — no changes)
 *   node --env-file=.env scripts/enrich_rebrand_skipped.js --fix        (update Airtable)
 */

import 'dotenv/config';
import axios from 'axios';
import { query, updateRecords } from '../execution/utils/airtable_client.js';
import { generateClaudeEmails } from '../hubspot/generateClaudeEmails.js';
import { SENDER_CONFIGS }       from '../hubspot/sequenceRouting.js';

const FIX          = process.argv.includes('--fix');
const HS_TOKEN     = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
const HS_BASE      = 'https://api.hubapi.com';
const APOLLO_BASE  = process.env.APOLLO_API_URL || 'https://api.apollo.io/v1';
const APOLLO_KEY   = process.env.APOLLO_API_KEY;

const REBRAND_CLAUDE_SEQ   = process.env.HS_SEQ_REBRAND_CLAUDE   || '310704131';
const SENDER_EMAIL         = process.env.ZACK_SENDER_EMAIL        || 'zack@starfishco.com';
const SENDER_USER_ID       = process.env.ZACK_HUBSPOT_OWNER_ID    || null;
const SENDER_CONFIG        = SENDER_CONFIGS[SENDER_EMAIL]         || { firstName: 'Zack', meetingLink: null };

function pause(ms) { return new Promise(r => setTimeout(r, ms)); }

function extractEmail(ci) {
  if (!ci) return null;
  const m = ci.match(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/);
  return m ? m[0].toLowerCase() : null;
}

function parseContactName(ci) {
  if (!ci) return '';
  function stripLabel(line) {
    return line.replace(/^(name|title|email|linkedin)\s*:\s*/i, '').trim();
  }
  const lines = ci.split('\n').map(l => l.trim()).filter(l =>
    l && !l.startsWith('⚠️') && !l.startsWith('http') &&
    !l.startsWith('Website:') && !l.startsWith('LinkedIn:')
  );
  for (const line of lines) {
    const clean = stripLabel(line);
    if (clean.includes('@')) continue;
    return clean;
  }
  return '';
}

// ── Email pattern parsing ─────────────────────────────────────────────────────
// Attempts to extract a real name from the email local part.
// Returns { firstName, lastName, source } or null if pattern doesn't match.
function parseNameFromEmail(email) {
  if (!email) return null;
  const local = email.split('@')[0].toLowerCase();

  // Skip generic addresses
  const GENERIC = ['info', 'contact', 'hello', 'admin', 'support', 'noreply',
                   'director', 'president', 'corporatecommunications', 'communications',
                   'marketing', 'hr', 'sales', 'team'];
  if (GENERIC.some(g => local === g || local.startsWith(g + '.') || local.startsWith(g + '_'))) {
    return null;
  }

  const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  // first.last or first-last
  const dotOrDash = local.match(/^([a-z]+)[.\-]([a-z]+)$/);
  if (dotOrDash) {
    return {
      firstName: capitalize(dotOrDash[1]),
      lastName:  capitalize(dotOrDash[2]),
      source:    'email pattern (first.last)',
    };
  }

  // firstlast — harder to split, skip unless short enough
  // flast (single letter + last name) — e.g. fbentley, jjohnson, mflores, mtrudeau
  const fLast = local.match(/^([a-z])([a-z]{3,})$/);
  if (fLast) {
    return {
      firstName: fLast[1].toUpperCase() + '.',
      lastName:  capitalize(fLast[2]),
      source:    'email pattern (f+last)',
    };
  }

  // first name only (single word, e.g. megan, cosmo, darren)
  if (/^[a-z]{3,}$/.test(local)) {
    return {
      firstName: capitalize(local),
      lastName:  '',
      source:    'email pattern (first only)',
    };
  }

  return null;
}

// ── HubSpot helpers ───────────────────────────────────────────────────────────
async function hsRequest(method, endpoint, data = null) {
  const cfg = {
    method,
    url:     `${HS_BASE}${endpoint}`,
    headers: { Authorization: `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' },
    timeout: 15000,
  };
  if (data) cfg.data = data;
  return axios(cfg);
}

async function findHubSpotContact(email) {
  try {
    const res = await hsRequest('POST', '/crm/v3/objects/contacts/search', {
      filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
      properties:   ['email', 'firstname', 'lastname', 'jobtitle', 'company', 'hs_sequences_is_enrolled', 'signal_data', 'ab_test_group'],
      limit: 1,
    });
    return res.data.results?.[0] || null;
  } catch {
    return null;
  }
}

async function enrollInSequence(contactId, sequenceId) {
  try {
    await hsRequest('POST', `/automation/v4/sequences/enrollments?userId=${SENDER_USER_ID}`, {
      sequenceId, contactId, senderEmail: SENDER_EMAIL,
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.response?.data?.message || err.message };
  }
}

// ── Apollo people/match by email ──────────────────────────────────────────────
async function apolloLookupByEmail(email) {
  if (!APOLLO_KEY) return null;
  try {
    const res = await axios.post(`${APOLLO_BASE}/people/match`, {
      email,
      reveal_personal_emails: false,
    }, {
      headers: { 'X-Api-Key': APOLLO_KEY, 'Content-Type': 'application/json' },
      timeout: 15000,
    });
    const person = res.data?.person || {};
    if (!person.first_name && !person.last_name) return null;
    return {
      firstName: person.first_name || '',
      lastName:  person.last_name  || '',
      title:     person.title      || '',
      source:    'Apollo',
    };
  } catch (err) {
    const status = err.response?.status;
    if (status !== 422 && status !== 404) {
      console.log(`    [Apollo] Error for ${email}: ${err.response?.data?.message || err.message}`);
    }
    return null;
  }
}

// ── Token substitution ────────────────────────────────────────────────────────
function substituteTokens(text, { contactFirstName, contactCompany, meetingLink }) {
  if (!text) return text;
  return text
    .replace(/\{\{\s*contact\.firstname\s*\}\}/gi,   contactFirstName || 'there')
    .replace(/\{\{\s*contact\.first_name\s*\}\}/gi,  contactFirstName || 'there')
    .replace(/\{\{\s*contact\.company\s*\}\}/gi,     contactCompany   || 'your company')
    .replace(/\{\{\s*sender\.firstname\s*\}\}/gi,    '') // removed — sign-off is "Best," only
    .replace(/\{\{\s*owner\.meetings_link\s*\}\}/gi, meetingLink      || '')
    .replace(/\{\{\s*TargetCo\s*\}\}/gi,             'the acquired company')
    .replace(/\{\{\s*Sector\s*\}\}/gi,               'your category')
    // Sign-off guard: strip any sender name after "Best," — belt-and-suspenders.
    .replace(/\nBest,[ \t]*\n\s*[A-Z][a-z]+\s*$/, '\nBest,');
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
  if (!HS_TOKEN) { console.error('HUBSPOT_PRIVATE_APP_TOKEN not set'); process.exit(1); }

  console.log('════════════════════════════════════════════════════════════');
  console.log('REBRAND SKIPPED — NAME ENRICHMENT');
  console.log(`Mode : ${FIX ? 'FIX — updating Airtable + enrolling' : 'SCAN — no changes'}`);
  console.log('════════════════════════════════════════════════════════════\n');

  // Fetch all pushed Rebrand records
  console.log('Fetching pushed Rebrand records from Airtable...');
  let records;
  try {
    records = await query({
      filterByFormula: `AND({Signal Type} = "Rebrand", {HubSpot Pushed} = TRUE())`,
      fields: [
        'Company Name', 'Signal Type', 'Contact Info', 'AB Test Group',
        'Industry', 'Brief', 'Signal Details', 'Company Website',
        'Acquired Company', 'Bespoke', 'Send Day',
      ],
    }, 60000);
  } catch (err) {
    console.error('Airtable fetch failed:', err.message);
    process.exit(1);
  }

  // Find the ones with no parseable first name — these are our 17
  const skipped = records.filter(r => {
    const name = parseContactName(r.fields['Contact Info'] || '');
    const parts = name.split(/\s+/).filter(Boolean);
    return !parts[0]; // no first name
  });

  console.log(`  Total pushed Rebrand records : ${records.length}`);
  console.log(`  Missing first name           : ${skipped.length}\n`);

  if (skipped.length === 0) {
    console.log('✓ All Rebrand contacts have names — nothing to enrich.');
    return;
  }

  // ── Enrich each contact ───────────────────────────────────────────────────
  const results = [];

  for (let i = 0; i < skipped.length; i++) {
    const record  = skipped[i];
    const f       = record.fields;
    const company = f['Company Name'] || '';
    const email   = extractEmail(f['Contact Info'] || '');
    const abGroup = f['AB Test Group'] || 'starfish';

    console.log(`[${i + 1}/${skipped.length}] ${company}`);
    console.log(`  Email    : ${email || '—'}`);
    console.log(`  AB group : ${abGroup}`);

    // Missing field audit
    const missing = [];
    if (!f['Brief']           || !f['Brief'].trim())           missing.push('Brief');
    if (!f['Signal Details']  || !f['Signal Details'].trim())  missing.push('Signal Details');
    if (!f['Industry']        || !f['Industry'].trim())        missing.push('Industry');
    if (!f['Company Website'] || !f['Company Website'].trim()) missing.push('Company Website');
    if (missing.length > 0) console.log(`  Missing  : ${missing.join(', ')}`);

    if (!email) {
      console.log('  ✗ No email in Contact Info — cannot look up\n');
      results.push({ record, company, email: null, found: null, missing });
      continue;
    }

    let found = null;

    // Source 1: HubSpot
    const hsContact = await findHubSpotContact(email);
    await pause(200);
    if (hsContact?.properties?.firstname) {
      found = {
        firstName: hsContact.properties.firstname || '',
        lastName:  hsContact.properties.lastname  || '',
        title:     hsContact.properties.jobtitle  || '',
        source:    'HubSpot',
        hsId:      hsContact.id,
        isEnrolled: hsContact.properties.hs_sequences_is_enrolled === 'true',
      };
    }

    // Source 2: Apollo
    if (!found && APOLLO_KEY) {
      console.log('  [Apollo] Looking up by email...');
      const apolloResult = await apolloLookupByEmail(email);
      await pause(300);
      if (apolloResult) {
        found = { ...apolloResult, hsId: hsContact?.id, isEnrolled: hsContact?.properties?.hs_sequences_is_enrolled === 'true' };
      }
    }

    // Source 3: Email pattern
    if (!found) {
      const parsed = parseNameFromEmail(email);
      if (parsed) {
        found = {
          ...parsed,
          title:     '',
          hsId:      hsContact?.id,
          isEnrolled: hsContact?.properties?.hs_sequences_is_enrolled === 'true',
        };
      }
    }

    if (found) {
      const fullName = [found.firstName, found.lastName].filter(Boolean).join(' ');
      console.log(`  ✓ Found  : ${fullName}${found.title ? ` / ${found.title}` : ''} (via ${found.source})`);
    } else {
      console.log('  ✗ No name found from any source');
    }

    results.push({ record, company, email, found, missing, hsContact });
    console.log('');
    await pause(300);
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const withName    = results.filter(r => r.found);
  const withoutName = results.filter(r => !r.found);
  const needsData   = results.filter(r => r.missing.length > 0);

  console.log('════════════════════════════════════════════════════════════');
  console.log('SCAN RESULTS');
  console.log('════════════════════════════════════════════════════════════');
  console.log(`  Total skipped contacts  : ${results.length}`);
  console.log(`  Names found             : ${withName.length}`);
  console.log(`  Names NOT found         : ${withoutName.length}`);
  console.log(`  Records missing fields  : ${needsData.length}`);

  if (withName.length > 0) {
    console.log('\n── Names found ───────────────────────────────────────────');
    for (const r of withName) {
      const fullName = [r.found.firstName, r.found.lastName].filter(Boolean).join(' ');
      console.log(`  ${(r.company).padEnd(30)} | ${fullName.padEnd(22)} | via ${r.found.source}`);
      if (r.found.title) console.log(`  ${''.padEnd(30)}   ${r.found.title}`);
    }
  }

  if (withoutName.length > 0) {
    console.log('\n── Names still missing ───────────────────────────────────');
    for (const r of withoutName) {
      console.log(`  ${(r.company).padEnd(30)} | ${r.email || '(no email)'}`);
    }
  }

  if (needsData.length > 0) {
    console.log('\n── Missing field details ─────────────────────────────────');
    for (const r of needsData) {
      console.log(`  ${(r.company).padEnd(30)} | missing: ${r.missing.join(', ')}`);
    }
  }

  if (!FIX) {
    console.log(`\nRun with --fix to update Airtable and enroll ${withName.length} contact(s) in Rebrand claude sequence.`);
    return;
  }

  // ── FIX MODE ─────────────────────────────────────────────────────────────
  console.log(`\n\nFixing ${withName.length} contacts with found names...\n`);
  const generatedAt = new Date().toISOString();
  let fixed = 0, failed = 0;

  for (const { record, company, email, found, hsContact } of withName) {
    const f         = record.fields;
    const firstName = found.firstName.replace(/\.$/, '');
    const fullName  = [found.firstName, found.lastName].filter(Boolean).join(' ');

    console.log(`${company} — ${email}`);
    console.log(`  Name  : ${fullName}${found.title ? ` / ${found.title}` : ''}`);

    // Build new Contact Info block
    const ciLines = [];
    if (fullName)    ciLines.push(fullName);
    if (found.title) ciLines.push(found.title);
    if (email)       ciLines.push(email);
    const newContactInfo = ciLines.join('\n');

    // ── Branch: already rerouted vs. not yet rerouted ─────────────────────
    const alreadyRerouted = hsContact?.properties?.signal_data === 'rebrand';

    if (alreadyRerouted) {
      // Already in the correct sequence (starfish or claude).
      // Just update Airtable Contact Info with the found name.
      // Also patch HubSpot firstname if it's currently blank so sequences resolve {{contact.firstname}}.
      if (found.hsId && !hsContact.properties?.firstname) {
        try {
          await hsRequest('PATCH', `/crm/v3/objects/contacts/${found.hsId}`, {
            properties: { firstname: found.firstName, lastname: found.lastName || '' },
          });
          console.log(`  ✓ HubSpot firstname patched (id: ${found.hsId})`);
        } catch (err) {
          console.log(`  ⚠️  HubSpot PATCH failed: ${err.response?.data?.message || err.message}`);
        }
        await pause(300);
      }
      try {
        await updateRecords([{ id: record.id, fields: { 'Contact Info': newContactInfo } }]);
        console.log('  ✓ Airtable Contact Info updated (already rerouted — no enrollment change)');
        fixed++;
      } catch (err) {
        console.log(`  ✗ Airtable update failed: ${err.message}`);
        failed++;
      }
      console.log('');
      continue;
    }

    // Not yet rerouted — these are the contacts the reroute script skipped because they
    // were assigned to the claude group (by index) but had no first name at the time.
    // Now that we have names, treat them all as claude.
    // Claude group: generate emails, update HubSpot, enroll in claude sequence
    const signal = {
      type:             'Rebrand',
      signal_type:      'Rebrand',
      company_name:     company,
      company:          { name: company, industry: f['Industry'] || '', website: f['Company Website'] || null },
      industry:         f['Industry'] || '',
      brief:            f['Brief']          || '',
      signal_details:   f['Signal Details'] || '',
      acquired_company: f['Acquired Company'] || null,
      bespoke:          f['Bespoke'] === true,
    };
    const contact = {
      name:       fullName,
      firstName,
      first_name: firstName,
      lastName:   found.lastName || '',
      last_name:  found.lastName || '',
      title:      found.title   || '',
      email,
    };

    console.log('  Generating Rebrand emails...');
    const senderForGeneration = {
      name:        SENDER_CONFIG.firstName,
      email:       SENDER_EMAIL,
      meetingLink: SENDER_CONFIG.meetingLink || null,
    };
    let emailResult;
    try {
      emailResult = await generateClaudeEmails(signal, contact, senderForGeneration);
    } catch (err) {
      console.log(`  ✗ Claude API error: ${err.message} — skipping`);
      failed++;
      continue;
    }
    if (!emailResult.success) {
      console.log(`  ✗ Email generation failed: ${emailResult.error} — skipping`);
      failed++;
      continue;
    }

    const subst = (t) => substituteTokens(t, {
      contactFirstName: firstName,
      contactCompany:   company,
      meetingLink:      SENDER_CONFIG.meetingLink,
    });

    const e = emailResult.emails;
    const claudeEmails = {
      email_1_subject:  subst(e.email_1_subject)  || null,
      email_1_body:     subst(e.email_1_body)      || null,
      email_2_subject:  subst(e.email_2_subject)   || null,
      email_2_body:     subst(e.email_2_body)       || null,
      email_3_subject:  subst(e.email_3_subject)   || null,
      email_3_body:     subst(e.email_3_body)       || null,
      email_4_subject:  subst(e.email_4_subject)   || null,
      email_4_body:     subst(e.email_4_body)       || null,
      email_5_subject:  subst(e.email_5_subject)   || null,
      email_5_body:     subst(e.email_5_body)       || null,
      email_6_subject:  subst(e.email_6_subject)   || null,
      email_6_body:     subst(e.email_6_body)       || null,
      email_7_subject:  subst(e.email_7_subject)   || null,
      email_7_body:     subst(e.email_7_body)       || null,
      email_8_subject:  subst(e.email_8_subject)   || null,
      email_8_body:     subst(e.email_8_body)       || null,
      email_9_subject:  subst(e.email_9_subject)   || null,
      email_9_body:     subst(e.email_9_body)       || null,
      email_10_subject: subst(e.email_10_subject)  || null,
      email_10_body:    subst(e.email_10_body)      || null,
    };
    console.log(`  ✓ ${emailResult.touchCount} emails generated`);

    // Update HubSpot
    if (found.hsId) {
      try {
        await hsRequest('PATCH', `/crm/v3/objects/contacts/${found.hsId}`, {
          properties: {
            signal_data:         'rebrand',
            ab_test_group:       'claude',
            claude_generated:    'true',
            claude_generated_at: generatedAt,
            firstname:           found.firstName,
            lastname:            found.lastName || '',
            ...Object.fromEntries(Object.entries(claudeEmails)),
          },
        });
        console.log(`  ✓ HubSpot updated (id: ${found.hsId})`);
      } catch (err) {
        console.log(`  ⚠️  HubSpot PATCH failed: ${err.response?.data?.message || err.message}`);
      }
      await pause(400);

      if (!found.isEnrolled) {
        const enrollResult = await enrollInSequence(found.hsId, REBRAND_CLAUDE_SEQ);
        if (enrollResult.success) {
          console.log(`  ✓ Enrolled → Rebrand claude sequence (${REBRAND_CLAUDE_SEQ})`);
        } else if (enrollResult.error?.toLowerCase().includes('already enrolled')) {
          console.log('  ✓ Already enrolled — skipping re-enrollment');
        } else {
          console.log(`  ⚠️  Enrollment failed: ${enrollResult.error}`);
        }
        await pause(400);
      } else {
        console.log('  ✓ Already enrolled — skipping enrollment');
      }
    }

    // Update Airtable
    try {
      await updateRecords([{
        id:     record.id,
        fields: {
          'Contact Info':        newContactInfo,
          'AB Test Group':       'claude',
          'Claude Generated':    true,
          'Claude Generated At': generatedAt,
          'Email 1 Subject':     claudeEmails.email_1_subject  || null,
          'Email 1 Body':        claudeEmails.email_1_body     || null,
          'Email 2 Subject':     claudeEmails.email_2_subject  || null,
          'Email 2 Body':        claudeEmails.email_2_body     || null,
          'Email 3 Subject':     claudeEmails.email_3_subject  || null,
          'Email 3 Body':        claudeEmails.email_3_body     || null,
          'Email 4 Subject':     claudeEmails.email_4_subject  || null,
          'Email 4 Body':        claudeEmails.email_4_body     || null,
          'Email 5 Subject':     claudeEmails.email_5_subject  || null,
          'Email 5 Body':        claudeEmails.email_5_body     || null,
          'Email 6 Subject':     claudeEmails.email_6_subject  || null,
          'Email 6 Body':        claudeEmails.email_6_body     || null,
          'Email 7 Subject':     claudeEmails.email_7_subject  || null,
          'Email 7 Body':        claudeEmails.email_7_body     || null,
          'Email 8 Subject':     claudeEmails.email_8_subject  || null,
          'Email 8 Body':        claudeEmails.email_8_body     || null,
          'Email 9 Subject':     claudeEmails.email_9_subject  || null,
          'Email 9 Body':        claudeEmails.email_9_body     || null,
          'Email 10 Subject':    claudeEmails.email_10_subject || null,
          'Email 10 Body':       claudeEmails.email_10_body    || null,
        },
      }]);
      console.log('  ✓ Airtable updated');
      fixed++;
    } catch (err) {
      console.log(`  ✗ Airtable update failed: ${err.message}`);
      failed++;
    }

    console.log('');
    await pause(1000);
  }

  console.log('════════════════════════════════════════════════════════════');
  console.log('RESULTS');
  console.log('════════════════════════════════════════════════════════════');
  console.log(`  Fixed     : ${fixed}`);
  console.log(`  Failed    : ${failed}`);
  console.log(`  No name   : ${withoutName.length}  (generic emails — manual lookup needed)`);
  console.log('════════════════════════════════════════════════════════════');
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
