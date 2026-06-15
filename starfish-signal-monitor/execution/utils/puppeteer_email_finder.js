/**
 * Puppeteer Email Finder
 * Fallback contact finder when Apollo/Hunter return no email.
 *
 * Strategy:
 * 1. Google search -> company website scrape
 * 2. If Google CAPTCHAs -> DuckDuckGo (automatic fallback, no code changes needed upstream)
 *
 * Uses the system's installed Google Chrome (not bundled Chromium).
 * Uses a shared browser pool -- one Chrome instance reused across all calls.
 * Never throws -- all errors return null.
 */

import puppeteer from 'puppeteer';
import { existsSync } from 'fs';
import { isFakeEmail } from './email_validator.js';

// -- Chrome path ------------------------------------------------------------------
// Resolve in order: env var -> Linux paths (Railway) -> Windows default -> null (Puppeteer bundled)
function resolveChromePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  if (process.platform === 'linux') {
    const candidates = [
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium'
    ];
    for (const p of candidates) {
      if (existsSync(p)) return p;
    }
  }
  if (process.platform === 'win32') {
    return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  }
  return null; // let Puppeteer fall back to its bundled Chromium
}
const CHROME_PATH = resolveChromePath();

// -- Helpers ----------------------------------------------------------------------

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// Common pages to check on company websites
const CONTACT_PATHS = ['/contact', '/contact-us', '/about', '/about-us', '/team', '/leadership', '/our-team', '/executives'];

// Domains to ignore when looking for a company's own website in search results
const SKIP_WEBSITE_DOMAINS = new Set([
  'google.com', 'youtube.com', 'facebook.com', 'twitter.com', 'x.com',
  'linkedin.com', 'instagram.com', 'wikipedia.org', 'crunchbase.com',
  'bloomberg.com', 'reuters.com', 'techcrunch.com', 'businesswire.com',
  'prnewswire.com', 'globenewswire.com', 'yelp.com', 'glassdoor.com',
  'indeed.com', 'pitchbook.com', 'zoominfo.com', 'dnb.com', 'wsj.com',
  'ft.com', 'forbes.com', 'fortune.com', 'inc.com', 'axios.com',
  'apple.com', 'amazon.com', 'microsoft.com', 'github.com', 'trustpilot.com',
  'bbb.org', 'sec.gov', 'businessinsider.com', 'cnbc.com', 'yahoo.com',
  'bing.com', 'msn.com', 'duckduckgo.com', 'reddit.com', 'quora.com',
  'stackexchange.com', 'stackoverflow.com', 'imdb.com', 'wikihow.com',
  'merriam-webster.com', 'dictionary.com', 'britannica.com', 'thesaurus.com',
  'cambridge.org', 'vocabulary.com', 'brainyquote.com', 'goodreads.com',
  'amazon.co.uk', 'ebay.com', 'etsy.com', 'walmart.com', 'target.com',
  'ikea.com', 'mayoclinic.org', 'healthline.com',
  'zhihu.com', 'baidu.com', 'weibo.com', 'qq.com',
  'chatgpt.com', 'openai.com', 'anthropic.com',
  'rottentomatoes.com', 'zillow.com', 'realtor.com', 'trulia.com',
  'investing.com', 'marketwatch.com', 'seekingalpha.com', 'fool.com',
  'montrealgazette.com', 'torontosun.com', 'nationalpost.com'
]);

// Email patterns to skip -- generic/support addresses and known error/fake patterns
const SKIP_PATTERNS = [
  'noreply', 'no-reply', 'support', 'info@', 'hello@',
  'press@', 'media@', 'legal@', 'privacy@', 'unsubscribe',
  'error-lite', 'error@', 'errors@'
];

function isUsefulEmail(email) {
  const lower = email.toLowerCase();
  if (SKIP_PATTERNS.some(p => lower.includes(p))) return false;
  // Reject emails from search engine / social domains (e.g. error-lite@duckduckgo.com)
  const emailDomain = email.split('@')[1]?.toLowerCase() || '';
  if (SKIP_WEBSITE_DOMAINS.has(emailDomain)) return false;
  // Also check subdomains of skip domains (e.g. mail.google.com)
  for (const skip of SKIP_WEBSITE_DOMAINS) {
    if (emailDomain.endsWith('.' + skip)) return false;
  }
  // Reject URL-encoded or garbled local parts (e.g. x3d%22@, %22@ from HTML attributes)
  const local = email.split('@')[0] || '';
  if (local.includes('%') || !/^[a-zA-Z]/.test(local)) return false;
  // Reject hex-encoded garbage short locals (e.g. x3d@ from HTML char codes)
  if (/^[0-9a-f]{2,5}$/i.test(local)) return false;
  return true;
}

