// Shared contact info parser — used by airtable.js (display) and hubspot.js (CRM push)
//
// contact_info is a freeform multi-line text block stored in Airtable.
// Structure varies per signal, but we identify fields by pattern:
//   - email:    contains @ and a dot after @
//   - linkedin: contains "linkedin.com"
//   - name:     first non-special line
//   - title:    second non-special line (or line matching common title keywords)
//
// Returns all fields so callers can pick what they need.

const TITLE_KEYWORDS = /\b(CEO|CTO|CFO|COO|VP|Director|Manager|Head|Lead|Founder|Partner|President|Officer|Engineer|Analyst|Consultant)\b/i

export function parseContactInfo(contactInfo) {
  if (!contactInfo) {
    return { name: null, title: null, email: null, linkedin: null, firstName: null, lastName: null, jobTitle: null }
  }

  const lines = contactInfo.split('\n').map(l => l.trim()).filter(Boolean)
  let name = null, title = null, email = null, linkedin = null

  for (const line of lines) {
    // Strict two-step check: first confirm line contains a plausible email structure,
    // then extract it. The leading check requires a valid TLD (2+ alpha chars after
    // the final dot) — prevents matching "text@text." with no TLD.
    if (!email && /[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/.test(line)) {
      const m = line.match(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/)
      if (m) { email = m[0]; continue }
    }
    if (!linkedin && /linkedin\.com/i.test(line)) {
      const urlMatch = line.match(/(https?:\/\/(?:www\.)?linkedin\.com\/\S+|(?:www\.)?linkedin\.com\/\S+)/i)
      if (urlMatch) {
        linkedin = urlMatch[0].startsWith('http') ? urlMatch[0] : 'https://' + urlMatch[0]
      }
      continue
    }
    if (!name && !line.startsWith('⚠️') && !line.startsWith('Website:')) {
      name = line; continue
    }
    if (name && !title && !line.startsWith('Website:') && !line.startsWith('http') && !line.includes('@')) {
      title = line
    }
  }

  let firstName = null, lastName = null
  if (name) {
    const parts = name.trim().split(/\s+/)
    firstName = parts[0] || null
    lastName  = parts.length > 1 ? parts.slice(1).join(' ') : null
  }

  let jobTitle = title
  if (!jobTitle) {
    for (const line of lines) {
      if (TITLE_KEYWORDS.test(line) && !line.includes('@')) {
        jobTitle = line
        break
      }
    }
  }

  return { name, title, email, linkedin, firstName, lastName, jobTitle }
}
