/**
 * scripts/reroute_rebrand_to_new_sequence.js
 *
 * Re-routes all pushed Rebrand contacts to the new dedicated Rebrand sequences.
 * Also reassigns AB groups across the full set to achieve 75% Starfish / 25% Claude.
 *
 * Per contact (in order):
 *   1. Assign new AB group (deterministic 75/25 — every 4th contact = claude)
 *   2. Look up in HubSpot by email
 *   3. For claude group: regenerate 10-touch Rebrand emails, replace old News/Press emails
 *   4. Update HubSpot properties: signal_data → 'rebrand', ab_test_group, email fields
 *   5. If currently enrolled in a sequence: unenroll first
 *   6. Enroll in the correct new Rebrand sequence
 *   7. Update Airtable: AB Test Group, email fields, Claude Generated flag
 *
 * Sequence IDs:
 *   Starfish: 310220684  (HS_SEQ_REBRAND_STARFISH env var)
 *   Claude  : 310704131  (HS_SEQ_REBRAND_CLAUDE env var)
 *
 * Sender: zack@starfishbci.com  (ZACK_BCI_SENDER_EMAIL env var)
 *
 * Run:
 *   node --env-file=.env scripts/reroute_rebrand_to_new_sequence.js            (preview — no changes)
 *   node --env-file=.env scripts/reroute_rebrand_to_new_sequence.js --single   (one contact — test first)
 *   node --env-file=.env scripts/reroute_rebrand_to_new_sequence.js --live     (all contacts)
 */

import 'dotenv/config';
import axios from 'axios';
import { query, updateRecords }   from '../execution/utils/airtable_client.js';
import { generateClaudeEmails }   from '../hubspot/generateClaudeEmails.js';
import { SENDER_CONFIGS }         from '../hubspot/sequenceRouting.js';

// ── Config ───────────────────────────────────────────────────────────────────
const HS_TOKEN  = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
const HS_BASE   = 'https://api.hubapi.com';

const REBRAND_STARFISH_SEQ = process.env.HS_SEQ_REBRAND_STARFISH || '310220684';
const REBRAND_CLAUDE_SEQ   = process.env.HS_SEQ_REBRAND_CLAUDE   || '310704131';
const SENDER_EMAIL         = process.env.ZACK_SENDER_EMAIL     || 'zack@starfishco.com';
const SENDER_USER_ID       = process.env.ZACK_HUBSPOT_OWNER_ID || null;
const SENDER_CONFIG        = SENDER_CONFIGS[SENDER_EMAIL] || { firstName: 'Zack', meetingLink: null };

const PREVIEW = !process.argv.includes('--live') && !process.argv.includes('--single');
const SINGLE  = process.argv.includes('--single');
const LIVE    = process.argv.includes('--live');

function pause(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Token substitution ────────────────────────────────────────────────────────
// Mirrors pushSignalToHubSpot.js substituteTokens — must stay in sync.
function substituteTokens(text, { contactFirstName, contactCompany, senderFirstName, meetingLink }) {
  if (!text) return text;
  return text
    .replace(/\{\{\s*contact\.firstname\s*\}\}/gi,   contactFirstName || 'there')
    .replace(/\{\{\s*contact\.first_name\s*\}\}/gi,  contactFirstName || 'there')
    .replace(/\{\{\s*contact\.company\s*\}\}/gi,     contactCompany   || 'your company')
    .replace(/\{\{\s*sender\.firstname\s*\}\}/gi,    senderFirstName  || '')
    .replace(/\{\{\s*owner\.meetings_link\s*\}\}/gi, meetingLink      || '')
    .replace(/\{\{\s*TargetCo\s*\}\}/gi,             'the acquired company')
    .replace(/\{\{\s*Sector\s*\}\}/gi,               'your category');
}

// ── Contact Info parser ───────────────────────────────────────────────────────
function parseContact(ci) {
  if (!ci) return { name: '', firstName: '', lastName: '', title: '' };
  function stripLabel(line) {
    return line.replace(/^(name|title|email|linkedin)\s*:\s*/i, '').trim();
  }
  const lines = ci.split('\n').map(l => l.trim()).filter(l =>
    l && !l.startsWith('⚠️') && !l.startsWith('http') &&
    !l.startsWith('Website:') && !l.startsWith('LinkedIn:')
  );
  let name = '', title = '';
  for (const line of lines) {
    const clean = stripLabel(line);
    if (clean.includes('@')) continue;
    if (!name) { name = clean; continue; }
    if (!title) { title = clean; break; }
  }
  const parts = name.split(/\s+/).filter(Boolean);
  return {
    name,
    firstName: parts[0] || '',
    lastName:  parts.length > 1 ? parts.slice(1).join(' ') : '',
    title,
  };
}

function extractEmail(ci) {
  if (!ci) return null;
  const m = ci.match(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/);
  return m ? m[0].toLowerCase() : null;
}

// ── HubSpot helpers ───────────────────────────────────────────────────────────
async function hsRequest(method, endpoint, data = null) {
  if (!HS_TOKEN) throw new Error('HUBSPOT_PRIVATE_APP_TOKEN not set');
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
      properties: [
        'email', 'firstname', 'company',
        'signal_data', 'ab_test_group',
        'hs_sequences_is_enrolled', 'hs_sequences_actively_enrolled_count',
      ],
      limit: 1,
    });
    return res.data.results?.[0] || null;
  } catch (err) {
    return null;
  }
}