// Score emails -- prefer ones that look like real people (firstname.lastname@)
function scoreEmail(email) {
  const local = email.split('@')[0].toLowerCase();
  if (/^[a-z]+\.[a-z]+$/.test(local)) return 3;    // firstname.lastname
  if (/^[a-z]+[._][a-z]+$/.test(local)) return 2;  // firstname_lastname
  if (/^[a-z]{2,}$/.test(local)) return 1;          // single name
  return 0;
}

// Detect the email pattern used by a company from a list of sample emails
function detectEmailPattern(emails) {
  const PATTERN_TESTS = [
    { regex: /^[a-z]+\.[a-z]{2,}$/, pattern: '{first}.{last}' },  // john.doe
    { regex: /^[a-z]\.[a-z]{2,}$/,  pattern: '{f}.{last}'     },  // j.doe
    { regex: /^[a-z]+_[a-z]{2,}$/,  pattern: '{first}_{last}' },  // john_doe
    { regex: /^[a-z][a-z]{3,8}$/,   pattern: '{f}{last}'      },  // jdoe
    { regex: /^[a-z]{3,}$/,         pattern: '{first}'         },  // john
  ];

  const counts = {};
  for (const { pattern } of PATTERN_TESTS) counts[pattern] = 0;

  for (const email of emails) {
    const local = email.split('@')[0].toLowerCase();
    for (const { regex, pattern } of PATTERN_TESTS) {
      if (regex.test(local)) { counts[pattern]++; break; }
    }
  }

  let best = null;
  let bestCount = 0;
  for (const [pattern, count] of Object.entries(counts)) {
    if (count > bestCount) { bestCount = count; best = pattern; }
  }
  return bestCount > 0 ? best : null;
}

// Company name stopwords -- filtered out before matching against page text
const COMPANY_STOPWORDS = new Set([
  'inc', 'llc', 'ltd', 'corp', 'co', 'company', 'group', 'holdings',
  'international', 'global', 'services', 'solutions', 'technologies',
  'technology', 'the', 'and', 'of', 'a', 'an', 'for', 'in', 'on', 'at',
  'by', 'to', 'with', 'from', 'its', 'their', 'our', 'your', 'this'
]);

// Returns significant words from a company name (lowercase, no stopwords, no punctuation)
function getSignificantWords(name) {
  if (!name) return [];
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !COMPANY_STOPWORDS.has(w));
}

// -- CAPTCHA detection ------------------------------------------------------------
function isCaptchaPage(content) {
  return (
    content.includes('unusual traffic') ||
    content.includes('are not a robot') ||
    content.includes('captcha') ||
    content.includes('recaptcha') ||
    content.includes('g-recaptcha')
  );
}

// Strict domain format -- only real domain strings (no spaces, +, follower counts, etc.)
const VALID_DOMAIN_REGEX = /^[a-z0-9][a-z0-9\-\.]*\.[a-z]{2,}$/i;

// Returns up to `limit` candidate domains from search result URLs (all valid, not just first)
function parseDomainCandidates(rawUrls, limit = 5) {
  const candidates = [];
  for (const raw of rawUrls) {
    const domain = raw
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, '')
      .split('\u203a')[0].trim()
      .split('/')[0]
      .split('?')[0]
      .toLowerCase()
      .trim();
    let isSkipped = SKIP_WEBSITE_DOMAINS.has(domain);
    if (!isSkipped) {
      for (const skip of SKIP_WEBSITE_DOMAINS) {
        if (domain.endsWith('.' + skip) || domain === skip) { isSkipped = true; break; }
      }
    }
    // Strict check: must look like an actual domain (no spaces, follower counts, etc.)
    if (
      domain &&
      VALID_DOMAIN_REGEX.test(domain) &&
      !isSkipped &&
      !candidates.includes(domain)
    ) {
      candidates.push(domain);
      if (candidates.length >= limit) break;
    }
  }
  return candidates;
}

// -- Domain validation -- visit homepage and confirm company name appears -----------
/**
 * Visits a candidate domain's homepage and checks that the company name
 * appears in the page title / h1 text. Prevents wrong-company domains from
 * being used (e.g. nourish-poultry.com when looking for "Nourish" the app).
 *
 * Returns true if the domain is confirmed to belong to the company.
 * Returns false if validation fails OR the homepage is unreachable.
 * Never throws.
 */
