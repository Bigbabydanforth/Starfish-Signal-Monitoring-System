/**
 * scripts/generate_email_subjects_only.js
 *
 * For all claude-group contacts missing any email subjects (2–10),
 * generates ONLY the missing subject lines. Never touches email bodies.
 *
 * - Checks subjects 2–10 individually. Skips any that already exist.
 * - Calls Claude once per contact — subjects-only prompt, much cheaper than full generation.
 * - Writes subjects to Airtable + patches HubSpot if the contact was already pushed.
 * - Year context: 2026.
 *
 * Run:
 *   node --env-file=.env scripts/generate_email_subjects_only.js              (preview)
 *   node --env-file=.env scripts/generate_email_subjects_only.js --live       (generate + write)
 *   node --env-file=.env scripts/generate_email_subjects_only.js --live --batch=100
 */

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import axios from 'axios';
import { query, updateRecords } from '../execution/utils/airtable_client.js';
import { SENDER_CONFIGS } from '../hubspot/sequenceRouting.js';

const LIVE     = process.argv.includes('--live');
const batchArg = process.argv.find(a => a.startsWith('--batch='));
const BATCH    = batchArg ? parseInt(batchArg.split('=')[1], 10) : Infinity;

const anthropic   = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
const HS_TOKEN    = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
const HS_BASE     = 'https://api.hubapi.com';
const PLACEHOLDER = 'email_not_unlocked@domain.com';

const ALL_SUBJECT_FIELDS = [
  'Email 2 Subject', 'Email 3 Subject', 'Email 4 Subject',
  'Email 5 Subject', 'Email 6 Subject', 'Email 7 Subject',
  'Email 8 Subject', 'Email 9 Subject', 'Email 10 Subject',
];

// ── Subject-generation system prompt ─────────────────────────────────────────
// Focused entirely on what makes a subject line get opened in 2026.
// No body-writing instructions — keeps the Claude call fast and cheap.
const SUBJECT_SYSTEM_PROMPT = `
You are a world-class B2B email strategist writing cold outreach subject lines for Starfish in 2026.
Starfish is a Brand and Creative consultancy. Their offer: a free Brand Intelligence diagnostic — a one-time,
no-cost read of how a prospect's brand is perceived by humans AND by AI systems (ChatGPT, Claude) that now
stand between brands and their buyers. The diagnostic is the only ask — never a pitch.

CURRENT YEAR: 2026. AI is no longer emerging — it is now the first layer every buyer goes through before
visiting a website or speaking to a rep. Subject lines should reflect this reality, not treat it as novel.

TOUCH ARC — match each subject to the angle of that email:
Touch 2 — AI has already formed its own standing read of the company before any person arrives. The prospect doesn't control that first impression anymore.
Touch 3 — AI systems summarise, rank, and recommend. They already have a view of this company based on what was online before this email. Most companies have no idea what that view says.
Touch 4 — McKinsey data: brand coherence is now a structural competitive advantage in the AI era. The companies that get it right now compound.
Touch 5 — The free Brand Intelligence diagnostic: what the company looks like to humans and to AI. Low friction, no commitment.
Touch 6 — Two worlds, one brand. Concrete consequence of doing nothing. Last hard ask.
Touch 7 — Not the right time, for now. Leave the door wide open. Restate the diagnostic as easy, no-commitment.
Touch 8 — Day 63 reconnect. Light check-in: has brand become a priority since we last spoke? No pressure.
Touch 9 — Day 91 reconnect. Planning season — budgets being set. End-of-year framing. Restate the diagnostic.
Touch 10 — Day 119, final touch. "Is it time?" Short. Warm. Leave on good terms.

MANDATORY SUBJECT LINE RULES:
1. Under 7 words. No colons. No emojis. No ALL CAPS.
2. Never use: "Quick question", "Following up", "Checking in", "Introduction", "Re:"
3. Every subject must be SPECIFIC to THIS company and THIS touch number — never generic
4. Tease the ONE insight in that email. "What ChatGPT says about [Company]" is strong. "AI and your brand" is weak.
   "The gap [Company]'s rebrand leaves open" is strong. "Brand strategy" is weak.
5. Use the company name, the trigger event, or a specific consequence where it makes the subject sharper
6. Each subject must be meaningfully different from all others — no recycling the same angle across touches
7. Touches 8–10 must feel like genuine human check-ins, not follow-up pitches
8. A busy exec should read the subject and feel a pull to open it — mild unease, curiosity, or recognition
9. Avoid superlatives, urgency bait, and anything that sounds like a marketing automation tool wrote it

OUTPUT: Return ONLY valid JSON. No markdown fences. No text before or after the JSON object.
The JSON keys must be only the email_N_subject keys you were asked to generate.
Example format:
{
  "email_2_subject": "...",
  "email_3_subject": "..."
}
`.trim();

