// Extract a company name from a news article object.
// Returns the extracted name string, or null if nothing found.
function extractCompanyName(article) {
  const title = article.title || '';
  const desc  = article.description || '';
  const text  = title + ' ' + desc;

  // Single words that are never standalone company names
  const WORD_BLOCKLIST = new Set([
    'spring', 'summer', 'fall', 'winter', 'wall', 'street', 'main',
    'new', 'old', 'top', 'best', 'first', 'last', 'next', 'former',
    'north', 'south', 'east', 'west', 'digital', 'global', 'national',
    'report', 'today', 'weekly', 'press', 'wire', 'here', 'now',
    // Generic nouns that pattern-matching sometimes picks up as company names
    'company', 'startup', 'group', 'firm', 'platform', 'business',
    'venture', 'partner', 'partners', 'enterprise', 'enterprises',
    // Legal suffixes that sometimes appear alone
    'inc', 'llc', 'ltd', 'corp', 'co',
    // Connector/article words
    'the', 'and', 'or', 'of', 'for', 'in', 'on', 'at', 'by'
  ]);

  // Phrases that are NEVER real company names — article titles, slogans, listicles
  const ARTICLE_FRAGMENT_PATTERNS = [
    /\bin every\b/i,            // "Top 10 Franchises in Every Industry"
    /\bthat connects\b/i,       // "Media That Connects"
    /engineers?\s*$/i,          // ends with "engineer(s)" — person description
    /^annual meeting\b/i,       // "Annual Meeting Arrow Financial"
    /^top \d+\b/i,              // "Top 10..."
    /^ex-[a-z]/i,               // "Ex-Anduril engineer"
    /^ranked among\b/i,         // "Ranked Among..."
    /^earns recognition\b/i,    // "Earns Recognition..."
    /^who are you\b/i,          // "Who Are You..."
    /\bof the year\b/i,         // "...of the Year"
    /\bappointments?\s*$/i,     // "...appointments"
    /^\d+\s/,                   // starts with a number "10 Trends..."
    /^[a-z][a-z0-9\s]*$/,       // all-lowercase — URL slug or noise (real names are Title Case)
  ];

  function validate(raw) {
    if (!raw) return null;
    let name = raw.trim().replace(/[.,;!?]+$/, '');
    // Strip stock ticker / parenthetical suffixes: "Apple Inc. (AAPL)" → "Apple Inc."
    name = name.replace(/\s*\([^)]{1,10}\)\s*$/, '').trim();
    if (name.length < 2) return null;

    // Reject anything over 80 chars — real company names don't span most of a headline.
    // This prevents the full article title from being returned when a verb keyword
    // appears late in the combined title + description text, while still allowing
    // long legitimate names like "International Business Machines Corporation".
    if (name.length > 80) return null;

    // Reject article fragments, slogans, and listicle titles
    if (ARTICLE_FRAGMENT_PATTERNS.some(p => p.test(name))) return null;

    // Strip hyphenated descriptor prefixes: "Alphabet-spinoff Isomorphic" → "Isomorphic"
    const hyphenDesc = name.match(/^[A-Z][A-Za-z]+-(?:spinoff|backed|owned|acquired|funded|based|led|focused)\s+(.+)/);
    if (hyphenDesc) name = hyphenDesc[1].trim();

    // Strip leading descriptor phrases like "Multiplayer AI startup Dust" → "Dust"
    // or "Cloud security firm Exaforce" → "Exaforce"
    // [A-Za-z0-9]+ handles all-caps acronyms like "AI", "B2B" that appear in descriptors
    const descriptorPhrase = name.match(
      /^(?:[A-Za-z0-9]+\s+){0,4}(?:startup|company|firm|platform|provider|vendor|developer|maker)\s+([A-Z][A-Za-z0-9\s&.',:-]+)$/
    );
    if (descriptorPhrase) name = descriptorPhrase[1].trim();

    // Strip trailing preposition phrases: "Dover Motor Speedway on Sunday" → "Dover Motor Speedway"
    name = name.replace(/\s+(?:on|at|in|for|from|with|during|after|before)\s+\S+$/, '').trim();

    const words = name.split(/\s+/);
    if (words.length === 1 && WORD_BLOCKLIST.has(name.toLowerCase())) return null;
    return name;
  }

  // Bail out early if the title starts with a known non-company prefix.
  // These are journalist/editorial patterns that are never company names.
  const HEADLINE_PREFIXES = [
    /^exclusive:/i,
    /^breaking:/i,
    /^nyse content update:/i,
    /^report:/i,
    /^update:/i,
    /^opinion:/i,
    /^analysis:/i,
    /^forget the /i,
    /^meet the /i,
    /^inside the /i,
    /^how /i,
    /^why /i,
    /^what /i,
    /^the case for/i,
    /^regtech /i,
    /^modular /i,
    // Additional journalist/editorial patterns
    /^annual meeting\b/i,       // "Annual Meeting Arrow Financial highlights..."
    /^top \d+\b/i,              // "Top 10 Franchises..."
    /^ex-[a-z]/i,               // "Ex-Anduril engineer raises..."
    /^\d+\s+/,                  // starts with a number "10 Trends in..."
    /^ranked\b/i,               // "Ranked Among..."
    /^earns\b/i,                // "Earns Recognition..."
    /^who are\b/i,              // "Who Are You Connecting?"
    /^a tale of\b/i,            // "A Tale of Two Transformations"
    /^highlights?\b/i,          // "Highlights Profit Gains..."
    /^releases?\b/i,            // "Releases May 2026 Update"
    /^strengthens?\b/i,         // "Strengthens management team..."
    /^completes?\b/i,           // "Completes acquisition of..."
  ];
  if (HEADLINE_PREFIXES.some(re => re.test(title))) return null;

  // Pattern 1: "[Company] verb..." at start of text.
  // Extended verb list catches M&A press release language ("completes", "agrees", "closes")
  // that wire service headlines use instead of plain "acquires".
  // `i` flag makes verbs case-insensitive ("Completes" == "completes") without
  // affecting the company name capture — validate() still enforces capital-first.
  const m1 = text.match(
    /^([A-Z][A-Za-z0-9\s&.',:-]+?)\s+(?:announces|has\s+announced|unveils|launches|raises|raised|acquires|acquired|completes|completed|agrees|agreed|closes|closed|appoints|names|hires|rebrands|expands|merges|secures|secured|receives|signs)/i
  );
  const v1 = validate(m1?.[1]);
  if (v1) return v1;

  // Pattern 2: "at [Company Name]" — stop at punctuation or function word boundary.
  // Apostrophes excluded so possessives don't extend past the company name.
  // Capped at 50 chars (down from 80) to stay conservative.
  // Added today|now|here to stop-word list so "at Salesforce today" → "Salesforce"
  const m2 = text.match(
    /\bat\s([A-Z][A-Za-z0-9\s&.,:-]{1,50}?)(?=[,;.()\n]|\s+(?:after|before|with|says|said|by|today\b|now\b|here\b|for\b|is\b|was\b|has\b|have\b|will\b|to\b|and\b|in\b|the\b)|$)/
  );
  const v2 = validate(m2?.[1]);
  if (v2) return v2;

  // Pattern 3: Company name in quotes — capped at 60 chars.
  const m3 = text.match(/"([A-Z][A-Za-z0-9\s&.,:-]{1,60}?)"/);
  const v3 = validate(m3?.[1]);
  if (v3) return v3;

  return null;
}

// Parse a headquarters string from PredictLeads into { city, state, country }.
// Handles formats: "San Francisco, CA, United States" | "New York, NY" | "California"
function parseHeadquarters(hqString) {
  if (!hqString) return { city: null, state: null, country: null };

  const parts = hqString.split(',').map(p => p.trim());

  if (parts.length >= 3) {
    return { city: parts[0], state: parts[1], country: parts[2] };
  } else if (parts.length === 2) {
    return { city: parts[0], state: parts[1], country: 'United States' };
  } else if (parts.length === 1) {
    return { city: null, state: parts[0], country: 'United States' };
  }

  return { city: null, state: null, country: null };
}

// Normalize a company name for deduplication comparison.
// Replace & with "and" BEFORE stripping so "Smith & Associates" ≠ "Smith Associates".
// Without this, both normalize to "smithassociates" causing false duplicate matches.
let _nullNameSeq = 0;
function normalizeCompanyName(name) {
  // M2: return a unique sentinel so null/undefined names never collide in the dedup Set
  // (two signals with missing names would otherwise both map to '' and be wrongly merged)
  if (!name || typeof name !== 'string') return `\x00null_${_nullNameSeq++}`;
  return name
    .toLowerCase()
    .trim()
    .replace(/\s*&\s*/g, 'and')   // "Smith & Associates" → "smith and associates"
    .replace(/[^a-z0-9]/g, '');   // strip remaining non-alphanumeric
}

// Garbage name patterns — news headlines / article fragments that are not real company names.
// Defined here so both workflow_2 (pre-Claude filter) and workflow_3 (dedup) use the same list.
const GARBAGE_PATTERNS = [
  /debunking/i,
  /hodl/i,
  /townhall/i,
  /ceo just/i,
  /burning truth/i,
  /wheel of fortune/i,
  /moving beyond/i,
  /^figure ai.s ceo/i,
  /^inaugural company/i,
  /^kroger senior/i,
  /^rochefort-backed/i,
  /^fit house of brands/i,
  /^the burning/i,
  /^annual meeting\b/i,
  /^top \d+\b/i,
  /^ex-[a-z]/i,
  /engineers?\s*$/i,
  /^media that\b/i,
  /\bin every\b/i,
  /^\s*inc\.?\s*$/i,
  /^[a-z][a-z0-9]*$/,
  /^[a-z][a-z0-9\s]+[a-z]me$/,
  /^ranked among\b/i,
  /^earns recognition\b/i,
  /^who are you\b/i,
  /\bappointments?\s*$/i,
  /^highlights?\b/i,
  /^releases?\b/i,
  /^launches\b/i,
  /^completes\b/i,
  /^acquires\b/i,
];

function isGarbageName(name) {
  if (!name || name.trim().length < 2) return true;
  return GARBAGE_PATTERNS.some(p => p.test(name));
}

// Sanitize a raw revenue value from external APIs before it enters the pipeline.
// Rejects negatives, non-numbers, and absurdly large values (> $100T = data error).
// Returns the numeric value or null if invalid.
function sanitizeRevenue(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  if (!isFinite(num) || isNaN(num)) return null;
  if (num < 0)               return null; // negative revenue is invalid
  if (num > 100_000_000_000_000) return null; // > $100T — clearly a data error
  return num;
}

// Format a revenue number into a human-readable string: "$250M", "$1.2B", etc.
function formatRevenue(revenue) {
  if (!revenue || revenue <= 0) return null;
  if (revenue >= 1_000_000_000) return '$' + (revenue / 1_000_000_000).toFixed(1) + 'B';
  if (revenue >= 1_000_000)     return '$' + (revenue / 1_000_000).toFixed(0) + 'M';
  return '$' + revenue.toLocaleString();
}

// Format a generic number into a compact string: "1.2B", "500M", etc.
function formatNumber(num) {
  if (!num) return '0';
  if (num >= 1_000_000_000) return (num / 1_000_000_000).toFixed(1) + 'B';
  if (num >= 1_000_000)     return (num / 1_000_000).toFixed(0) + 'M';
  return num.toLocaleString();
}

// Sanitize a string before passing to external APIs (Apollo, Hunter, PDL).
// Strips control characters, trims whitespace, and enforces a max length.
// Prevents garbage data or injection attempts from reaching API requests.
function sanitizeApiInput(value, maxLength = 200) {
  if (!value || typeof value !== 'string') return '';
  return value
    .replace(/[\x00-\x1F\x7F]/g, '') // strip control characters
    .trim()
    .slice(0, maxLength);
}

export {
  extractCompanyName,
  parseHeadquarters,
  normalizeCompanyName,
  isGarbageName,
  formatRevenue,
  formatNumber,
  sanitizeApiInput,
  sanitizeRevenue
};
