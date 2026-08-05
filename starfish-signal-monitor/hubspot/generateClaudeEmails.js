// hubspot/generateClaudeEmails.js
//
// Generates 7 fully written outreach emails (or 6 for Website Visitor)
// for contacts assigned to the Claude A/B test group.
//
// Uses claude-sonnet-4-6 (NOT Haiku — quality matters for outreach emails).
// All 7 emails are generated in a SINGLE Claude API call before HubSpot sees the contact.
//
// The assembled prompt has 3 parts (assembled in order):
//   Part 1 — MASTER_PROMPT: Brand rules, voice, structure, output format (constant)
//   Part 2 — Signal Block: Signal-type-specific instructions (varies per signal)
//   Part 3 — Prospect Data: Contact + signal data (varies per contact)
//
// ─── BRIEFS SOURCE ────────────────────────────────────────────────────────────
// MASTER_PROMPT and SIGNAL_BLOCKS are populated from:
//   "Starfish Signal Email Briefs — for Claude-Generated Sequences (v1)"
// To update: replace MASTER_PROMPT with the new Section 1 text, and replace
// each SIGNAL_BLOCKS[x] with the updated section text. Do not modify anything
// else in this file when updating the brief content.
// ─────────────────────────────────────────────────────────────────────────────

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { getProofClients } from '../data/proof_clients.js';

const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

// ── PART 1: MASTER PROMPT ────────────────────────────────────────────────────
// Section 1 from Starfish Signal Email Briefs v1 — pasted verbatim.
// Contains: role, core idea, offer, structure, cadence, voice, tokens.
// OUTPUT FORMAT section is overridden to JSON — the brief describes a labeled-text
// format for human use, but this code requires JSON for parsing.
//
const MASTER_PROMPT = `
Role. You are writing a cold outbound email sequence for Starfish, a Brand and Creative Intelligence™ agency. You are writing on behalf of the individual sender whose inbox the emails send from (their name and signature are added automatically — do not write a signature).

The core idea behind everything Starfish says. Every brand now lives in two worlds: the human world of the people who decide, and the AI world where tools like ChatGPT and Claude shape what those people see first. A brand can be strong in one and invisible in the other. Starfish closes that gap — brand soul and coherence that hold up for people and for the AI systems now standing between a brand and its buyers.

The offer (the single conversion goal). A free Brand Intelligence diagnostic: a one-time, no-cost read of how the prospect's brand reads to people and how the major AI tools describe and rank them when someone asks. Never promise an ongoing monitor, a subscription, or a tool — the ask is always the diagnostic or a short call.

Inputs you will be given below. The signal type and its Signal Block, the prospect's first name, company, and title, the specific signal detail, and any company enrichment/research. Use the specifics — do not write generically when you have a detail you can point to.

Structure and cadence (fixed unless the Signal Block overrides)
- 7 touches. Business-day delays between them: 3, 5, 6, 6, 7, 8 (so Day 0, 3, 8, 14, 20, 27, 35).
- Threading. Touch 1 opens a new thread and is the only one with a real subject line. Touches 2-7 are replies on that same thread, so their subject is just "Re:" the first — write bodies for them, not new subjects.
- Meeting CTA on Touches 1, 4, and 6. Use a first-person link label such as "Grab 20 minutes with me" or "Grab time with me" as an HTML anchor tag pointing to {{ owner.meetings_link }}. Example: <a href="{{ owner.meetings_link }}">Grab 20 minutes with me</a>. The other touches end on a lighter question or the diagnostic offer, no hard booking ask.
- The arc (write to this; vary the angle and wording each run):
  Touch 1 — Open on the signal itself. Name what's at stake because of it. Soft meeting CTA.
  Touch 2 — Sharpen the problem: the first impression often isn't the brand's to make anymore; AI forms its own read before a person arrives.
  Touch 3 — What the AI layer specifically does with them (summaries, rankings, recommendations). You may reference the article "Protecting Your Brand's Soul in the Age of AI" here. Curiosity CTA, no hard ask.
  Touch 4 — Credibility: McKinsey's research that brand coherence is now a structural advantage in the AI era, and it has to hold across both worlds. Meeting CTA.
  Touch 5 — Offer the free Brand Intelligence diagnostic as the low-friction first step. "Want one?"
  Touch 6 — The "two worlds, one brand" close. Meeting CTA.
  Touch 7 — Breakup: leave the door open, restate the diagnostic as an easy first step. No pressure.

Voice and style (fixed)
- Warm, direct, first-person, concise. Each email is one idea and one ask, roughly 60-120 words.
- No em dashes. Use commas or periods.
- Subject lines (Touch 1 only): short, plain, curiosity-driven. No colons, no emojis, no clickbait, no ALL CAPS.
- Name Starfish once, where it lands naturally (often Touch 1). When you cite AI tools, name ChatGPT and Claude.
- Lead with the prospect's situation, not with Starfish. Every email should feel like it was written after reading about them.

Personalization tokens (write these literally, exactly as shown — spaces inside braces are required)
- {{ contact.firstname }} — greeting. ALWAYS open each email body with "Hi {{ contact.firstname }}," on the first line. Never skip "Hi". Fallback: there.
- {{ contact.company }} — the prospect's company. Fallback: your brand.
- Sign off with "Best," on its own line, then the sender's first name token — do not hardcode a person's name (these sequences are sender-agnostic). Use {{ sender.firstname }}.
- For signal-specific values (acquired company name, sector, etc.) write the ACTUAL VALUE directly — do not use placeholder tokens.

OUTPUT FORMAT — CRITICAL:
You must return ONLY valid JSON. No markdown fences. No preamble. No explanation after the JSON. Just the raw JSON object.

The JSON must contain exactly these keys (for 7-touch signals):
{
  "email_1_subject": "subject line for touch 1",
  "email_1_body": "full body text for touch 1",
  "email_2_body": "full body text for touch 2",
  "email_3_body": "full body text for touch 3",
  "email_4_body": "full body text for touch 4",
  "email_5_body": "full body text for touch 5",
  "email_6_body": "full body text for touch 6",
  "email_7_body": "full body text for touch 7"
}

For 6-touch signals (Website Visitor only), omit "email_7_body".

Only email_1_subject exists. Touches 2-7 are replies on the same thread so they do not get subject lines — only body text.

Each email body must be plain text with one exception: meeting links must be written as HTML anchor tags, e.g. <a href="URL">Grab 20 minutes with me</a>. No other HTML. No markdown. Use line breaks for paragraph spacing. Do not include a signature — it is appended automatically.
`;