// ── Condensed signal context for subject generation ───────────────────────────
// These are hook summaries for the subject-generation call — NOT the full SIGNAL_BLOCKS.
// The full blocks are designed for body writing; here we only need the trigger angle.
const SIGNAL_CONTEXT = {
  'Job Change': `
Signal: A new senior marketing leader (CMO / VP Marketing) just started at the company.
Hook: They didn't build this brand — they inherited it. Whatever is broken is theirs the moment they stop being "the new person" (roughly the 6-month mark). This is the one window to act before the brand's problems become their problems.
Angle: inherited brand risk, the fork every new leader faces (move fast vs study it), the AI layer forming its own read of the company right now.
`,
  'News/Press': `
Signal: The company made a notable announcement or issued a press release.
Hook: A moment like this sends a wave of people — and AI tools — to look the company up at the same time. What they find is the brand, not the press release. The spike only compounds if the brand underneath is clear; otherwise attention resets within days.
Angle: what lasts after a news moment, how ChatGPT/Claude fold the announcement into their standing summary, capitalising on momentum vs letting it reset.
`,
  'Rebrand': `
Signal: The company is rebranding or recently rebranded.
Hook: A rebrand is the one moment a company has full permission to rewrite the narrative — but most companies spend all their effort on the visual layer and nothing on the AI layer. ChatGPT and Claude will keep serving the old version of the brand for months after launch.
Angle: the gap a rebrand leaves open in the AI layer, what the old brand still says about them, the window to close that gap.
`,
  'M&A Activity': `
Signal: The company was involved in a merger or acquisition.
Hook: M&A is where brand value is most often lost. Two brands collide, AI systems form their own read of the combined entity, and the story told to the market is rarely the story the company intended.
Angle: brand integration risk, what AI says about the combined entity right now, the window to shape the new brand's narrative before it sets.
`,
  'Funding': `
Signal: The company recently received a funding round.
Hook: A raise announces ambition. What follows is a spike of attention — investors, press, talent, competitors — all forming a view of the company at once. Brand-led companies compound that attention; others let it scatter.
Angle: what the attention spike reveals about the brand's readiness, how ChatGPT/Claude will explain the company to a buyer who just heard about the raise, brand-led growth vs channel-chasing.
`,
  'Website Visitor': `
Signal: The contact works at a company in this industry.
Hook: The company exists in a market where AI tools are now shaping buyer decisions before any human conversation starts. Most companies in this space have never checked what ChatGPT or Claude says about them when a buyer asks.
CRITICAL: Do NOT reference website visits, tracking, intent data, or digital footprints. Write as if reaching out based on knowledge of the industry only.
Angle: the AI layer in their market, what buyers find before they find the company's own site, brand coherence in 2026.
`,
  'Brand Strategy Intent': `
Signal: The company is actively researching brand strategy — they already know they have a gap.
Hook: They're already looking for answers. The question is whether they're thinking about both worlds: the human side and the AI side. Most brand strategy work only addresses one.
Angle: they're mid-search, what they're probably finding, the dimension most strategies miss (the AI read), the diagnostic as the obvious first step for someone already in research mode.
`,
};

function getSignalContext(signalType) {
  return SIGNAL_CONTEXT[signalType]
    || SIGNAL_CONTEXT['News/Press']; // fallback
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function pause(ms) { return new Promise(r => setTimeout(r, ms)); }

function extractEmail(ci) {
  if (!ci) return null;
  const m = ci.match(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/);
  return m ? m[0].toLowerCase() : null;
}

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
  return { name, firstName: parts[0] || '', lastName: parts.length > 1 ? parts.slice(1).join(' ') : '', title };
}

