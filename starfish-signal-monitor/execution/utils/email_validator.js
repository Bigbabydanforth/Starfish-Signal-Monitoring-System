// ── Shared email validation — union of all patterns from workflow_4 and enrich_airtable ──

// Fake email patterns — Puppeteer sometimes picks up placeholder/example emails
const FAKE_EMAIL_PATTERNS = [
  /^john\.?doe@/i,
  /^john\.?smith@/i,
  /^j\.?doe@/i,
  /^johndoe@/i,
  /^jane\.?doe@/i,
  /^jane\.?smith@/i,
  /^firstname[\._]lastname@/i,
  /^first[\._]last@/i,
  /^name@/i,
  /^user@/i,
  /^example@/i,
  /^test@/i,
  /^sample@/i,
  /^placeholder@/i,
  /^yourname@/i,
  /^email@/i,
  /^admin@/i,
  // FLast@ regex removed — it caused false positives on legitimate emails
  // like JSmith@company.com or MJones@company.com. Other patterns already
  // catch true placeholders (john.doe@, firstname.lastname@, etc.).
];

// Generic inbox prefixes that are never a real person's email
const GENERIC_EMAIL_PREFIXES = [
  'noreply', 'no-reply', 'support@', 'info@', 'hello@', 'contact@',
  'press@', 'media@', 'media.', 'legal@', 'privacy@', 'unsubscribe', 'team@',
  'service@', 'sales@', 'billing@', 'admin@', 'hr@', 'careers@',
  'jobs@', 'recruitment@', 'partnerships@', 'abuse@',
  'investor@', 'investors@', 'ir@', 'webmaster@', 'postmaster@',
  'inquiries', 'customerservice', 'helpdesk', 'donotreply', 'do-not-reply',
  'notifications@', 'alerts@', 'bounce@', 'mailer@', 'robot@', 'daemon@',
  // Generic/placeholder local parts that are not real people
  'anything@', 'someone@', 'nobody@', 'everybody@', 'quality@', 'beerquality@',
  'webmail@', 'newsroom@', 'news@', 'marketing@', 'advertising@', 'retail@',
  // Generic department mailboxes that Hunter sometimes returns as "contacts"
  'solutions', 'marketingteam', 'marketingdept', 'digitalmarketing',
  'operations', 'businessdev', 'businessdevelopment', 'corporate',
  'communications', 'generalinfo', 'generalinquiries', 'globalmarketing'
];

// Free/personal email domains — never a company contact
const PERSONAL_EMAIL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com',
  'icloud.com', 'me.com', 'mac.com', 'live.com', 'msn.com', 'protonmail.com'
]);

// Search engine / directory domains — never a real company contact email
const THIRD_PARTY_SEARCH_DOMAINS = new Set([
  'duckduckgo.com', 'bing.com'
]);

const FILE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'ico', 'webp', 'bmp', 'mp4', 'mp3', 'pdf', 'zip', 'exe', 'css', 'js', 'xml', 'json']);

export function isFakeEmail(email) {
  if (!email || typeof email !== 'string') return true;
  const lower = email.toLowerCase().trim();
  const parts = lower.split('@');
  if (parts.length !== 2) return true;
  const [localPart, domain] = parts;

  // Generic prefix check on localPart only (avoids matching valid domains like multimedia.com)
  const isGeneric = GENERIC_EMAIL_PREFIXES.some(p => {
    if (p.endsWith('@')) {
      return localPart === p.slice(0, -1);
    }
    return localPart.includes(p);
  });
  if (isGeneric) return true;

  if (FAKE_EMAIL_PATTERNS.some(pattern => pattern.test(lower))) return true;

  // Reject short local parts (e.g. e@, jd@)
  if (localPart.length < 3) return true;
  // Reject local parts ending with a special character (e.g. black-@1x.png)
  if (/[-_+.]$/.test(localPart)) return true;
  // Reject personal/free email domains
  if (PERSONAL_EMAIL_DOMAINS.has(domain)) return true;
  // Reject search engine domains (e.g. error-lite@duckduckgo.com)
  if (THIRD_PARTY_SEARCH_DOMAINS.has(domain)) return true;
  // Reject URL-encoded local parts (e.g. x3d%22@, %22@ from HTML attribute scraping)
  if (localPart.includes('%')) return true;
  // Reject local parts that start with a non-alphanumeric character (e.g. .john@, -john@)
  if (!/^[a-zA-Z0-9]/.test(localPart)) return true;

  // Reject system/department emails: 3+ underscores in local part (relaxed from 2 to allow double-barrelled/middle names)
  if ((localPart.match(/_/g) || []).length >= 3) return true;

  // Reject file extensions mistaken as TLDs (e.g. a-logo-black-@1x.png)
  const tld = domain.split('.').pop();
  if (FILE_EXTENSIONS.has(tld)) return true;
  return false;
}