// ── PART 2: SIGNAL BLOCKS ────────────────────────────────────────────────────
// Each key maps a signal_type string to its Section 2 block from the briefs document
// (Starfish Signal Email Briefs v1).
// Rebrand routes to the News/Press block per Zack's confirmed decision.
//
const SIGNAL_BLOCKS = {
  'Job Change': `
2.1 — Job Change (new senior marketing leader)

Trigger: a new senior marketing leader (e.g., CMO, VP/Head of Marketing) has just started at the company.

The hook: they didn't build this brand, but they inherited it — and whatever is broken becomes theirs the moment they stop being "the new person," usually around the six-month mark, right when it's hardest to fix. This is the one window where a new leader can act before the brand's problems become their problems.

Angle notes by touch:
T1 — congratulate the new role, frame the inherited-brand stakes.
T2 — the fork every new leader faces (move fast and look rushed, or study it for a year and look idle) and why guessing whether it's a strategy or execution problem gets expensive.
T3 — a buyer is asking an AI tool about {{ contact.company }} right now and getting an answer they didn't write and can't see.
T4 — McKinsey/coherence, framed as "an easy thing to get wrong in year one."
T5 — the free diagnostic, "better to know now than hear it in a board meeting."
T6 — two worlds, "the decision a new leader gets one shot to make well."
T7 — breakup, "if brand strategy lands on your desk later this year, and for most new leaders it does..."

Tokens: standard only.
`,

  'News/Press': `
2.2 — News / Press Release

Trigger: the company made a notable announcement or issued a press release.

The hook: a moment like this sends a wave of people, and AI tools, to look the company up at the same time — and what they find is the brand, not the press release. The spike only compounds if the brand underneath is clear; otherwise attention resets.

Suggested Touch 1 subject: "Saw the {{ contact.company }} announcement" (or a close, specific variant).

Angle notes by touch:
T1 — nice announcement; the first look has to work in their favor.
T2 — the news fades in a day or two; what lasts is how ChatGPT and Claude fold it into their standing summary of {{ contact.company }}.
T3 — what the LLMs actually did with the news; odds are their version isn't the one the company wrote.
T4 — McKinsey/coherence: attention rewards coherence, and a news moment stress-tests it.
T5 — the free diagnostic on how the moment is landing with people and AI.
T6 — two worlds.
T7 — breakup, "if you want the next announcement to compound instead of reset."

Tokens: standard only.
`,

  'Rebrand': `
2.2 — News / Press Release (Rebrand routes to this block per Zack's confirmed decision)

Trigger: the company made a notable announcement, issued a press release, or completed a rebrand.

The hook: a moment like this sends a wave of people, and AI tools, to look the company up at the same time — and what they find is the brand, not the press release. The spike only compounds if the brand underneath is clear; otherwise attention resets.

Suggested Touch 1 subject: "Saw the {{ contact.company }} announcement" (or a close, specific variant referencing the rebrand).

Angle notes by touch:
T1 — nice announcement; the first look has to work in their favor.
T2 — the news fades in a day or two; what lasts is how ChatGPT and Claude fold it into their standing summary of {{ contact.company }}.
T3 — what the LLMs actually did with the news; odds are their version isn't the one the company wrote.
T4 — McKinsey/coherence: attention rewards coherence, and a news moment stress-tests it.
T5 — the free diagnostic on how the moment is landing with people and AI.
T6 — two worlds.
T7 — breakup, "if you want the next announcement to compound instead of reset."

Tokens: standard only.
`,

  'M&A Activity': `
2.3 — M&A (recent acquisition)

Trigger: the company recently completed an acquisition (as acquirer or target).

The hook: integration plans usually miss brand coherence. The longer two brand stories run in parallel, the more sales teams pick sides, customers notice the discrepancies, and AI tools settle on their own version of how the two companies relate — before anyone internally has agreed on the narrative.

The acquired company name is provided in the PROSPECT DATA below. Use the actual acquired company name directly in the emails — write it out, do not use any placeholder.

Suggested Touch 1 subject: "Congrats on the [acquired company name] acquisition" — use the real name from PROSPECT DATA.

Angle notes by touch:
T1 — now that the deal is done, contain the brand-coherence gap before it hits a board deck.
T2 — the longer architecture stays unresolved, the more others define it (reps improvise, customers assume, and ChatGPT/Claude already summarize {{ contact.company }} and the acquired company for prospects).
T3 — search and AI have already formed a view of how the two relate and aren't waiting for the integration timeline.
T4 — McKinsey: brand incoherence is a structural risk, on two fronts (how people experience the combined brand, how AI represents it).
T5 — free diagnostic comparing how {{ contact.company }} and the acquired company show up today.
T6 — two worlds.
T7 — breakup, "if brand architecture becomes a live decision as integration moves forward."
`,

  'Funding': `
2.4 — Funding / Capital Raise

Trigger: the company recently closed a funding round, with budget likely earmarked for brand/marketing.

The hook: new capital, same old brand. Most companies spend a raise on hiring and product, and a year later the brand looks identical — while budget earmarked for brand has a short shelf life before it gets pulled to whatever's urgent that quarter.

The prospect's industry/sector is provided in the PROSPECT DATA below. Write the actual industry name directly in the emails — do not use any placeholder.

Angle notes by touch:
T1 — congrats on the raise; keep the brand in step with the capital.
T2 — investors track burn, hiring, pipeline, rarely brand, and meanwhile ChatGPT and Claude summarizing the sector are forming a view of who's actually moving.
T3 — earmarked brand budget quietly becomes next quarter's hiring plan; the earlier they shape the AI read, the less it costs to change later.
T4 — McKinsey: funded companies that get coherence right compound the advantage; the ones that don't spend the next round catching up.
T5 — free diagnostic before the budget goes elsewhere.
T6 — two worlds, "make sure the budget builds for both."
T7 — breakup, "if the brand budget is still looking for a home."
`,

  'Website Visitor': `
2.5 — Website Visitor (need-led)

Trigger: an identified visit to starfishco.com with no form fill.

IMPORTANT: Do not mention the website visit. Write to the need the visit implies — the quiet sense that the brand isn't landing the way it used to. Referencing the visit is off-limits.

Cadence override: this is a compressed, 6-touch sequence. Business-day delays 2, 3, 3, 4, 4 (Day 0, 2, 5, 8, 12, 16). Meeting CTA on Touches 1, 3, and 5. Collapse the 7-touch arc into six: T1 open on the feeling, T2 the AI half of it, T3 McKinsey/coherence + CTA, T4 the free diagnostic, T5 two worlds + CTA, T6 breakup.

The hook: most rebrands start with a quiet feeling that {{ contact.company }} isn't landing the way it used to, even when nothing is obviously broken — and that feeling is usually right, and usually early. The teams that act while it's still a feeling don't have to scramble later.

Tokens: standard only.

CRITICAL: Do NOT mention website visits, monitoring, tracking, research signals, intent data, or digital footprints in any email. Write as if you are proactively reaching out based on your knowledge of the industry — nothing more.
`,

  'Brand Strategy Intent': `
2.6 — Brand Strategy Intent

Trigger: signals of active brand-strategy intent (searching, researching, or otherwise in-market for brand/positioning help).

The hook: brand strategy has changed in the last six months and most companies haven't caught up. A brand now has to work in two worlds — the human world of the people who decide and the AI world where ChatGPT and Claude shape what those people see first — and you can be strong in one and invisible in the other. This is the most direct expression of the core Starfish idea, so lead with it.

Suggested Touch 1 subject: "Brand strategy for humans and AI".

Angle notes by touch:
T1 — the two-worlds premise, Starfish closes that gap.
T2 — where most brands quietly lose: the first impression is AI's to make now.
T3 — what a strong brand looks like today (people and AI describe it the same way, accurately, even with no one from the company in the room); link the article.
T4 — the diagnostic framed as "rather than keep making the case, I'd rather show you."
T5 — before the next brand/positioning decision, see the human and AI picture side by side.
T6 — two worlds, one brand.
T7 — breakup, door open, diagnostic as the easy first step.
`
};

