import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

// Haiku is faster and cheaper than Sonnet — sufficient for signal scoring and brief writing.
// Override with CLAUDE_MODEL env var if you need Sonnet quality for any run.
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';

const SYSTEM_PROMPT = `You are analyzing intent signals for Starfish, a high-end branding agency. Starfish charges $50M+ companies between $50K–$250K for brand strategy, repositioning, and omnichannel activation.

For M&A Activity signals: the entire C-Suite of the acquiring company (CEO, COO, CMO, CFO, CIO, CHRO, etc.) becomes relevant — a merger creates immediate brand integration, repositioning, and culture alignment needs. If a PE firm is involved, the firm's partners are also key contacts as they drive post-acquisition brand strategy decisions.

For Brand Strategy Intent signals: the contact person will be identified and enriched separately by the pipeline. Do NOT invent, guess, or name any specific person. Write only about the company, its situation, and why the intent signal matters. Your contact_approach should recommend which executive role to target (e.g. CMO, VP Marketing) without naming an individual.

For Rebrand signals: priority depends on timing.
- Past tense language ("unveiled new brand", "launched new identity", "completed rebrand", "revealed new logo", "has rebranded", "announced new look", "introduced new identity", "now operating as") = MEDIUM priority. The work is already done — Starfish can offer refinement or future activation.
- Future tense or trigger language ("plans to rebrand", "will rebrand", "as part of merger", "following acquisition", "new CEO announces rebrand", "is rebranding", "in connection with", "to be renamed", "undergoing rebrand") = HIGH priority. This is an active, open opportunity.`;

// Standard template — used for all signal types except Brand Strategy Intent
const USER_PROMPT_TEMPLATE = `Signal Type: {SIGNAL_TYPE}
Company: {COMPANY_NAME}
Industry: {INDUSTRY}
Revenue: {REVENUE}
Employees: {EMPLOYEE_COUNT}
Details: {SIGNAL_DETAILS}
Contact Name: {CONTACT_NAME}
Contact Email: {CONTACT_EMAIL}
Contact Title: {CONTACT_TITLE}

Your tasks:
1. Determine priority: HIGH (perfect fit, urgent need, strong signal), MEDIUM (good fit, worth reaching out, moderate signal), or LOW (edge case, low urgency, weak signal)
2. Write exactly 2 sentences explaining why this signal matters to Starfish
3. Suggest the best contact approach in exactly 1 sentence. If a contact name or email is provided above, personalise the approach to that specific person and include their email address in the sentence.

Additionally, evaluate whether this signal qualifies as BESPOKE — meaning it requires
custom, handcrafted outreach by a senior team member rather than an automated email sequence.

Flag as bespoke = true if ANY of the following are true:
1. The company is a widely recognized household brand (Fortune 100 or equivalent global brand)
   Examples: Apple, Google, Microsoft, Amazon, Nike, Goldman Sachs, JPMorgan, Coca-Cola,
   Pepsi, Disney, Netflix, Walmart, Samsung, IBM, McDonald's, Meta, Ford, GE, Boeing
2. The deal or funding round involved is $1 billion USD or more
3. The contact is C-Suite (CEO, COO, President) at a company with 50,000 or more employees
4. The situation is so specific and context-dependent that a template sequence cannot
   appropriately address it without sounding generic or tone-deaf

For all other signals: bespoke = false. Default to false when uncertain.

Return these additional fields in your JSON response:
- "bespoke": boolean (true or false)
- "bespoke_reason": string (one concise sentence explaining WHY, only when bespoke = true; empty string when false)

Respond ONLY with valid JSON. No other text before or after.

JSON format:
{
  "priority": "HIGH" or "MEDIUM" or "LOW",
  "brief": "Two sentence explanation here.",
  "contact_approach": "One sentence suggestion here.",
  "bespoke": true or false,
  "bespoke_reason": "One sentence reason here, or empty string."
}`;

