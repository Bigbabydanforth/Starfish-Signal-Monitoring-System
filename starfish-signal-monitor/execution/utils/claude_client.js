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

Respond ONLY with valid JSON. No other text before or after.

JSON format:
{
  "priority": "HIGH" or "MEDIUM" or "LOW",
  "brief": "Two sentence explanation here.",
  "contact_approach": "One sentence suggestion here."
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

Respond ONLY with valid JSON. No other text before or after.

JSON format:
{
  "priority": "HIGH" or "MEDIUM" or "LOW",
  "brief": "Two sentence explanation here.",
  "contact_approach": "One sentence suggestion here."
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

  return {
    priority:         parsed.priority,
    brief:            parsed.brief.trim(),
    contact_approach: parsed.contact_approach.trim()
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
// Uses a single low-token Haiku call — non-critical, failures are silently swallowed.
// Returns a string like "Financial Services" or null on failure.
async function inferIndustry(companyName, website) {
  try {
    const message = await client.messages.create(
      {
        model:      CLAUDE_MODEL,
        max_tokens: 30,
        messages: [{
          role:    'user',
          content: `What industry is "${companyName}" (${website || 'no website'}) in? Reply with ONLY the industry name, nothing else. Use standard categories like: Financial Services, Healthcare, Technology, Legal Services, Real Estate, Consumer Goods, Retail, Manufacturing, Media & Entertainment, Professional Services, Education, Energy, Transportation, Food & Beverage, Hospitality, Construction, Insurance, Telecommunications.`
        }]
      },
      { timeout: 10_000 }
    );
    const text = message.content[0]?.text?.trim();
    return text || null;
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

export { enrichSignal, inferIndustry };