// ── PART 2 ROUTER: Pick the correct signal block ──────────────────────────────

/**
 * getSignalBlock()
 * Returns the signal-specific instructions block for the assembled prompt.
 * Rebrand routes to News/Press per Zack's confirmed decision.
 * Returns null if signal_type is unrecognised — caller handles this.
 * @param {string} signalType
 * @returns {string|null}
 */
function getSignalBlock(signalType) {
  // Normalise — handles both 'Job Change' and 'job_change' formats
  const normalised = (signalType || '').trim();

  const lookup = {
    'Job Change':              SIGNAL_BLOCKS['Job Change'],
    'job_change':              SIGNAL_BLOCKS['Job Change'],
    'News/Press':              SIGNAL_BLOCKS['News/Press'],
    'news_press_release':      SIGNAL_BLOCKS['News/Press'],
    'Rebrand':                 SIGNAL_BLOCKS['Rebrand'],       // routes to News/Press block
    'rebrand':                 SIGNAL_BLOCKS['Rebrand'],
    'M&A Activity':            SIGNAL_BLOCKS['M&A Activity'],
    'm_and_a':                 SIGNAL_BLOCKS['M&A Activity'],
    'Funding':                 SIGNAL_BLOCKS['Funding'],
    'funding':                 SIGNAL_BLOCKS['Funding'],
    'Website Visitor':         SIGNAL_BLOCKS['Website Visitor'],
    'website_visitor':         SIGNAL_BLOCKS['Website Visitor'],
    'Brand Strategy Intent':   SIGNAL_BLOCKS['Brand Strategy Intent'],
    'brand_strategy_intent':   SIGNAL_BLOCKS['Brand Strategy Intent'],
  };

  return lookup[normalised] || null;
}

