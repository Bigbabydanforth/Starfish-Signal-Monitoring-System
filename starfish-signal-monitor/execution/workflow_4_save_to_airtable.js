/*
 * EMAIL VERIFICATION UPGRADE — June 2026
 *
 * All email assignment now routes through verifyEmail(email, source, apolloStatus)
 * from utils/email_validator.js. Returns { valid, flagged, reason }.
 *
 * Sources and fail policy:
 *   'apollo'    → Layer 1 is Apollo email_status (free). 'verified'/'likely_to_engage'
 *                 → accept immediately. 'risky' → run Hunter verifier. Otherwise discard.
 *   'hunter'    → Always run Hunter verifier. Unavailable → accept flagged (fail open).
 *   'puppeteer' → Always run Hunter verifier. Unavailable → discard (fail closed).
 *
 * Flagged emails (valid but risky): stored with email_flagged / _email_flagged = true
 * so formatContactInfo() can append [unverified] to the Airtable Contact Info field.
 *
 * BSI T1 (AudienceLab identity-resolved contacts): isFakeEmail() only — no verifyEmail().
 * BSI T2 / T3 contacts that fail verification: skipped (reachability filter drops
 * contacts with no email AND no LinkedIn — preserving LinkedIn-only contacts).
 *
 * circuit_breaker.js — no changes. Hunter verifier calls are protected inside verifyEmail().
 */

import 'dotenv/config';
import fs from 'fs';
import axios from 'axios';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

import * as airtableClient from './utils/airtable_client.js';
import { createRecordsInBase } from './utils/airtable_client.js';
import { getTodayStamp, getTodayString, formatShortDate } from './utils/date_helpers.js';
import { formatRevenue, formatNumber } from './utils/text_parsing.js';
import { sendErrorAlert } from './utils/telegram_client.js';
import { findEmailWithPuppeteer, findCompanyDomain, findEmailPatternViaGoogle } from './utils/puppeteer_email_finder.js';
import { getKnownDomain } from './utils/known_domains.js';
import { isFakeEmail, verifyEmail } from './utils/email_validator.js';
import { getBreaker } from './utils/circuit_breaker.js';
import { extractDomain, findEmailWithApollo, findEmailWithHunterPerson, findEmailWithHunterDomain, HUNTER_BSI_TITLE_KEYWORDS, HUNTER_BSI_DEPT_KEYWORDS } from './utils/email_enrichment.js';
import { pushSignalToHubSpot } from '../hubspot/pushSignalToHubSpot.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TMP_DIR = resolve(__dirname, '../.tmp');

// ── BSI strict title allowlist ────────────────────────────────────────────────
// Only contacts matching these roles are allowed into Airtable for BSI signals.
// Protects Carly's time and keeps the database clean — drop anything else.
// Marketing/brand leadership, senior C-suite (own the brand budget), and
// communications leaders. Finance, ops-only, HR, tech, legal, etc. are excluded.
const BSI_ALLOWED_TITLE_KEYWORDS = [
  // Marketing & Brand C-suite
  'cmo', 'chief marketing', 'chief brand', 'chief communications',
  // General C-suite (valid T3 targets — they greenlight brand spend)
  'ceo', 'chief executive',
  'coo', 'chief operating',
  'president',
  // Bare VP — approved when no disqualifying function is present (REJECTED_TITLE_WORDS runs first).
  // "VP of Sales", "VP of Finance", "VP of IT" etc. are all blocked by REJECTED_TITLE_WORDS.
  'vp',
  // VP-level Marketing / Brand / Communications
  'vp marketing', 'vp of marketing', 'vp brand', 'vp of brand',
  'vp communications', 'vp of communications',
  'vice president marketing', 'vice president of marketing',
  'vice president brand', 'vice president of brand',
  'vice president communications', 'vice president of communications',
  'svp marketing', 'svp brand', 'svp communications',
  'svp of marketing', 'svp of brand', 'svp of communications',
  'evp marketing', 'evp brand', 'evp communications',
  'evp of marketing', 'evp of brand', 'evp of communications',
  'senior vice president marketing', 'senior vice president brand',
  'senior vice president of marketing', 'senior vice president of brand',
  'executive vice president marketing', 'executive vice president brand',
  'executive vice president of marketing', 'executive vice president of brand',
  // NOTE: bare SVP / EVP / Managing Director / Partner removed — these passed wrong contacts
  // at PE firms, investment banks, real estate firms, construction companies, SaaS, telecom etc.
  // because there is no firm-type check available from the title alone. Only marketing/brand/comms
  // qualified versions are kept (e.g. "SVP Marketing", "EVP Brand", "Managing Director, Brand").
  // Head / Director level — senior practitioners with budget influence
  'head of marketing', 'head of brand', 'head of communications',
  'director of marketing', 'marketing director',
  'director of brand', 'brand director', 'director of brand marketing',
  'director of communications', 'communications director',
];

// Short C-suite abbreviations that must match as whole words, not substrings.
// Without this, 'coo' matches "c-o-ordinator", 'cmo' matches "commodity", etc.
// 'partner' uses word-boundary matching to prevent 'partnerships' / 'partnership manager'
// from matching. The bare keyword must appear as a whole word (e.g. "Senior Partner",
// "Managing Partner") not as part of "partnerships" or "partner account manager".
// Short C-suite abbreviations that must match as whole words, not substrings.
// 'svp', 'evp', 'partner' removed — bare seniority titles no longer in the allowlist.
const BSI_SHORT_ABBREVS = new Set(['cmo', 'ceo', 'coo', 'cro', 'cbo', 'vp']);

// Hard junior words — always rejected, even before the marketing override check.
// These are support/admin roles that should never pass even if a marketing exec's
// name appears in the title (e.g. "Executive Assistant to the Chief Marketing Officer").
// 'former ' (with trailing space) blocks "Partner and Former CEO", "Former CMO" etc. — past roles.
// 'emeritus' blocks "President Emeritus" — retired title.
const HARD_JUNIOR_WORDS = [
  'assistant', 'intern', 'trainee', 'clerk', 'emeritus',
  // 'presidente' (Spanish) slips through isTitleCSuite's `includes('president')` check.
  // No English legitimate title contains 'presidente' — safe to hard-block.
  'presidente',
  // 'people &' / 'people and' blocks "People & Communications Director" before the
  // marketing override fires on "communications director". HR+Comms hybrids are not targets.
  'people &', 'people and',
  // Sub-director levels — too junior for outreach even if a marketing keyword appears.
  // Blocks "Associate Director of Communications", "Deputy Director of Communications",
  // "Senior Manager, Head of Marketing" before the marketing override fires on them.
  'associate director', 'deputy director', 'senior manager',
  // 'brand partnerships' — "VP, Brand Partnerships" at talent/sports agencies is sponsorship
  // SALES, not internal marketing leadership. Must block BEFORE the override fires on 'vp brand'.
  'brand partnerships',
  // 'football' — "Managing Director Football" at Octagon is a divisional MD for the
  // football practice, not a company-level executive. Sports vertical qualifier.
  'football',
  // 'national ambassador' — signals MLM/direct-sales distributor titles, not real execs.
  'national ambassador',
  // 'community developer' — "Community Developer / President" at National Field Representatives.
  // A community outreach role with a slash-appended President title is not a real C-suite exec.
  'community developer',
  // 'career center' — "President" at "Union College Career Center" is a campus unit head.
  'career center',
  // 'chief of staff' — support/admin role. Fires before isTitleCSuite's CEO check so
  // "Chief of Staff to President & CEO" is not wrongly approved because CEO appears in the title.
  'chief of staff',
  // Unconditional junior & non-employed exclusions (checked before any marketing override)
  'analyst', 'specialist', 'coordinator', 'administrator', 'representative', 'recruiter',
  'seeking', 'self employed', 'self-employed', 'freelance', 'contractor', 'student', 'open to work',
  'independent consultant', 'independent distributor', 'qualified', 'ambassador',
];

// Soft junior words — rejected after the marketing override check.
// These can appear in legitimate marketing titles (e.g. "Associate Director of Marketing")
// so they only block when no core marketing phrase is present.
const JUNIOR_TITLE_WORDS = [
  'coordinator', 'associate', 'junior',
  'specialist', 'administrator', 'representative', 'recruiter',
  'analyst', // Note: "Brand Analyst" is too junior for Starfish's engagement level
  'advisor',  // "CEO Advisor", "Senior Advisor" — advisory roles, not decision-makers
];

// Titles that disqualify a contact regardless of seniority.
// A "VP of Sales", "Director of HR", or "VP of Tax" is not a Starfish target.
// NOTE: short abbreviations with word boundaries ('hr ', 'it ') use trailing space
// to avoid matching words like "sharing" or "digital". 'data' is caught separately
// via \bdata\b regex in isTitleApproved to handle it at end-of-string too.
const REJECTED_TITLE_WORDS = [
  // Sales / Revenue
  'sales',
  'commercial',              // "EVP Commercial - Americas" / "EVP Chief Commercial Officer" — revenue/sales role
  'business development',    // "SVP of Business Development" — sales function
  // HR / People / Talent
  'hr ', 'human resources', 'talent acquisition', 'talent partner', 'talent management',
  'people operations',            // "VP of People Operations" — HR function
  'recruiter', 'recruiting',      // "SVP Recruiting", "Senior Recruiter" — HR
  'vp of talent', 'svp talent',  // "VP of Talent", "SVP Talent" — HR leadership
  'chief people',                 // "Chief People Officer" — HR
  'chief human',                  // "Chief Human Resources Officer" — HR
  'people experience',       // "People Experience Partner" — HR
  'people partner',          // "People Partner North LATAM" — HR
  'talent sourcing',         // "Talent Sourcing Strategy Partner" — HR/recruiting
  'sourcing partner',        // "Senior Talent Sourcing Partner" — HR/recruiting
  'recruitment partner',     // "Recruitment Partner" — HR
  'ta partner',              // "TA Senior Sourcing Partner" — talent acquisition
  'acquisition partner',     // "Talent and Acquisition Partner" — HR/recruiting
  'learning & development', 'learning and development',  // L&D roles
  // Finance / Tax / Investments
  'finance', 'financial', 'accounting', 'accountant', 'tax', 'treasury', 'controller', 'comptroller',
  'billing', 'accounts payable', 'accounts receivable', 'purchasing',
  'cfo', 'chief financial officer',
  'investor relations',
  'quantitative',            // "Managing Director of Quantitative Strategies" — quant finance
  'investments',             // "Managing Director - Horizons Investments" — finance
  'originations',            // "Managing Director, Originations" — lending
  'lending',                 // "EVP, National Director Retail Home Lending"
  'leasing',                 // "Managing Director, Americas Leasing" — real estate/finance
  'real assets',             // "Senior Managing Director, Infrastructure & Real Assets"
  'wealth management',       // "VP of Wealth Management" — finance
  'asset management',        // finance
  'equity trading', 'trading',
  'investment',               // "Co-Founder and Co-Managing Partner at Cordillera Investment Partners"
  'private equity',           // "Private Equity Operating Partner" (already caught by 'operating partner', belt-and-suspenders)
  // Technology / Engineering / IT / Security
  'engineer', 'engineering', 'developer', 'technical', 'information technology', 'it ',
  'technology',              // "Managing Director, Technology Risk"
  'cyber',                   // "Managing Director, Cyber Solutions"
  'information security', 'chief information security',
  'cio', 'chief information officer',
  'infrastructure',          // "Senior Managing Director, Infrastructure & Real Assets" / "EVP, Chief Information Security & Infrastructure Officer"
  'data center',             // "EVP & Leader, CBRE Data Center Capital Markets"
  // Operations / Procurement / Real Estate / Admin / Construction
  'operations', 'operating', // "SVP & Chief Operating Officer" — 'operating' catches it where 'operations' misses
  'procurement', 'supply chain', 'logistics',
  'new homes',               // "Executive Vice President - New Homes Division" — real estate ops
  'administration', 'admin', 'facilities', 'construction', 'manufacturing', 'economics', 'economic',
  // Legal / Compliance
  'legal', 'counsel', 'attorney', 'compliance',
  // Product / Project
  'product manager', 'product management', 'product owner', 'project manager', 'program manager',
  'scrum',                     // "Scrum Master", "VP Scrum & Agile" — engineering/PMO
  'devops',                    // "DevOps Engineer", "VP DevOps" — engineering
  'data science',              // "VP of Data Science" — analytics/engineering
  'data ',                     // "VP of Data Strategy", "Head of Data Engineering" — trailing space avoids matching 'database'
  // Events / Exhibitions (production, not brand strategy)
  'exhibitions',             // "Executive Vice President, Exhibitions"
  // Account management / sales hybrid
  'account director',        // "Executive Vice President - Group Account Director" — agency account mgmt
  'account manager',         // "Senior Account Manager" — sales/CRM role, not marketing leadership
  'account executive',       // "Account Executive" — sales role
  // Field/regional sales management
  'branch manager',          // "Branch Manager" — local ops/sales
  'district manager',        // "District Manager" — regional sales ops
  'territory manager',       // "Territory Manager" — field sales
  'regional manager',        // "Regional Manager" — field sales ('regional director' already blocks)
  'store manager',           // "Store Manager" — retail ops
  'retail manager',          // "Retail Manager" — retail ops
  // Food / nutrition product roles
  'nutrition',               // "EVP, Nutrition" — product/ops role
  // Research / Science / Academic
  'scientist', 'researcher', 'graphic designer', 'content creator',
  'office manager',
  'research',                // "Managing Director, Research, Advocacy & Standards"
  // Note: 'emeritus' is in HARD_JUNIOR_WORDS — no need to duplicate here
  // Data / analytics
  'analytics',
  // Non-marketing "partner" compound titles — prevents bare 'partner' from approving
  // HR, ops, IT, sales, and channel relationship roles.
  'business partner', 'technology partner', 'solutions partner',
  'channel partner', 'alliance partner', 'implementation partner',
  'effectiveness partner',   // "Organizational Effectiveness Partner" — HR
  'partner services',        // "Partner Services Manager" — ops/vendor
  'partner manager',         // "Senior Partner Manager - EMEA" — channel sales
  'partner engagement',      // "HPE Partner Engagement Lead" — channel sales
  'partner trainer',         // "Partner Trainer" — L&D
  'operating partner',       // "Private Equity Operating Partner" — PE ops
  'client partner',          // "Client Partner" — account management / sales
  'creative partner',        // "Global Creative Partner" — production role
  'site partner',            // "Site Partner" — ops
  'cross functional partner', // "Cross-Functional Partner" (hyphen normalized to space)
  'co-innovation', 'co innovation', // "Global Director Partner Co-Innovation" — tech/product (both pre/post hyphen normalization)
  'partner account',         // "Partner Account Manager" — sales role
  'partner member',          // "Partner Member | Risk Solutions" — HR/risk
  'acquisition partner',     // "Talent and Acquisition Partner" — HR/recruiting
  // DEI / Inclusion
  'chief inclusion',         // "EVP, Chief Inclusion Officer" — DEI/HR
  // Other finance/ops EVP disqualifiers
  'branch leader',           // "EVP-Branch Leader Professional Lines Broker"
  'economist',               // "Chief Economist and Partner"
  // Retail / merchandising
  'merchandising',
  // Insurance / specialist medical / specialist roles that slip through
  'anesthesiology', 'auditor', 'inspector',
  // Junior / Support / Admin roles — not decision-makers with brand budget
  // CORE_MARKETING_OVERRIDE fires first, so "Associate Director of Marketing" is safe.
  'associate director',      // "Associate Director" — junior to Director; override saves "Assoc Dir of Marketing"
  'associate vp',            // "Associate VP" — junior; override saves "Associate VP Marketing"
  'assistant vice president', // written-out form of AVP
  'assistant vp',            // abbreviated form
  'coordinator',             // "Events Coordinator", "Marketing Coordinator" — junior support
  'specialist',              // "Brand Specialist", "Marketing Specialist" — junior individual contributor
  'intern ',                 // "Marketing Intern" — trailing space avoids matching 'internal'
  'trainee',                 // "Management Trainee" — junior/entry level
  'junior ',                 // "Junior Brand Manager" — trailing space avoids false matches
  // AVP = Assistant Vice President — junior, not a decision-maker
  'avp',
  // Additional VP function words not covered above — ensures bare 'vp' approval
  // doesn't let "VP of X" slip through for non-marketing functions.
  'client relations',        // "VP of Client Relations" — account mgmt
  'internal audit',          // "VP of Internal Audit" — audit/finance
  'quality assurance',       // "VP of Quality Assurance" — ops
  'perioperative',           // "VP of Perioperative Clinical Services" — medical ops
  'treasurer',               // "VP & Treasurer" — finance
  'academics',               // "VP of Academics" — education admin
  'experiential production', // "VP of Experiential Production" — events/production
  'liquefaction',            // "VP of Floating Liquefaction" — energy ops
  'program management',      // "VP of Program Management" — ops/PMO
  'project development',     // "VP of Project Development" — ops
  'software',                // "VP of Software Engineering"
  // 'general manager' removed — "General Manager and Managing Director" was wrongly rejected
  // because 'general manager' in REJECTED blocked the MD component. Bare "General Manager"
  // without MD falls through the allowlist and is correctly not approved.
  'banking',                 // "President of Retail Banking" — finance/banking line of business
  'campus',                  // "President at Cedar Valley Campus" — education admin, not marketing
  'wireline',                // "President, Wireline" — technical telecom division, not marketing
  'division',                // "Division President", "Division CEO" — explicitly a sub-unit role
  'portfolio manager',       // "CEO, Managing Partner, and Portfolio Manager" — investment role
  'high net worth',          // "Prime President, High Net Worth & Specialty Programs" — finance
  'regional managing',       // "Regional Managing Director" — 'regional director' misses this
                             // because 'managing' sits between 'regional' and 'director'
  'country managing',        // "President & Country Managing Director France" — country-level MD
  'brand partnerships',      // "VP Brand Partnerships" at talent/sports agencies — sponsorship sales, not marketing
  // Geographic/regional qualifiers — reject any C-suite or MD title scoped to a region.
  // Marketing titles are safe: CORE_MARKETING_OVERRIDE fires before REJECTED reaches these.
  // e.g. "VP Marketing EMEA" → override catches 'vp marketing' → approved.
  // e.g. "Managing Director EMEA" → no override match → REJECTED catches 'emea' → blocked.
  'emea', 'apac', 'latam',
  'eastern region', 'western region',
  'north america', 'south america', 'latin america',
  'south asia', 'southeast asia', 'asia pacific',
  'americas', 'europe',
  'safety',                  // "VP of Safety" — ops/compliance
  'architecture',            // "VP of Architecture" — IT/tech
  'customer support', 'customer experience', 'customer success', // CX roles
  'public affairs', 'public sector',  // government/comms-adjacent but not brand
  'real estate',             // "VP of Real Estate" — facilities
  'regional director',       // compound title, ops
  'development',             // "VP of Development" — fundraising/real estate
  'onboarding',              // "VP of Onboarding" — ops
  'delivery',                // "VP of Delivery" — ops/services
  // Clinical / healthcare ops
  'nursing', 'nurse',        // "VP Chief Nursing Officer", "Chief Nursing Executive" — clinical
  'physician', 'doctor',     // clinical titles — not marketing decision-makers
  'clinical',                // "VP Clinical Operations", "Medical Director Clinical" — healthcare ops
  'medical director',        // "Medical Director" — clinical, not brand leadership
  'patient care',            // "VP Patient Care" — healthcare ops
  'care coordinator',        // "Care Coordinator" — healthcare ops
  'anesthesia', 'anesthesiology', // both forms — clinical specialist
  'revenue cycle',           // "VP Revenue Cycle Management" — healthcare finance
  // Ops / internal improvement
  'process improvement',     // "VP Business & Process Improvement" — ops/PMO
  // Board / Governance / Investors — not operating marketing leaders
  'board of directors',      // "Member, Board of Directors" — governance role
  'board member',            // "Board Member" — governance role
  'executive chairman',      // "Executive Chairman" — governance, not CMO-equivalent
  'vice chairman',           // "Vice Chairman" — governance (global affairs already blocks the common compound form)
  'investor',                // "Investor", "Angel Investor" — 'investor relations' already in list, belt-and-suspenders
  'venture partner',         // "Venture Partner" — VC/PE, not a brand buyer
  'general partner',         // "General Partner" — VC/PE
  'managing partner',        // "Managing Partner" — VC/PE or law firm; CORE_MARKETING_OVERRIDE fires first for "Managing Partner & CMO"
  // Diplomatic / policy
  'global affairs',          // "Vice Chairman, Global Affairs" — policy/diplomacy, not brand
  // Vague/non-marketing VP function
  'engagement strategy',     // "VP Engagement Strategy" — unclear, not brand leadership
  // Manufacturing / supply chain ops
  'contract manufacturing',  // "Director of Contract Manufacturing" — ops, not brand
  // Unemployment / job-seeking states — person has no brand budget to spend
  'seeking',                 // "Seeking New Opportunity", "Currently Seeking" — unemployed
  'open to work',            // LinkedIn "Open to Work" headline used as title
  'self employed',           // "Self-Employed" (hyphen normalized to space) — no company budget
  'freelance',               // "Freelance CMO" — independent contractor, not a brand buyer
  'consultant at self',      // LinkedIn "Consultant at Self-Employed" style — no company budget
  'in transition',           // "Currently in Transition" — between roles
  // Customer/partner success — account management, not marketing leadership
  'partner success',         // "Partner Success Specialist", "Partner Success Manager"
];