// BSI-specific template — no contact fields, company-level focus only
const BSI_USER_PROMPT_TEMPLATE = `Signal Type: Brand Strategy Intent
Company: {COMPANY_NAME}
Industry: {INDUSTRY}
Revenue: {REVENUE}
Employees: {EMPLOYEE_COUNT}
Details: {SIGNAL_DETAILS}

This company is actively researching brand strategy online. The specific contact will be found separately — do NOT name or invent any individual.

Your tasks:
1. Determine priority: HIGH (perfect fit, urgent need, strong signal), MEDIUM (good fit, worth reaching out, moderate signal), or LOW (edge case, low urgency, weak signal)
2. Write exactly 2 sentences explaining why this company is a strong Starfish prospect based on their size, industry, and the fact they are actively evaluating branding services
3. Suggest the best contact approach in exactly 1 sentence — recommend which executive role to target (CMO, VP Marketing, Head of Brand, etc.) and the outreach angle. Do not name a specific person.

Additionally, evaluate whether this signal qualifies as BESPOKE — meaning it requires
custom, handcrafted outreach by a senior team member rather than an automated email sequence.

Flag as bespoke = true if ANY of the following are true:
1. The company is a widely recognized household brand (Fortune 100 or equivalent global brand)
   Examples: Apple, Google, Microsoft, Amazon, Nike, Goldman Sachs, JPMorgan, Coca-Cola,
   Pepsi, Disney, Netflix, Walmart, Samsung, IBM, McDonald's, Meta, Ford, GE, Boeing
2. The deal or funding round involved is $1 billion USD or more
3. The contact is C-Suite (CEO, COO, President) at a company with 50,000 or more employees
4. The situation is so specific and context-dependent that a template sequence cannot
   appropriately address it without sounding generic or tone-deaf

For all other signals: bespoke = false. Default to false when uncertain.

Return these additional fields in your JSON response:
- "bespoke": boolean (true or false)
- "bespoke_reason": string (one concise sentence explaining WHY, only when bespoke = true; empty string when false)

Respond ONLY with valid JSON. No other text before or after.

JSON format:
{
  "priority": "HIGH" or "MEDIUM" or "LOW",
  "brief": "Two sentence explanation here.",
  "contact_approach": "One sentence suggestion here.",
  "bespoke": true or false,
  "bespoke_reason": "One sentence reason here, or empty string."
}`;

function buildUserMessage(promptVars) {
  const isBSI = promptVars.SIGNAL_TYPE === 'Brand Strategy Intent';
  const template = isBSI ? BSI_USER_PROMPT_TEMPLATE : USER_PROMPT_TEMPLATE;

  let msg = template
    .replace('{SIGNAL_TYPE}',    promptVars.SIGNAL_TYPE    || 'Unknown')
    .replace('{COMPANY_NAME}',   promptVars.COMPANY_NAME   || 'Unknown')
    .replace('{INDUSTRY}',       promptVars.INDUSTRY       || 'Unknown')
    .replace('{REVENUE}',        promptVars.REVENUE        || 'Unknown')
    .replace('{EMPLOYEE_COUNT}', promptVars.EMPLOYEE_COUNT || 'Unknown')
    .replace('{SIGNAL_DETAILS}', promptVars.SIGNAL_DETAILS || 'No details available.');

  if (!isBSI) {
    msg = msg
      .replace('{CONTACT_NAME}',  promptVars.CONTACT_NAME  || 'Not available')
      .replace('{CONTACT_EMAIL}', promptVars.CONTACT_EMAIL || 'Not available')
      .replace('{CONTACT_TITLE}', promptVars.CONTACT_TITLE || 'Not available');
  }

  return msg;
}

function parseAndValidate(text) {
  // Strip markdown code fences if Claude wraps the JSON in them
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (parseErr) {
    throw new Error(`Claude returned non-JSON response: ${parseErr.message}. Raw: ${cleaned.slice(0, 200)}`);
  }

  if (!['HIGH', 'MEDIUM', 'LOW'].includes(parsed.priority)) {
    throw new Error(`Invalid priority value: ${parsed.priority}`);
  }
  if (!parsed.brief || typeof parsed.brief !== 'string' || !parsed.brief.trim()) {
    throw new Error('Missing or empty brief in Claude response');
  }
  if (!parsed.contact_approach || typeof parsed.contact_approach !== 'string' || !parsed.contact_approach.trim()) {
    throw new Error('Missing or empty contact_approach in Claude response');
  }

  // LOW priority + bespoke is a contradiction: if Claude rates the signal low value,
  // routing it to senior team for handcrafted outreach wastes their time.
  const bespoke = parsed.bespoke === true && parsed.priority !== 'LOW';
  const bespokeReason = bespoke && (typeof parsed.bespoke_reason === 'string')
    ? parsed.bespoke_reason.slice(0, 300).trim()
    : '';

  return {
    priority:         parsed.priority,
    brief:            parsed.brief.trim(),
    contact_approach: parsed.contact_approach.trim(),
    bespoke,
    bespoke_reason:   bespokeReason
  };
}