// Attempt to unenroll contact from all current active sequence enrollments.
// Uses CRM v4 associations to find enrollment object IDs, then patches each to UNENROLLED.
async function unenrollContact(contactId) {
  try {
    const res = await hsRequest('GET', `/crm/v4/objects/contacts/${contactId}/associations/sequence_enrollment`);
    const enrollments = res.data?.results || [];

    if (enrollments.length === 0) {
      return { success: true, note: 'no active enrollments found in associations' };
    }

    let unenrolled = 0;
    for (const enrollment of enrollments) {
      const enrollmentId = enrollment.toObjectId;
      try {
        await hsRequest('DELETE', `/automation/v4/sequences/enrollments/${enrollmentId}?userId=${SENDER_USER_ID}`);
        unenrolled++;
      } catch (delErr) {
        const delMsg = delErr.response?.data?.message || delErr.message;
        console.log(`     ⚠️  Unenroll DELETE failed for enrollment ${enrollmentId}: ${delMsg}`);
      }
    }
    return { success: true, unenrolled, total: enrollments.length };
  } catch (err) {
    return {
      success: false,
      error:   err.response?.data?.message || err.message,
    };
  }
}

// Enroll a contact in a HubSpot sequence.
// Tries the v4 body-style endpoint first; falls back to the v4 path-style endpoint.
async function enrollInSequence(contactId, sequenceId) {
  const attempts = [
    // Attempt 1: userId as query param, senderEmail in body (HubSpot v4)
    {
      method:   'POST',
      endpoint: `/automation/v4/sequences/enrollments?userId=${SENDER_USER_ID}`,
      data:     { sequenceId, contactId, senderEmail: SENDER_EMAIL },
    },
    // Attempt 2: userId + senderEmail both in query + body
    {
      method:   'POST',
      endpoint: `/automation/v4/sequences/${sequenceId}/enrollments?userId=${SENDER_USER_ID}`,
      data:     { contactId, senderEmail: SENDER_EMAIL },
    },
  ];

  for (const attempt of attempts) {
    try {
      await hsRequest(attempt.method, attempt.endpoint, attempt.data);
      return { success: true };
    } catch (err) {
      const status  = err.response?.status;
      const body    = err.response?.data;
      const message = body?.message || body?.error || err.message;
      if (status === 404) continue; // try next format
      // Non-404 error — return immediately with details
      if (typeof body === 'string' && body.includes('<html')) {
        console.log(`     → Full response: [HTML error page]`);
      } else if (body) {
        console.log(`     → Full response: ${JSON.stringify(body)}`);
      }
      return { success: false, error: message, status, body };
    }
  }

  // Both attempts returned 404
  return {
    success: false,
    error:   'Both enrollment endpoint formats returned 404 — sequence ID may not exist in this HubSpot portal',
    status:  404,
  };
}