// Core marketing title substrings that override REJECTED_TITLE_WORDS.
// When a title contains one of these, the contact is approved immediately — before
// REJECTED_TITLE_WORDS and JUNIOR_TITLE_WORDS run. This prevents "Director of Marketing
// Operations", "VP Marketing & Creative Ops", "Associate Director of Marketing", and
// "Marketing Director - Global Financial Services" from being wrongly rejected because
// a non-marketing word ("operations", "financial", "associate") appears as a modifier.
// These are long, specific phrases — substring matching is safe (no short-abbrev risk).
const CORE_MARKETING_OVERRIDE_KEYWORDS = [
  'chief marketing', 'chief brand', 'chief communications',
  'vp marketing', 'vp of marketing', 'vp brand', 'vp of brand',
  'vp communications', 'vp of communications',
  'vice president marketing', 'vice president of marketing',
  'vice president brand', 'vice president of brand',
  'vice president communications', 'vice president of communications',
  'svp marketing', 'svp brand', 'svp communications',
  'svp of marketing', 'svp of brand', 'svp of communications',
  'evp marketing', 'evp brand', 'evp communications',
  'evp of marketing', 'evp of brand', 'evp of communications',
  'senior vice president marketing', 'senior vice president of marketing',
  'senior vice president brand', 'senior vice president of brand',
  'executive vice president marketing', 'executive vice president of marketing',
  'executive vice president brand', 'executive vice president of brand',
  'head of marketing', 'head of brand', 'head of communications',
  'director of marketing', 'marketing director',
  'director of brand', 'brand director', 'director of brand marketing',
  'director of communications', 'communications director',
  'director of content marketing',  // content marketing is a marketing function
  'director of product marketing',  // product marketing is a marketing function
  // Comma-normalized variants: "Senior Director, Marketing" → "senior director marketing"
  // These don't contain "of" so they miss the patterns above without these entries.
  'director marketing', 'director brand', 'director communications',
  // MarTech — "EVP - AI, MarTech, and Marketing Futures" at the Association of National
  // Advertisers is an EVP of a marketing technology function. 'martech' is a unique enough
  // term that it only appears in marketing-domain titles.
  'martech',
  // VP/SVP/EVP Public Affairs — at nonprofits and associations this is the top comms/PR role.
  'vp public affairs', 'vp of public affairs',
  'vice president public affairs', 'vice president of public affairs',
  'svp public affairs', 'svp of public affairs',
  'evp public affairs', 'evp of public affairs',
  // Head of / EVP / SVP Public Relations — PR is a communications function.
  // "EVP & Head of Public Relations" at Laughlin Constable was wrongly rejected because
  // bare EVP is no longer in the allowlist and "public relations" wasn't in the override.
  'head of public relations',
  'evp public relations', 'evp of public relations', 'evp & head of public relations',
  'svp public relations', 'svp of public relations',
  'vp public relations', 'vp of public relations',
  'vice president public relations', 'vice president of public relations',
  'director of public relations', 'public relations director',
];

// Marketing-only subset of BSI_ALLOWED_TITLE_KEYWORDS — excludes CEO/COO/President.
// Computed once at module load. Used by isTitleApproved() so C-suite contacts
// can be tracked separately and only added as explicit fallbacks via isTitleCSuite().
// Bare 'svp'/'evp'/'senior vice president'/'executive vice president' are not in
// BSI_ALLOWED_TITLE_KEYWORDS anymore (removed above), so this filter only needs to
// exclude the C-suite entries that remain in the allowlist.
const MARKETING_TITLE_KEYWORDS = BSI_ALLOWED_TITLE_KEYWORDS.filter(
  k => !['ceo', 'chief executive', 'coo', 'chief operating', 'president'].includes(k)
);

// Maximum broadcast contacts kept per company for BSI signals.
// Keeps the Airtable queue manageable and prevents one company flooding Carly's inbox.
const MAX_CONTACTS_PER_COMPANY = 4;

// ── Title classification helpers ─────────────────────────────────────────────

