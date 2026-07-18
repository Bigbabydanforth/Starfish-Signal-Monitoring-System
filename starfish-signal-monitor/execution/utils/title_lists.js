/**
 * title_lists.js
 *
 * Single source of truth for all title classification lists used across the pipeline.
 * Imported by workflow_4_save_to_airtable.js (contact filtering) and
 * used by apolloFindExec / apolloBroadcastSearch for Apollo API search queries.
 *
 * Three categories:
 *   APPROVED_TITLES        — marketing/brand/comms roles Starfish wants to reach
 *   CSUITE_FALLBACK_TITLES — CEO/COO/President — only used when no marketing contact exists
 *   REJECTED_TITLE_WORDS   — words that disqualify any contact regardless of seniority
 */

// ── APPROVED: Primary titles we are actively looking for ─────────────────────
// Used as person_titles in Apollo search queries AND as the allowlist for contact filtering.
// These are the people who own the brand/marketing budget at a company.
export const APPROVED_TITLES = [
  // C-level marketing & brand
  'Chief Marketing Officer',
  'CMO',
  'Chief Brand Officer',
  'CBO',
  'Chief Communications Officer',
  // VP-level (most common decision-maker title)
  'VP Marketing',
  'VP of Marketing',
  'Vice President of Marketing',
  'Vice President Marketing',
  'VP Brand',
  'VP of Brand',
  'VP Brand Marketing',
  'VP Communications',
  'VP of Communications',
  'Vice President Brand',
  'Vice President of Brand',
  'Vice President Communications',
  'Vice President of Communications',
  // SVP / EVP with function
  'SVP Marketing',
  'SVP of Marketing',
  'Senior Vice President of Marketing',
  'Senior Vice President Marketing',
  'SVP Brand',
  'SVP of Brand',
  'Senior Vice President Brand',
  'Senior Vice President of Brand',
  'SVP Communications',
  'SVP of Communications',
  'EVP Marketing',
  'EVP of Marketing',
  'Executive Vice President of Marketing',
  'Executive Vice President Marketing',
  'EVP Brand',
  'EVP of Brand',
  'Executive Vice President Brand',
  'Executive Vice President of Brand',
  'EVP Communications',
  'EVP of Communications',
  // Head / Director level — senior practitioners with budget influence
  'Head of Marketing',
  'Head of Brand',
  'Head of Communications',
  'Director of Marketing',
  'Marketing Director',
  'Director of Brand',
  'Brand Director',
  'Director of Brand Marketing',
  'Director of Communications',
  'Communications Director',
  // Public Relations — a communications function
  'VP Public Affairs',
  'VP of Public Affairs',
  'Vice President Public Affairs',
  'Vice President of Public Affairs',
  'SVP Public Affairs',
  'EVP Public Affairs',
  'Head of Public Relations',
  'VP Public Relations',
  'VP of Public Relations',
  'Vice President Public Relations',
  'Director of Public Relations',
  'Public Relations Director',
];

// ── CSUITE FALLBACK: Used only when no APPROVED_TITLES contact is found ──────
// Apollo pass 3 & 4 — and BSI Tier 3 broadcast.
// These contacts CAN greenlight brand spend but are not the primary target.
export const CSUITE_FALLBACK_TITLES = [
  'CEO',
  'Chief Executive Officer',
  'COO',
  'Chief Operating Officer',
  'President',
  // Partner-level — primary targets at law firms, consulting firms, and PE firms
  'Managing Partner',
  'Senior Partner',
  'Equity Partner',
  'Founding Partner',
  'Managing Director',
];

// ── Apollo search: all titles combined (approved first, fallback second) ──────
// Used as person_titles in mixed_people/api_search.
// Apollo searches across ALL these titles; pass logic in the code picks the best one.
export const APOLLO_SEARCH_TITLES = [
  ...APPROVED_TITLES,
  ...CSUITE_FALLBACK_TITLES,
];

