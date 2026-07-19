// Shared contact info parser — used by SignalDetail and SignalsTable
//
// contact_info is a freeform multi-line text block stored in Airtable.
// We identify fields by pattern:
//   - email:    contains @ and a dot after @
//   - linkedin: contains "linkedin.com"
//   - name:     first non-special line
//   - title:    second non-special line

export function parseContactInfo(raw) {
  if (!raw) return { name: null, title: null, email: null, linkedin: null }

  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean)
  let name = null, title = null, email = null, linkedin = null

  for (const line of lines) {
    if (!email && /@.+\..+/.test(line)) {
      const m = line.match(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/)
      if (m) { email = m[0]; continue }
    }
    if (!linkedin && /linkedin\.com/i.test(line)) {
      // Extract just the URL — line may have a label prefix like "LinkedIn: https://..."
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

  return { name, title, email, linkedin }
}