async function callClaude(userMessage) {
  const message = await client.messages.create(
    {
      model:      CLAUDE_MODEL,
      max_tokens: 1000,
      system:     SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }]
    },
    { timeout: 30_000 }  // 30s — prevents pipeline hang if Claude API is slow
  );

  const text = message.content[0]?.text;
  if (!text) throw new Error('Claude returned an empty response body');
  return text;
}

// Infer the industry for a company when Apollo/PDL returned nothing.
// Uses Sonnet for a more accurate guess — this is the last resort fallback.
// Returns a string like "Financial Services" or null on failure.
async function inferIndustry(companyName, website) {
  try {
    const message = await client.messages.create(
      {
        model:      'claude-sonnet-4-6',
        max_tokens: 30,
        messages: [{
          role:    'user',
          content: `What industry is "${companyName}" (${website || 'no website'}) in? Reply with ONLY the industry name, nothing else. Use standard categories like: Financial Services, Healthcare, Technology, Legal Services, Real Estate, Consumer Goods, Retail, Manufacturing, Media & Entertainment, Professional Services, Education, Energy, Transportation, Food & Beverage, Hospitality, Construction, Insurance, Telecommunications.`
        }]
      },
      { timeout: 10_000 }
    );
    const text = message.content[0]?.text?.trim();
    if (!text) return null;
    // Reject hedge/refusal responses — a valid industry label is short (1-5 words).
    // If Claude can't determine the industry, it hedges with a long sentence — drop it.
    if (text.length > 60) return null;
    if (/\b(I don'?t|I cannot|I can'?t|I am not|without (a |additional |more )?context|insufficient|not enough information)\b/i.test(text)) return null;
    return text;
  } catch (_) {
    return null;  // non-critical — caller falls back to 'Unknown'
  }
}

// Enrich a signal using Claude API.
// promptVars: { SIGNAL_TYPE, COMPANY_NAME, INDUSTRY, REVENUE, EMPLOYEE_COUNT, SIGNAL_DETAILS }
// Returns: { priority, brief, contact_approach }
async function enrichSignal(promptVars) {
  const userMessage = buildUserMessage(promptVars);

  try {
    const text = await callClaude(userMessage);
    return parseAndValidate(text);
  } catch (error) {
    // Rate limit -- wait 60 seconds and retry once
    if (error.status === 429 || error.response?.status === 429) {
      console.warn('[Claude] Rate limited (429) -- waiting 60s before retry...');
      await new Promise(resolve => setTimeout(resolve, 60_000));
      const text = await callClaude(userMessage);
      return parseAndValidate(text);
    }
    throw error;
  }
}

// Classify a News/Press signal as M&A or not.
// Returns { is_ma: bool, acquired_company: string|null, confidence: 'high'|'medium'|'low' }.
// Never throws — returns { is_ma: false, acquired_company: null, confidence: 'low' } on any error.
async function classifyMaSignal(company, details, brief) {
  const prompt = `Company: ${company || 'Unknown'}

Signal Details: ${details || 'No details available'}

Brief: ${brief || 'No brief available'}

Is this an M&A (merger/acquisition/buyout/takeover) signal?
If yes, what is the name of the company being acquired/merged?

Respond ONLY with JSON:
{"is_ma": true or false, "acquired_company": "Company Name" or null, "confidence": "high" or "medium" or "low"}`;

  try {
    const message = await client.messages.create(
      {
        model:      CLAUDE_MODEL,
        max_tokens: 150,
        system:     'You are classifying news signals for a sales intelligence system. Determine whether a signal describes M&A activity: an acquisition, merger, buyout, takeover, or similar deal where one company is purchasing or merging with another. Return ONLY valid JSON — no other text.',
        messages:   [{ role: 'user', content: prompt }],
      },
      { timeout: 20_000 }
    );

    const text = message.content[0]?.text?.trim();
    if (!text) throw new Error('Empty response');

    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const parsed  = JSON.parse(cleaned);

    return {
      is_ma:            parsed.is_ma === true,
      acquired_company: typeof parsed.acquired_company === 'string' && parsed.acquired_company.trim()
        ? parsed.acquired_company.trim()
        : null,
      confidence: ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'low',
    };
  } catch (_) {
    return { is_ma: false, acquired_company: null, confidence: 'low' };
  }
}

export { enrichSignal, inferIndustry, classifyMaSignal };