// ── PART 3: PROSPECT DATA ASSEMBLY ───────────────────────────────────────────

/**
 * assembleProspectData()
 * Builds Part 3 of the assembled prompt from signal + contact data.
 * Website Visitor signals: NEVER includes any visit reference.
 * M&A signals: includes TargetCo.
 * Funding signals: includes Sector.
 *
 * All values are sanitised — if a value is missing or null,
 * a safe placeholder is substituted so the prompt never contains
 * "undefined", "null", or blank template slots.
 *
 * @param {object} signal — the full signal object from the pipeline
 * @param {object} contact — { name, firstName, lastName, title, email }
 * @returns {string}
 */
function assembleProspectData(signal, contact) {
  const signalType = signal.type || signal.signal_type || '';
  const isWebsiteVisitor = ['Website Visitor', 'website_visitor'].includes(signalType);
  const isMandA          = ['M&A Activity',    'm_and_a'].includes(signalType);
  const isFunding        = ['Funding',         'funding'].includes(signalType);

  // Safe value extraction — never allow undefined or null in the prompt
  const firstName    = (contact.firstName || contact.first_name || contact.name?.split(' ')[0] || 'there').trim();
  const companyName  = (signal.company_name || signal.company?.name || 'the company').trim();
  const contactTitle = (contact.title || 'executive').trim();
  const industry     = (signal.industry || signal.company?.industry || 'their industry').trim();
  const employeeCount = signal.employee_count || signal.company?.employee_count || null;
  const companyWebsite = signal.company_website || signal.company?.website || null;
  const proofClients = getProofClients(industry);

  // Signal brief — what the pipeline already generated about this signal.
  // For Website Visitor: use a generic industry-focused framing, NEVER the brief
  // (the brief may contain visit language — safer to omit entirely).
  const signalDetail = isWebsiteVisitor
    ? `The company operates in the ${industry} space.`
    : (signal.brief || signal.signal_details || `${signalType} signal detected for ${companyName}.`).slice(0, 500);

  let prospectData = `
PROSPECT DATA:
Contact first name: ${firstName}
Company: ${companyName}
Contact title: ${contactTitle}
Industry: ${industry}
${employeeCount ? `Company size: approximately ${Number(employeeCount).toLocaleString()} employees` : ''}
${companyWebsite ? `Company website: ${companyWebsite}` : ''}

Signal context: ${signalDetail}

Starfish proof clients in ${industry}: ${proofClients}
`;

  // M&A: add TargetCo
  if (isMandA) {
    const targetCo = signal.deal?.seller || signal.acquired_company || null;
    prospectData += `
M&A deal detail: ${companyName} ${signal.deal?.type || 'acquired'} ${targetCo || 'another company'}.
Acquired company name: ${targetCo || 'the acquired company'} — use this name directly in the emails.
`;
  }

  // Funding: add Sector
  if (isFunding) {
    prospectData += `
Sector/Industry: ${industry} — use this name directly in the emails.
`;
  }

  // Website Visitor: explicit instruction to never mention the visit
  if (isWebsiteVisitor) {
    prospectData += `
CRITICAL: Do NOT mention website visits, monitoring, tracking, research signals,
intent data, or digital footprints in any email. Write as if you are proactively
reaching out based on your knowledge of the industry — nothing more.
`;
  }

  return prospectData;
}