// Returns true for marketing/brand/comms roles only — CMO, VP Marketing, Head of Brand, etc.
// Does NOT include CEO/COO/President — those are handled separately by isTitleCSuite().
// Shared prefix check (JUNIOR_TITLE_WORDS, REJECTED_TITLE_WORDS, data) runs first so
// "Marketing Coordinator" or "VP of Sales" never leaks through on a keyword match.
function isTitleApproved(title) {
  if (!title) return false;
  // raw_t: normalized but WITH parenthetical content — used for REJECTED checks so that
  // "Europe (People) Partner" → raw_t contains "people" and matches 'people partner'.
  const raw_t = title.toLowerCase().trim()
    .replace(/-/g, ' ')
    .replace(/,\s*/g, ' ')
    .replace(/[()]/g, ' ')  // strip parenthesis chars but keep content for REJECTED check
    .replace(/\s+/g, ' ')
    .trim();
  // t: full normalization including stripping parenthetical content — used for allowlist
  // matching so "(CEO)" in a long title doesn't accidentally trigger an allowlist match.
  const t = title.toLowerCase().trim()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/-/g, ' ')
    .replace(/,\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Titles with a date in parentheses like "Partner (starting 1/9/23)" indicate a future
  // or tentative role — not a current decision-maker. Reject unconditionally.
  if (/\(\s*(?:starting|from|as of|effective|joining)\s/i.test(title) || /\(\s*\d{1,2}\/\d{1,2}\/\d{2,4}\s*\)/i.test(title)) return false;
  // 'former' block — only when the title STARTS with "former", meaning the entire current
  // role is a past one (e.g. "Former CEO", "Former CMO"). Does NOT block titles like
  // "Partner and Former CEO" where the person is currently a Partner.
  if (raw_t.startsWith('former ')) return false;
  // "People & X" / "People + X" / "People / X" — HR+Comms hybrid titles.
  // "People & Communications Director" at Kone mixes HR and Comms functions. The string
  // check 'people &' in HARD_JUNIOR_WORDS may miss non-standard ampersand characters from
  // LinkedIn data, so this regex catches all separator variants unconditionally.
  if (/^people\s*[&+\/]/i.test(title)) return false;
  // Hard junior words block unconditionally — even before the marketing override.
  if (HARD_JUNIOR_WORDS.some(w => raw_t.includes(w))) return false;
  // CMO check runs FIRST — if the title contains CMO it is approved regardless of other
  // functions present (e.g. "EVP, CRO, CMO" — the CMO mandate is what matters for Starfish).
  if (/(?:^|[\s,/&-])cmo(?:[\s,/&-]|$)/.test(t)) return true;
  // Geographic scope check — runs BEFORE the marketing override so that geographically scoped
  // marketing titles ("Marketing & Communications Director APAC", "Head Of Marketing, Us",
  // "Strategic Marketing Director - Arizona Market") are rejected as regional roles.
  // CMO is exempt (caught above) — regional CMOs are acceptable targets for Starfish.
  // NOTE: 'us' uses word-boundary to avoid matching "business", "focus" etc.
  const GEO_SCOPE = [
    'emea', 'apac', 'latam',
    'eastern region', 'western region',
    'north america', 'south america', 'latin america',
    'south asia', 'southeast asia', 'asia pacific',
    'americas', 'europe',
    'india', 'brazil', 'france', 'china', 'japan', 'germany', 'australia', 'canada',
    'arizona', 'texas', 'california', 'florida', // US state markets
  ];
  if (GEO_SCOPE.some(q => raw_t.includes(q))) return false;
  // "Head Of Marketing, Us" → after normalization ends with " us" — catch US geographic suffix.
  if (/\bus\s*$/.test(raw_t)) return false;
  // 'sales' pre-override block — "SVP Marketing & Sales Operations" must not slip through.
  // Pure marketing titles never contain 'sales'. Word-boundary regex avoids false matches
  // on "wholesale" or "resales". Fires before the marketing override so 'svp marketing'
  // in the override can't approve a combined Marketing & Sales title.
  if (/\bsales\b/.test(raw_t)) return false;
  // Analytics is a data/tech function — block before override so 'director of marketing'
  // can't approve 'director of marketing analytics'. Word-boundary avoids false matches.
  if (/\banalytics\b/.test(raw_t)) return false;
  // Product-line / segment qualifiers after a marketing title signal a narrow product role,
  // not company-level brand leadership. "Product Marketing Director, Financials" at Workday
  // is marketing for the Financials product line — not a CMO-equivalent target.
  // 'financials' is checked separately because 'financial' in REJECTED fires after the override.
  if (/\bfinancials\b/.test(raw_t)) return false;
  // Core marketing phrases override soft-junior and REJECTED filters — approve immediately.
  if (CORE_MARKETING_OVERRIDE_KEYWORDS.some(k => t.includes(k))) return true;
  // CRO (Chief Revenue Officer) is a sales role — block AFTER the CMO/marketing override
  // checks above, so a pure CRO title is rejected but "EVP, CRO, CMO" is already approved.
  if (/(?:^|[\s,/&-])cro(?:[\s,/&-]|$)/.test(t) || t.includes('chief revenue')) return false;
  if (JUNIOR_TITLE_WORDS.some(w => raw_t.includes(w))) return false;
  // Run REJECTED on raw_t so "(People) Partner" → "people partner" is caught.
  if (REJECTED_TITLE_WORDS.some(w => raw_t.includes(w))) return false;
  if (/\bdata\b/.test(raw_t)) return false;
  return MARKETING_TITLE_KEYWORDS.some(k => {
    if (BSI_SHORT_ABBREVS.has(k)) {
      return new RegExp(`(?:^|[\\s,/&-])${k}(?:[\\s,/&-]|$)`).test(t);
    }
    return t.includes(k);
  });
}

// Returns true for CEO/COO/President only — used as a C-suite fallback when
// fewer than MAX_CONTACTS_PER_COMPANY approved marketing contacts exist.
// Word-boundary regex prevents 'coo' matching 'coordinator', 'president' matching
// 'vice president of operations', etc.
function isTitleCSuite(title) {
  if (!title) return false;
  // raw_t keeps parenthetical content for HARD/JUNIOR/REJECTED checks (same as isTitleApproved).
  const raw_t = title.toLowerCase().trim()
    .replace(/-/g, ' ')
    .replace(/,\s*/g, ' ')
    .replace(/[()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const t = title.toLowerCase().trim()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/-/g, ' ')
    .replace(/,\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (/\(\s*(?:starting|from|as of|effective|joining)\s/i.test(title) || /\(\s*\d{1,2}\/\d{1,2}\/\d{2,4}\s*\)/i.test(title)) return false;
  if (raw_t.startsWith('former ')) return false;
  if (/^people\s*[&+\/]/i.test(title)) return false;
  // Hard junior words block unconditionally — even CEOs can be "acting" or "former".
  if (HARD_JUNIOR_WORDS.some(w => raw_t.includes(w))) return false;
  if (JUNIOR_TITLE_WORDS.some(w => raw_t.includes(w))) return false;
  // CRO (Chief Revenue Officer) is a sales role — block before C-suite checks.
  if (/(?:^|[\s,/&-])cro(?:[\s,/&-]|$)/.test(t) || t.includes('chief revenue')) return false;
  // Geographic qualifiers that signal a regional/division CEO or COO — not company-level.
  // Used inline on CEO and COO because those checks run BEFORE REJECTED (needed to stop
  // 'operating' in REJECTED from blocking COO). By checking geo terms here directly,
  // "CEO APAC", "CEO North America", "COO Brazil", "COO EMEA" are all rejected.
  const GEO_QUALIFIERS = [
    // Geographic regions — regional/subsidiary CEO/COO is not company-level
    'emea', 'apac', 'latam',
    'eastern region', 'western region',
    'north america', 'south america', 'latin america',
    'south asia', 'southeast asia', 'asia pacific',
    'americas', 'europe',
    'india', 'brazil', 'france', 'china', 'japan', 'germany', 'australia', 'canada',
    // Named business unit / segment qualifiers — "CEO, Specialty + Benefits" at CRC Group,
    // "CEO, Specialty" at insurance firms etc. are division CEOs, not company-level.
    'specialty', 'benefits', 'wireline', 'banking', 'campus',
  ];
  // CEO and COO are checked BEFORE REJECTED so 'operating' in REJECTED doesn't block COO.
  // Strip any "former [role]" / "and former [role]" suffix before checking — prevents
  // "Partner and Former CEO" from being approved as a CEO when the current role is Partner.
  const t_no_former = t.replace(/\b(?:and\s+)?former\s+\w[\w\s]*/g, '').replace(/\s+/g, ' ').trim();
  if (t_no_former.includes('chief executive') || /(?:^|[\s,/&-])ceo(?:[\s,/&-]|$)/.test(t_no_former)) {
    // Reject regional/division CEOs — "CEO Europe", "CEO APAC", "CEO Eastern Region", etc.
    if (GEO_QUALIFIERS.some(q => t_no_former.includes(q))) return false;
    return true;
  }
  // Block CFO before approving COO — "CFO/COO" hybrid title must not slip through as COO.
  if (raw_t.includes('cfo') || raw_t.includes('chief financial')) return false;
  if (t.includes('chief operating') || /(?:^|[\s,/&-])coo(?:[\s,/&-]|$)/.test(t)) {
    // Reject regional/division COOs — "COO Brazil", "COO North America", etc.
    if (GEO_QUALIFIERS.some(q => t.includes(q))) return false;
    return true;
  }
  // Run REJECTED here — after CEO/COO (which must bypass 'operating') but BEFORE President/
  // Chairman. This catches division presidents like "President of Retail Banking" or
  // "President at Cedar Valley Campus" — REJECTED sees 'banking'/'campus' and returns false.
  if (REJECTED_TITLE_WORDS.some(w => raw_t.includes(w))) return false;
  if (t.includes('president') && !t.includes('vice president')) {
    // Structural check: only approve if "president" is standalone or paired with a recognised
    // C-suite co-title. Division/regional/segment presidents ("President, New Energies",
    // "President- Sport & Lifestyle", "President, Cognizant Americas", "President at
    // NationsMarket", "Agency President of ...", "President of Media & New Enterprises")
    // all have a qualifier after "president" that is NOT a C-suite co-title — reject them.
    const PRESIDENT_CO_OK = [
      'ceo', 'chief executive', 'coo', 'chief operating',
      'chairman', 'cmo', 'chief marketing',
      'founder', 'co founder', 'cofounder',
      'cro', 'chief revenue', 'cbo',
      'co',   // "Co-President" prefix
    ];
    // Remove the word "president" itself, then check what remains.
    const qualifier = t.replace(/\bpresident\b/g, '').replace(/\s+/g, ' ')
      .replace(/^[&,/\s]+|[&,/\s]+$/g, '').trim();
    if (!qualifier || PRESIDENT_CO_OK.some(c => qualifier.includes(c))) return true;
    // Non-empty qualifier that isn't a C-suite co-title — division/regional president.
    return false;
  }
  if (t.includes('chairman')) return true;
  // NOTE: bare EVP / SVP are PRIMARY contacts (isTitleApproved), not fallbacks here.
  return false;
}

// General seniority floor for non-BSI signal contacts (Job Change, WV, News/Press).
// Not marketing-specific — checks if the person is Director/VP/C-suite level.
// Called before email enrichment to avoid API calls on junior contacts.
function isSeniorEnough(title) {
  if (!title) return false;
  const raw_t = title.toLowerCase().trim()
    .replace(/-/g, ' ')
    .replace(/,\s*/g, ' ')
    .replace(/[()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const t = title.toLowerCase().trim()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/-/g, ' ')
    .replace(/,\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (/\(\s*(?:starting|from|as of|effective|joining)\s/i.test(title) || /\(\s*\d{1,2}\/\d{1,2}\/\d{2,4}\s*\)/i.test(title)) return false;
  if (raw_t.startsWith('former ')) return false;
  if (HARD_JUNIOR_WORDS.some(w => raw_t.includes(w))) return false;
  if (JUNIOR_TITLE_WORDS.some(w => raw_t.includes(w))) return false;
  if (REJECTED_TITLE_WORDS.some(w => raw_t.includes(w))) return false;
  if (/\bdata\b/.test(raw_t)) return false;
  return (
    t.includes('chief') ||
    t.includes('vice president') ||
    /\bvp\b/.test(t) ||
    /\bsvp\b/.test(t) ||
    /\bevp\b/.test(t) ||
    t.includes('director') ||
    t.includes('head of') ||
    (t.includes('president') && !t.includes('vice president')) ||
    /(?:^|[\s,/&-])ceo(?:[\s,/&-]|$)/.test(t) ||
    /(?:^|[\s,/&-])coo(?:[\s,/&-]|$)/.test(t) ||
    t.includes('managing director') ||
    t.includes('managing partner') ||
    t.includes('partner')
  );
}

// BSI contact allowlist gate — accepts marketing/brand/comms roles (isTitleApproved)
// plus CEO/COO/President as last-resort fallback (isTitleCSuite).
// Behaviour is identical to the original single-function implementation; the separation
// exists so isTitleCSuite() can be used explicitly in the cap/priority logic.
function isBSIAllowedTitle(title) {
  return isTitleApproved(title) || isTitleCSuite(title);
}

// Returns true when a contact has a usable full name (first + last, no single-letter initials).
// Single-letter last names ('S', 'K') are initials from bad data — Hunter person-finder
// and email pattern construction both require a real last name to work correctly.
// Also rejects obvious placeholder / junk names from bad API data.
const JUNK_NAMES = new Set(['unknown', 'n/a', 'na', 'test', 'null']);
function isNameComplete(contact) {
  const first = (contact.first_name || '').trim();
  const last  = (contact.last_name  || '').trim();
  if (!first || !last)               return false;
  if (first.length <= 1)             return false;
  if (last.length  <= 1)             return false;
  if (JUNK_NAMES.has(first.toLowerCase())) return false;
  if (JUNK_NAMES.has(last.toLowerCase()))  return false;
  return true;
}

// Returns false when a contact's title indicates they are not currently employed
// (job-seeking headlines, self-employed, freelance). Handles both raw and hyphen-normalized
// forms — isTitleApproved/isTitleCSuite already normalize hyphens, but this function
// is called early before those checks in some paths.
const UNEMPLOYED_SIGNALS = [
  'seeking', 'open to work', 'open to opportunities',
  'job seeker', 'looking for', 'self employed',
  'freelance', 'consultant at self',
  'seeking new opportunity', 'seeking opportunities',
  'in transition', 'between roles'
];
function isCurrentlyEmployed(contact) {
  const title = (contact.title || '').toLowerCase().replace(/-/g, ' ');
  return !UNEMPLOYED_SIGNALS.some(s => title.includes(s));
}

// Returns false when a contact's title signals MLM distributor / independent rep status.
// These contacts are not corporate employees with brand budget — they are individual
// distributors whose email domain won't match the corporate domain anyway.
// Called as a gate before any contact is saved to Airtable.
const MLM_TITLE_SIGNALS = [
  'qualified', 'national marketing director',
  'independent', 'distributor',
  'brand ambassador', 'brand partner'
];
function isCorporateEmployee(contact) {
  const title = (contact.title || '').toLowerCase().replace(/-/g, ' ');
  return !MLM_TITLE_SIGNALS.some(m => title.includes(m));
}

// Email domain validation — reject emails that don't belong to the company's domain.
// Catches cases like Goldman Sachs contact with @aquilafunds.com email (wrong company).
// If companyWebsite is unknown, rejects the email — we can't validate what we don't have.
// Allows subdomain variations (john@us.sunlife.com passes for sunlife.com) but NOT
// sibling country domains (john@sunlife.com.ph fails for sunlife.com — different entity).
function isEmailDomainValid(email, companyWebsite) {
  if (!email || !companyWebsite) return false;

  const emailDomain = email.split('@')[1]?.toLowerCase().trim();
  const companyDomain = companyWebsite
    .replace(/https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split('/')[0]
    .toLowerCase().trim();

  if (!emailDomain || !companyDomain) return false;

  // Accept exact match (john@sunlife.com → sunlife.com)
  // or subdomain match (john@us.sunlife.com → sunlife.com).
  const valid = emailDomain === companyDomain || emailDomain.endsWith('.' + companyDomain);
  if (!valid) {
    console.log(`  [DomainCheck] ❌ ${email} — domain "${emailDomain}" does not match company domain "${companyDomain}" — rejecting`);
  }
  return valid;
}


// ── BSI send-day assignment — determines outreach sequence ─────────────────────
// Day 1: CMO / VP Marketing / Chief Brand Officer  (owns budget)
// Day 2: CEO / President                           (top decision-maker)
// Day 3: COO                                       (ops integration context)
// Day 4: Head/Director of Marketing or Brand       (senior practitioners)
// Day 5: Communications roles                      (brand visibility angle)
function assignSendDay(title) {
  if (!title) return 5;
  const t = title.toLowerCase();
  if (['cmo', 'chief marketing', 'chief brand',
       'vp marketing', 'vp of marketing', 'vp brand', 'vp of brand',
       'svp marketing', 'svp of marketing', 'evp marketing', 'evp of marketing',
       'senior vice president marketing', 'senior vice president of marketing',
       'senior vice president brand', 'senior vice president of brand',
       'executive vice president marketing', 'executive vice president of marketing',
       'executive vice president brand', 'executive vice president of brand',
       'vice president marketing', 'vice president of marketing',
       'vice president brand', 'vice president of brand',
       'vp brand marketing', 'vp of brand marketing'].some(k => t.includes(k))) return 1;
  // 'ceo'/'coo' need word boundary — 'coo' must not match 'coordinator'
  // 'president' must not match 'vice president operations' (only standalone President)
  if (t.includes('chief executive') || t.includes('chief executive officer') ||
      /(?:^|[\s,/&-])ceo(?:[\s,/&-]|$)/.test(t) ||
      (t.includes('president') && !t.includes('vice president'))) return 2;
  if (t.includes('chief operating') ||
      /(?:^|[\s,/&-])coo(?:[\s,/&-]|$)/.test(t)) return 3;
  if (['head of marketing', 'head of brand',
       'director of marketing', 'marketing director',
       'director of brand', 'brand director'].some(k => t.includes(k))) return 4;
  if (['communications', 'comms'].some(k => t.includes(k))) return 5;
  return 5;
}

// ── Apollo broadcast search — find up to 5 contacts across all exec + marketing + comms roles ──
// Used exclusively for BSI signals. Returns an array of contact objects (never throws).
//
// NEW LOGIC (July 2026):
// Search uses has_email flag (free, in search result) to identify unlockable contacts BEFORE
// spending any credits. Email unlock uses POST /people/match (correct reveal endpoint).
// GET /people/{id} was the old approach — it only reads cached data and CANNOT unlock emails.
// Contacts without has_email still come through for LinkedIn-only outreach.
async function apolloBroadcastSearch(domain) {
  if (!process.env.APOLLO_API_KEY || !domain) return [];
  if (getBreaker('apollo').isOpen()) {
    console.log(`  [Apollo/Broadcast] ⚡ Circuit open — skipping ${domain}`);
    return [];
  }

  const baseUrl = process.env.APOLLO_API_URL || 'https://api.apollo.io/v1';
  const body = {
    // Apollo API requires unprefixed params for title and seniority filtering in api_search.
    // Prefixed q_person_titles / q_person_seniorities are silently ignored by the endpoint.
    // organization_domains (unprefixed) is silently ignored; we use q_organization_domains.
    // Title list sourced from utils/title_lists.js — APPROVED_TITLES first, CSUITE_FALLBACK second.
    person_titles: [
      // ── APPROVED: Primary titles (marketing/brand/comms) ─────────────────────
      'Chief Marketing Officer', 'CMO',
      'Chief Brand Officer', 'CBO',
      'Chief Communications Officer',
      'VP Marketing', 'VP of Marketing', 'Vice President Marketing', 'Vice President of Marketing',
      'VP Brand', 'VP of Brand', 'VP Brand Marketing',
      'VP Communications', 'VP of Communications',
      'Vice President Brand', 'Vice President of Brand',
      'Vice President Communications', 'Vice President of Communications',
      'SVP Marketing', 'SVP of Marketing', 'Senior Vice President of Marketing', 'Senior Vice President Marketing',
      'SVP Brand', 'SVP of Brand', 'Senior Vice President Brand', 'Senior Vice President of Brand',
      'SVP Communications', 'SVP of Communications',
      'EVP Marketing', 'EVP of Marketing', 'Executive Vice President of Marketing', 'Executive Vice President Marketing',
      'EVP Brand', 'EVP of Brand', 'Executive Vice President Brand', 'Executive Vice President of Brand',
      'EVP Communications', 'EVP of Communications',
      'Head of Marketing', 'Head of Brand', 'Head of Communications',
      'Director of Marketing', 'Marketing Director',
      'Director of Brand', 'Brand Director', 'Director of Brand Marketing',
      'Director of Communications', 'Communications Director',
      'VP Public Affairs', 'VP of Public Affairs', 'Vice President Public Affairs', 'Vice President of Public Affairs',
      'SVP Public Affairs', 'EVP Public Affairs',
      'Head of Public Relations', 'VP Public Relations', 'VP of Public Relations',
      'Vice President Public Relations', 'Director of Public Relations', 'Public Relations Director',
      // ── CSUITE FALLBACK: Used only when no marketing contact found ────────────
      'CEO', 'Chief Executive Officer',
      'COO', 'Chief Operating Officer',
      'President',
      'Managing Partner', 'Senior Partner', 'Equity Partner', 'Founding Partner',
      'Managing Director'
    ],
    person_seniorities: ['c_suite', 'vp', 'head', 'director', 'owner', 'partner'],
    person_locations:   ['United States'],  // narrows to US contacts — same as fetchMaCSuite
    q_organization_domains: domain,
    per_page: 10,
    page: 1
  };

  // Up to 3 attempts on 429: wait 15s after attempt 1, wait 30s after attempt 2.
  const RETRY_DELAYS = [15000, 30000];
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await axios.post(`${baseUrl}/mixed_people/api_search`, body, {
        headers: { 'X-Api-Key': process.env.APOLLO_API_KEY, 'Content-Type': 'application/json' },
        timeout: 15000
      });
      getBreaker('apollo').recordSuccess();
      const people = res.data?.people || [];
      console.log(`  [Apollo/Broadcast] ${people.length} contacts found at ${domain} (${people.filter(p => p.has_email).length} with email available)`);

      // ── Unlock emails via POST /people/match ─────────────────────────────────
      // has_email: true on the search result means Apollo CAN return a real email for this person.
      // POST /people/match is the correct unlock endpoint — costs 1 credit per call.
      // GET /people/{id} (old approach) only reads cached profile data, cannot unlock emails.
      // Contacts with has_email: false still get their LinkedIn URL for fallback outreach.
      const enriched = [];
      for (const p of people) {
        let email       = null;
        let emailStatus = null;
        let lastName    = p.last_name || '';
        let linkedinUrl = p.linkedin_url || null;

        if (p.has_email && p.id && isBSIAllowedTitle(p.title)) {
          // Unlock email — 1 Apollo credit (only for approved/C-suite titles)
          try {
            const matchRes = await axios.post(`${baseUrl}/people/match`, {
              id: p.id,
              reveal_personal_emails: false
            }, {
              headers: { 'X-Api-Key': process.env.APOLLO_API_KEY, 'Content-Type': 'application/json' },
              timeout: 15000
            });
            const full = matchRes.data?.person || {};
            const rawEmail = full.email || null;
            email = (rawEmail &&
              rawEmail !== 'email_not_unlocked@domain.com' &&
              !/^[^@]+@domain\.com$/.test(rawEmail))
              ? rawEmail : null;
            emailStatus = full.email_status || null;
            if (!lastName)    lastName    = full.last_name    || '';
            if (!linkedinUrl) linkedinUrl = full.linkedin_url || null;
            if (email) {
              console.log(`  [Apollo/Broadcast] ✅ ${p.first_name} ${lastName} (${p.title}) → ${email}${emailStatus ? ` [${emailStatus}]` : ''}`);
            } else {
              console.log(`  [Apollo/Broadcast] ℹ️  ${p.first_name} ${p.title} — unlock returned no email (has_email flag may be stale)`);
            }
          } catch (matchErr) {
            console.warn(`  [Apollo/Broadcast] Unlock failed for ${p.first_name} (${p.id}): ${matchErr.message}`);
          }
        } else if (p.has_email && p.id && !isBSIAllowedTitle(p.title)) {
          // Title not approved — skip email unlock to save credits, LinkedIn-only fallback
          console.log(`  [Apollo/Broadcast] ⛔ ${p.first_name} ${p.last_name || ''} (${p.title}) — title not target role, skipping unlock`);
        } else if (p.id && (!lastName || !linkedinUrl)) {
          // No email available — use GET /people/{id} (free, no credit) only to retrieve
          // last_name / linkedin_url so Hunter cascade has a complete name to work with.
          try {
            const enrichRes = await axios.get(`${baseUrl}/people/${p.id}`, {
              headers: { 'X-Api-Key': process.env.APOLLO_API_KEY },
              timeout: 15000
            });
            const full = enrichRes.data?.person || {};
            if (!lastName)    lastName    = full.last_name    || '';
            if (!linkedinUrl) linkedinUrl = full.linkedin_url || null;
          } catch (enrichErr) {
            console.warn(`  [Apollo/Broadcast] Profile fetch failed for ${p.first_name} (${p.id}): ${enrichErr.message}`);
          }
        }

        enriched.push({
          firstName:    p.first_name || '',
          lastName,
          title:        p.title      || null,
          linkedin_url: linkedinUrl,
          email,
          email_status: emailStatus
        });
      }
      return enriched;
    } catch (err) {
      const status = err.response?.status;
      if (status === 429 && attempt < 3) {
        const wait = RETRY_DELAYS[attempt - 1];
        console.warn(`  [Apollo/Broadcast] ⏳ Rate limited (429) at ${domain} — retrying in ${wait / 1000}s (attempt ${attempt}/3)...`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      if (status === 401)      console.warn(`  [Apollo/Broadcast] ❌ Unauthorized (401) — check APOLLO_API_KEY`);
      else if (status === 429) console.warn(`  [Apollo/Broadcast] ⏳ Rate limited (429) at ${domain} — all 3 attempts exhausted, marking Contact Needed`);
      else if (status === 422) console.warn(`  [Apollo/Broadcast] ⚠️  422 Unprocessable at ${domain}:`, JSON.stringify(err.response?.data)?.slice(0, 200));
      else {
        console.warn(`  [Apollo/Broadcast] ⚠️  Error at ${domain}: ${err.message}`);
        getBreaker('apollo').recordFailure(err.message);
      }
      return [];
    }
  }
  return [];
}

// ── Broadcast contact search for non-BSI signals ──────────────────────────────
// Reuses apolloBroadcastSearch (which already filters by title, name completeness,
// employment, and unlocks emails) and adds per-contact email verification + send_day.
// Returns up to maxContacts verified contact objects.
// excludeEmail: skip a contact whose email matches Contact #1 (avoids duplicates).
async function runBroadcastContacts(domain, companyName, maxContacts, excludeEmail) {
  const contacts = [];
  if (!domain) return contacts;

  // Step 1: Apollo broadcast search — title-filtered, email-unlocked
  if (!getBreaker('apollo').isOpen()) {
    const apolloContacts = await apolloBroadcastSearch(domain);
    for (const c of apolloContacts) {
      if (contacts.length >= maxContacts) break;
      if (!c.firstName?.trim()) continue;
      // Dedup: skip if this is the same person as Contact #1
      if (excludeEmail && c.email && c.email.toLowerCase() === excludeEmail.toLowerCase()) {
        console.log(`  [Broadcast] ⏭️  ${c.firstName} ${c.lastName || ''} — same as Contact #1`);
        continue;
      }
      const rawEmail = c.email && !isFakeEmail(c.email) ? c.email : null;
      let verifiedEmail = null;
      let emailVerification;
      if (rawEmail) {
        const src = c.email_status ? 'apollo' : 'hunter';
        const result = await verifyEmail(rawEmail, src, c.email_status || null);
        await new Promise(r => setTimeout(r, 300));
        if (result.valid) {
          verifiedEmail     = rawEmail;
          emailVerification = result;
          if (result.flagged) console.log(`  [Broadcast] ⚠️  ${rawEmail} flagged as risky (${result.reason})`);
        } else {
          console.log(`  [Broadcast] ❌ ${rawEmail} failed verification (${result.reason}) — keeping LinkedIn if available`);
        }
      }
      // Drop contacts with no email AND no LinkedIn — completely unreachable
      if (!verifiedEmail && !c.linkedin_url) continue;
      if (!isNameComplete({ first_name: c.firstName, last_name: c.lastName })) {
        console.log(`  [Broadcast] ⛔ ${c.firstName} ${c.lastName || ''} — incomplete name`);
        continue;
      }
      if (!isCurrentlyEmployed({ title: c.title })) {
        console.log(`  [Broadcast] ⛔ ${c.firstName} ${c.lastName || ''} (${c.title}) — not currently employed`);
        continue;
      }
      if (!isCorporateEmployee({ title: c.title })) {
        console.log(`  [Broadcast] ⛔ ${c.firstName} ${c.lastName || ''} (${c.title}) — MLM/distributor title`);
        continue;
      }
      contacts.push({
        first_name:        c.firstName,
        last_name:         c.lastName        || '',
        title:             c.title           || null,
        email:             verifiedEmail,
        email_flagged:     emailVerification?.flagged || undefined,
        emailVerification: emailVerification          || null,
        linkedin_url:      c.linkedin_url    || null,
        source:            'apollo',
        send_day:          assignSendDay(c.title)
      });
      console.log(`  [Broadcast] ➕ ${c.firstName} ${c.lastName || ''} (${c.title || 'Unknown'})${verifiedEmail ? ` → ${verifiedEmail}` : ' — LinkedIn only'}`);
    }
    await new Promise(r => setTimeout(r, 400));
  }

  // Step 2: Hunter domain-search fallback when Apollo returned nothing usable
  if (contacts.length === 0 && process.env.HUNTER_API_KEY && !getBreaker('hunter').isOpen()) {
    console.log(`  [Broadcast/Hunter] Apollo empty — trying Hunter domain-search at ${domain}...`);
    try {
      const hDomRes = await axios.get('https://api.hunter.io/v2/domain-search', {
        params: { domain, api_key: process.env.HUNTER_API_KEY },
        timeout: 15000
      });
      getBreaker('hunter').recordSuccess();
      const hEmails     = hDomRes.data?.data?.emails || [];
      const execMatches = hEmails.filter(e => isBSIAllowedTitle(e.position));
      for (const e of execMatches) {
        if (contacts.length >= maxContacts) break;
        if (!e.first_name?.trim()) continue;
        if (!isNameComplete({ first_name: e.first_name, last_name: e.last_name })) continue;
        if (!isCurrentlyEmployed({ title: e.position })) continue;
        if (!isCorporateEmployee({ title: e.position })) {
          console.log(`  [Broadcast/Hunter] ⛔ ${e.first_name} ${e.last_name || ''} (${e.position}) — MLM/distributor title`);
          continue;
        }
        const rawEmail = e.value && !isFakeEmail(e.value) ? e.value : null;
        let verifiedEmail = null;
        let emailVerification;
        if (rawEmail) {
          const { valid, flagged, reason } = await verifyEmail(rawEmail, 'hunter', null);
          await new Promise(r => setTimeout(r, 300));
          if (valid) { verifiedEmail = rawEmail; emailVerification = { valid, flagged, reason }; }
        }
        if (!verifiedEmail && !e.linkedin) continue;
        contacts.push({
          first_name:        e.first_name,
          last_name:         e.last_name  || '',
          title:             e.position   || null,
          email:             verifiedEmail,
          email_flagged:     emailVerification?.flagged || undefined,
          emailVerification: emailVerification          || null,
          linkedin_url:      e.linkedin   || null,
          source:            'hunter',
          send_day:          assignSendDay(e.position)
        });
        console.log(`  [Broadcast/Hunter] ➕ ${e.first_name} ${e.last_name || ''} (${e.position || 'Unknown'})${verifiedEmail ? ` → ${verifiedEmail}` : ' — LinkedIn only'}`);
      }
    } catch (err) {
      const status = err.response?.status;
      if (status === 429)      console.warn(`  [Broadcast/Hunter] ⏳ Rate limited (429) at ${domain}`);
      else if (status === 401) console.warn(`  [Broadcast/Hunter] ❌ Hunter unauthorized (401)`);
      else { console.warn(`  [Broadcast/Hunter] ⚠️  ${err.message}`); getBreaker('hunter').recordFailure(err.message); }
    }
    await new Promise(r => setTimeout(r, 400));
  }

  if (contacts.length > 0) {
    console.log(`  [Broadcast] ✅ ${companyName} — ${contacts.length} additional contact(s) found at ${domain}`);
  } else {
    console.log(`  [Broadcast] ℹ️  ${companyName} — no additional contacts found at ${domain}`);
  }
  return contacts;
}

// ── Extract named person from a News/Press article ────────────────────────────
// Looks for patterns like "Jane Smith appointed as CMO" or "named John Doe as VP Marketing"
// Returns { firstName, lastName } or null if no name found.
function extractNameFromArticle(signal) {
  const text = [signal.article?.title, signal.article?.description].filter(Boolean).join(' ');
  if (!text) return null;

  // Pattern: "FirstName LastName appointed/named/joins as/hired as <title>"
  // or "appointed/named FirstName LastName as <title>"
  const patterns = [
    // "appointed Jane Smith as CMO" / "named John Doe as VP Marketing"
    /(?:appointed|named|promoted|hired)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\s+(?:as|to)\s+/,
    // "Jane Smith appointed as CMO" / "Jane Smith joins as VP"
    /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\s+(?:appointed|named|joins as|hired as|promoted to)/,
    // "Jane Smith, CMO" — name followed by comma and title keyword
    /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+),\s+(?:CMO|CEO|COO|CBO|President|VP|SVP|EVP|Director|Head of)/,
  ];

  for (const regex of patterns) {
    const match = text.match(regex);
    if (match) {
      const fullName = match[1].trim();
      const parts = fullName.split(/\s+/);
      if (parts.length >= 2) {
        return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
      }
    }
  }
  return null;
}

// ── Apply Hunter email pattern to a person's name ─────────────────────────────
function applyHunterPattern(pattern, firstName, lastName, domain) {
  if (!pattern || !firstName || !domain) return null;
  const first = firstName.toLowerCase().replace(/[^a-z]/g, '');
  if (!first) return null; // M1: non-latin name stripped to empty — would produce @domain.com
  const last  = (lastName || '').toLowerCase().replace(/[^a-z]/g, '');
  // If the pattern requires a last name component but we have none, bail out —
  // otherwise patterns like "{first}.{last}" produce "john." with a trailing dot.
  if (!last && (pattern.includes('{last}') || pattern.includes('{l}'))) return null;
  const f     = first[0] || '';
  const l     = last[0]  || '';
  const local = pattern
    .replace('{first}', first)
    .replace('{last}',  last)
    .replace('{f}',     f)
    .replace('{l}',     l);
  if (!local || local.includes('{')) return null;
  return `${local}@${domain}`;
}

// verifyEmailWithHunter removed — replaced by verifyEmail() imported from utils/email_validator.js.
// verifyEmail() adds Apollo email_status as a free Layer 1 gate and returns null (instead of false)
// when Hunter is unavailable, so callers can choose fail-open vs fail-closed per context.


// ── Apollo people search — find an exec by domain ─────────────────────────────
// For M&A signals: searches full C-Suite (CEO, CFO, COO, etc.)
// For all other signal types: searches marketing titles only
//
// NEW LOGIC (July 2026) — four-pass selection + POST /people/match email unlock:
// Pass 1: marketing/brand title + has_email → unlock immediately (best case, 1 credit)
// Pass 2: marketing/brand title, no email   → return name only, Hunter cascade follows
// Pass 3: C-suite title + has_email         → fallback unlock (1 credit)
// Pass 4: C-suite title, no email           → return name only
// has_email: true is free in the search result — avoids spending credits on guaranteed misses.
async function apolloFindExec(domain, signalType) {
  if (!process.env.APOLLO_API_KEY || !domain) return null;
  if (getBreaker('apollo').isOpen()) {
    console.log(`  [Apollo/exec] ⚡ Circuit open — skipping ${domain}`);
    return null;
  }
  try {
    const baseUrl = process.env.APOLLO_API_URL || 'https://api.apollo.io/v1';
    const titles = signalType === 'M&A Activity'
      ? ['CEO', 'Chief Executive Officer', 'COO', 'Chief Operating Officer',
         'CFO', 'Chief Financial Officer', 'CMO', 'Chief Marketing Officer',
         'President', 'Managing Director',
         'Managing Partner', 'Senior Partner', 'Equity Partner', 'Partner',
         'SVP', 'EVP', 'Senior Vice President', 'Executive Vice President']
      : [
          // ── APPROVED: Primary titles (marketing/brand/comms) — sourced from utils/title_lists.js
          'Chief Marketing Officer', 'CMO',
          'Chief Brand Officer', 'CBO',
          'Chief Communications Officer',
          'VP Marketing', 'VP of Marketing', 'Vice President of Marketing', 'Vice President Marketing',
          'VP Brand', 'VP of Brand', 'VP Brand Marketing',
          'VP Communications', 'VP of Communications',
          'Vice President Brand', 'Vice President of Brand',
          'Vice President Communications', 'Vice President of Communications',
          'SVP Marketing', 'SVP of Marketing', 'Senior Vice President of Marketing', 'Senior Vice President Marketing',
          'SVP Brand', 'SVP of Brand', 'Senior Vice President Brand', 'Senior Vice President of Brand',
          'SVP Communications', 'SVP of Communications',
          'EVP Marketing', 'EVP of Marketing', 'Executive Vice President of Marketing', 'Executive Vice President Marketing',
          'EVP Brand', 'EVP of Brand', 'Executive Vice President Brand', 'Executive Vice President of Brand',
          'EVP Communications', 'EVP of Communications',
          'Head of Marketing', 'Head of Brand', 'Head of Communications',
          'Director of Marketing', 'Marketing Director',
          'Director of Brand', 'Brand Director', 'Director of Brand Marketing',
          'Director of Communications', 'Communications Director',
          'VP Public Affairs', 'VP of Public Affairs', 'Vice President Public Affairs', 'Vice President of Public Affairs',
          'SVP Public Affairs', 'EVP Public Affairs',
          'Head of Public Relations', 'VP Public Relations', 'VP of Public Relations',
          'Vice President Public Relations', 'Director of Public Relations', 'Public Relations Director',
          // ── CSUITE FALLBACK: only used when no marketing contact found ─────────
          'CEO', 'Chief Executive Officer',
          'COO', 'Chief Operating Officer',
          'President',
          'Managing Partner', 'Senior Partner', 'Equity Partner', 'Founding Partner',
          'Managing Director'
        ];

    const departments = signalType === 'M&A Activity'
      ? ['marketing', 'executive']
      : ['marketing'];
    const seniorities = signalType === 'M&A Activity'
      ? ['c_suite', 'vp', 'owner', 'partner']
      : ['c_suite', 'vp', 'head', 'director', 'owner', 'partner'];

    const res = await axios.post(`${baseUrl}/mixed_people/api_search`, {
      person_titles:          titles,
      person_seniorities:     seniorities,
      person_locations:       ['United States'],  // narrows to US contacts — same as fetchMaCSuite
      q_organization_domains: domain,
      per_page:               10
    }, {
      headers: { 'X-Api-Key': process.env.APOLLO_API_KEY, 'Content-Type': 'application/json' },
      timeout: 15000
    });
    getBreaker('apollo').recordSuccess();
    const candidates = res.data?.people || [];
    if (candidates.length === 0) {
      console.log(`  [Apollo/exec] ℹ️  No results for ${domain} (${signalType})`);
      return null;
    }

    // ── Four-pass selection ────────────────────────────────────────────────────
    // Apollo's q_person_titles is a soft filter — can return people with unrelated titles.
    // Prefer marketing/brand contacts with a confirmed email (has_email: true) first.
    // has_email is free in search results — tells us upfront if the unlock will succeed.
    let p = null;
    // Pass 1: marketing/brand + has_email — best case, unlock immediately
    for (const c of candidates) {
      if (c.has_email && isTitleApproved(c.title)) {
        p = c; break;
      }
    }
    // Pass 2: marketing/brand, no email — name only; Hunter cascade will find the email
    if (!p) {
      for (const c of candidates) {
        if (isTitleApproved(c.title)) {
          p = c; break;
        }
      }
    }
    // Pass 3: C-suite fallback + has_email
    // Uses isTitleCSuite() — NOT HUNTER_EXEC_TITLE_KEYWORDS substring match.
    // HUNTER_EXEC_TITLE_KEYWORDS contains 'president' which is a substring of 'vice president',
    // causing "VP Environment Health Safety", "VP of Sales" etc. to pass incorrectly.
    // isTitleCSuite() runs the full rejection pipeline (HARD_JUNIOR_WORDS, REJECTED_TITLE_WORDS)
    // so only real C-suite contacts get through.
    if (!p) {
      for (const c of candidates) {
        if (c.has_email && isTitleCSuite(c.title)) {
          p = c;
          console.log(`  [Apollo/exec] ℹ️  No marketing contact at ${domain} — falling back to ${c.title}`);
          break;
        }
      }
    }
    // Pass 4: C-suite fallback, no email — name only
    if (!p) {
      for (const c of candidates) {
        if (isTitleCSuite(c.title)) {
          p = c;
          console.log(`  [Apollo/exec] ℹ️  No marketing contact at ${domain} — falling back to ${c.title}`);
          break;
        }
        console.warn(`  [Apollo/exec] ⚠️  Skipping ${c.first_name} ${c.last_name || ''} at ${domain} — title "${c.title}" not a marketing/exec role`);
      }
    }
    if (!p) {
      console.log(`  [Apollo/exec] ℹ️  No valid contact found at ${domain} after checking ${candidates.length} candidate(s)`);
      return null;
    }

    // ── Email unlock via POST /people/match ───────────────────────────────────
    // Only when has_email: true — avoids spending 1 credit on a guaranteed miss.
    // GET /people/{id} (old approach) cannot unlock emails — it only reads cached data.
    let email       = null;
    let emailStatus = null;
    let lastName    = p.last_name    || '';
    let linkedinUrl = p.linkedin_url || null;

    if (p.has_email && p.id) {
      try {
        const matchRes = await axios.post(`${baseUrl}/people/match`, {
          id: p.id,
          reveal_personal_emails: false
        }, {
          headers: { 'X-Api-Key': process.env.APOLLO_API_KEY, 'Content-Type': 'application/json' },
          timeout: 15000
        });
        const full = matchRes.data?.person || {};
        const rawEmail = full.email || null;
        email = (rawEmail &&
          rawEmail !== 'email_not_unlocked@domain.com' &&
          !/^[^@]+@domain\.com$/.test(rawEmail))
          ? rawEmail : null;
        emailStatus = full.email_status || null;
        if (!lastName)    lastName    = full.last_name    || '';
        if (!linkedinUrl) linkedinUrl = full.linkedin_url || null;
        if (email) {
          console.log(`  [Apollo/exec] ✅ ${p.first_name} ${lastName} (${p.title}) → ${email}${emailStatus ? ` [${emailStatus}]` : ''}`);
        } else {
          console.log(`  [Apollo/exec] ℹ️  ${p.first_name} (${p.title}) — unlock returned no email, Hunter cascade follows`);
        }
      } catch (matchErr) {
        console.warn(`  [Apollo/exec] Unlock failed for ${p.first_name} (${p.id}): ${matchErr.message}`);
      }
    } else if (p.id && (!lastName || !linkedinUrl)) {
      // No email available — GET /people/{id} is free (no credit) and retrieves last_name
      // + linkedin_url so the Hunter cascade has a complete name to search with.
      try {
        const enrichRes = await axios.get(`${baseUrl}/people/${p.id}`, {
          headers: { 'X-Api-Key': process.env.APOLLO_API_KEY },
          timeout: 15000
        });
        const full = enrichRes.data?.person || {};
        if (!lastName)    lastName    = full.last_name    || '';
        if (!linkedinUrl) linkedinUrl = full.linkedin_url || null;
      } catch (enrichErr) {
        console.warn(`  [Apollo/exec] Profile fetch failed for ${p.first_name} (${p.id}): ${enrichErr.message}`);
      }
    }

    return { firstName: p.first_name, lastName, title: p.title || null, email, emailStatus, linkedin_url: linkedinUrl };
  } catch (err) {
    const status = err.response?.status;
    if (status === 401)      console.warn(`  [Apollo/exec] ❌ Unauthorized (401) — check APOLLO_API_KEY`);
    else if (status === 429) console.warn(`  [Apollo/exec] ⏳ Rate limited (429) at ${domain}`);
    else if (status === 422) console.warn(`  [Apollo/exec] ℹ️  422 Unprocessable at ${domain} — domain not in Apollo database`);
    // 422 is a normal "not found" response, NOT an outage — do not trip the circuit
    else {
      console.warn(`  [Apollo/exec] ⚠️  Error at ${domain}: ${err.message}`);
      getBreaker('apollo').recordFailure(err.message);
    }
    return null;
  }
}

// --- Format Helpers ---

function formatSignalDetails(signal) {
  // If this signal was merged in deduplication, its details are already built — preserve them
  if (signal.signalDetails && signal.signalDetails.startsWith('⚡ SIGNAL SEEN')) {
    return signal.signalDetails.length > 2000
      ? signal.signalDetails.substring(0, 1997) + '...'
      : signal.signalDetails;
  }

  let details = '';

  if (signal.type === 'Job Change') {
    if (!signal.person) return '(Job Change — person data missing)';
    const fullName  = `${signal.person.first_name || ''} ${signal.person.last_name || ''}`.trim();
    const revenue   = signal.company.revenue ? formatRevenue(signal.company.revenue) : 'Unknown revenue';
    const employees = signal.company.employee_count
      ? signal.company.employee_count.toLocaleString() + ' employees' // format number
      : 'Unknown employee count';

    details = `${fullName} joined ${signal.company.name} as ${signal.person.title || 'Unknown'}. `;
    details += `Company: ${signal.company.industry || 'Unknown industry'}, ${revenue}, ${employees}.`;
    if (signal.person.job_started_at) {
      details += ` Started: ${formatShortDate(signal.person.job_started_at)}.`;
    }
  }
  else if (signal.type === 'Website Visitor') {
    const fullName  = signal.person
      ? `${signal.person.first_name || ''} ${signal.person.last_name || ''}`.trim()
      : 'Unknown';
    const title     = signal.person?.title || 'Unknown Title';
    const employees = signal.company.employee_count
      ? signal.company.employee_count.toLocaleString() + ' employees'
      : null;
    details = `${fullName} (${title}) from ${signal.company.name} visited the Starfish website.`;
    if (signal.detected_date)    details += ` Visit: ${signal.detected_date}.`;
    if (signal.company.industry) details += ` Industry: ${signal.company.industry}.`;
    if (employees)               details += ` Company size: ${employees}.`;
  }
  else if (signal.type === 'Brand Strategy Intent') {
    // BSI details focus on the company, not the (discarded) AL contact
    const employees = signal.company.employee_count
      ? signal.company.employee_count.toLocaleString() + ' employees'
      : null;
    details = `${signal.company.name} is actively researching brand strategy online.`;
    if (signal.company.industry) details += ` Industry: ${signal.company.industry}.`;
    if (employees)               details += ` Company size: ${employees}.`;
    if (signal.bsi_contacts?.length > 0) {
      details += ` Broadcast contacts: ${signal.bsi_contacts.length} exec(s) identified.`;
    }
  }
  else if (signal.type === 'News/Press') {
    if (!signal.article) return '(News/Press — article data missing)';
    details = signal.article.title || '';
    if (signal.article.description) details += '. ' + signal.article.description;
    details += ` (Published by ${signal.article.source || 'Unknown'} on ${formatShortDate(signal.article.published_at)})`;
  }
  else if (signal.type === 'M&A Activity') {
    if (!signal.deal?.type) return '(M&A Activity — deal data missing)';
    const dealType = signal.deal.type.replace(/_/g, ' ').toUpperCase();
    details = `${dealType}: ${signal.company.name}`;
    if (signal.deal.seller) details += ` acquiring ${signal.deal.seller}`;
    details += signal.deal.amount ? `. Deal value: $${formatNumber(signal.deal.amount)}` : `. Deal value: Undisclosed`;
    if (signal.deal.seller_revenue > 0) details += `. Target revenue: ${formatRevenue(signal.deal.seller_revenue)}`;
    if (signal.deal.description) details += `. ${signal.deal.description}`;
  }
  else if (signal.type === 'Rebrand') {
    details = `${signal.company.name} is rebranding` +
      (signal.rebrand?.new_name ? ` to ${signal.rebrand.new_name}` : '') +
      (signal.rebrand?.summary ? `. ${signal.rebrand.summary}` : '');
  }

  return details.length > 2000 ? details.substring(0, 1997) + '...' : details;
}

// Maps a stored verification result to the Airtable "Email Verified" single-select field.
function getEmailVerifiedStatus(verification) {
  if (!verification) return 'Unverified';
  if (verification.reason === 'apollo_verified') return 'Verified';
  if (verification.reason === 'apollo_likely')   return 'Likely';
  if (verification.flagged === true)             return 'Risky (Flagged)';
  if (verification.valid   === true)             return 'Verified';
  return 'Unverified';
}

// ── Format a single BSI broadcast contact for the Airtable Contact Info field ──
function formatBSIContactInfo(contact, companyWebsite) {
  const name = `${contact.first_name || ''} ${contact.last_name || ''}`.trim();
  let info = '';
  if (name)               info += `Name: ${name}`;
  if (contact.title)      info += `\nTitle: ${contact.title}`;
  if (contact.email)      info += `\nEmail: ${contact.email}${contact.email_flagged ? ' [unverified]' : ''}`;
  if (contact.linkedin_url) info += `\nLinkedIn: ${contact.linkedin_url}`;
  if (!contact.email && !contact.linkedin_url && companyWebsite) info += `\nWebsite: ${companyWebsite}`;
  if (contact.email_flagged) info += `\nEmail flagged as risky — verify before sending`;
  return info.length > 500 ? info.substring(0, 497) + '...' : info || 'Contact info not available';
}

function formatContactInfo(signal) {
  let info = '';

  const _personName = `${signal.person?.first_name || ''} ${signal.person?.last_name || ''}`.trim();
  if ((signal.type === 'Job Change' || signal.source === 'AudienceLab') && signal.person && _personName) {
    const name = _personName;
    info = `Name: ${name}\nTitle: ${signal.person.title || 'Unknown'}`;
    if (signal.person.linkedin_url)  info += `\nLinkedIn: ${signal.person.linkedin_url}`;
    if (signal.person.email)         info += `\nEmail: ${signal.person.email}${signal._email_flagged ? ' [unverified]' : ''}`;
    else if (signal._puppeteer_email) info += `\nEmail: ${signal._puppeteer_email}${signal._email_flagged ? ' [unverified]' : ''} (via ${signal._puppeteer_source})`;
    if (signal._email_flagged)       info += `\nEmail flagged as risky — verify before sending`;
    if (signal.person.phone)         info += `\nPhone: ${signal.person.phone}`;
    if (signal.person.department)    info += `\nDept: ${signal.person.department}`;
  } else if (signal.type === 'M&A Activity' && signal.ma_contacts?.length > 0) {
    // M&A — list C-Suite contacts of the acquiring company
    // Build lines individually and stop before hitting the 500-char Airtable field limit
    const lines = [];
    let total = 0;
    for (const c of signal.ma_contacts) {
      let line = `${c.name} — ${c.title || 'Unknown Title'}`;
      if (c.email)        line += ` | ${c.email}${c.email_flagged ? ' [unverified]' : ''}`;
      if (c.linkedin_url) line += ` | ${c.linkedin_url}`;
      if (total + line.length + 1 > 490) break; // +1 for \n, leave headroom
      lines.push(line);
      total += line.length + 1;
    }
    info = lines.join('\n');
  } else {
    // News/Press or M&A with no contacts found
    if (signal._puppeteer_email) {
      info = `Email: ${signal._puppeteer_email}${signal._email_flagged ? ' [unverified]' : ''} (via ${signal._puppeteer_source})`;
    } else if (signal.company.website) {
      info = `Company Website: ${signal.company.website}`;
    } else {
      info = 'Contact info not available';
    }
  }

  return info.length > 500 ? info.substring(0, 497) + '...' : info;
}

// broadcastContact: undefined = legacy single-contact signal (use formatContactInfo)
//                  null      = broadcast ran but found nobody ("Contact Needed")
//                  object    = one broadcast contact (BSI or non-BSI multi-contact expansion)
function formatForAirtable(signal, broadcastContact) {
  // Compute and cache Signal Details on the signal object before writing to Airtable.
  // Without this, workflow_4b (Sheets) and workflow_5 (email) never see what was written here
  // and fall back to their own simpler reconstruction logic — producing three different versions
  // of the same field. With this, all consumers read the same rich string Airtable received.
  // Skip if already set (merged signals have signal.signalDetails from workflow_3).
  if (signal.signalDetails == null) {
    signal.signalDetails = formatSignalDetails(signal);
  }

  let contactInfo;
  if (broadcastContact !== undefined) {
    // Broadcast expansion — one record per contact (BSI and non-BSI multi-contact signals).
    if (broadcastContact) {
      contactInfo = formatBSIContactInfo(broadcastContact, signal.company.website);
    } else {
      contactInfo = `⚠️ Contact Needed${signal.company.website ? '\nWebsite: ' + signal.company.website : ''}`;
    }
  } else {
    contactInfo = formatContactInfo(signal);
    // Cache so workflow_4b (Sheets) and workflow_5 (email) show the identical string
    // that was written to Airtable — not a separately rebuilt version.
    // Excluded when broadcast contacts are used — each contact produces its own string.
    signal._contactInfo = contactInfo;
  }

  return {
    fields: {
      'Company Name':          signal.company.name,
      'Signal Type':           signal.type,
      'Signal Details':        signal.signalDetails,
      'Contact Info':          contactInfo,
      'Company Revenue':       signal.company.revenue || null,
      'Company Funding Stage': signal.company.funding_stage || null,
      'Industry':              signal.company.industry || null,
      'Date Detected':         signal.detected_date,
      'Priority':              signal.priority,
      'Brief':                 signal._enrichment_failed
                                 ? `⚠️ [Email enrichment crashed — contact info may be incomplete. Review before outreach.]\n\n${signal.brief || '(no brief)'}`
                                 : signal._claude_failed
                                   ? `⚠️ [Claude enrichment failed — placeholder priority, not a real analysis]\n\n${signal.brief}`
                                   : signal._auto_approved
                                     ? `${signal.brief}\n\n⏱️ Note: This PDL signal was auto-approved (timeout) — not manually reviewed in Telegram.`
                                     : signal.brief,
      'Contact Approach':      signal.contact_approach,
      'Source URL':            signal.source_url || null,
      'Status':                (signal._claude_failed || signal._enrichment_failed) ? 'Needs Review' : 'New',
      'Email Verified':        (broadcastContact && typeof broadcastContact === 'object')
                                 ? getEmailVerifiedStatus(broadcastContact.emailVerification)
                                 : getEmailVerifiedStatus(signal.emailVerification),
      // Send Day: 1–5 stagger for broadcast contacts (BSI and non-BSI). null for legacy single-contact signals.
      'Send Day':              (broadcastContact && typeof broadcastContact === 'object') ? (broadcastContact.send_day || null) : null
    }
  };
}

// ── Expand signals to Airtable records ────────────────────────────────────────
// BSI signals expand to one record per broadcast contact (or one "Contact Needed" record).
// Non-BSI signals with broadcast_contacts also expand one record per contact.
// Signals without broadcast_contacts (e.g. enrichment failed) map 1-to-1 (legacy path).
function expandToRecords(signals) {
  const records = [];
  for (const signal of signals) {
    if (signal.type === 'Brand Strategy Intent') {
      if (signal.bsi_contacts?.length > 0) {
        // Hard cap at 5 contacts per signal — Airtable batches are 10 records max and
        // one signal expanding to 10+ records would overflow a single batch and cause failures.
        const contacts = signal.bsi_contacts.slice(0, 5);
        for (const contact of contacts) {
          const record = sanitizeAirtableRecord(formatForAirtable(signal, contact));
          if (record) records.push(record);
        }
      } else {
        const record = sanitizeAirtableRecord(formatForAirtable(signal, null));
        if (record) records.push(record);
      }
    } else if (signal.broadcast_contacts !== undefined) {
      // Non-BSI broadcast expansion — one record per contact.
      const allContacts = [];

      // Job Change: job-changer themselves = Contact #1 (send_day 1)
      if (signal.type === 'Job Change' && signal.person?.first_name) {
        allContacts.push({
          first_name:        signal.person.first_name,
          last_name:         signal.person.last_name   || '',
          title:             signal.person.title        || null,
          email:             signal.person.email        || signal._puppeteer_email || null,
          email_flagged:     signal._email_flagged      || undefined,
          emailVerification: signal.emailVerification   || null,
          linkedin_url:      signal.person.linkedin_url || null,
          source:            'audiencelab',
          send_day:          1  // job-changer is always the first touchpoint
        });
      }

      // Append broadcast contacts (max 3 additional for Job Change; max 4 for all others)
      const maxBroadcast = signal.type === 'Job Change' ? 3 : 4;
      for (const c of (signal.broadcast_contacts || []).slice(0, maxBroadcast)) {
        allContacts.push(c);
      }

      if (allContacts.length > 0) {
        for (const contact of allContacts) {
          const record = sanitizeAirtableRecord(formatForAirtable(signal, contact));
          if (record) records.push(record);
        }
      } else {
        // Broadcast ran but found nobody — save one "Contact Needed" record
        const record = sanitizeAirtableRecord(formatForAirtable(signal, null));
        if (record) records.push(record);
      }
    } else {
      // broadcast_contacts not set (enrichment failed or type skipped broadcast) — legacy path
      const record = sanitizeAirtableRecord(formatForAirtable(signal));
      if (record) records.push(record);
    }
  }
  return records;
}

function chunkArray(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

// Validate and sanitize a record before sending to Airtable.
// - Drops records missing required fields (returns null — caller skips)
// - Replaces undefined values with null (Airtable API rejects undefined)
// - Truncates long-text fields to Airtable's 100,000-char hard limit
const AIRTABLE_TEXT_LIMIT = 100_000;
const AIRTABLE_REQUIRED   = ['Company Name', 'Signal Type', 'Date Detected'];

function sanitizeAirtableRecord(record) {
  const fields = record.fields;
  for (const key of AIRTABLE_REQUIRED) {
    if (!fields[key]) {
      console.warn(`[Airtable/Validation] Dropping record — missing required field: "${key}" (Company: ${fields['Company Name'] || '?'})`);
      return null;
    }
  }
  const cleaned = {};
  for (const [key, val] of Object.entries(fields)) {
    if (val === undefined) {
      cleaned[key] = null;
    } else if (typeof val === 'string' && val.length > AIRTABLE_TEXT_LIMIT) {
      console.warn(`[Airtable/Validation] Field "${key}" truncated (${val.length} → ${AIRTABLE_TEXT_LIMIT}) for: ${fields['Company Name']}`);
      cleaned[key] = val.slice(0, AIRTABLE_TEXT_LIMIT);
    } else {
      cleaned[key] = val;
    }
  }
  return { fields: cleaned };
}

// ── HubSpot contact extractor ─────────────────────────────────────────────────
// Converts a signal object into the flat contact shape that pushSignalToHubSpot expects.
// Returns an array — most signals produce one contact, BSI and M&A produce several.
function extractHubSpotContacts(signal) {
  const type = signal.type;

  if (type === 'Brand Strategy Intent') {
    return (signal.bsi_contacts || [])
      .filter(c => c.email)
      .map(c => ({
        name:         `${c.first_name || ''} ${c.last_name || ''}`.trim(),
        email:        c.email,
        title:        c.title        || '',
        send_day:     c.send_day     || 1,
        email_source: 'AudienceLab',
      }));
  }

  if (type === 'M&A Activity') {
    return (signal.ma_contacts || [])
      .filter(c => c.email)
      .map(c => ({
        name:         `${c.first_name || ''} ${c.last_name || ''}`.trim(),
        email:        c.email,
        title:        c.title        || '',
        send_day:     1,
        email_source: 'Apollo', // M&A contacts come from fetchMaCSuite() which queries Apollo
      }));
  }

  // Job Change, Website Visitor, News/Press, Rebrand — single contact
  const email = signal.person?.email || signal._puppeteer_email || null;
  if (!email) return [];
  return [{
    name:         signal.person
      ? `${signal.person.first_name || ''} ${signal.person.last_name || ''}`.trim()
      : '',
    email,
    title:        signal.person?.title || '',
    send_day:     1,
    email_source: signal.person?.email ? 'Apollo' : 'Puppeteer',
  }];
}

// --- Main Workflow ---

async function saveToAirtable(deduplicatedSignals) {
  const today    = getTodayStamp();
  const todayStr = getTodayString();

  if (deduplicatedSignals.length === 0) {
    console.log('[Airtable] No signals to save — skipping');
    return 0;
  }

  // Per-run Apollo enrichment cache — avoids duplicate API calls for the same company
  const apolloCache = new Map(); // domain/name → enrichment result for this run

  // Step 4.1: Apollo company enrichment — fill missing revenue, industry, AND website
  // Runs for any signal missing revenue OR website, so Hunter has a domain to work with later.
  console.log('[Airtable] Running Apollo company enrichment...');
  for (const signal of deduplicatedSignals) {
    // Check KNOWN_DOMAINS first — instant, no API call needed
    if (!signal.company.website) {
      const knownDomain = getKnownDomain(signal.company.name);
      if (knownDomain) {
        signal.company.website = `https://${knownDomain}`;
        console.log(`  [Domain] ✅ ${signal.company.name} → ${knownDomain} (KNOWN_DOMAINS)`);
      }
    }

    const needsRevenue = !signal.company.revenue || signal.company.revenue === 0;
    const needsWebsite = !signal.company.website;
    if (!needsRevenue && !needsWebsite) continue; // already have both — skip

    // Only worth calling Apollo if we have a domain or company name
    const website = signal.company.website;
    const name    = signal.company.name;
    if (!website && !name) continue;

    // Check Apollo cache before making an API call.
    // Prefer domain as cache key — it's unambiguous. When no website is available, fall back
    // to a name-based key so the same company isn't queried twice in the same run.
    // Name keys are prefixed with 'name:' to avoid collisions with domain keys.
    const cacheKey = website
      ? website.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/.*$/, '')
      : `name:${name.toLowerCase().trim()}`;
    if (apolloCache.has(cacheKey)) {
      const org = apolloCache.get(cacheKey);
      if (org.website_url && !signal.company.website) {
        signal.company.website = org.website_url;
      }
      const _rev = Number(org.annual_revenue || org.estimated_annual_revenue);
      if (!isNaN(_rev) && _rev > 0 && !signal.company.revenue) {
        signal.company.revenue = _rev;
      }
      signal.company.industry  = signal.company.industry  || org.industry    || null;
      if (signal.company.headquarters) {
        signal.company.headquarters.country = signal.company.headquarters.country || org.country || null;
        signal.company.headquarters.state   = signal.company.headquarters.state   || org.state   || null;
      } else {
        signal.company.headquarters = { city: null, state: org.state || null, country: org.country || null };
      }
      console.log(`  [Apollo] ♻️  ${name} — using cached result`);
      continue;
    }

    try {
      const baseUrl = process.env.APOLLO_API_URL || 'https://api.apollo.io/v1';
      const body = {};
      if (website) {
        body.domain = website.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/.*$/, '');
      } else {
        body.name = name;
      }

      const res = await axios.post(`${baseUrl}/organizations/enrich`, body, {
        headers: { 'X-Api-Key': process.env.APOLLO_API_KEY, 'Content-Type': 'application/json' },
        timeout: 15000
      });
      const org = res.data?.organization || res.data || {};
      // Cache the result — keyed by domain when available, otherwise by 'name:<normalized>'.
      // Both are prefixed differently so they can't collide with each other.
      apolloCache.set(cacheKey, org);

      // Always save website when Apollo finds it — Hunter needs this domain
      if (org.website_url && !signal.company.website) {
        signal.company.website = org.website_url;
        console.log(`  [Apollo] 🌐 ${name} — website: ${org.website_url}`);
      }

      const _rev = Number(org.annual_revenue || org.estimated_annual_revenue);
      if (!isNaN(_rev) && _rev > 0 && !signal.company.revenue) {
        signal.company.revenue = _rev;
        console.log(`  [Apollo] ✅ ${name} — revenue $${(_rev/1e6).toFixed(0)}M`);
      }
      signal.company.industry  = signal.company.industry  || org.industry    || null;
      if (signal.company.headquarters) {
        signal.company.headquarters.country = signal.company.headquarters.country || org.country || null;
        signal.company.headquarters.state   = signal.company.headquarters.state   || org.state   || null;
      } else {
        signal.company.headquarters = { city: null, state: org.state || null, country: org.country || null };
      }
    } catch { /* Apollo error — skip, not critical */ }

    await new Promise(r => setTimeout(r, 400));
  }

  // Step 4.2: Email enrichment — Apollo → Hunter → Puppeteer
  // Runs up to 5 signals concurrently to reduce wall-clock time at scale.
  // Each signal is its own object — parallel mutation is safe.
  // Uses `return` (not `continue`) because this is a standalone async function.
  // Override with ENRICHMENT_CONCURRENCY env var (see execution/utils/config.js for all options)
  const ENRICHMENT_CONCURRENCY = Number(process.env.ENRICHMENT_CONCURRENCY) || 5;
  console.log(`[Airtable] Running email enrichment (Apollo → Hunter → Puppeteer) [concurrency: ${ENRICHMENT_CONCURRENCY}]...`);

  async function enrichOneSignal(signal) {
    console.log(`[Email Enrichment] Starting cascade for: ${signal.company.name} (${signal.type})`);

    // ── Brand Strategy Intent: 4-Tier Contact Waterfall ──────────────────────
    //
    // Tier 1: AL sent the right person WITH a valid email → use them, done.
    // Tier 2: Find ONE marketing/brand decision-maker ourselves → one record.
    // Tier 3: Can't find marketing person → broadcast to up to 5 senior leaders.
    // Tier 4: All cascades exhausted → flag "Contact Needed" for Carly.
    //
    // signal.person is always cleared — contacts live in signal.bsi_contacts[].
    if (signal.type === 'Brand Strategy Intent') {
      const alPerson = signal.person;
      const alTitle  = (alPerson?.title || '').toLowerCase().trim();
      // Marketing/brand titles are the Tier 2 target — matches HUNTER_BSI_TITLE_KEYWORDS
      const alTitleIsBrandMarketing = alTitle && HUNTER_BSI_TITLE_KEYWORDS.some(k => alTitle.includes(k));

      signal.person       = null; // never let the raw AL contact leak into Airtable
      signal.bsi_contacts = [];

      // ── TIER 1: AL sent the right person with a valid email ─────────────────
      // Perfect case — one contact, one record, no APIs needed.
      if (alPerson?.first_name && alTitleIsBrandMarketing) {
        if (alPerson.email && !isFakeEmail(alPerson.email) && isEmailDomainValid(alPerson.email, signal.company?.website)) {
          // T1 AudienceLab contacts are identity-resolved — isFakeEmail() gate only, no Hunter verifier.
          signal.bsi_contacts.push({
            first_name:   alPerson.first_name,
            last_name:    alPerson.last_name  || '',
            title:        alPerson.title,
            email:        alPerson.email,
            linkedin_url: alPerson.linkedin_url || null,
            source:       'audiencelab',
            send_day:     assignSendDay(alPerson.title)
          });
          console.log(`  [BSI/T1] ✅ AL has right person + email — ${alPerson.first_name} ${alPerson.last_name} (${alPerson.title}) → ${alPerson.email}`);
          console.log(`  [BSI] ✅ ${signal.company.name} — Tier 1 complete`);
          return;
        }
      }

      // ── Discover domain (needed for all remaining tiers) ────────────────────
      if (!signal.company.website) {
        const discovered = await findCompanyDomain(signal.company.name);
        if (discovered) {
          signal.company.website = `https://${discovered}`;
          console.log(`  [Domain] ✅ ${signal.company.name} → ${discovered} (via Puppeteer)`);
        }
        await new Promise(r => setTimeout(r, 400));
      }
      const bsiDomain = extractDomain(signal.company?.website);

      // ── TIER 2: Find ONE marketing/brand decision-maker ─────────────────────
      // Target titles: CMO, VP Marketing, Brand Director, Head of Marketing, etc.
      // Stop as soon as we find one — that's enough for our campaign.
      // Order: Apollo first (highest quality) → Hunter person-finder → Hunter domain-search.
      console.log(`  [BSI/T2] Looking for a marketing/brand contact at ${signal.company.name}...`);

      // Step 2.1: Apollo exec search (marketing titles only) — PRIMARY source
      // Apollo has verified professional data and searches by exact title — best quality contact.
      // apolloFindExec now uses POST /people/match when has_email is true, returning email + emailStatus.
      if (bsiDomain && !getBreaker('apollo').isOpen()) {
        const exec = await apolloFindExec(bsiDomain, 'Brand Strategy Intent');
        if (exec) {
          // If Apollo already unlocked an email, verify it before saving.
          let execEmail = null;
          let execEmailVerification;
          if (exec.email && !isFakeEmail(exec.email)) {
            const src    = exec.emailStatus ? 'apollo' : 'hunter';
            const result = await verifyEmail(exec.email, src, exec.emailStatus || null);
            await new Promise(r => setTimeout(r, 400));
            if (result.valid) {
              execEmail = exec.email;
              execEmailVerification = result;
              if (result.flagged) console.log(`  [BSI/T2] ⚠️  Apollo email ${exec.email} flagged as risky (${result.reason}) — saving with [unverified] note`);
            } else {
              console.log(`  [BSI/T2] ❌ Apollo email ${exec.email} failed verification (${result.reason}) — Hunter cascade will follow`);
            }
          }
          signal.bsi_contacts.push({
            first_name:        exec.firstName,
            last_name:         exec.lastName || '',
            title:             exec.title    || null,
            email:             execEmail,
            emailVerification: execEmailVerification,
            linkedin_url:      exec.linkedin_url || null,
            source:            'apollo',
            send_day:          assignSendDay(exec.title)
          });
          console.log(`  [BSI/T2] ✅ Apollo found: ${exec.firstName} ${exec.lastName} (${exec.title})${execEmail ? ` → ${execEmail}` : ' — no email yet, Hunter will follow'}`);
        } else {
          console.log(`  [BSI/T2] ℹ️  Apollo found no marketing contact at ${bsiDomain} — trying Hunter...`);
        }
        await new Promise(r => setTimeout(r, 400));
      }

      // Step 2.2: Hunter person-finder for the AudienceLab contact — FIRST BACKUP
      // Only runs if Apollo found nothing AND AudienceLab gave us a person with the right title but no email.
      if (signal.bsi_contacts.length === 0 && alPerson?.first_name && alTitleIsBrandMarketing && bsiDomain && process.env.HUNTER_API_KEY && !getBreaker('hunter').isOpen()) {
        console.log(`  [BSI/T2] AL has ${alPerson.title} but no email — trying Hunter for ${alPerson.first_name} ${alPerson.last_name}...`);
        try {
          const hRes = await axios.get('https://api.hunter.io/v2/email-finder', {
            params: { domain: bsiDomain, first_name: alPerson.first_name, last_name: alPerson.last_name || '', api_key: process.env.HUNTER_API_KEY },
            timeout: 15000
          });
          getBreaker('hunter').recordSuccess();
          const { email: hEmail, score } = hRes.data?.data || {};
          if (hEmail && score >= 70 && !isFakeEmail(hEmail)) {
            const { valid, flagged, reason } = await verifyEmail(hEmail, 'hunter', null);
            await new Promise(r => setTimeout(r, 400));
            if (valid) {
              if (flagged) console.log(`  [BSI/T2] ⚠️  ${hEmail} flagged as risky (${reason}) — saving with [unverified] note`);
              signal.bsi_contacts.push({
                first_name:   alPerson.first_name,
                last_name:    alPerson.last_name  || '',
                title:        alPerson.title,
                email:        hEmail,
                email_flagged:    flagged || undefined,
                emailVerification: { valid, flagged, reason },
                linkedin_url: alPerson.linkedin_url || null,
                source:       'audiencelab+hunter',
                send_day:     assignSendDay(alPerson.title)
              });
              console.log(`  [BSI/T2] ✅ Found email for AL contact → ${hEmail} (score ${score})`);
            } else {
              console.log(`  [BSI/T2] ❌ ${hEmail} failed verification (${reason}) — keeping AL contact without email`);
              if (alPerson.linkedin_url) {
                signal.bsi_contacts.push({
                  first_name:   alPerson.first_name,
                  last_name:    alPerson.last_name  || '',
                  title:        alPerson.title,
                  email:        null,
                  linkedin_url: alPerson.linkedin_url,
                  source:       'audiencelab',
                  send_day:     assignSendDay(alPerson.title)
                });
              }
            }
          } else if (alPerson.linkedin_url) {
            // Keep them with LinkedIn only — right person even without email
            signal.bsi_contacts.push({
              first_name:   alPerson.first_name,
              last_name:    alPerson.last_name  || '',
              title:        alPerson.title,
              email:        null,
              linkedin_url: alPerson.linkedin_url,
              source:       'audiencelab',
              send_day:     assignSendDay(alPerson.title)
            });
            console.log(`  [BSI/T2] ℹ️  No email found — keeping AL contact with LinkedIn only`);
          }
        } catch (err) {
          const status = err.response?.status;
          if (status === 429)      console.warn(`  [BSI/T2] ⏳ Hunter rate limited (429)`);
          else if (status === 401) console.warn(`  [BSI/T2] ❌ Hunter unauthorized (401)`);
          else { console.warn(`  [BSI/T2] ⚠️  Hunter error: ${err.message}`); getBreaker('hunter').recordFailure(err.message); }
        }
        await new Promise(r => setTimeout(r, 400));
      }

      // Step 2.3: Hunter domain-search filtered to marketing/brand titles — SECOND BACKUP
      // Only runs if both Apollo and the AL person lookup came up empty.
      if (signal.bsi_contacts.length === 0 && bsiDomain && process.env.HUNTER_API_KEY && !getBreaker('hunter').isOpen()) {
        console.log(`  [BSI/T2] Searching Hunter for marketing/brand contact at ${bsiDomain}...`);
        try {
          const hDomRes = await axios.get('https://api.hunter.io/v2/domain-search', {
            params: { domain: bsiDomain, api_key: process.env.HUNTER_API_KEY },
            timeout: 15000
          });
          getBreaker('hunter').recordSuccess();
          const hEmails  = hDomRes.data?.data?.emails || [];
          const bsiMatch = hEmails.find(e => {
            const pos  = (e.position   || '').toLowerCase();
            const dept = (e.department || '').toLowerCase();
            return HUNTER_BSI_TITLE_KEYWORDS.some(k => pos.includes(k)) ||
                   HUNTER_BSI_DEPT_KEYWORDS.some(k => dept.includes(k));
          });
          // Reject contacts with no first name — a generic dept mailbox with no person is useless
          if (bsiMatch && bsiMatch.first_name) {
            let bsiMatchEmail = null;
            let bsiMatchEmailFlagged;
            let bsiMatchEmailVerification;
            if (bsiMatch.value && !isFakeEmail(bsiMatch.value)) {
              const { valid, flagged, reason } = await verifyEmail(bsiMatch.value, 'hunter', null);
              await new Promise(r => setTimeout(r, 400));
              if (valid) {
                bsiMatchEmail             = bsiMatch.value;
                bsiMatchEmailFlagged      = flagged || undefined;
                bsiMatchEmailVerification = { valid, flagged, reason };
                if (flagged) console.log(`  [BSI/T2] ⚠️  ${bsiMatch.value} flagged as risky (${reason}) — saving with [unverified] note`);
              } else {
                console.log(`  [BSI/T2] ❌ ${bsiMatch.value} failed verification (${reason})`);
              }
            }
            signal.bsi_contacts.push({
              first_name:        bsiMatch.first_name,
              last_name:         bsiMatch.last_name  || '',
              title:             bsiMatch.position   || null,
              email:             bsiMatchEmail,
              email_flagged:     bsiMatchEmailFlagged,
              emailVerification: bsiMatchEmailVerification,
              linkedin_url:      bsiMatch.linkedin   || null,
              source:            'hunter',
              send_day:          assignSendDay(bsiMatch.position)
            });
            console.log(`  [BSI/T2] ✅ Hunter found: ${bsiMatch.first_name} ${bsiMatch.last_name} (${bsiMatch.position})${bsiMatchEmail ? ` → ${bsiMatchEmail}` : ' — no email'}`);
          } else if (bsiMatch) {
            console.log(`  [BSI/T2] ℹ️  Hunter matched a role at ${bsiDomain} but no person name — skipping (generic mailbox)`);
          } else {
            console.log(`  [BSI/T2] ℹ️  Hunter has no marketing/brand contact at ${bsiDomain}`);
          }
        } catch (err) {
          const status = err.response?.status;
          if (status === 429)      console.warn(`  [BSI/T2] ⏳ Hunter rate limited (429) at ${bsiDomain}`);
          else if (status === 401) console.warn(`  [BSI/T2] ❌ Hunter unauthorized (401)`);
          else { console.warn(`  [BSI/T2] ⚠️  Hunter domain-search error: ${err.message}`); getBreaker('hunter').recordFailure(err.message); }
        }
        await new Promise(r => setTimeout(r, 400));
      }

      // Step 2.4: Fill email for the Tier 2 contact if they have a name but no email
      const t2Found = signal.bsi_contacts[0];
      if (t2Found && !t2Found.email && t2Found.first_name && bsiDomain) {
        // Hunter person-finder — requires last name, skip if missing to avoid guaranteed 400 errors
        if (process.env.HUNTER_API_KEY && !getBreaker('hunter').isOpen() && t2Found.last_name) {
          try {
            const hRes = await axios.get('https://api.hunter.io/v2/email-finder', {
              params: { domain: bsiDomain, first_name: t2Found.first_name, last_name: t2Found.last_name || '', api_key: process.env.HUNTER_API_KEY },
              timeout: 15000
            });
            getBreaker('hunter').recordSuccess();
            const { email: hEmail, score } = hRes.data?.data || {};
            if (hEmail && score >= 70 && !isFakeEmail(hEmail)) {
              const { valid, flagged, reason } = await verifyEmail(hEmail, 'hunter', null);
              await new Promise(r => setTimeout(r, 400));
              if (valid) {
                t2Found.email = hEmail;
                t2Found.email_flagged    = flagged || undefined;
                t2Found.emailVerification = { valid, flagged, reason };
                if (flagged) console.log(`  [BSI/T2] ⚠️  ${hEmail} flagged as risky (${reason}) — saving with [unverified] note`);
                console.log(`  [BSI/T2] ✅ Hunter email: ${t2Found.first_name} ${t2Found.last_name} → ${hEmail} (score ${score})`);
              } else {
                console.log(`  [BSI/T2] ❌ ${hEmail} failed verification (${reason}) for ${t2Found.first_name} ${t2Found.last_name} — trying pattern...`);
              }
            } else if (hEmail) {
              console.log(`  [BSI/T2] ⚠️  ${t2Found.first_name} ${t2Found.last_name} → ${hEmail} rejected (score ${score || 'n/a'}${isFakeEmail(hEmail) ? ', fake' : ', below threshold'})`);
            } else {
              console.log(`  [BSI/T2] ℹ️  No email found for ${t2Found.first_name} ${t2Found.last_name} — trying pattern...`);
            }
          } catch (err) {
            const status = err.response?.status;
            if (status === 429)      console.warn(`  [BSI/T2] ⏳ Hunter rate limited (429)`);
            else if (status === 401) console.warn(`  [BSI/T2] ❌ Hunter unauthorized (401)`);
            else { console.warn(`  [BSI/T2] ⚠️  Hunter error: ${err.message}`); getBreaker('hunter').recordFailure(err.message); }
          }
          await new Promise(r => setTimeout(r, 400));
        }

        // Pattern construction if Hunter person-finder also came up empty
        if (!t2Found.email && process.env.HUNTER_API_KEY) {
          let t2Pattern = null;
          try {
            const patRes = await axios.get('https://api.hunter.io/v2/domain-search', {
              params: { domain: bsiDomain, api_key: process.env.HUNTER_API_KEY },
              timeout: 15000
            });
            t2Pattern = patRes.data?.data?.pattern || null;
            if (t2Pattern) console.log(`  [Pattern/BSI/T2] Hunter pattern: "${t2Pattern}"`);
            else           console.log(`  [Pattern/BSI/T2] Hunter has no pattern — trying Puppeteer...`);
          } catch (err) {
            const status = err.response?.status;
            if (status === 429) console.warn(`  [Pattern/BSI/T2] ⏳ Hunter rate limited`);
            else console.warn(`  [Pattern/BSI/T2] ⚠️  Hunter error: ${err.message}`);
          }
          await new Promise(r => setTimeout(r, 400));

          if (!t2Pattern) {
            const patResult = await findEmailPatternViaGoogle(bsiDomain);
            t2Pattern = patResult?.pattern || null;
            if (t2Pattern) console.log(`  [Pattern/BSI/T2] Puppeteer pattern: "${t2Pattern}"`);
            await new Promise(r => setTimeout(r, 600));
          }

          if (t2Pattern) {
            const constructed = applyHunterPattern(t2Pattern, t2Found.first_name, t2Found.last_name, bsiDomain);
            if (constructed && !isFakeEmail(constructed)) {
              console.log(`  [Pattern/BSI/T2] "${t2Pattern}" → ${constructed} — verifying...`);
              const { valid, flagged, reason } = await verifyEmail(constructed, 'hunter', null);
              await new Promise(r => setTimeout(r, 400));
              if (valid) {
                t2Found.email = constructed;
                t2Found.email_flagged    = flagged || undefined;
                t2Found.emailVerification = { valid, flagged, reason };
                if (flagged) console.log(`  [Pattern/BSI/T2] ⚠️  ${constructed} flagged as risky (${reason}) — saving with [unverified] note`);
                console.log(`  [Pattern/BSI/T2] ✅ ${t2Found.first_name} ${t2Found.last_name} → ${constructed}`);
              } else {
                console.log(`  [Pattern/BSI/T2] ❌ ${constructed} failed verification (${reason})`);
              }
            }
          }
        }
      }

      // ── TIER 2 SUCCESS CHECK ─────────────────────────────────────────────────
      // A contact only counts if they are actually reachable — email OR LinkedIn.
      // A name with no way to reach them is useless and must not block Tier 3.
      // Also run the strict title check here: Apollo isn't always perfectly precise and
      // can occasionally return someone whose actual title doesn't match the searched title.
      const t2Contact = signal.bsi_contacts[0];
      if (t2Contact) {
        // Fix 2: reject email if it belongs to a different company's domain
        if (t2Contact.email && !isEmailDomainValid(t2Contact.email, signal.company?.website)) {
          t2Contact.email = null;
        }
        if (t2Contact.email || t2Contact.linkedin_url) {
          if (!isCurrentlyEmployed(t2Contact)) {
            const t2Name = `${t2Contact.first_name} ${t2Contact.last_name}`.trim();
            console.log(`  [BSI/T2] ⛔ ${t2Name} (${t2Contact.title || 'Unknown Title'}) — not currently employed — falling through to Tier 3`);
            signal.bsi_contacts = [];
          } else if (!isNameComplete(t2Contact)) {
            const t2Name = `${t2Contact.first_name} ${t2Contact.last_name}`.trim();
            console.log(`  [BSI/T2] ⛔ ${t2Name} (${t2Contact.title || 'Unknown Title'}) — incomplete name — falling through to Tier 3`);
            signal.bsi_contacts = [];
          } else if (!isCorporateEmployee(t2Contact)) {
            const t2Name = `${t2Contact.first_name} ${t2Contact.last_name}`.trim();
            console.log(`  [BSI/T2] ⛔ ${t2Name} (${t2Contact.title || 'Unknown Title'}) — MLM/distributor role — falling through to Tier 3`);
            signal.bsi_contacts = [];
          } else if (!isBSIAllowedTitle(t2Contact.title)) {
            // Reachable but wrong role — drop and fall through to Tier 3
            const t2Name = `${t2Contact.first_name} ${t2Contact.last_name}`.trim();
            console.log(`  [BSI/T2] ⛔ ${t2Name} (${t2Contact.title || 'Unknown Title'}) — not a Starfish target role — falling through to Tier 3`);
            signal.bsi_contacts = [];
          } else {
            console.log(`  [BSI] ✅ ${signal.company.name} — Tier 2: ${t2Contact.first_name} ${t2Contact.last_name} (${t2Contact.title})${t2Contact.email ? ` → ${t2Contact.email}` : ' — LinkedIn only'}`);
            return;
          }
        } else {
          // Found a name but no way to reach them — drop and fall through to Tier 3
          console.log(`  [BSI/T2] ⚠️  ${t2Contact.first_name} ${t2Contact.last_name} found but unreachable (no email, no LinkedIn) — falling through to Tier 3`);
          signal.bsi_contacts = [];
        }
      }

      // ── TIER 3: Broadcast to senior leaders ─────────────────────────────────
      // No marketing/brand person found anywhere. Go wide:
      // CEO, COO, President, anyone in Marketing or Communications. Up to 5.
      console.log(`  [BSI/T3] No marketing contact found — broadcasting to senior leaders at ${signal.company.name}...`);

      if (bsiDomain) {
        // Step 3.1: Apollo broadcast search (CEO, COO, President, Marketing, Comms)
        if (!getBreaker('apollo').isOpen()) {
          const apolloContacts = await apolloBroadcastSearch(bsiDomain);
          for (const c of apolloContacts) {
            if (signal.bsi_contacts.length >= 5) break;
            if (!c.firstName?.trim()) continue; // skip contacts with no name — unreachable
            if (!isCurrentlyEmployed({ title: c.title })) {
              console.log(`  [BSI/T3] ⛔ Skipping ${c.firstName} ${c.lastName || ''} (${c.title || 'Unknown'}) — not currently employed`);
              continue;
            }
            // Title gate — must be an approved marketing/brand role OR C-suite.
            // Without this check, wrong-role contacts (HR, engineers, recruiters) fill the
            // 5-contact cap and prevent Hunter Step 3.2 from running as a fallback.
            if (!isBSIAllowedTitle(c.title)) {
              console.log(`  [BSI/T3] ⛔ Skipping ${c.firstName} ${c.lastName || ''} (${c.title || 'Unknown'}) — not a target role`);
              continue;
            }
            if (!isNameComplete({ first_name: c.firstName, last_name: c.lastName })) {
              console.log(`  [BSI/T3] ⛔ Skipping ${c.firstName} ${c.lastName || ''} (${c.title || 'Unknown'}) — incomplete name`);
              continue;
            }
            if (!isCorporateEmployee({ title: c.title })) {
              console.log(`  [BSI/T3] ⛔ Skipping ${c.firstName} ${c.lastName || ''} (${c.title || 'Unknown'}) — MLM/distributor role`);
              continue;
            }
            const apolloEmail = c.email && !isFakeEmail(c.email) ? c.email : null;
            // Verify Apollo broadcast emails using Apollo's own email_status as Layer 1.
            // This is free (no Hunter credit spent) and catches bounced/unavailable emails
            // before they reach Airtable. Falls back to 'hunter' source (fail-open) when
            // email_status is absent.
            let emailVerification;
            if (apolloEmail) {
              const src    = c.email_status ? 'apollo' : 'hunter';
              const result = await verifyEmail(apolloEmail, src, c.email_status || null);
              emailVerification = result.valid ? result : undefined;
              if (!result.valid) {
                console.log(`  [BSI/T3] ❌ Apollo email failed verification for ${c.firstName} ${c.lastName} (${result.reason}) — saving without email`);
              }
            }
            signal.bsi_contacts.push({
              first_name:        c.firstName,
              last_name:         c.lastName,
              title:             c.title,
              email:             apolloEmail && emailVerification ? apolloEmail : null,
              emailVerification,
              linkedin_url:      c.linkedin_url,
              source:            'apollo',
              send_day:          assignSendDay(c.title)
            });
            console.log(`  [BSI/T3] ➕ Apollo: ${c.firstName} ${c.lastName} (${c.title})${apolloEmail ? ` ✉️ ${apolloEmail}` : ''}`);
          }
          if (apolloContacts.length === 0) console.log(`  [BSI/T3] ℹ️  Apollo found no contacts at ${bsiDomain}`);
          await new Promise(r => setTimeout(r, 400));
        }

        // Step 3.2: Hunter domain-search fallback (broader exec titles)
        if (signal.bsi_contacts.length === 0 && process.env.HUNTER_API_KEY && !getBreaker('hunter').isOpen()) {
          console.log(`  [BSI/T3] Apollo found nothing — trying Hunter domain-search at ${bsiDomain}...`);
          try {
            const hDomRes = await axios.get('https://api.hunter.io/v2/domain-search', {
              params: { domain: bsiDomain, api_key: process.env.HUNTER_API_KEY },
              timeout: 15000
            });
            getBreaker('hunter').recordSuccess();
            const hEmails     = hDomRes.data?.data?.emails || [];
            // Use isBSIAllowedTitle (approved marketing + C-suite) instead of
            // HUNTER_EXEC_TITLE_KEYWORDS substring match — that list contains 'president'
            // which is a substring of 'vice president', letting in VP Sales, VP HR, etc.
            const execMatches = hEmails.filter(e => isBSIAllowedTitle(e.position));
            for (const e of execMatches) {
              if (signal.bsi_contacts.length >= 5) break;
              if (!e.first_name?.trim()) continue; // skip contacts with no name — unreachable
              if (!isNameComplete({ first_name: e.first_name, last_name: e.last_name })) {
                console.log(`  [BSI/T3] ⛔ Skipping ${e.first_name} ${e.last_name || ''} (${e.position || 'Unknown'}) — incomplete name`);
                continue;
              }
              if (!isCurrentlyEmployed({ title: e.position })) {
                console.log(`  [BSI/T3] ⛔ Skipping ${e.first_name} ${e.last_name || ''} (${e.position || 'Unknown'}) — not currently employed`);
                continue;
              }
              if (!isCorporateEmployee({ title: e.position })) {
                console.log(`  [BSI/T3] ⛔ Skipping ${e.first_name} ${e.last_name || ''} (${e.position || 'Unknown'}) — MLM/distributor role`);
                continue;
              }
              let email = e.value && !isFakeEmail(e.value) ? e.value : null;
              let emailVerification;
              if (email) {
                const { valid, flagged, reason } = await verifyEmail(email, 'hunter', null);
                await new Promise(r => setTimeout(r, 400));
                if (valid) {
                  emailVerification = { valid, flagged, reason };
                  if (flagged) console.log(`  [BSI/T3] ⚠️  ${email} flagged as risky (${reason}) — saving with [unverified] note`);
                } else {
                  console.log(`  [BSI/T3] ❌ ${email} failed verification (${reason}) for ${e.first_name} ${e.last_name} — Step 3.3 will try person-finder`);
                  email = null; // clear so Step 3.3 can attempt a Hunter person-finder lookup
                }
              }
              signal.bsi_contacts.push({
                first_name:   e.first_name,
                last_name:    e.last_name  || '',
                title:        e.position   || null,
                email,
                emailVerification,
                linkedin_url: e.linkedin   || null,
                source:       'hunter',
                send_day:     assignSendDay(e.position)
              });
              console.log(`  [BSI/T3] ➕ Hunter: ${e.first_name} ${e.last_name} (${e.position})${email ? ` ✉️ ${email}` : ''}`);
            }
            if (signal.bsi_contacts.length === 0) console.log(`  [BSI/T3] ℹ️  Hunter also found no contacts at ${bsiDomain}`);
          } catch (err) {
            const status = err.response?.status;
            if (status === 429)      console.warn(`  [BSI/T3] ⏳ Hunter rate limited (429) at ${bsiDomain}`);
            else if (status === 401) console.warn(`  [BSI/T3] ❌ Hunter unauthorized (401)`);
            else { console.warn(`  [BSI/T3] ⚠️  Hunter error: ${err.message}`); getBreaker('hunter').recordFailure(err.message); }
          }
          await new Promise(r => setTimeout(r, 400));
        }

        // Step 3.3: Hunter person-finder for each T3 contact still missing email
        if (signal.bsi_contacts.length > 0 && process.env.HUNTER_API_KEY) {
          for (const contact of signal.bsi_contacts) {
            if (contact.email || !contact.first_name) continue;
            // Hunter requires both first AND last name — skip if no last name to avoid a
            // guaranteed 400 error that records a circuit breaker failure.
            if (!contact.last_name) {
              console.log(`  [BSI/T3] ⏭️  Skipping Hunter for ${contact.first_name} (${contact.title || 'Unknown Title'}) — no last name`);
              continue;
            }
            console.log(`  [BSI/T3] Hunter searching for ${contact.first_name} ${contact.last_name} (${contact.title || 'Unknown Title'}) at ${bsiDomain}...`);
            try {
              const hRes = await axios.get('https://api.hunter.io/v2/email-finder', {
                params: { domain: bsiDomain, first_name: contact.first_name, last_name: contact.last_name || '', api_key: process.env.HUNTER_API_KEY },
                timeout: 15000
              });
              const { email: hEmail, score } = hRes.data?.data || {};
              if (hEmail && score >= 70 && !isFakeEmail(hEmail)) {
                const { valid, flagged, reason } = await verifyEmail(hEmail, 'hunter', null);
                await new Promise(r => setTimeout(r, 400));
                if (valid) {
                  contact.email = hEmail;
                  contact.email_flagged    = flagged || undefined;
                  contact.emailVerification = { valid, flagged, reason };
                  if (flagged) console.log(`  [BSI/T3] ⚠️  ${hEmail} flagged as risky (${reason}) — saving with [unverified] note`);
                  console.log(`  [BSI/T3] ✅ Hunter: ${contact.first_name} ${contact.last_name} → ${hEmail} (score ${score})`);
                } else {
                  console.log(`  [BSI/T3] ❌ ${hEmail} failed verification (${reason}) for ${contact.first_name} ${contact.last_name} — will try pattern`);
                }
              } else if (hEmail) {
                console.log(`  [BSI/T3] ⚠️  ${contact.first_name} ${contact.last_name} → ${hEmail} rejected (score ${score || 'n/a'}${isFakeEmail(hEmail) ? ', fake' : ', below threshold'})`);
              } else {
                console.log(`  [BSI/T3] ℹ️  No email found for ${contact.first_name} ${contact.last_name} — will use LinkedIn or pattern`);
              }
            } catch (err) {
              const status = err.response?.status;
              if (status === 429)      console.warn(`  [BSI/T3] ⏳ Hunter rate limited (429) for ${contact.first_name} ${contact.last_name}`);
              else if (status === 401) console.warn(`  [BSI/T3] ❌ Hunter unauthorized (401) — check HUNTER_API_KEY`);
              else {
                console.warn(`  [BSI/T3] ⚠️  Hunter error for ${contact.first_name} ${contact.last_name}: ${err.message}`);
                getBreaker('hunter').recordFailure(err.message);
              }
            }
            await new Promise(r => setTimeout(r, 400));
          }
        }

        // Step 3.4: Pattern construction for T3 contacts still missing email
        const t3NeedingEmail = signal.bsi_contacts.filter(c => !c.email && c.first_name && c.last_name);
        if (t3NeedingEmail.length > 0 && process.env.HUNTER_API_KEY) {
          let t3Pattern = null;
          try {
            const patRes = await axios.get('https://api.hunter.io/v2/domain-search', {
              params: { domain: bsiDomain, api_key: process.env.HUNTER_API_KEY },
              timeout: 15000
            });
            t3Pattern = patRes.data?.data?.pattern || null;
            if (t3Pattern) console.log(`  [Pattern/BSI/T3] Hunter pattern: "${t3Pattern}"`);
            else           console.log(`  [Pattern/BSI/T3] Hunter has no pattern — trying Puppeteer...`);
          } catch (err) {
            const status = err.response?.status;
            if (status === 429) console.warn(`  [Pattern/BSI/T3] ⏳ Hunter rate limited`);
            else console.warn(`  [Pattern/BSI/T3] ⚠️  Hunter error: ${err.message}`);
          }
          await new Promise(r => setTimeout(r, 400));

          if (!t3Pattern) {
            const patResult = await findEmailPatternViaGoogle(bsiDomain);
            t3Pattern = patResult?.pattern || null;
            if (t3Pattern) console.log(`  [Pattern/BSI/T3] Puppeteer pattern: "${t3Pattern}"`);
            await new Promise(r => setTimeout(r, 600));
          }

          if (t3Pattern) {
            for (const contact of t3NeedingEmail) {
              const constructed = applyHunterPattern(t3Pattern, contact.first_name, contact.last_name, bsiDomain);
              if (!constructed || isFakeEmail(constructed)) continue;
              console.log(`  [Pattern/BSI/T3] "${t3Pattern}" → ${constructed} — verifying...`);
              const { valid, flagged, reason } = await verifyEmail(constructed, 'hunter', null);
              await new Promise(r => setTimeout(r, 400));
              if (valid) {
                contact.email = constructed;
                contact.email_flagged    = flagged || undefined;
                contact.emailVerification = { valid, flagged, reason };
                if (flagged) console.log(`  [Pattern/BSI/T3] ⚠️  ${constructed} flagged as risky (${reason}) — saving with [unverified] note`);
                console.log(`  [Pattern/BSI/T3] ✅ ${contact.first_name} ${contact.last_name} → ${constructed}`);
              } else {
                console.log(`  [Pattern/BSI/T3] ❌ ${constructed} failed verification (${reason})`);
              }
            }
          }
        }
      } else {
        console.log(`  [BSI] ⚠️  ${signal.company.name} — no domain found, cannot run broadcast search`);
      }

      // ── TIER 3 REACHABILITY FILTER ───────────────────────────────────────────
      // Drop any broadcast contact with no email AND no LinkedIn — completely unreachable.
      const unreachable = signal.bsi_contacts.filter(c => !c.email && !c.linkedin_url);
      if (unreachable.length > 0) {
        for (const u of unreachable) {
          const uName = `${u.first_name || ''} ${u.last_name || ''}`.trim() || 'Unknown';
          console.log(`  [BSI/T3] ⚠️  Dropping unreachable contact: ${uName} (${u.title || 'Unknown Title'}) — no email, no LinkedIn`);
        }
        signal.bsi_contacts = signal.bsi_contacts.filter(c => c.email || c.linkedin_url);
      }

      // ── Fix 2: DOMAIN VALIDATION — strip emails from wrong company domain ────
      // Prevents contacts with aquilafunds.com, umich.edu, etc. from going to Airtable.
      for (const c of signal.bsi_contacts) {
        if (c.email && !isEmailDomainValid(c.email, signal.company?.website)) {
          c.email = null;
        }
      }

      // ── BSI TWO-PASS TITLE FILTER + CAP ─────────────────────────────────────
      // Pass 1: marketing/brand/comms contacts only (CMO, VP Marketing, Head of Brand…).
      // Pass 2: if fewer than 3 marketing contacts survive, fill remaining slots with
      //         C-suite (CEO, COO, President) as last-resort fallback.
      // Anything that fails both passes is dropped. Cap at MAX_CONTACTS_PER_COMPANY.
      const approvedContacts = signal.bsi_contacts.filter(c => isTitleApproved(c.title));
      // C-suite (CEO/COO/President) only added when ZERO marketing contacts exist —
      // if even one CMO/VP Marketing is found, we don't pad with the CEO.
      const csuiteContacts   = approvedContacts.length === 0
        ? signal.bsi_contacts.filter(c => isTitleCSuite(c.title))
        : [];
      const merged = [
        ...approvedContacts,
        ...csuiteContacts.slice(0, MAX_CONTACTS_PER_COMPANY - approvedContacts.length)
      ].slice(0, MAX_CONTACTS_PER_COMPANY);

      // Log every contact that was dropped and why
      const mergedSet = new Set(merged);
      for (const d of signal.bsi_contacts) {
        if (mergedSet.has(d)) continue;
        const dName = `${d.first_name || ''} ${d.last_name || ''}`.trim() || 'Unknown';
        if (!isTitleApproved(d.title) && !isTitleCSuite(d.title)) {
          console.log(`  [BSI/TitleFilter] ⛔ Dropping ${dName} (${d.title || 'Unknown Title'}) — not a Starfish target role`);
        } else {
          console.log(`  [BSI/Cap] ✂️  Capping at ${MAX_CONTACTS_PER_COMPANY}: dropping ${dName} (${d.title || 'Unknown Title'})`);
        }
      }
      if (csuiteContacts.length > 0) {
        const added = merged.length - approvedContacts.length;
        console.log(`  [BSI/T3] ℹ️  ${approvedContacts.length} approved marketing contact(s) — added ${added} C-suite fallback(s) (total: ${merged.length})`);
      }
      signal.bsi_contacts = merged;

      // ── TIER 4: Nothing found → Contact Needed (Carly) ──────────────────────
      const withEmail    = signal.bsi_contacts.filter(c => c.email).length;
      const withLinkedIn = signal.bsi_contacts.filter(c => c.linkedin_url && !c.email).length;
      if (signal.bsi_contacts.length === 0) {
        console.log(`  [BSI] ⚠️  ${signal.company.name} — all tiers exhausted, flagging as "Contact Needed"`);
      } else {
        console.log(`  [BSI] ✅ ${signal.company.name} — Tier 3 broadcast: ${signal.bsi_contacts.length} contacts (${withEmail} with email, ${withLinkedIn} LinkedIn only)`);
      }
      return;
    }

    // Check if email already came through from the fetch stage (PDL, AudienceLab, etc.)
    // These come from third-party databases that can be months stale — verify before trusting.
    // Apollo signals carry email_status from their enrichment response — use Apollo's own
    // deliverability verdict as Layer 1 (free). PDL/AudienceLab have no status → treat as
    // 'hunter' source (fail-open when Hunter verifier is unavailable).
    if (signal.person?.email && !isFakeEmail(signal.person.email)) {
      const emailSource  = signal.person.email_status ? 'apollo' : 'hunter';
      const apolloStatus = signal.person.email_status || null;
      const { valid, flagged, reason } = await verifyEmail(signal.person.email, emailSource, apolloStatus);
      await new Promise(r => setTimeout(r, 400));
      if (valid) {
        signal._email_flagged    = flagged || undefined;
        signal.emailVerification = { valid, flagged, reason };
        if (flagged) console.log(`  [Email] ⚠️  ${signal.company.name} — pre-loaded email flagged as risky (${reason}) — saving with [unverified] note`);
        console.log(`  [Email] ✅ ${signal.company.name} — pre-loaded email verified (${signal.person.email})`);
        return;
      }
      console.log(`  [Email] ❌ ${signal.company.name} — pre-loaded email ${signal.person.email} failed verification (${reason}) — running cascade`);
      signal.person.email = null; // clear so the cascade below can find a good one
    }

    // ── Website Visitor with known person: run person-specific email lookup ──────
    // AudienceLab Pixel gives us first name, last name, and title for the visitor.
    // Only run the cascade if their title is a relevant marketing/brand decision-maker.
    // Irrelevant titles (teacher, engineer, etc.) are skipped — no API calls wasted.
    if (signal.type === 'Website Visitor' && signal.person?.first_name && signal.person?.last_name) {
      // Website visitors self-selected by coming to Starfish's site — enrich any
      // senior person (Director+) regardless of marketing relevance, since the visit
      // itself signals intent. isSeniorEnough() blocks junior titles (coordinator,
      // analyst, intern) that can't greenlight brand work.
      const wvTitle = (signal.person.title || '').toLowerCase().trim();
      if (wvTitle && wvTitle !== 'unknown') {
        if (!isSeniorEnough(wvTitle)) {
          console.log(`  [Email/WV] ⛔ Skipping cascade for ${signal.company.name} — title too junior: "${signal.person.title}"`);
          return;
        }
      } else {
        // Unknown title — skip cascade, signal already set to LOW priority in workflow_2
        console.log(`  [Email/WV] ⏭️  Skipping cascade for ${signal.company.name} — title unknown`);
        return;
      }
      // Ensure we have a domain first
      if (!signal.company.website) {
        const discovered = await findCompanyDomain(signal.company.name);
        if (discovered) {
          signal.company.website = `https://${discovered}`;
          console.log(`  [Domain] ✅ ${signal.company.name} → ${discovered} (via Puppeteer)`);
        }
        await new Promise(r => setTimeout(r, 400));
      }
      const wvDomain = extractDomain(signal.company?.website);

      // Step 1: Apollo people/match via LinkedIn URL (if available)
      if (signal.person.linkedin_url) {
        const apolloResult = await findEmailWithApollo(signal);
        if (apolloResult?.email && !isFakeEmail(apolloResult.email)) {
          const { valid, flagged, reason } = await verifyEmail(apolloResult.email, 'apollo', apolloResult.emailStatus);
          await new Promise(r => setTimeout(r, 400));
          if (valid) {
            signal.person.email = apolloResult.email;
            signal._email_flagged    = flagged || undefined;
            signal.emailVerification = { valid, flagged, reason };
            if (flagged) console.log(`  [Apollo/WV] ⚠️  ${apolloResult.email} flagged as risky (${reason}) — saving with [unverified] note`);
            console.log(`  [Apollo/WV] ✅ ${signal.company.name} → ${apolloResult.email}`);
            return;
          }
          console.log(`  [Apollo/WV] ❌ ${apolloResult.email} failed verification (${reason}) — continuing cascade`);
        }
      }

      // Step 2: Hunter person-finder — first + last + domain
      if (wvDomain && process.env.HUNTER_API_KEY) {
        console.log(`  [Hunter/WV] Searching for ${signal.person.first_name} ${signal.person.last_name} at ${wvDomain}...`);
        try {
          const hRes = await axios.get('https://api.hunter.io/v2/email-finder', {
            params: { domain: wvDomain, first_name: signal.person.first_name, last_name: signal.person.last_name, api_key: process.env.HUNTER_API_KEY },
            timeout: 15000
          });
          const { email: hEmail, score } = hRes.data?.data || {};
          if (hEmail && score >= 70 && !isFakeEmail(hEmail)) {
            const { valid, flagged, reason } = await verifyEmail(hEmail, 'hunter', null);
            await new Promise(r => setTimeout(r, 400));
            if (valid) {
              signal.person.email = hEmail;
              signal._email_flagged    = flagged || undefined;
              signal.emailVerification = { valid, flagged, reason };
              if (flagged) console.log(`  [Hunter/WV] ⚠️  ${hEmail} flagged as risky (${reason}) — saving with [unverified] note`);
              console.log(`  [Hunter/WV] ✅ ${signal.person.first_name} ${signal.person.last_name} at ${signal.company.name} → ${hEmail} (score ${score})`);
              return;
            }
            console.log(`  [Hunter/WV] ❌ ${hEmail} failed verification (${reason}) — trying pattern...`);
          } else if (hEmail) {
            console.log(`  [Hunter/WV] ⚠️  ${hEmail} rejected (score ${score || 'n/a'}${isFakeEmail(hEmail) ? ', fake' : ', below threshold'}) — trying pattern...`);
          } else {
            console.log(`  [Hunter/WV] ℹ️  No email found — trying Puppeteer...`);
          }
        } catch (err) {
          const status = err.response?.status;
          if (status === 429)      console.warn(`  [Hunter/WV] ⏳ Rate limited (429) at ${wvDomain} — trying Puppeteer...`);
          else if (status === 401) console.warn(`  [Hunter/WV] ❌ Unauthorized (401) — check HUNTER_API_KEY`);
          else { console.warn(`  [Hunter/WV] ⚠️  Error: ${err.message} — trying Puppeteer...`); getBreaker('hunter').recordFailure(err.message); }
        }
        await new Promise(r => setTimeout(r, 400));
      }

      // Step 3: Pattern construction — get domain pattern then construct + verify for this person
      if (wvDomain && process.env.HUNTER_API_KEY) {
        let wvPattern = null;

        // 3a: Hunter domain-search for pattern
        try {
          const patRes = await axios.get('https://api.hunter.io/v2/domain-search', {
            params: { domain: wvDomain, api_key: process.env.HUNTER_API_KEY },
            timeout: 15000
          });
          wvPattern = patRes.data?.data?.pattern || null;
          if (wvPattern) console.log(`  [Pattern/WV] Hunter pattern at ${wvDomain}: "${wvPattern}"`);
          else            console.log(`  [Pattern/WV] Hunter has no pattern at ${wvDomain} — trying Puppeteer...`);
        } catch (err) {
          const status = err.response?.status;
          if (status === 429)      console.warn(`  [Pattern/WV] ⏳ Hunter rate limited (429) at ${wvDomain}`);
          else if (status === 401) console.warn(`  [Pattern/WV] ❌ Hunter unauthorized (401)`);
          else                     console.warn(`  [Pattern/WV] ⚠️  Hunter error: ${err.message} — trying Puppeteer...`);
        }
        await new Promise(r => setTimeout(r, 400));

        // 3b: Puppeteer pattern scrape if Hunter had none
        if (!wvPattern) {
          const patResult = await findEmailPatternViaGoogle(wvDomain);
          wvPattern = patResult?.pattern || null;
          if (wvPattern) console.log(`  [Pattern/WV] Puppeteer pattern at ${wvDomain}: "${wvPattern}"`);
          await new Promise(r => setTimeout(r, 600));
        }

        // 3c: Apply pattern to this specific visitor and Hunter-verify
        if (wvPattern) {
          const constructed = applyHunterPattern(wvPattern, signal.person.first_name, signal.person.last_name || '', wvDomain);
          if (constructed && !isFakeEmail(constructed)) {
            console.log(`  [Pattern/WV] "${wvPattern}" → ${constructed} — verifying...`);
            const { valid, flagged, reason } = await verifyEmail(constructed, 'hunter', null);
            await new Promise(r => setTimeout(r, 400));
            if (valid) {
              signal.person.email = constructed;
              signal._email_flagged    = flagged || undefined;
              signal.emailVerification = { valid, flagged, reason };
              if (flagged) console.log(`  [Pattern/WV] ⚠️  ${constructed} flagged as risky (${reason}) — saving with [unverified] note`);
              console.log(`  [Pattern/WV] ✅ ${signal.company.name} → ${constructed}`);
              return;
            } else {
              console.log(`  [Pattern/WV] ❌ ${constructed} failed verification (${reason}) — trying Puppeteer...`);
            }
          }
        }
      }

      // Step 4: Puppeteer Google fallback — search for this specific person at the company
      console.log(`  [Puppeteer/WV] Searching ${signal.company.name}...`);
      const wvSearchTitle = signal.person.title || 'Marketing';
      const wvResult = await findEmailWithPuppeteer(signal.company.name, signal.company.website, wvSearchTitle);
      if (wvResult?.email && !isFakeEmail(wvResult.email)) {
        const wvTrustedDomain = getKnownDomain(signal.company.name) || wvDomain;
        const wvEmailDomain   = wvResult.email.split('@')[1]?.toLowerCase() || '';
        if (wvTrustedDomain && !wvEmailDomain.endsWith(wvTrustedDomain)) {
          console.log(`  [Puppeteer/WV] ❌ Rejected ${wvResult.email} — domain mismatch (expected ${wvTrustedDomain})`);
          console.log(`  [Puppeteer/WV] ℹ️  No valid email found — cascade exhausted for ${signal.company.name}`);
        } else {
          const { valid, flagged, reason } = await verifyEmail(wvResult.email, 'puppeteer', null);
          await new Promise(r => setTimeout(r, 400));
          if (valid) {
            signal._puppeteer_email  = wvResult.email;
            signal._puppeteer_source = wvResult.source;
            signal._email_flagged    = flagged || undefined;
            signal.emailVerification = { valid, flagged, reason };
            if (flagged) console.log(`  [Puppeteer/WV] ⚠️  ${wvResult.email} flagged as risky (${reason}) — saving with [unverified] note`);
            console.log(`  [Puppeteer/WV] ✅ ${signal.company.name} → ${wvResult.email}`);
          } else {
            console.log(`  [Puppeteer/WV] ❌ ${wvResult.email} failed verification (${reason}) — cascade exhausted for ${signal.company.name}`);
          }
        }
      } else {
        console.log(`  [Puppeteer/WV] ℹ️  No email found — cascade exhausted for ${signal.company.name}`);
      }
      return; // done — don't fall into the generic path
    }

    // ── Website Visitor with NO identified person ─────────────────────────────
    // AudienceLab saw the company visit but couldn't resolve the individual.
    // Use apolloFindExec (4-pass: marketing+has_email → marketing → csuite+has_email → csuite)
    // to find the best marketing/brand contact at this company, then Hunter cascade.
    // The found contact is written into signal.person.* so formatContactInfo renders it
    // identically to a visitor whose name AudienceLab did resolve.
    if (signal.type === 'Website Visitor' && signal._no_identified_person) {
      console.log(`  [WV/NoPerson] ${signal.company.name} — searching for marketing contact via Apollo...`);

      // Resolve domain
      if (!signal.company.website) {
        const discovered = await findCompanyDomain(signal.company.name);
        if (discovered) {
          signal.company.website = `https://${discovered}`;
          console.log(`  [Domain] ✅ ${signal.company.name} → ${discovered} (via Puppeteer)`);
        }
        await new Promise(r => setTimeout(r, 400));
      }
      const wvNpDomain = extractDomain(signal.company?.website);
      if (!wvNpDomain) {
        console.log(`  [WV/NoPerson] ⚠️  No domain found for ${signal.company.name} — skipping cascade`);
        return;
      }

      // Step 1: Apollo 4-pass exec search — marketing titles first, C-suite fallback
      if (!getBreaker('apollo').isOpen()) {
        const exec = await apolloFindExec(wvNpDomain, 'Brand Strategy Intent');
        await new Promise(r => setTimeout(r, 600));

        if (exec?.firstName) {
          // Populate signal.person so formatContactInfo picks it up naturally
          signal.person = signal.person || {};
          signal.person.first_name   = exec.firstName;
          signal.person.last_name    = exec.lastName    || '';
          signal.person.title        = exec.title       || null;
          signal.person.linkedin_url = exec.linkedin_url || null;

          // Apollo unlocked an email — verify it
          if (exec.email && !isFakeEmail(exec.email)) {
            const src    = exec.emailStatus ? 'apollo' : 'hunter';
            const { valid, flagged, reason } = await verifyEmail(exec.email, src, exec.emailStatus || null);
            await new Promise(r => setTimeout(r, 400));
            if (valid) {
              signal.person.email   = exec.email;
              signal._email_flagged = flagged || undefined;
              signal.emailVerification = { valid, flagged, reason };
              if (flagged) console.log(`  [WV/Noperson] ⚠️  ${exec.email} flagged as risky (${reason})`);
              console.log(`  [WV/NoPerson] ✅ ${exec.firstName} ${exec.lastName} (${exec.title}) → ${exec.email}`);
              return;
            }
            console.log(`  [WV/NoPerson] ❌ Apollo email ${exec.email} failed verification — Hunter cascade follows`);
          }

          // Step 2: Hunter person-finder for the Apollo-returned name
          if (exec.lastName && process.env.HUNTER_API_KEY && !getBreaker('hunter').isOpen()) {
            try {
              const hRes = await axios.get('https://api.hunter.io/v2/email-finder', {
                params: { domain: wvNpDomain, first_name: exec.firstName, last_name: exec.lastName, api_key: process.env.HUNTER_API_KEY },
                timeout: 15000
              });
              getBreaker('hunter').recordSuccess();
              const { email: hEmail, score } = hRes.data?.data || {};
              if (hEmail && score >= 70 && !isFakeEmail(hEmail)) {
                const { valid, flagged, reason } = await verifyEmail(hEmail, 'hunter', null);
                await new Promise(r => setTimeout(r, 400));
                if (valid) {
                  signal.person.email   = hEmail;
                  signal._email_flagged = flagged || undefined;
                  signal.emailVerification = { valid, flagged, reason };
                  if (flagged) console.log(`  [WV/NoPerson] ⚠️  ${hEmail} flagged as risky (${reason})`);
                  console.log(`  [WV/NoPerson] ✅ Hunter: ${exec.firstName} ${exec.lastName} → ${hEmail} (score ${score})`);
                  return;
                }
                console.log(`  [WV/NoPerson] ❌ ${hEmail} failed verification — trying pattern...`);
              } else {
                console.log(`  [WV/NoPerson] ℹ️  Hunter has no email for ${exec.firstName} ${exec.lastName} — trying pattern...`);
              }
            } catch (err) {
              const status = err.response?.status;
              if (status === 429)      console.warn(`  [WV/NoPerson] ⏳ Hunter rate limited (429)`);
              else if (status === 401) console.warn(`  [WV/NoPerson] ❌ Hunter unauthorized (401)`);
              else { console.warn(`  [WV/NoPerson] ⚠️  Hunter error: ${err.message}`); getBreaker('hunter').recordFailure(err.message); }
            }
            await new Promise(r => setTimeout(r, 400));
          }

          // Step 3: Pattern construction
          if (process.env.HUNTER_API_KEY && exec.lastName) {
            try {
              const patRes = await axios.get('https://api.hunter.io/v2/domain-search', {
                params: { domain: wvNpDomain, api_key: process.env.HUNTER_API_KEY },
                timeout: 15000
              });
              const wvNpPattern = patRes.data?.data?.pattern || null;
              if (wvNpPattern) {
                const constructed = applyHunterPattern(wvNpPattern, exec.firstName, exec.lastName, wvNpDomain);
                if (constructed && !isFakeEmail(constructed)) {
                  console.log(`  [WV/NoPattern] "${wvNpPattern}" → ${constructed} — verifying...`);
                  const { valid, flagged, reason } = await verifyEmail(constructed, 'hunter', null);
                  await new Promise(r => setTimeout(r, 400));
                  if (valid) {
                    signal.person.email   = constructed;
                    signal._email_flagged = flagged || undefined;
                    signal.emailVerification = { valid, flagged, reason };
                    if (flagged) console.log(`  [WV/NoPattern] ⚠️  ${constructed} flagged as risky (${reason})`);
                    console.log(`  [WV/NoPattern] ✅ ${exec.firstName} ${exec.lastName} → ${constructed}`);
                    return;
                  }
                  console.log(`  [WV/NoPattern] ❌ ${constructed} failed verification`);
                }
              }
            } catch (err) {
              if (err.response?.status !== 429) console.warn(`  [WV/NoPattern] ⚠️  Hunter error: ${err.message}`);
            }
            await new Promise(r => setTimeout(r, 400));
          }

          // Apollo found a name but no email path worked — save with LinkedIn if available
          if (signal.person.linkedin_url) {
            console.log(`  [WV/NoPattern] ℹ️  ${exec.firstName} ${exec.lastName} (${exec.title}) — no email found, saving with LinkedIn only`);
          }
          return;
        }
      }

      // Apollo found nobody — no contact to save
      console.log(`  [WV/NoPattern] ℹ️  Apollo found no contact at ${wvNpDomain} for ${signal.company.name}`);
      return;
    }

    // Step 1: Apollo people/match (Job Change only — needs LinkedIn URL)
    const apolloResult = await findEmailWithApollo(signal);
    if (apolloResult?.email && !isFakeEmail(apolloResult.email)) {
      const knownDomain       = getKnownDomain(signal.company.name);
      const apolloEmailDomain = apolloResult.email.split('@')[1]?.toLowerCase() || '';
      if (knownDomain && !apolloEmailDomain.endsWith(knownDomain)) {
        console.log(`  [Apollo] ⚠️  Rejected ${apolloResult.email} — domain (${apolloEmailDomain}) doesn't match company (${knownDomain})`);
      } else {
        const { valid, flagged, reason } = await verifyEmail(apolloResult.email, 'apollo', apolloResult.emailStatus);
        await new Promise(r => setTimeout(r, 400));
        if (valid) {
          signal.person = signal.person || {};
          signal.person.email = apolloResult.email;
          signal._email_flagged    = flagged || undefined;
          signal.emailVerification = { valid, flagged, reason };
          if (flagged) console.log(`  [Apollo] ⚠️  ${apolloResult.email} flagged as risky (${reason}) — saving with [unverified] note`);
          return;
        }
        console.log(`  [Apollo] ❌ ${apolloResult.email} failed verification (${reason}) — continuing cascade`);
      }
    }

    // Step 2: If still no website, ask Puppeteer to Google it — Hunter needs this
    if (!signal.company.website) {
      const discovered = await findCompanyDomain(signal.company.name);
      if (discovered) {
        signal.company.website = `https://${discovered}`;
        console.log(`  [Domain] ✅ ${signal.company.name} → ${discovered} (via Puppeteer)`);
      }
      await new Promise(r => setTimeout(r, 400));
    }

    const domain = extractDomain(signal.company?.website);

    // Step 2a: Hunter email-finder (Job Change — first + last + domain)
    if (signal.type === 'Job Change') {
      const hunterEmail = await findEmailWithHunterPerson(signal);
      if (hunterEmail && !isFakeEmail(hunterEmail)) {
        const { valid, flagged, reason } = await verifyEmail(hunterEmail, 'hunter', null);
        await new Promise(r => setTimeout(r, 400));
        if (valid) {
          signal.person = signal.person || {};
          signal.person.email = hunterEmail;
          signal._email_flagged    = flagged || undefined;
          signal.emailVerification = { valid, flagged, reason };
          if (flagged) console.log(`  [Hunter/JC] ⚠️  ${hunterEmail} flagged as risky (${reason}) — saving with [unverified] note`);
          return;
        }
        console.log(`  [Hunter/JC] ❌ ${hunterEmail} failed verification (${reason}) — continuing cascade`);
      }
    }

    // Step 2b-MA: Enrich each ma_contact with Hunter email-finder (first + last + domain)
    if (signal.type === 'M&A Activity' && signal.ma_contacts?.length > 0 && domain) {
      let puppeteerCalledForCompany = false;

      for (const contact of signal.ma_contacts) {
        if (!contact.name) continue;

        // If Apollo's search result already included an email, verify it before accepting.
        // Previously this was skipped (if (contact.email) continue) which meant Apollo emails
        // for M&A contacts were never verified — inconsistent with Job Change handling.
        if (contact.email && !contact.email_verified) {
          if (!isFakeEmail(contact.email)) {
            const { valid, flagged, reason } = await verifyEmail(contact.email, 'apollo', contact.email_status || null);
            await new Promise(r => setTimeout(r, 400));
            if (valid) {
              contact.email_flagged     = flagged || undefined;
              contact.emailVerification = { valid, flagged, reason };
              contact.email_verified    = true;
              signal.emailVerification  = { valid, flagged, reason };
              if (flagged) console.log(`  [Apollo/MA] ⚠️  ${contact.email} flagged (${reason}) — saving with [unverified] note`);
              else         console.log(`  [Apollo/MA] ✅ ${contact.name} → ${contact.email} verified`);
              continue;
            }
            console.log(`  [Apollo/MA] ❌ ${contact.email} failed verification (${reason}) — clearing and trying Hunter`);
            contact.email = null; // clear so Hunter can try
          } else {
            console.log(`  [Apollo/MA] ⛔ ${contact.email} is fake — clearing and trying Hunter`);
            contact.email = null;
          }
        }
        if (contact.email) continue; // already verified above
        const [firstName, ...rest] = contact.name.split(' ');
        const lastName = rest.join(' ');
        if (!firstName) continue;
        if (!lastName) {
          console.log(`  [Hunter/MA] ⏭️  Skipping ${contact.name} — single-name contact, Hunter requires first + last`);
          continue;
        }

        if (process.env.HUNTER_API_KEY) {
          console.log(`  [Hunter/MA] Searching for ${contact.name} at ${domain}...`);
          try {
            const res = await axios.get('https://api.hunter.io/v2/email-finder', {
              params: { domain, first_name: firstName, last_name: lastName, api_key: process.env.HUNTER_API_KEY },
              timeout: 15000
            });
            const { email: hEmail, score } = res.data?.data || {};
            if (hEmail && score >= 70 && !isFakeEmail(hEmail)) {
              const { valid, flagged, reason } = await verifyEmail(hEmail, 'hunter', null);
              await new Promise(r => setTimeout(r, 400));
              if (valid) {
                // Domain guard: skip if email is from a different company's domain.
                // Hunter searches by company domain so mismatches are rare but possible
                // (e.g., holding-company email for a subsidiary contact).
                if (signal.company?.website && !isEmailDomainValid(hEmail, signal.company.website)) {
                  console.log(`  [Hunter/MA] ⛔ ${hEmail} — domain mismatch vs ${signal.company.website} — skipping`);
                } else {
                  contact.email = hEmail;
                  contact.email_flagged    = flagged || undefined;
                  contact.emailVerification = { valid, flagged, reason };
                  signal.emailVerification  = { valid, flagged, reason }; // M&A: last found email wins
                  if (flagged) console.log(`  [Hunter/MA] ⚠️  ${hEmail} flagged as risky (${reason}) — saving with [unverified] note`);
                  console.log(`  [Hunter/MA] ✅ ${contact.name} (${contact.title}) → ${hEmail} (score ${score})`);
                  continue;
                }
              }
              console.log(`  [Hunter/MA] ❌ ${hEmail} failed verification (${reason}) for ${contact.name} — will try Puppeteer`);
            } else if (hEmail) {
              console.log(`  [Hunter/MA] ⚠️  ${contact.name} → ${hEmail} rejected (score ${score || 'n/a'}${isFakeEmail(hEmail) ? ', fake' : ', below threshold'})`);
            } else {
              console.log(`  [Hunter/MA] ℹ️  No email found for ${contact.name} — will try Puppeteer`);
            }
          } catch (err) {
            const status = err.response?.status;
            if (status === 429)      console.warn(`  [Hunter/MA] ⏳ Rate limited (429) for ${contact.name}`);
            else if (status === 401) console.warn(`  [Hunter/MA] ❌ Unauthorized (401) — check HUNTER_API_KEY`);
            else { console.warn(`  [Hunter/MA] ⚠️  Error for ${contact.name}: ${err.message}`); getBreaker('hunter').recordFailure(err.message); }
          }
          await new Promise(r => setTimeout(r, 400));
        }
      }

      const stillMissing = signal.ma_contacts.find(c => !c.email && c.name);
      if (stillMissing && !puppeteerCalledForCompany) {
        puppeteerCalledForCompany = true;
        console.log(`  [Puppeteer/MA] Searching ${signal.company.name}...`);
        const puppeteerResult = await findEmailWithPuppeteer(
          signal.company.name,
          signal.company.website,
          'CEO OR CMO OR CFO OR COO OR President'
        );
        if (puppeteerResult?.email && !isFakeEmail(puppeteerResult.email)) {
          const { valid, flagged, reason } = await verifyEmail(puppeteerResult.email, 'puppeteer', null);
          await new Promise(r => setTimeout(r, 400));
          if (valid) {
            stillMissing.email = puppeteerResult.email;
            stillMissing.email_flagged    = flagged || undefined;
            stillMissing.emailVerification = { valid, flagged, reason };
            signal.emailVerification       = { valid, flagged, reason }; // M&A: last found email wins
            if (flagged) console.log(`  [Puppeteer/MA] ⚠️  ${puppeteerResult.email} flagged as risky (${reason}) — saving with [unverified] note`);
            console.log(`  [Puppeteer/MA] ✅ ${stillMissing.name} → ${puppeteerResult.email}`);
          } else {
            console.log(`  [Puppeteer/MA] ❌ ${puppeteerResult.email} failed verification (${reason}) — contacts will show LinkedIn only`);
          }
        } else {
          console.log(`  [Puppeteer/MA] ℹ️  No email found — contacts will show LinkedIn only`);
        }
      }
      return; // M&A with ma_contacts — skip general enrichment
    }

    // Step 2b: Hunter domain-search (News/Press & M&A — best exec email at domain)
    // For News/Press: first try Hunter person-search using name extracted from article
    if (signal.type === 'News/Press' && domain && process.env.HUNTER_API_KEY && !getBreaker('hunter').isOpen()) {
      const extracted = extractNameFromArticle(signal);
      if (extracted) {
        // Remember the article-named person so we can display them even if email lookup fails,
        // and so the Apollo exec search below is skipped (avoids returning a different person).
        signal._article_named_person = extracted;
        console.log(`  [Hunter/NP] Found name in article: ${extracted.firstName} ${extracted.lastName} — trying person search at ${domain}...`);
        try {
          const res = await axios.get('https://api.hunter.io/v2/email-finder', {
            params: {
              domain,
              first_name: extracted.firstName,
              last_name: extracted.lastName,
              api_key: process.env.HUNTER_API_KEY
            },
            timeout: 15000
          });
          getBreaker('hunter').recordSuccess();
          const { email: hEmail, score } = res.data?.data || {};
          if (hEmail && score >= 70 && !isFakeEmail(hEmail)) {
            const { valid, flagged, reason } = await verifyEmail(hEmail, 'hunter', null);
            await new Promise(r => setTimeout(r, 400));
            if (valid) {
              if (!isEmailDomainValid(hEmail, signal.company?.website)) {
                console.log(`  [Hunter/NP] ⛔ ${hEmail} — domain mismatch vs company website — skipping`);
              } else {
                signal._puppeteer_email  = hEmail;
                signal._puppeteer_source = `Hunter (${extracted.firstName} ${extracted.lastName})`;
                signal._email_flagged    = flagged || undefined;
                signal.emailVerification = { valid, flagged, reason };
                if (flagged) console.log(`  [Hunter/NP] ⚠️  ${hEmail} flagged as risky (${reason}) — saving with [unverified] note`);
                console.log(`  [Hunter/NP] ✅ ${extracted.firstName} ${extracted.lastName} → ${hEmail} (score ${score})`);
                return;
              }
            }
            console.log(`  [Hunter/NP] ❌ ${hEmail} failed verification (${reason}) — falling through to domain search`);
          } else if (hEmail) {
            console.log(`  [Hunter/NP] ⚠️  ${hEmail} rejected (score ${score || 'n/a'}${isFakeEmail(hEmail) ? ', fake' : ', below threshold'}) — falling through to domain search`);
          } else {
            console.log(`  [Hunter/NP] ℹ️  No email found for ${extracted.firstName} ${extracted.lastName} — falling through to domain search`);
          }
        } catch (err) {
          const status = err.response?.status;
          if (status === 429)      console.warn(`  [Hunter/NP] ⏳ Rate limited (429) for ${extracted.firstName} ${extracted.lastName}`);
          else if (status === 401) console.warn(`  [Hunter/NP] ❌ Unauthorized (401) — check HUNTER_API_KEY`);
          else {
            console.warn(`  [Hunter/NP] ⚠️  Person search error: ${err.message}`);
            getBreaker('hunter').recordFailure(err.message);
          }
        }
        await new Promise(r => setTimeout(r, 400));
      }
    }

    // Step 2b-NP: Apollo exec search for News/Press — only when NO person was named in the article.
    // If extractNameFromArticle already identified someone (stored in signal._article_named_person),
    // we skip Apollo entirely — using Apollo here would return a *different* person than the one
    // named in the article (e.g. returning Julie Soviero instead of Yogesh Khadilkar from EZ Texting).
    if (signal.type === 'News/Press' && domain && !getBreaker('apollo').isOpen() && !signal._article_named_person) {
      const apolloExec = await apolloFindExec(domain, signal.type);
      if (apolloExec?.firstName) {
        // Title gate — reject contacts that passed Apollo's soft filter but fail our strict check.
        // e.g. "VP Environment Health Safety" slips through Apollo's title search but must be blocked here.
        if (apolloExec.title && !isTitleApproved(apolloExec.title) && !isTitleCSuite(apolloExec.title)) {
          console.log(`  [Apollo/NP] ⛔ ${apolloExec.firstName} ${apolloExec.lastName} (${apolloExec.title}) — title not approved, falling through to Hunter domain search`);
        } else {
          console.log(`  [Apollo/NP] ✅ ${signal.company.name} → found ${apolloExec.firstName} ${apolloExec.lastName} (${apolloExec.title || 'exec'})`);

          // apolloFindExec now returns email + emailStatus when Apollo unlocked it directly.
          // If we already have a verified email, use it immediately — no Hunter credit needed.
          if (apolloExec.email && !isFakeEmail(apolloExec.email)) {
            const src    = apolloExec.emailStatus ? 'apollo' : 'hunter';
            const result = await verifyEmail(apolloExec.email, src, apolloExec.emailStatus || null);
            await new Promise(r => setTimeout(r, 400));
            if (result.valid && isEmailDomainValid(apolloExec.email, signal.company?.website)) {
              signal._puppeteer_email  = apolloExec.email;
              signal._puppeteer_source = `Apollo (${apolloExec.firstName} ${apolloExec.lastName})`;
              signal._email_flagged    = result.flagged || undefined;
              signal.emailVerification = result;
              if (result.flagged) console.log(`  [Apollo/NP] ⚠️  ${apolloExec.email} flagged as risky (${result.reason}) — saving with [unverified] note`);
              console.log(`  [Apollo/NP] ✅ ${apolloExec.firstName} ${apolloExec.lastName} → ${apolloExec.email} (Apollo direct)`);
              return;
            }
            console.log(`  [Apollo/NP] ❌ Apollo email ${apolloExec.email} failed verification or domain check — trying Hunter...`);
          }

          // No email from Apollo (or it failed verification) — hand the name to Hunter.
          // Hunter requires both first and last name — skip if Apollo returned no last name
          // (some Apollo records have only a first name, which causes a Hunter 400 error and
          //  records a circuit breaker failure, potentially tripping the breaker for the whole run).
          if (process.env.HUNTER_API_KEY && !getBreaker('hunter').isOpen() && apolloExec.lastName) {
            try {
              const res = await axios.get('https://api.hunter.io/v2/email-finder', {
                params: { domain, first_name: apolloExec.firstName, last_name: apolloExec.lastName, api_key: process.env.HUNTER_API_KEY },
                timeout: 15000
              });
              getBreaker('hunter').recordSuccess();
              const { email: hEmail, score } = res.data?.data || {};
              if (hEmail && score >= 70 && !isFakeEmail(hEmail)) {
                const { valid, flagged, reason } = await verifyEmail(hEmail, 'hunter', null);
                await new Promise(r => setTimeout(r, 400));
                if (valid) {
                  if (!isEmailDomainValid(hEmail, signal.company?.website)) {
                    console.log(`  [Apollo/NP] ⛔ ${hEmail} — domain mismatch vs company website — skipping`);
                  } else {
                    signal._puppeteer_email  = hEmail;
                    signal._puppeteer_source = `Apollo+Hunter (${apolloExec.firstName} ${apolloExec.lastName})`;
                    signal._email_flagged    = flagged || undefined;
                    signal.emailVerification = { valid, flagged, reason };
                    if (flagged) console.log(`  [Apollo/NP] ⚠️  ${hEmail} flagged as risky (${reason}) — saving with [unverified] note`);
                    console.log(`  [Apollo/NP] ✅ ${apolloExec.firstName} ${apolloExec.lastName} → ${hEmail} (score ${score})`);
                    return;
                  }
                }
                console.log(`  [Apollo/NP] ❌ ${hEmail} failed verification (${reason}) — falling through to domain search`);
              } else if (hEmail) {
                console.log(`  [Apollo/NP] ⚠️  ${hEmail} rejected (score ${score || 'n/a'}${isFakeEmail(hEmail) ? ', fake' : ', below threshold'}) — falling through to domain search`);
              } else {
                console.log(`  [Apollo/NP] ℹ️  Hunter has no email for ${apolloExec.firstName} ${apolloExec.lastName} — falling through to domain search`);
              }
            } catch (err) {
              const status = err.response?.status;
              if (status === 429)      console.warn(`  [Apollo/NP] ⏳ Hunter rate limited (429)`);
              else if (status === 401) console.warn(`  [Apollo/NP] ❌ Hunter unauthorized (401) — check HUNTER_API_KEY`);
              else {
                console.warn(`  [Apollo/NP] ⚠️  Hunter error: ${err.message}`);
                getBreaker('hunter').recordFailure(err.message);
              }
            }
            await new Promise(r => setTimeout(r, 400));
          }
        } // end title gate else
      } else {
        console.log(`  [Apollo/NP] ℹ️  No marketing exec found at ${domain} — falling through to Hunter domain search`);
      }
      await new Promise(r => setTimeout(r, 400));
    }

    let hunterResult = null;
    if (signal.type !== 'Job Change') {
      hunterResult = await findEmailWithHunterDomain(signal);
      if (hunterResult?.email && !isFakeEmail(hunterResult.email)) {
        // Title gate: Hunter domain-search filters by exec/marketing keywords but can still
        // return VP of Business Development, VP of Wealth Management, etc. Apply the same
        // title check the rest of the pipeline uses so only approved contacts pass through.
        // Skip the check if title is absent — absence of title is not grounds for rejection.
        const hunterTitleOk = !hunterResult.title ||
          isTitleApproved(hunterResult.title) || isTitleCSuite(hunterResult.title);
        if (hunterResult.title && !hunterTitleOk) {
          console.log(`  [Hunter] ⛔ Skipping ${hunterResult.email} — title not approved: "${hunterResult.title}"`);
        } else {
          const { valid, flagged, reason } = await verifyEmail(hunterResult.email, 'hunter', null);
          await new Promise(r => setTimeout(r, 400));
          if (valid) {
            // Domain guard: reject emails from the wrong company's domain.
            // Skip if website is unknown — we can't validate what we don't have.
            if (signal.company?.website && !isEmailDomainValid(hunterResult.email, signal.company.website)) {
              console.log(`  [Hunter] ⛔ Skipping ${hunterResult.email} — domain mismatch vs company website — trying pattern...`);
            } else {
              signal._puppeteer_email  = hunterResult.email;
              signal._puppeteer_source = `Hunter${hunterResult.title ? ` (${hunterResult.title})` : ''}`;
              signal._email_flagged    = flagged || undefined;
              signal.emailVerification = { valid, flagged, reason };
              if (flagged) console.log(`  [Hunter] ⚠️  ${hunterResult.email} flagged as risky (${reason}) — saving with [unverified] note`);
              return;
            }
          } else {
            console.log(`  [Hunter] ❌ ${hunterResult.email} failed verification (${reason}) — trying pattern...`);
          }
        }
      }
    }

    // Step 2c: Hunter pattern → construct + verify
    if (domain) {
      let pattern = hunterResult?.pattern || null;
      if (!pattern && signal.type === 'Job Change' && process.env.HUNTER_API_KEY) {
        console.log(`  [Pattern] Checking Hunter for email pattern at ${domain}...`);
        try {
          const res = await axios.get('https://api.hunter.io/v2/domain-search', {
            params: { domain, api_key: process.env.HUNTER_API_KEY },
            timeout: 15000
          });
          pattern = res.data?.data?.pattern || null;
          if (pattern) console.log(`  [Pattern] Hunter pattern: "${pattern}"`);
          else         console.log(`  [Pattern] Hunter has no pattern for ${domain} — trying Puppeteer...`);
        } catch (err) {
          const status = err.response?.status;
          if (status === 429)      console.warn(`  [Pattern] ⏳ Hunter rate limited (429) at ${domain}`);
          else if (status === 401) console.warn(`  [Pattern] ❌ Hunter unauthorized (401) — check HUNTER_API_KEY`);
          else                     console.warn(`  [Pattern] ⚠️  Hunter domain-search error: ${err.message}`);
        }
        await new Promise(r => setTimeout(r, 400));
      }

      if (!pattern) {
        console.log(`  [Pattern] Trying Puppeteer for email pattern at ${domain}...`);
        const patternResult = await findEmailPatternViaGoogle(domain);
        pattern = patternResult?.pattern || null;
        await new Promise(r => setTimeout(r, 600));
      }

      if (pattern) {
        let targetFirst = null;
        let targetLast  = null;

        if (signal.type === 'Job Change' && signal.person?.first_name) {
          targetFirst = signal.person.first_name;
          targetLast  = signal.person.last_name || '';
        } else if (signal.type !== 'Job Change') {
          targetFirst = hunterResult?.firstName || null;
          targetLast  = hunterResult?.lastName  || null;
          if (!targetFirst) {
            const exec = await apolloFindExec(domain, signal.type);
            if (exec) { targetFirst = exec.firstName; targetLast = exec.lastName; }
            await new Promise(r => setTimeout(r, 400));
          }
        }

        if (targetFirst) {
          const constructed = applyHunterPattern(pattern, targetFirst, targetLast, domain);
          if (constructed && !isFakeEmail(constructed)) {
            console.log(`  [Pattern] "${pattern}" → ${constructed} — verifying...`);
            const { valid, flagged, reason } = await verifyEmail(constructed, 'hunter', null);
            await new Promise(r => setTimeout(r, 400));
            if (valid) {
              if (flagged) console.log(`  [Pattern] ⚠️  ${constructed} flagged as risky (${reason}) — saving with [unverified] note`);
              console.log(`  [Pattern] ✅ ${signal.company.name} → ${constructed}`);
              signal._email_flagged    = flagged || undefined;
              signal.emailVerification = { valid, flagged, reason };
              if (signal.type === 'Job Change') {
                signal.person = signal.person || {};
                signal.person.email = constructed;
              } else {
                signal._puppeteer_email  = constructed;
                signal._puppeteer_source = 'pattern';
              }
              return;
            } else {
              console.log(`  [Pattern] ${constructed} failed verification`);
            }
          }
        }
      }
    }

    // Step 3: Puppeteer fallback — Google + company website scrape
    const searchTitle = signal.type === 'Job Change'
      ? (signal.person?.title || 'CMO')
      : signal.type === 'M&A Activity'
        ? 'CEO OR CMO OR CFO OR COO OR CIO OR CHRO OR President OR "Managing Partner"'
        : 'CMO OR "VP Marketing" OR "Chief Marketing Officer"';

    console.log(`  [Puppeteer] Searching ${signal.company.name} for "${searchTitle}"...`);
    const result = await findEmailWithPuppeteer(
      signal.company.name,
      signal.company.website,
      searchTitle
    );

    if (result?.email && !isFakeEmail(result.email)) {
      const trustedDomain = getKnownDomain(signal.company.name) || domain;
      const emailDomain   = result.email.split('@')[1]?.toLowerCase() || '';
      if (trustedDomain && !emailDomain.endsWith(trustedDomain)) {
        console.log(`  [Puppeteer] ❌ Rejected ${result.email} — domain mismatch (expected ${trustedDomain})`);
        console.log(`[Email Enrichment] ✗ No valid email found for ${signal.company.name} after all steps — Contact Info will show "Contact Needed"`);
      } else {
        const { valid, flagged, reason } = await verifyEmail(result.email, 'puppeteer', null);
        if (valid) {
          signal._puppeteer_email  = result.email;
          signal._puppeteer_source = result.source;
          signal._email_flagged    = flagged || undefined;
          signal.emailVerification = { valid, flagged, reason };
          if (flagged) console.log(`  [Puppeteer] ⚠️  ${result.email} flagged as risky (${reason}) — saving with [unverified] note`);
          console.log(`  [Puppeteer] ✅ ${signal.company.name} → ${result.email}`);
        } else {
          console.log(`  [Puppeteer] ❌ ${result.email} failed verification (${reason})`);
          console.log(`[Email Enrichment] ✗ No valid email found for ${signal.company.name} after all steps — Contact Info will show "Contact Needed"`);
        }
      }
    } else {
      console.log(`[Email Enrichment] ✗ No valid email found for ${signal.company.name} after all steps — Contact Info will show "Contact Needed"`);
    }
  }

  // Run enrichment concurrently in batches of ENRICHMENT_CONCURRENCY
  for (let i = 0; i < deduplicatedSignals.length; i += ENRICHMENT_CONCURRENCY) {
    const batch = deduplicatedSignals.slice(i, i + ENRICHMENT_CONCURRENCY);
    await Promise.all(batch.map(s => enrichOneSignal(s).catch(err => {
      // C-NEW-2: mark failed signals so formatForAirtable() can flag them in Airtable
      // rather than silently writing an incomplete record with missing contact/email fields
      s._enrichment_failed = true;
      console.error(`  [Enrichment] Unexpected error for ${s.company?.name}: ${err.message}`);
    })));
  }

  // ── Second pass: broadcast contact discovery for non-BSI signals ───────────
  // Each signal type now expands to multiple Airtable records (one per contact).
  // This pass runs AFTER the primary enrichment so Contact #1 (job-changer, article
  // person, etc.) is already set — runBroadcastContacts() uses that email as excludeEmail
  // to avoid duplicating them in the broadcast results.
  //
  // Job Change:              Contact #1 = job-changer (send_day 1) + up to 3 broadcast execs
  // News/Press, Rebrand, WV: up to 4 broadcast contacts; excludes the single contact already found
  // M&A Activity:            up to 4 broadcast contacts at the acquiring company
  //
  // Signals where broadcast_contacts is not set (BSI handled above, enrichment failed)
  // are skipped here and fall through to the legacy 1-to-1 Airtable path in expandToRecords().
  const broadcastCandidates = deduplicatedSignals.filter(s =>
    s.type !== 'Brand Strategy Intent' && !s._enrichment_failed
  );

  if (broadcastCandidates.length > 0) {
    console.log(`[Airtable] Running broadcast contact discovery for ${broadcastCandidates.length} non-BSI signal(s)...`);
    for (let i = 0; i < broadcastCandidates.length; i += ENRICHMENT_CONCURRENCY) {
      const batch = broadcastCandidates.slice(i, i + ENRICHMENT_CONCURRENCY);
      await Promise.all(batch.map(async (signal) => {
        try {
          const domain = extractDomain(signal.company?.website);
          if (!domain) {
            console.log(`  [Broadcast/${signal.type}] ⚠️  ${signal.company.name} — no domain, skipping`);
            signal.broadcast_contacts = [];
            return;
          }

          console.log(`  [Broadcast/${signal.type}] ${signal.company.name} at ${domain}...`);

          if (signal.type === 'Job Change') {
            // Contact #1 is the job-changer themselves (already in signal.person).
            // Broadcast finds up to 3 additional execs at their new company.
            const excludeEmail = signal.person?.email || signal._puppeteer_email || null;
            signal.broadcast_contacts = await runBroadcastContacts(domain, signal.company.name, 3, excludeEmail);
          } else if (signal.type === 'M&A Activity') {
            // Broadcast finds exec contacts at the acquiring company.
            // (Acquired company domain not available in the signal — not searched.)
            signal.broadcast_contacts = await runBroadcastContacts(domain, signal.company.name, 4, null);
          } else {
            // News/Press, Rebrand, Website Visitor — up to 4 exec contacts.
            // Exclude the single contact the primary pass already found.
            const excludeEmail = signal.person?.email || signal._puppeteer_email || null;
            signal.broadcast_contacts = await runBroadcastContacts(domain, signal.company.name, 4, excludeEmail);
          }
        } catch (err) {
          signal.broadcast_contacts = [];
          console.error(`  [Broadcast] Error for ${signal.company?.name}: ${err.message}`);
        }
      }));
    }
  }

  // Step 4.3: Format and split by destination
  // AudienceLab signals go to a separate base (if configured) to avoid hitting the
  // main base record limit. All other signals go to the main base as normal.
  const alBaseId    = process.env.AUDIENCELAB_AIRTABLE_BASE_ID;
  const alTableName = process.env.AUDIENCELAB_AIRTABLE_TABLE_NAME;
  const useAlBase   = !!(alBaseId && alTableName);

  const mainSignals        = useAlBase
    ? deduplicatedSignals.filter(s => s.source !== 'AudienceLab')
    : deduplicatedSignals;
  const audienceLabSignals = useAlBase
    ? deduplicatedSignals.filter(s => s.source === 'AudienceLab')
    : [];

  const mainRecords = expandToRecords(mainSignals);
  const alRecords   = expandToRecords(audienceLabSignals);

  console.log(`[Airtable] Formatted ${mainRecords.length} records for main base${useAlBase ? `, ${alRecords.length} for AudienceLab base` : ''}`);

  let totalInserted  = 0;
  const failedRecords = [];

  // ── Shared batch insert helper ─────────────────────────────────────────────
  async function insertBatches(records, label, insertFn) {
    const batches = chunkArray(records, 10);
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      try {
        console.log(`[${label}] Inserting batch ${i + 1}/${batches.length} (${batch.length} records)...`);
        const result = await insertFn(batch);
        totalInserted += result.length;
        console.log(`[${label}] Batch ${i + 1} done (${result.length} records)`);
        if (i < batches.length - 1) await new Promise(r => setTimeout(r, 1000));
      } catch (error) {
        console.error(`[${label}] Batch ${i + 1} failed:`, error.message);

        const isRateLimit = error.statusCode === 429 ||
          (error.message || '').toLowerCase().includes('rate limit') ||
          (error.message || '').toLowerCase().includes('too many requests');

        if (isRateLimit) {
          // Rate limit: wait then retry the ENTIRE batch — safe because nothing was written yet
          console.warn(`[${label}] Rate limit — waiting 30s before retrying batch ${i + 1}...`);
          await new Promise(r => setTimeout(r, 30000));
          try {
            const result = await insertFn(batch);
            totalInserted += result.length;
            console.log(`[${label}] Batch ${i + 1} succeeded on retry (${result.length} records)`);
            if (i < batches.length - 1) await new Promise(r => setTimeout(r, 1000));
            continue;
          } catch (retryErr) {
            console.error(`[${label}] Batch ${i + 1} still failed after retry:`, retryErr.message);
            // Fall through to individual insertion — do NOT retry batch again (risk of duplicates)
          }
        }

        // Network/timeout errors have no HTTP status — the request may have already reached
        // Airtable and written some records before the connection dropped. Individual re-insertion
        // would create duplicates. Add the whole batch to failedRecords for manual review instead.
        const httpStatus = error.statusCode || error.response?.status;
        if (!httpStatus) {
          console.error(`[${label}] Batch ${i + 1} failed with a network/timeout error (no HTTP status) — skipping individual fallback to avoid duplicates. ${batch.length} record(s) added to failed list.`);
          failedRecords.push(...batch);
          continue;
        }

        // HTTP error (4xx/5xx from Airtable): request was rejected before any records were written.
        // Individual insertion is safe — it will identify and isolate the bad record.
        console.log(`[${label}] Falling back to individual insertion for batch ${i + 1} (HTTP ${httpStatus})...`);
        await new Promise(r => setTimeout(r, 2000));
        for (const record of batch) {
          try {
            const result = await insertFn([record]);
            totalInserted += result.length;
          } catch (singleErr) {
            console.error(`[${label}] Single record failed (${record.fields?.['Company Name'] || '?'}):`, singleErr.message);
            failedRecords.push(record);
          }
          await new Promise(r => setTimeout(r, 300));
        }
      }
    }
  }

  // Step 4.4: Insert main signals into main base
  if (mainRecords.length > 0) {
    await insertBatches(mainRecords, 'Airtable', batch => airtableClient.createRecords(batch));
  }

  // Step 4.4b: Insert AudienceLab signals into separate base (if configured)
  if (alRecords.length > 0 && useAlBase) {
    console.log(`[Airtable/AudienceLab] Inserting ${alRecords.length} records into separate base (${alBaseId})...`);
    await insertBatches(alRecords, 'Airtable/AudienceLab', batch => createRecordsInBase(alBaseId, alTableName, batch));
  }

  if (failedRecords.length > 0) {
    fs.writeFileSync(`${TMP_DIR}/airtable_failures_${today}.json`, JSON.stringify(failedRecords, null, 2));
    await sendErrorAlert(`Airtable: ${failedRecords.length} records failed to insert. See .tmp/airtable_failures_${today}.json`);
  }

  // Step 4.5: Verify
  let verifyCount = '?';
  try {
    const verifyRecords = await airtableClient.query({ filterByFormula: `IS_SAME({Date Detected}, '${todayStr}', 'day')` });
    verifyCount = verifyRecords.length;
    console.log(`[Airtable] Verification: ${verifyCount} records with today's date`);
  } catch (err) {
    console.error('[Airtable] Verification query failed:', err.message);
  }

  // Step 4.6: Log
  const totalToInsert = mainRecords.length + alRecords.length;
  const status        = totalInserted === totalToInsert ? 'SUCCESS' : 'PARTIAL FAILURE';
  const logEntry      = `
[${new Date().toISOString()}] Airtable Insertion Log
=================================================
Total to insert:   ${totalToInsert} (main: ${mainRecords.length}, AudienceLab: ${alRecords.length})
Inserted:          ${totalInserted}
Failed:            ${failedRecords.length}
Verification:      ${verifyCount}
Status:            ${status}
=================================================
`;

  fs.appendFileSync(`${TMP_DIR}/airtable_log_${today}.txt`, logEntry);
  console.log(`[Airtable] Complete: ${totalInserted}/${totalToInsert} records — ${status}`);

  // Step 4.7: HubSpot auto-push (inactive by default).
  // Enable only after David/Zack confirm sequences are live and tested.
  // Manual push from the dashboard is the primary path until then.
  const AUTO_PUSH_TO_HUBSPOT = process.env.AUTO_PUSH_TO_HUBSPOT === 'true';

  if (AUTO_PUSH_TO_HUBSPOT) {
    console.log('\n[HubSpot Auto-Push] Auto-push enabled — pushing signals to HubSpot CRM...');
    for (const signal of deduplicatedSignals) {
      // Extract per-contact objects from the signal based on type.
      // pushSignalToHubSpot takes (signal, contact) — one call per contact.
      const contacts = extractHubSpotContacts(signal);
      for (const contact of contacts) {
        if (!contact.email) continue;
        try {
          const pushResult = await pushSignalToHubSpot(signal, contact);
          if (pushResult.success) {
            console.log(`[HubSpot Auto-Push] ✓ ${signal.company?.name || '?'} pushed successfully`);
          } else {
            console.log(`[HubSpot Auto-Push] ✗ Push failed for ${signal.company?.name || '?'}: ${pushResult.error || pushResult.reason}`);
          }
        } catch (err) {
          // Non-fatal — pipeline continues regardless
          console.error(`[HubSpot Auto-Push] Unexpected error for ${signal.company?.name || '?'} / ${contact.email}: ${err.message}`);
        }
      }
    }
    console.log('[HubSpot Auto-Push] Complete.');
  }

  return totalInserted;
}

export default saveToAirtable;

// Named exports — used by scripts/reverify_database.js for database cleanup.
// isTitleApproved / isTitleCSuite: apply the same title filter that the live pipeline uses.
// isEmailDomainValid: apply the same domain-mismatch check.
// apolloFindExec: 4-pass has_email + POST /people/match contact search.
export { isTitleApproved, isTitleCSuite, isEmailDomainValid, isCorporateEmployee, apolloBroadcastSearch, apolloFindExec };