async function validateDomainBelongsToCompany(page, domain, companyName) {
  if (!domain || !companyName) return false;

  const sigWords = getSignificantWords(companyName);
  if (sigWords.length === 0) return true; // Nothing to check -- trust it

  try {
    await page.goto(`https://${domain}`, { waitUntil: 'domcontentloaded', timeout: 12000 });

    const pageText = await page.evaluate(() => {
      const title = (document.title || '').toLowerCase();
      const h1s   = Array.from(document.querySelectorAll('h1'))
        .slice(0, 3)
        .map(el => (el.innerText || el.textContent || '').toLowerCase())
        .join(' ');
      return title + ' ' + h1s;
    });

    if (!pageText.trim()) {
      console.log(`    [Validate] ${domain} -- blank page, rejecting`);
      return false;
    }

    // Count how many significant company name words appear in the page
    const matched = sigWords.filter(w => pageText.includes(w));
    const matchRatio = matched.length / sigWords.length;

    // Domain-level penalty: if domain has extra hyphened segments or extra appended
    // characters not in the company name, it's likely a different company.
    let domainPenalty = 0;
    if (sigWords.length <= 2) {
      const domainCore = domain
        .replace(/\.(com|org|net|io|co|ai|app|tech|ag|fm|tv|us|ca|uk|au)(\.[a-z]{2})?$/, '')
        .toLowerCase();

      // Case A -- hyphenated domain (e.g. nourish-poultry): extra hyphen segments not in company name
      const hyphenParts = domainCore.split('-').filter(p => p.length > 2);
      if (hyphenParts.length > 1) {
        const extraHyphen = hyphenParts.filter(p => !sigWords.some(w => p.includes(w) || w.includes(p)));
        if (extraHyphen.length > 0) domainPenalty = Math.max(domainPenalty, 0.45);
      }

      // Case B -- concatenated extra suffix (e.g. prophetxcasino, dustbandofficial)
      const nameCore = sigWords.join('');
      if (
        !domainCore.includes('-') &&
        domainCore.length > nameCore.length + 3 &&
        domainCore.startsWith(nameCore)
      ) {
        domainPenalty = Math.max(domainPenalty, 0.45);
      }
    }

    // For single-word company names require all words to appear; multi-word allows 60%
    const baseThreshold = sigWords.length === 1 ? 1.0 : 0.6;
    const effectiveScore = matchRatio - domainPenalty;

    if (effectiveScore >= baseThreshold) {
      console.log(`    [Validate] ${domain} confirmed for "${companyName}"`);
      return true;
    } else {
      console.log(`    [Validate] ${domain} rejected for "${companyName}" -- score ${effectiveScore.toFixed(2)} < ${baseThreshold} (matched: ${matched.join(', ') || 'none'}, penalty: ${domainPenalty})`);
      return false;
    }

  } catch {
    // Homepage unreachable or timed out -- reject to be safe
    console.log(`    [Validate] ${domain} rejected -- homepage unreachable`);
    return false;
  }
}

// -- Browser pool -----------------------------------------------------------------
// Each slot is one Chrome process. Workers acquire a slot, open a page inside it,
// then release the slot when done. This means N concurrent workers each get their
// own isolated Chrome — no tab contention, no cross-worker page.close() collisions.
//
// Pool size matches PUPPETEER_CONCURRENCY (default 5). Override with the env var
// on memory-constrained hosts (e.g. PUPPETEER_CONCURRENCY=2).
const POOL_SIZE = Number(process.env.PUPPETEER_CONCURRENCY) || 5;

const _launchOpts = {
  headless:          true,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
    '--disable-infobars',
    '--window-size=1366,768'
  ],
  ignoreDefaultArgs: ['--enable-automation']
};
if (CHROME_PATH) _launchOpts.executablePath = CHROME_PATH;

// Pool: array of slots, each { browser: null | Browser, busy: false | true }
const _pool      = Array.from({ length: POOL_SIZE }, () => ({ browser: null, busy: false }));
const _waitQueue = []; // resolvers waiting for a free slot

/**
 * Acquire a free browser slot.
 * Returns a slot object — caller must call _releaseSlot(slot) when done.
 * Launches a fresh Chrome if the slot has no running browser.
 */