// ── PART 4: CALL CLAUDE AND PARSE OUTPUT ─────────────────────────────────────

/**
 * generateClaudeEmails()
 * Main exported function. Assembles the 3-part prompt, calls Claude Sonnet,
 * parses the JSON response, and returns the email objects.
 *
 * Returns an object with email keys, or null on unrecoverable failure.
 * NEVER throws — all errors are caught and returned as { success: false }.
 *
 * @param {object} signal — full signal object from pipeline
 * @param {object} contact — { name, firstName, lastName, title, email }
 * @returns {Promise<{
 *   success: boolean,
 *   emails?: {
 *     email_1_subject: string,
 *     email_1_body: string,
 *     email_2_body: string,
 *     email_3_body: string,
 *     email_4_body: string,
 *     email_5_body: string,
 *     email_6_body: string,
 *     email_7_body?: string   ← undefined for Website Visitor
 *   },
 *   touchCount?: number,      ← 6 or 7
 *   error?: string
 * }>}
 */
async function generateClaudeEmails(signal, contact) {
  const signalType      = signal.type || signal.signal_type || '';
  const isWebsiteVisitor = ['Website Visitor', 'website_visitor'].includes(signalType);
  const touchCount      = isWebsiteVisitor ? 6 : 7;

  console.log(`[Email Gen] Starting generation for: ${signal.company_name || signal.company?.name} — ${signalType} (${touchCount} touches)`);

  // Validate required fields before calling Claude
  const firstName = contact.firstName || contact.first_name || contact.name?.split(' ')[0];
  if (!firstName) {
    console.log('[Email Gen] ✗ Missing contact first name — aborting generation');
    return { success: false, error: 'Missing contact first name' };
  }
  if (!signal.company_name && !signal.company?.name) {
    console.log('[Email Gen] ✗ Missing company name — aborting generation');
    return { success: false, error: 'Missing company name' };
  }

  // Get signal block — return failure if signal type is unknown
  const signalBlock = getSignalBlock(signalType);
  if (!signalBlock) {
    console.log(`[Email Gen] ✗ Unknown signal type: "${signalType}" — no signal block found`);
    return { success: false, error: `Unknown signal type: ${signalType}` };
  }

  // Assemble the 3-part prompt
  const prospectData    = assembleProspectData(signal, contact);
  const assembledPrompt = `${MASTER_PROMPT}\n\n${signalBlock}\n\n${prospectData}`;

  // Call Claude Sonnet — NOT Haiku
  let rawText;
  try {
    const response = await anthropic.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 4000,
      messages:   [{ role: 'user', content: assembledPrompt }],
    });

    rawText = response.content[0]?.text;
    if (!rawText) {
      console.log('[Email Gen] ✗ Claude returned empty response');
      return { success: false, error: 'Claude returned empty response' };
    }
  } catch (err) {
    console.log(`[Email Gen] ✗ Claude API call failed: ${err.message}`);
    return { success: false, error: `Claude API error: ${err.message}` };
  }

  // Parse the JSON response.
  // Claude sometimes wraps output in ```json ... ``` fences — strip these.
  // On parse failure, attempt light repair (smart quotes, stray control chars) before giving up.
  let emails;
  try {
    // Strip markdown fences, then strip any preamble text before the first {
    // (Claude occasionally adds "I notice..." commentary before the JSON object)
    const stripped = rawText
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
    // Find the email JSON object specifically — anchors to {"email_1 to avoid
    // slicing at a stray { in preamble text (e.g. "Note: here's the JSON {")
    const anchoredStart = stripped.indexOf('{"email_1');
    const jsonStart     = anchoredStart >= 0 ? anchoredStart : stripped.indexOf('{');
    const clean         = jsonStart > 0 ? stripped.slice(jsonStart) : stripped;

    let parsed = null;

    // First attempt: standard parse
    try {
      parsed = JSON.parse(clean);
    } catch (_) {
      // Second attempt: repair common Claude JSON issues
      // 1. Replace curly/smart quotes with straight quotes
      // 2. Remove ASCII control characters (except \n \r \t)
      // 3. Re-try parse
      const repaired = clean
        .replace(/[\u2018\u2019]/g, "'")          // curly single quotes → straight
        .replace(/[\u201C\u201D]/g, '"')           // curly double quotes → straight
        .replace(/[\u2013\u2014]/g, '-')           // en/em dash → hyphen (safe in JSON)
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ''); // strip illegal control chars

      parsed = JSON.parse(repaired); // let this throw if still broken
    }

    emails = parsed;
  } catch (parseErr) {
    console.log(`[Email Gen] ✗ Failed to parse Claude JSON response: ${parseErr.message}`);
    console.log(`[Email Gen]   Raw response (first 500 chars): ${rawText.slice(0, 500)}`);
    return { success: false, error: 'Failed to parse Claude JSON response', rawText };
  }

  // Validate required keys exist in the parsed response
  const required7 = ['email_1_subject', 'email_1_body', 'email_2_body', 'email_3_body',
                      'email_4_body',   'email_5_body', 'email_6_body', 'email_7_body'];
  const required6 = ['email_1_subject', 'email_1_body', 'email_2_body', 'email_3_body',
                      'email_4_body',   'email_5_body', 'email_6_body'];
  const requiredKeys = isWebsiteVisitor ? required6 : required7;

  const missingKeys = requiredKeys.filter(k => !emails[k] || typeof emails[k] !== 'string' || emails[k].trim() === '');
  if (missingKeys.length > 0) {
    console.log(`[Email Gen] ✗ Claude response missing required keys: ${missingKeys.join(', ')}`);
    return { success: false, error: `Missing email keys: ${missingKeys.join(', ')}`, rawText };
  }

  // Validate no email content is suspiciously short (placeholder or error).
  // Subject lines can be legitimately short — 5 char minimum.
  // Body content should be at least 30 chars.
  for (const key of requiredKeys) {
    const minLen = key === 'email_1_subject' ? 5 : 30;
    if (emails[key].trim().length < minLen) {
      console.log(`[Email Gen] ✗ ${key} is suspiciously short (${emails[key].trim().length} chars) — possible generation error`);
      return { success: false, error: `${key} content too short — likely a generation error` };
    }
  }

  // Strip email_7_body from Website Visitor responses (in case Claude included it anyway)
  if (isWebsiteVisitor && emails.email_7_body) {
    delete emails.email_7_body;
  }

  console.log(`[Email Gen] ✓ Generated ${touchCount} emails for ${signal.company_name || signal.company?.name}`);
  requiredKeys.forEach(k => console.log(`  ${k}: ${emails[k].slice(0, 60).replace(/\n/g, ' ')}...`));

  return { success: true, emails, touchCount };
}

export { generateClaudeEmails, getSignalBlock, assembleProspectData };