// ── REJECTED: Words that disqualify any contact regardless of seniority ───────
// If a contact's title contains any of these words/phrases, they are dropped.
// ORDER MATTERS: Checked after HARD_JUNIOR_WORDS, before the allowlist.
export const REJECTED_TITLE_WORDS = [
  // Sales / Revenue
  'sales',
  'commercial',              // "EVP Commercial - Americas" / "EVP Chief Commercial Officer" — revenue/sales role
  'business development',    // "SVP of Business Development" — sales function
  // HR / People / Talent
  'hr ', 'human resources', 'talent acquisition', 'talent partner',
  'people experience',       // "People Experience Partner" — HR
  'people partner',          // "People Partner North LATAM" — HR
  'talent sourcing',         // "Talent Sourcing Strategy Partner" — HR/recruiting
  'sourcing partner',        // "Senior Talent Sourcing Partner" — HR/recruiting
  'recruitment partner',     // "Recruitment Partner" — HR
  'ta partner',              // "TA Senior Sourcing Partner" — talent acquisition
  'acquisition partner',     // "Talent and Acquisition Partner" — HR/recruiting
  'learning & development', 'learning and development',  // L&D roles
  // Finance / Tax / Investments
  'finance', 'financial', 'accounting', 'tax', 'treasury', 'controller',
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
  'investment',              // "Co-Founder and Co-Managing Partner at Cordillera Investment Partners"
  'private equity',          // "Private Equity Operating Partner"
  // Technology / Engineering / IT / Security
  'engineer', 'engineering', 'technical', 'information technology', 'it ',
  'technology',              // "Managing Director, Technology Risk"
  'cyber',                   // "Managing Director, Cyber Solutions"
  'information security', 'chief information security',
  'cio', 'chief information officer',
  'infrastructure',          // "Senior Managing Director, Infrastructure & Real Assets"
  'data center',             // "EVP & Leader, CBRE Data Center Capital Markets"
  // Operations / Procurement / Real Estate / Admin / Construction
  'operations', 'operating', // "SVP & Chief Operating Officer" — 'operating' catches it where 'operations' misses
  'procurement', 'supply chain', 'logistics',
  'new homes',               // "Executive Vice President - New Homes Division" — real estate ops
  'administration', 'admin', 'facilities', 'construction', 'manufacturing', 'economics', 'economic',
  // Legal / Compliance
  'legal', 'counsel', 'attorney', 'compliance',
  // Product / Project
  'product manager', 'product owner', 'project manager', 'program manager',
  // Events / Exhibitions (production, not brand strategy)
  'exhibitions',             // "Executive Vice President, Exhibitions"
  // Account management / sales hybrid
  'account director',        // "Executive Vice President - Group Account Director" — agency account mgmt
  // Food / nutrition product roles
  'nutrition',               // "EVP, Nutrition" — product/ops role
  // Research / Science / Academic
  'scientist', 'researcher', 'graphic designer', 'content creator',
  'office manager',
  'research',                // "Managing Director, Research, Advocacy & Standards"
  // Data / analytics
  'analytics',
  // Non-marketing "partner" compound titles
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
  'cross functional partner', // "Cross-Functional Partner"
  'co-innovation', 'co innovation', // "Global Director Partner Co-Innovation" — tech/product
  'partner account',         // "Partner Account Manager" — sales role
  'partner member',          // "Partner Member | Risk Solutions" — HR/risk
  // DEI / Inclusion
  'chief inclusion',         // "EVP, Chief Inclusion Officer" — DEI/HR
  // Other finance/ops EVP disqualifiers
  'branch leader',           // "EVP-Branch Leader Professional Lines Broker"
  'economist',               // "Chief Economist and Partner"
  // Retail / merchandising
  'merchandising',
  // Insurance / specialist medical / specialist roles that slip through
  'anesthesiology', 'auditor', 'inspector',
  // AVP = Assistant Vice President — junior, not a decision-maker
  'avp',
  // Additional VP function words not covered above
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
  'banking',                 // "President of Retail Banking" — finance/banking line of business
  'campus',                  // "President at Cedar Valley Campus" — education admin
  'wireline',                // "President, Wireline" — technical telecom division
  'division',                // "Division President", "Division CEO" — sub-unit role
  'portfolio manager',       // "CEO, Managing Partner, and Portfolio Manager" — investment role
  'high net worth',          // "Prime President, High Net Worth & Specialty Programs" — finance
  'regional managing',       // "Regional Managing Director"
  'country managing',        // "President & Country Managing Director France" — country-level MD
  'brand partnerships',      // "VP Brand Partnerships" at talent/sports agencies — sponsorship sales
  // Geographic/regional qualifiers — reject any C-suite or MD title scoped to a region
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
  'nursing',                 // "VP Chief Nursing Officer" — clinical, not marketing
  'revenue cycle',           // "VP Revenue Cycle Management" — healthcare finance
  // Ops / internal improvement
  'process improvement',     // "VP Business & Process Improvement" — ops/PMO
  // Diplomatic / policy
  'global affairs',          // "Vice Chairman, Global Affairs" — policy/diplomacy
  // Vague/non-marketing VP function
  'engagement strategy',     // "VP Engagement Strategy" — unclear, not brand leadership
];