async function _acquireSlot() {
  // Find a free slot synchronously if one is available
  const free = _pool.find(s => !s.busy);
  if (free) {
    free.busy = true;
    if (!free.browser || !free.browser.connected) {
      free.browser = await puppeteer.launch(_launchOpts);
    }
    return free;
  }
  // All slots busy — wait in queue
  return new Promise(resolve => _waitQueue.push(resolve));
}

/**
 * Release a browser slot so the next waiter (or future caller) can use it.
 * The browser is kept alive for reuse — it is only killed in closeBrowser().
 */
function _releaseSlot(slot) {
  slot.busy = false;
  if (_waitQueue.length > 0) {
    const next = _waitQueue.shift();
    slot.busy = true;
    // Ensure browser is still alive before handing slot to the next waiter.
    // If the reconnect fails, do NOT hand the broken slot to the next waiter —
    // that would give them a dead browser and cause an immediate crash.
    // Instead, put the waiter back at the front of the queue and free the slot
    // so the next successful _releaseSlot() call picks them up with a working browser.
    Promise.resolve(
      slot.browser && slot.browser.connected
        ? slot
        : puppeteer.launch(_launchOpts).then(b => { slot.browser = b; return slot; })
    ).then(next).catch(() => {
      _waitQueue.unshift(next); // waiter goes back to the front — they'll get the next good slot
      slot.busy = false;        // free the slot without handing it to anyone
    });
  }
}

/**
 * Open a new page inside an acquired browser slot.
 * The returned page's close() automatically releases the slot.
 * Callers need no changes — just open and close pages as before.
 */
async function newPage() {
  const slot = await _acquireSlot();
  if (!slot) throw new Error('Browser pool is shutting down');
  try {
    const page = await slot.browser.newPage();
    // Wrap close() to release the slot automatically
    const _originalClose = page.close.bind(page);
    page.close = async (...args) => {
      page.close = _originalClose; // prevent double-release on re-close
      _releaseSlot(slot);
      return _originalClose(...args);
    };
    return page;
  } catch (err) {
    _releaseSlot(slot);
    throw err;
  }
}

async function closeBrowser() {
  // Drain wait queue — resolve any pending waiters with a dummy so they don't hang
  while (_waitQueue.length > 0) _waitQueue.shift()(null);

  // Close every browser in the pool
  await Promise.all(_pool.map(async slot => {
    if (slot.browser) {
      try {
        const pages = await slot.browser.pages();
        await Promise.all(pages.map(p => p.close().catch(() => {})));
      } catch (err) {
        console.error('[Puppeteer] Error closing pages during shutdown:', err.message);
      }
      try { await slot.browser.close(); } catch (err) {
        console.error('[Puppeteer] Error closing browser during shutdown:', err.message);
      }
      slot.browser = null;
      slot.busy    = false;
    }
  }));
}

// -- Core: scrape emails from a page ----------------------------------------------
async function scrapeEmailsFromPage(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 8000 });
    const content = await page.content();
    const matches = content.match(EMAIL_REGEX) || [];
    return [...new Set(matches)].filter(isUsefulEmail);
  } catch {
    return [];
  }
}

// -- Company website scrape -------------------------------------------------------
async function searchCompanyWebsite(page, website) {
  if (!website) return [];
  const base = website.replace(/\/$/, '');
  const allEmails = [];
  for (const path of CONTACT_PATHS) {
    const emails = await scrapeEmailsFromPage(page, base + path);
    allEmails.push(...emails);
    // Only break early if we found a real non-generic email (not sales@, info@, etc.)
    const hasRealEmail = allEmails.some(e => !isFakeEmail(e));
    if (hasRealEmail) break;
    await new Promise(r => setTimeout(r, 500));
  }
  return [...new Set(allEmails)];
}

// -- Google: search for emails ----------------------------------------------------
// Returns { emails: string[], captcha: boolean }
async function searchGoogle(page, companyName, title) {
  try {
    const q   = encodeURIComponent(`"${companyName}" "${title}" email contact`);
    const url = `https://www.google.com/search?q=${q}&num=5`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 8000 });
    const content = await page.content();
    if (isCaptchaPage(content)) {
      console.log('    [Puppeteer] Google CAPTCHA detected -- switching to DuckDuckGo');
      return { emails: [], captcha: true };
    }
    const emails = (content.match(EMAIL_REGEX) || []).filter(isUsefulEmail);
    return { emails: [...new Set(emails)], captcha: false };
  } catch {
    return { emails: [], captcha: false };
  }
}