function getSenderEmailForType(signalType) {
  const DAVID  = process.env.DAVID_SENDER_EMAIL  || 'david@starfishco.com';
  const ZACK   = process.env.ZACK_SENDER_EMAIL   || 'zack@starfishco.com';
  const COLE   = process.env.COLE_SENDER_EMAIL   || 'cole@starfishco.com';
  const ANDREW = process.env.ANDREW_SENDER_EMAIL || 'andrew@starfishco.com';
  if (['Job Change', 'M&A Activity', 'Funding'].includes(signalType)) return DAVID;
  if (['Website Visitor', 'Rebrand'].includes(signalType)) return ZACK;
  if (signalType === 'Brand Strategy Intent') return COLE;
  return ANDREW; // News/Press → Andrew
}

// ── HubSpot helpers ───────────────────────────────────────────────────────────
async function hsRequest(method, endpoint, data = null) {
  const cfg = {
    method, url: `${HS_BASE}${endpoint}`,
    headers: { Authorization: `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' },
    timeout: 15000,
  };
  if (data) cfg.data = data;
  return axios(cfg);
}

async function findHubSpotId(email) {
  try {
    const res = await hsRequest('POST', '/crm/v3/objects/contacts/search', {
      filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
      properties: ['email'],
      limit: 1,
    });
    return res.data.results?.[0]?.id || null;
  } catch { return null; }
}

async function patchHubSpotContact(contactId, properties) {
  try {
    await hsRequest('PATCH', `/crm/v3/objects/contacts/${contactId}`, { properties });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.response?.data?.message || err.message };
  }
}

// ── Claude subject generation ─────────────────────────────────────────────────
async function generateSubjectsForContact(signal, contact, missingNums) {
  const signalType   = signal.type || signal.signal_type || '';
  const companyName  = signal.company_name || signal.company?.name || 'the company';
  const firstName    = contact.firstName || contact.first_name || 'there';
  const contactTitle = contact.title || 'executive';
  const industry     = signal.industry || signal.company?.industry || 'their industry';
  const isWebsiteVisitor = ['Website Visitor', 'website_visitor'].includes(signalType);

  const signalDetail = isWebsiteVisitor
    ? `The company operates in the ${industry} space.`
    : (signal.brief || signal.signal_details || `${signalType} signal detected for ${companyName}.`).slice(0, 400);

  const signalContext = getSignalContext(signalType);

  // Describe which subject numbers to generate
  const numsStr   = missingNums.join(', ');
  const outputKeys = missingNums.map(n => `  "email_${n}_subject": "subject for touch ${n}"`).join(',\n');

  const userMessage = `
SIGNAL TYPE: ${signalType}

${signalContext}

PROSPECT:
Company: ${companyName}
Contact first name: ${firstName}
Contact title: ${contactTitle}
Industry: ${industry}
Signal detail: ${signalDetail}

TASK: Generate subject lines for email touches: ${numsStr}

Return ONLY this JSON (no extra text, no markdown):
{
${outputKeys}
}
`.trim();

  const response = await anthropic.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 600,
    system: [
      {
        type: 'text',
        text: SUBJECT_SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: userMessage }],
  });

  const raw = response.content?.[0]?.text?.trim() || '';

  // Strip markdown fences if Claude included them despite instructions
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return { success: false, error: `JSON parse failed. Raw: ${raw.slice(0, 200)}` };
  }

  // Validate all requested subjects are present and non-empty
  const missing = missingNums.filter(n => !parsed[`email_${n}_subject`]?.trim());
  if (missing.length > 0) {
    return { success: false, error: `Missing subjects for touches: ${missing.join(', ')}` };
  }

  return { success: true, subjects: parsed };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
  if (!HS_TOKEN)  { console.error('HUBSPOT_PRIVATE_APP_TOKEN not set'); process.exit(1); }
  if (!process.env.CLAUDE_API_KEY) { console.error('CLAUDE_API_KEY not set'); process.exit(1); }

  console.log('════════════════════════════════════════════════════════════');
  console.log('GENERATE MISSING EMAIL SUBJECTS ONLY (2–10)');
  console.log(`Mode  : ${LIVE ? 'LIVE — calling Claude + writing to Airtable + patching HubSpot' : 'PREVIEW — no Claude calls, no writes'}`);
  if (BATCH < Infinity) console.log(`Batch : ${BATCH} unique contacts max`);
  console.log('════════════════════════════════════════════════════════════\n');

  // ── Fetch Airtable records ────────────────────────────────────────────────
  console.log('Fetching claude-group records from Airtable...');
  let records;
  try {
    records = await query({
      filterByFormula: `AND(
        {AB Test Group} = "claude",
        {Claude Generated} = TRUE(),
        NOT({Contact Info} = ""),
        NOT(FIND("${PLACEHOLDER}", {Contact Info}) > 0),
        NOT(FIND("Research Needed", {Contact Info}) > 0),
        NOT(FIND("Contact Needed", {Contact Info}) > 0)
      )`,
      fields: [
        'Company Name', 'Signal Type', 'Contact Info', 'Industry',
        'Brief', 'Signal Details', 'Acquired Company', 'Company Website',
        'HubSpot Pushed',
        ...ALL_SUBJECT_FIELDS,
      ],
    }, 180000);
  } catch (err) {
    console.error('Airtable fetch failed:', err.message);
    process.exit(1);
  }

  console.log(`  Total claude-group records fetched : ${records.length}`);

  // ── Filter to records with at least one missing subject ───────────────────
  const incomplete = records.filter(r => {
    const email = extractEmail(r.fields['Contact Info'] || '');
    if (!email || email.includes(PLACEHOLDER)) return false;
    const isWebsite = (r.fields['Signal Type'] || '') === 'Website Visitor';
    // Website Visitor: 9-touch sequence → subjects 2–9 only
    const needed = isWebsite
      ? ALL_SUBJECT_FIELDS.filter(f => f !== 'Email 10 Subject')
      : ALL_SUBJECT_FIELDS;
    return needed.some(f => !(r.fields[f] || '').trim());
  });

  console.log(`  Records with missing subjects      : ${incomplete.length}\n`);

  if (incomplete.length === 0) {
    console.log('✓ All claude-group contacts already have subjects 2–10. Nothing to do.');
    return;
  }

  // ── Deduplicate by email ──────────────────────────────────────────────────
  const emailToRecords = new Map();
  for (const r of incomplete) {
    const email = extractEmail(r.fields['Contact Info'] || '');
    if (!emailToRecords.has(email)) emailToRecords.set(email, []);
    emailToRecords.get(email).push(r);
  }

  const uniqueEmails = [...emailToRecords.keys()].slice(0, BATCH);
  const totalRecords = uniqueEmails.reduce((s, e) => s + emailToRecords.get(e).length, 0);

  console.log(`  Unique contacts to process         : ${uniqueEmails.length}`);
  console.log(`  Total Airtable records to update   : ${totalRecords}`);

  if (!LIVE) {
    console.log('\nSample (first 20 contacts):');
    for (const email of uniqueEmails.slice(0, 20)) {
      const r         = emailToRecords.get(email)[0];
      const company   = (r.fields['Company Name'] || '(unknown)').padEnd(36);
      const type      = (r.fields['Signal Type']  || '—').padEnd(24);
      const isWebsite = r.fields['Signal Type'] === 'Website Visitor';
      const needed    = (isWebsite ? ALL_SUBJECT_FIELDS.slice(0, 8) : ALL_SUBJECT_FIELDS)
        .filter(f => !(r.fields[f] || '').trim())
        .map(f => f.replace('Email ', '').replace(' Subject', ''))
        .join(',');
      console.log(`  ${company} | ${type} | missing: ${needed} | ${email}`);
    }
    if (uniqueEmails.length > 20) console.log(`  ... and ${uniqueEmails.length - 20} more`);
    console.log(`\nPREVIEW: Would generate subjects for ${uniqueEmails.length} contacts (${totalRecords} records).`);
    console.log('Run with --live to apply.\n');
    return;
  }

  // ── LIVE ──────────────────────────────────────────────────────────────────
  let generated = 0, failed = 0, hsPatched = 0, hsSkipped = 0;

  for (let i = 0; i < uniqueEmails.length; i++) {
    const email   = uniqueEmails[i];
    const rList   = emailToRecords.get(email);
    const r       = rList[0];
    const f       = r.fields;

    const company    = f['Company Name'] || '';
    const signalType = f['Signal Type']  || '';
    const industry   = f['Industry']     || '';
    const pushed     = f['HubSpot Pushed'] === true;
    const parsed     = parseContact(f['Contact Info'] || '');
    const isWebsite  = signalType === 'Website Visitor';

    // Determine which subject numbers are missing for this contact
    const allNums = isWebsite ? [2,3,4,5,6,7,8,9] : [2,3,4,5,6,7,8,9,10];
    const missingNums = allNums.filter(n => !(f[`Email ${n} Subject`] || '').trim());

    if (missingNums.length === 0) {
      // Shouldn't happen due to pre-filter, but be safe
      continue;
    }

    console.log(`[${i + 1}/${uniqueEmails.length}] ${company} [${signalType}]`);
    console.log(`  Contact : ${parsed.name || email}`);
    console.log(`  Missing : Subjects ${missingNums.join(', ')}`);

    if (!parsed.firstName) {
      console.log(`  ✗ SKIP: no first name in Contact Info\n`);
      failed++;
      continue;
    }

    // Build signal object
    const signal = {
      type:             signalType,
      signal_type:      signalType,
      company_name:     company,
      company:          { name: company, industry, website: f['Company Website'] || null },
      industry,
      brief:            f['Brief']            || '',
      signal_details:   f['Signal Details']   || '',
      acquired_company: f['Acquired Company'] || null,
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

    // Call Claude
    let result;
    try {
      result = await generateSubjectsForContact(signal, contact, missingNums);
    } catch (err) {
      console.log(`  ✗ Claude error: ${err.message}\n`);
      failed++;
      await pause(1000);
      continue;
    }

    if (!result.success) {
      console.log(`  ✗ Generation failed: ${result.error}\n`);
      failed++;
      await pause(500);
      continue;
    }

    // Build Airtable fields — ONLY subjects, never touch bodies
    const newAirtableFields = {};
    const newHubSpotProps   = {};
    for (const n of missingNums) {
      const val = (result.subjects[`email_${n}_subject`] || '').trim();
      if (val) {
        newAirtableFields[`Email ${n} Subject`] = val;
        newHubSpotProps[`email_${n}_subject`]   = val;
      }
    }

    if (Object.keys(newAirtableFields).length === 0) {
      console.log(`  ✗ No valid subjects returned by Claude\n`);
      failed++;
      continue;
    }

    // Write to Airtable
    const updates = rList.map(rec => ({ id: rec.id, fields: newAirtableFields }));
    try {
      await updateRecords(updates);
      console.log(`  ✓ Airtable: wrote ${Object.keys(newAirtableFields).length} subjects to ${updates.length} record(s)`);
    } catch (writeErr) {
      console.log(`  ✗ Airtable write failed: ${writeErr.message}\n`);
      failed++;
      await pause(500);
      continue;
    }

    // Patch HubSpot if contact was already pushed
    if (pushed) {
      await pause(150);
      const hsId = await findHubSpotId(email);
      if (hsId) {
        const patch = await patchHubSpotContact(hsId, newHubSpotProps);
        if (patch.success) {
          console.log(`  ✓ HubSpot: patched contact ${hsId}`);
          hsPatched++;
        } else {
          console.log(`  ⚠️  HubSpot patch failed: ${patch.error}`);
          hsSkipped++;
        }
      } else {
        console.log(`  ⚠️  HubSpot: contact not found — Airtable updated, HubSpot skipped`);
        hsSkipped++;
      }
    } else {
      hsSkipped++;
    }

    generated++;
    console.log('');
    await pause(300);
  }

  console.log('════════════════════════════════════════════════════════════');
  console.log('RESULTS');
  console.log('════════════════════════════════════════════════════════════');
  console.log(`  Generated + written to Airtable : ${generated} contacts`);
  console.log(`  HubSpot contacts patched        : ${hsPatched}`);
  console.log(`  HubSpot skipped (not pushed)    : ${hsSkipped}`);
  console.log(`  Failed                          : ${failed}`);
  console.log(`  Total attempted                 : ${uniqueEmails.length}`);
  if (BATCH < Infinity && generated + failed < uniqueEmails.length) {
    console.log(`\n  Run again without --batch to process the rest.`);
  }
  console.log('════════════════════════════════════════════════════════════');
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