// ── AB group assignment ───────────────────────────────────────────────────────
// Every 4th contact (index 0, 4, 8, …) = claude → gives ~25%.
// Rest = starfish → gives ~75%.
// Deterministic: same records always get same group.
function assignNewAbGroup(index) {
  return index % 4 === 0 ? 'claude' : 'starfish';
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
  if (!HS_TOKEN) { console.error('HUBSPOT_PRIVATE_APP_TOKEN not set'); process.exit(1); }

  const mode = SINGLE ? 'SINGLE — testing one contact' : LIVE ? 'LIVE — all contacts' : 'PREVIEW — no changes';
  console.log('════════════════════════════════════════════════════════════');
  console.log('REROUTE REBRAND → NEW SEQUENCES');
  console.log(`Mode     : ${mode}`);
  console.log(`Starfish : sequence ${REBRAND_STARFISH_SEQ}`);
  console.log(`Claude   : sequence ${REBRAND_CLAUDE_SEQ}`);
  console.log(`Sender   : ${SENDER_EMAIL}`);
  console.log('════════════════════════════════════════════════════════════\n');

  // Fetch all pushed Rebrand records from Airtable
  console.log('Fetching pushed Rebrand records from Airtable...');
  let records;
  try {
    records = await query({
      filterByFormula: `AND({Signal Type} = "Rebrand", {HubSpot Pushed} = TRUE())`,
      fields: [
        'Company Name', 'Signal Type', 'Contact Info',
        'Industry', 'Brief', 'Signal Details',
        'Acquired Company', 'Company Website',
        'Bespoke', 'Send Day', 'AB Test Group',
      ],
    }, 60000);
  } catch (err) {
    console.error('Airtable fetch failed:', err.message);
    process.exit(1);
  }

  const withEmail = records.filter(r => !!extractEmail(r.fields['Contact Info'] || ''));

  console.log(`  Total pushed Rebrand records : ${records.length}`);
  console.log(`  With a valid email           : ${withEmail.length}`);
  if (records.length - withEmail.length > 0) {
    console.log(`  Skipped (no email)          : ${records.length - withEmail.length}`);
  }
  console.log('');

  if (withEmail.length === 0) {
    console.log('No Rebrand contacts with emails found. Nothing to do.');
    return;
  }

  const toProcess   = SINGLE ? withEmail.slice(0, 1) : withEmail;
  const claudeCount = toProcess.filter((_, i) => assignNewAbGroup(i) === 'claude').length;
  const starfishCount = toProcess.length - claudeCount;

  console.log(`Contacts to process : ${toProcess.length}`);
  console.log(`New AB distribution : ${claudeCount} claude (${Math.round(claudeCount / toProcess.length * 100)}%) + ${starfishCount} starfish`);
  console.log('');

  // PREVIEW — just show the plan, no API calls
  if (PREVIEW) {
    console.log('── Preview (first 15) ──────────────────────────────────────');
    for (let i = 0; i < Math.min(15, toProcess.length); i++) {
      const f        = toProcess[i].fields;
      const company  = (f['Company Name'] || '(unknown)').padEnd(35);
      const oldGroup = (f['AB Test Group'] || 'none').padEnd(8);
      const newGroup = assignNewAbGroup(i).padEnd(8);
      const action   = newGroup.trim() === 'claude' ? '→ will regenerate emails' : '→ no email generation';
      console.log(`  [${String(i + 1).padStart(2)}] ${company} | old:${oldGroup} → new:${newGroup} | ${action}`);
    }
    if (toProcess.length > 15) console.log(`  ... and ${toProcess.length - 15} more`);
    console.log(`\nPREVIEW: No changes made.`);
    console.log('Run with --single to test one contact, then --live to process all.');
    return;
  }

  // ── SINGLE or LIVE ────────────────────────────────────────────────────────
  let succeeded = 0, failed = 0;
  const generatedAt = new Date().toISOString();

  for (let i = 0; i < toProcess.length; i++) {
    const record   = toProcess[i];
    const f        = record.fields;
    const newGroup = assignNewAbGroup(i);
    const email    = extractEmail(f['Contact Info'] || '');
    const company  = f['Company Name'] || '';
    const industry = f['Industry']     || '';
    const parsed   = parseContact(f['Contact Info'] || '');

    console.log(`\n[${i + 1}/${toProcess.length}] ${company}`);
    console.log(`  Email    : ${email}`);
    console.log(`  AB group : ${f['AB Test Group'] || 'none'} → ${newGroup}`);
    console.log(`  Contact  : ${parsed.name || '—'} / ${parsed.title || '—'}`);

    if (!parsed.firstName && newGroup === 'claude') {
      console.log('  ✗ SKIP: no first name found in Contact Info (required for claude email generation)');
      failed++;
      continue;
    }

    // Step 1: Find in HubSpot
    const hsContact = await findHubSpotContact(email);
    if (!hsContact) {
      console.log('  ✗ SKIP: contact not found in HubSpot');
      failed++;
      await pause(300);
      continue;
    }

    const contactId     = hsContact.id;
    const isEnrolled    = hsContact.properties.hs_sequences_is_enrolled === 'true';
    const alreadyDone   = hsContact.properties.signal_data === 'rebrand';
    console.log(`  HubSpot  : id ${contactId} | enrolled: ${isEnrolled}`);

    if (alreadyDone) {
      console.log('  ✓ Already rerouted (signal_data=rebrand) — skipping');
      succeeded++;
      await pause(150);
      continue;
    }

    // Step 2: Generate new Rebrand emails for claude group
    let claudeEmails = null;
    if (newGroup === 'claude') {
      console.log('  Generating Rebrand emails...');

      const signal = {
        type:             'Rebrand',
        signal_type:      'Rebrand',
        company_name:     company,
        company:          { name: company, industry, website: f['Company Website'] || null },
        industry,
        brief:            f['Brief']            || '',
        signal_details:   f['Signal Details']   || '',
        acquired_company: f['Acquired Company'] || null,
        bespoke:          f['Bespoke'] === true,
      };

      const contact = {
        name:       parsed.name,
        firstName:  parsed.firstName,
        first_name: parsed.firstName,
        lastName:   parsed.lastName,
        last_name:  parsed.lastName,
        title:      parsed.title,
        email,
      };

      const senderForGeneration = {
        name:        SENDER_CONFIG.firstName,
        email:       SENDER_EMAIL,
        meetingLink: SENDER_CONFIG.meetingLink || null,
      };

      let result;
      try {
        result = await generateClaudeEmails(signal, contact, senderForGeneration);
      } catch (err) {
        console.log(`  ✗ Claude API error: ${err.message} — skipping contact`);
        failed++;
        await pause(1000);
        continue;
      }

      if (!result.success) {
        console.log(`  ✗ Email generation failed: ${result.error} — skipping contact`);
        failed++;
        await pause(500);
        continue;
      }

      const subst = (t) => substituteTokens(t, {
        contactFirstName: parsed.firstName,
        contactCompany:   company,
        senderFirstName:  SENDER_CONFIG.firstName,
        meetingLink:      SENDER_CONFIG.meetingLink,
      });

      const e = result.emails;
      claudeEmails = {
        email_1_subject:  subst(e.email_1_subject)  || null,
        email_1_body:     subst(e.email_1_body)     || null,
        email_2_subject:  subst(e.email_2_subject)  || null,
        email_2_body:     subst(e.email_2_body)     || null,
        email_3_subject:  subst(e.email_3_subject)  || null,
        email_3_body:     subst(e.email_3_body)     || null,
        email_4_subject:  subst(e.email_4_subject)  || null,
        email_4_body:     subst(e.email_4_body)     || null,
        email_5_subject:  subst(e.email_5_subject)  || null,
        email_5_body:     subst(e.email_5_body)     || null,
        email_6_subject:  subst(e.email_6_subject)  || null,
        email_6_body:     subst(e.email_6_body)     || null,
        email_7_subject:  subst(e.email_7_subject)  || null,
        email_7_body:     subst(e.email_7_body)     || null,
        email_8_subject:  subst(e.email_8_subject)  || null,
        email_8_body:     subst(e.email_8_body)     || null,
        email_9_subject:  subst(e.email_9_subject)  || null,
        email_9_body:     subst(e.email_9_body)     || null,
        email_10_subject: subst(e.email_10_subject) || null,
        email_10_body:    subst(e.email_10_body)    || null,
      };
      console.log(`  ✓ ${result.touchCount} emails generated`);
    }

    // Step 3: Update HubSpot contact properties
    const hsProps = {
      signal_data:   'rebrand',
      ab_test_group: newGroup,
      ...(claudeEmails ? {
        email_1_subject:     claudeEmails.email_1_subject,
        email_1_body:        claudeEmails.email_1_body,
        email_2_subject:     claudeEmails.email_2_subject,
        email_2_body:        claudeEmails.email_2_body,
        email_3_subject:     claudeEmails.email_3_subject,
        email_3_body:        claudeEmails.email_3_body,
        email_4_subject:     claudeEmails.email_4_subject,
        email_4_body:        claudeEmails.email_4_body,
        email_5_subject:     claudeEmails.email_5_subject,
        email_5_body:        claudeEmails.email_5_body,
        email_6_subject:     claudeEmails.email_6_subject,
        email_6_body:        claudeEmails.email_6_body,
        email_7_subject:     claudeEmails.email_7_subject,
        email_7_body:        claudeEmails.email_7_body,
        email_8_subject:     claudeEmails.email_8_subject,
        email_8_body:        claudeEmails.email_8_body,
        email_9_subject:     claudeEmails.email_9_subject,
        email_9_body:        claudeEmails.email_9_body,
        email_10_subject:    claudeEmails.email_10_subject,
        email_10_body:       claudeEmails.email_10_body,
        claude_generated:    'true',
        claude_generated_at: generatedAt,
      } : {}),
    };

    try {
      await hsRequest('PATCH', `/crm/v3/objects/contacts/${contactId}`, { properties: hsProps });
      console.log(`  ✓ HubSpot updated (signal_data=rebrand, ab_test_group=${newGroup}${claudeEmails ? ', emails written' : ''})`);
    } catch (err) {
      console.log(`  ✗ HubSpot PATCH failed: ${err.response?.data?.message || err.message} — skipping enrollment`);
      failed++;
      await pause(300);
      continue;
    }

    // Step 4: Unenroll from current sequence (if enrolled)
    if (isEnrolled) {
      await pause(400);
      const unenrollResult = await unenrollContact(contactId);
      if (unenrollResult.success) {
        const detail = unenrollResult.note
          || `${unenrollResult.unenrolled}/${unenrollResult.total} enrollment(s) finished`;
        console.log(`  ✓ Unenrolled: ${detail}`);
      } else {
        console.log(`  ⚠️  Unenroll: ${unenrollResult.error} — will still attempt new enrollment`);
      }
    }

    // Step 5: Enroll in the correct new Rebrand sequence
    await pause(400);
    const targetSeq    = newGroup === 'claude' ? REBRAND_CLAUDE_SEQ : REBRAND_STARFISH_SEQ;
    const enrollResult = await enrollInSequence(contactId, targetSeq);
    if (enrollResult.success) {
      console.log(`  ✓ Enrolled → Rebrand ${newGroup} sequence (${targetSeq})`);
    } else if (enrollResult.error?.toLowerCase().includes('already enrolled')) {
      console.log(`  ✓ Already enrolled in a sequence — skipping re-enrollment (verify in HubSpot)`);
    } else {
      console.log(`  ⚠️  Enrollment: ${enrollResult.error}`);
      if (enrollResult.status === 403) {
        console.log('     → 403: private app token may be missing sequence enrollment scopes');
        console.log('     → HubSpot: Settings → Private Apps → Scopes → add CRM + Sequences scopes');
      }
    }

    // Step 6: Update Airtable
    const airtableFields = {
      'AB Test Group': newGroup,
      ...(claudeEmails ? {
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
      } : {}),
    };

    try {
      await updateRecords([{ id: record.id, fields: airtableFields }]);
      console.log('  ✓ Airtable updated');
    } catch (err) {
      console.log(`  ⚠️  Airtable update failed (non-fatal): ${err.message}`);
    }

    succeeded++;
    // Longer pause after claude contacts (Claude API rate limit)
    await pause(claudeEmails ? 1500 : 500);
  }

  console.log('\n════════════════════════════════════════════════════════════');
  console.log('RESULTS');
  console.log('════════════════════════════════════════════════════════════');
  console.log(`  Completed : ${succeeded}`);
  console.log(`  Failed    : ${failed}`);
  console.log(`  Total     : ${toProcess.length}`);
  if (SINGLE && succeeded > 0) {
    console.log('\nSingle-contact test done. Check HubSpot to verify enrollment.');
    console.log('If correct, run with --live to process all contacts.');
  }
  console.log('════════════════════════════════════════════════════════════');
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