// -- DuckDuckGo: search for emails ------------------------------------------------
// Automatic fallback when Google CAPTCHAs. No CAPTCHA on DuckDuckGo HTML endpoint.
async function searchDuckDuckGo(page, companyName, title) {
  try {
    const q   = encodeURIComponent(`"${companyName}" "${title}" email contact`);
    const url = `https://duckduckgo.com/html/?q=${q}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });
    const content = await page.content();
    const emails = (content.match(EMAIL_REGEX) || []).filter(isUsefulEmail);
    console.log(`    [Puppeteer] DuckDuckGo search: ${emails.length} emails found`);
    return [...new Set(emails)];
  } catch {
    return [];
  }
}

// -- Google: domain discovery -----------------------------------------------------
// Returns { candidates: string[], captcha: boolean }
async function searchGoogleForDomain(page, companyName) {
  try {
    const q = encodeURIComponent(`"${companyName}" official website`);
    await page.goto(`https://www.google.com/search?q=${q}&num=5`, { waitUntil: 'domcontentloaded', timeout: 8000 });
    const content = await page.content();
    if (isCaptchaPage(content)) {
      return { candidates: [], captcha: true };
    }
    const resultUrls = await page.evaluate(() => {
      const cites = Array.from(document.querySelectorAll('cite')).map(el => el.textContent.trim());
      if (cites.length > 0) return cites;
      return Array.from(document.querySelectorAll('a[href]'))
        .map(a => a.href)
        .filter(h => h.startsWith('http') && !h.includes('google.') && !h.includes('accounts.'));
    });
    return { candidates: parseDomainCandidates(resultUrls), captcha: false };
  } catch {
    return { candidates: [], captcha: false };
  }
}

// -- DuckDuckGo: domain discovery -------------------------------------------------
async function searchDuckDuckGoForDomain(page, companyName) {
  try {
    const q = encodeURIComponent(`"${companyName}" official website`);
    await page.goto(`https://duckduckgo.com/html/?q=${q}`, { waitUntil: 'domcontentloaded', timeout: 10000 });
    // DuckDuckGo HTML shows display URLs in <span class="result__url"> or <a class="result__url">
    const resultUrls = await page.evaluate(() => {
      // Primary: span.result__url text (shows bare domain/path like "example.com > about")
      const spans = Array.from(document.querySelectorAll('span.result__url, a.result__url'))
        .map(el => el.textContent.trim())
        .filter(Boolean);
      if (spans.length > 0) return spans;
      // Fallback: all non-DDG links
      return Array.from(document.querySelectorAll('a[href]'))
        .map(a => a.href)
        .filter(h => h.startsWith('http') && !h.includes('duckduckgo.'));
    });
    const candidates = parseDomainCandidates(resultUrls);
    if (candidates.length > 0) console.log(`    [Puppeteer] DuckDuckGo domain candidates: ${candidates.slice(0,3).join(', ')}`);
    return candidates;
  } catch {
    return [];
  }
}

// -- Domain discovery -- Google first, DuckDuckGo fallback ------------------------
/**
 * Find a company's website domain.
 * Tries Google first. If Google CAPTCHAs, automatically retries on DuckDuckGo.
 *
 * @param {string} companyName
 * @returns {Promise<string|null>} bare domain e.g. "artivion.com", or null
 */
async function findCompanyDomain(companyName) {
  if (!companyName) return null;
  let page;
  try {
    page = await newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    // Collect candidates from Google first, DuckDuckGo on CAPTCHA
    const googleResult = await searchGoogleForDomain(page, companyName);
    let candidates = [...googleResult.candidates];

    if (googleResult.captcha || candidates.length === 0) {
      if (googleResult.captcha) console.log(`    [Puppeteer] Google CAPTCHA on domain search -- trying DuckDuckGo`);
      const ddgCandidates = await searchDuckDuckGoForDomain(page, companyName);
      for (const d of ddgCandidates) {
        if (!candidates.includes(d)) candidates.push(d);
      }
    }

    if (candidates.length === 0) return null;

    // Validate each candidate -- return first one confirmed to belong to the company
    for (const candidate of candidates) {
      const valid = await validateDomainBelongsToCompany(page, candidate, companyName);
      if (valid) return candidate;
      await new Promise(r => setTimeout(r, 300));
    }

    console.log(`    [Puppeteer] No validated domain found for "${companyName}" (tried: ${candidates.slice(0,3).join(', ')})`);
    return null;

  } catch {
    return null;
  } finally {
    if (page) try { await page.close(); } catch {}
  }
}

