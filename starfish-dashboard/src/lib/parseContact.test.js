import { describe, it, expect } from 'vitest'
import { parseContactInfo } from './parseContact'

describe('parseContactInfo', () => {

  it('returns all nulls for null input', () => {
    expect(parseContactInfo(null)).toEqual({ name: null, title: null, email: null, linkedin: null })
  })

  it('returns all nulls for empty string', () => {
    expect(parseContactInfo('')).toEqual({ name: null, title: null, email: null, linkedin: null })
  })

  it('parses a standard 4-line contact block', () => {
    const raw = `Jane Smith\nVP of Marketing\njane@acmecorp.com\nhttps://linkedin.com/in/janesmith`
    const result = parseContactInfo(raw)
    expect(result.name).toBe('Jane Smith')
    expect(result.title).toBe('VP of Marketing')
    expect(result.email).toBe('jane@acmecorp.com')
    expect(result.linkedin).toBe('https://linkedin.com/in/janesmith')
  })

  it('extracts email even when it appears first', () => {
    const raw = `jane@acmecorp.com\nJane Smith\nDirector`
    const result = parseContactInfo(raw)
    expect(result.email).toBe('jane@acmecorp.com')
    expect(result.name).toBe('Jane Smith')
    expect(result.title).toBe('Director')
  })

  it('adds https:// prefix to bare linkedin URLs', () => {
    const raw = `John Doe\nlinkedin.com/in/johndoe`
    const result = parseContactInfo(raw)
    expect(result.linkedin).toBe('https://linkedin.com/in/johndoe')
  })

  it('preserves https:// on already-prefixed linkedin URLs', () => {
    const raw = `John Doe\nhttps://linkedin.com/in/johndoe`
    const result = parseContactInfo(raw)
    expect(result.linkedin).toBe('https://linkedin.com/in/johndoe')
  })

  it('strips email from label prefixes like "Email: foo@bar.com"', () => {
    const raw = `Jane Smith\nEmail: jane@company.com`
    const result = parseContactInfo(raw)
    expect(result.email).toBe('jane@company.com')
  })

  it('ignores lines starting with ⚠️ for name', () => {
    const raw = `⚠️ Unverified contact\nJane Smith\nCEO`
    const result = parseContactInfo(raw)
    expect(result.name).toBe('Jane Smith')
    expect(result.title).toBe('CEO')
  })

  it('ignores lines starting with Website: for name and title', () => {
    const raw = `Jane Smith\nWebsite: www.acme.com\nCTO`
    const result = parseContactInfo(raw)
    expect(result.name).toBe('Jane Smith')
    expect(result.title).toBe('CTO')
  })

  it('handles whitespace-only lines gracefully', () => {
    const raw = `\nJane Smith\n\n  \nCFO\n`
    const result = parseContactInfo(raw)
    expect(result.name).toBe('Jane Smith')
    expect(result.title).toBe('CFO')
  })

  it('returns null title when only one non-special line exists', () => {
    const raw = `Jane Smith`
    const result = parseContactInfo(raw)
    expect(result.name).toBe('Jane Smith')
    expect(result.title).toBeNull()
  })

  it('returns null for all fields when only special lines exist', () => {
    const raw = `⚠️ No contact found\nWebsite: example.com`
    const result = parseContactInfo(raw)
    expect(result.name).toBeNull()
    expect(result.title).toBeNull()
    expect(result.email).toBeNull()
    expect(result.linkedin).toBeNull()
  })

  it('does not treat linkedin URL as a title', () => {
    const raw = `John Doe\nhttps://linkedin.com/in/johndoe\nCOO`
    const result = parseContactInfo(raw)
    expect(result.linkedin).toBe('https://linkedin.com/in/johndoe')
    expect(result.title).toBe('COO')
  })

  it('does not treat email line as a name or title', () => {
    const raw = `john@company.com\nJohn Doe\nPartner`
    const result = parseContactInfo(raw)
    expect(result.name).toBe('John Doe')
    expect(result.title).toBe('Partner')
  })

  it('handles email with subdomains', () => {
    const raw = `Jane Smith\njane@mail.acmecorp.co.uk`
    const result = parseContactInfo(raw)
    expect(result.email).toBe('jane@mail.acmecorp.co.uk')
  })

})