// -- Email finder -- Google first, DuckDuckGo fallback, then website scrape --------
/**
 * Find a contact email for a company.
 *
 * @param {string} companyName
 * @param {string} website     - Company website URL
 * @param {string} title       - Target title (e.g. "CMO", "VP Marketing")
 * @returns {Promise<{email: string, source: string} | null>}
 */
async function findEmailWithPuppeteer(companyName, website, title = 'CMO') {
  let page;
  try {
    console.log(`    [Puppeteer] Searching for ${title} email at ${companyName}...`);

    page = await newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    // Strategy 1a: Google search
    const googleResult = await searchGoogle(page, companyName, title);
    let searchEmails = googleResult.emails;

    // Strategy 1b: DuckDuckGo if Google CAPTCHAd
    if (googleResult.captcha || searchEmails.length === 0) {
      const ddgEmails = await searchDuckDuckGo(page, companyName, title);
      searchEmails = [...new Set([...searchEmails, ...ddgEmails])];
    }

    // Strategy 2: Company website scrape (only with trusted domain)
    const siteEmails = await searchCompanyWebsite(page, website);

    const allEmails = [...new Set([...searchEmails, ...siteEmails])].filter(isUsefulEmail);

    if (allEmails.length === 0) {
      console.log(`    [Puppeteer] No emails found for ${companyName}`);
      return null;
    }

    const best   = allEmails.sort((a, b) => scoreEmail(b) - scoreEmail(a))[0];
    const source = searchEmails.includes(best) ? (googleResult.captcha ? 'duckduckgo' : 'google') : 'website';

    console.log(`    [Puppeteer] Found: ${best} (via ${source})`);
    return { email: best, source };

  } catch (err) {
    console.error(`    [Puppeteer] Error for ${companyName}: ${err.message}`);
    return null;
  } finally {
    if (page) try { await page.close(); } catch {}
  }
}

// -- Email pattern finder -- Google first, DuckDuckGo fallback --------------------
/**
 * Find the email pattern a company uses (e.g. {first}.{last}) by collecting
 * sample emails from search results.
 *
 * @param {string} domain - bare domain e.g. "acme.com"
 * @returns {Promise<{pattern: string, sampleEmails: string[]} | null>}
 */
async function findEmailPatternViaGoogle(domain) {
  if (!domain) return null;
  let page;
  try {
    page = await newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    // -- Try Google first ---------------------------------------------------------
    const gq = encodeURIComponent(`"@${domain}" email contact`);
    await page.goto(`https://www.google.com/search?q=${gq}&num=10`, { waitUntil: 'domcontentloaded', timeout: 8000 });
    let content = await page.content();
    let usedEngine = 'Google';

    if (isCaptchaPage(content)) {
      // -- Fallback to DuckDuckGo -------------------------------------------------
      console.log(`    [Puppeteer] Google CAPTCHA on pattern search -- trying DuckDuckGo`);
      const dq = encodeURIComponent(`"@${domain}" email`);
      await page.goto(`https://duckduckgo.com/html/?q=${dq}`, { waitUntil: 'domcontentloaded', timeout: 10000 });
      content = await page.content();
      usedEngine = 'DuckDuckGo';
    }

    const matches = (content.match(EMAIL_REGEX) || [])
      .filter(e => {
        const emailDomain = e.split('@')[1]?.toLowerCase() || '';
        return emailDomain === domain && isUsefulEmail(e);
      });

    const unique = [...new Set(matches)];
    if (unique.length === 0) {
      console.log(`    [Puppeteer] No sample emails found for @${domain} (via ${usedEngine})`);
      return null;
    }

    const pattern = detectEmailPattern(unique);
    if (!pattern) {
      console.log(`    [Puppeteer] Emails found for @${domain} but pattern unclear: ${unique.slice(0, 3).join(', ')}`);
      return null;
    }

    console.log(`    [Puppeteer] Pattern detected for ${domain}: "${pattern}" via ${usedEngine} (from ${unique.slice(0, 3).join(', ')})`);
    return { pattern, sampleEmails: unique };

  } catch (err) {
    console.error(`    [Puppeteer] Pattern search error for ${domain}: ${err.message}`);
    return null;
  } finally {
    if (page) try { await page.close(); } catch {}
  }
}

export { findEmailWithPuppeteer, findCompanyDomain, findEmailPatternViaGoogle, validateDomainBelongsToCompany, closeBrowser };
