// Backend parseContact tests — uses Node's built-in test runner (node:test)
// Run with: node --test server/lib/parseContact.test.js

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseContactInfo } from './parseContact.js'

describe('parseContactInfo (server)', () => {

  it('returns all nulls for null input', () => {
    const r = parseContactInfo(null)
    assert.equal(r.name, null)
    assert.equal(r.title, null)
    assert.equal(r.email, null)
    assert.equal(r.linkedin, null)
    assert.equal(r.firstName, null)
    assert.equal(r.lastName, null)
    assert.equal(r.jobTitle, null)
  })

  it('returns all nulls for empty string', () => {
    const r = parseContactInfo('')
    assert.equal(r.name, null)
    assert.equal(r.email, null)
  })

  it('parses a full standard 4-line contact block', () => {
    const raw = 'Jane Smith\nVP of Marketing\njane@acmecorp.com\nhttps://linkedin.com/in/janesmith'
    const r = parseContactInfo(raw)
    assert.equal(r.name, 'Jane Smith')
    assert.equal(r.title, 'VP of Marketing')
    assert.equal(r.email, 'jane@acmecorp.com')
    assert.equal(r.linkedin, 'https://linkedin.com/in/janesmith')
    assert.equal(r.firstName, 'Jane')
    assert.equal(r.lastName, 'Smith')
    assert.equal(r.jobTitle, 'VP of Marketing')
  })

  it('splits multi-word first names correctly', () => {
    const raw = 'Mary Jane Watson\nDirector'
    const r = parseContactInfo(raw)
    assert.equal(r.firstName, 'Mary')
    assert.equal(r.lastName, 'Jane Watson')
  })

  it('adds https:// prefix to bare linkedin URLs', () => {
    const raw = 'John Doe\nlinkedin.com/in/johndoe'
    const r = parseContactInfo(raw)
    assert.equal(r.linkedin, 'https://linkedin.com/in/johndoe')
  })

  it('extracts email even when it appears before name', () => {
    const raw = 'jane@acmecorp.com\nJane Smith\nCEO'
    const r = parseContactInfo(raw)
    assert.equal(r.email, 'jane@acmecorp.com')
    assert.equal(r.name, 'Jane Smith')
    assert.equal(r.title, 'CEO')
  })

  it('handles multi-part domain emails (.co.uk)', () => {
    const raw = 'Jane Smith\njane@mail.acmecorp.co.uk'
    const r = parseContactInfo(raw)
    assert.equal(r.email, 'jane@mail.acmecorp.co.uk')
  })

  it('falls back to keyword scan for jobTitle when title is missing', () => {
    const raw = 'John Doe\njohn@company.com\nFounder & CEO'
    const r = parseContactInfo(raw)
    assert.equal(r.jobTitle, 'Founder & CEO')
  })

  it('ignores ⚠️ lines for name extraction', () => {
    const raw = '⚠️ Unverified\nJane Smith\nPartner'
    const r = parseContactInfo(raw)
    assert.equal(r.name, 'Jane Smith')
    assert.equal(r.title, 'Partner')
  })

  it('ignores Website: lines', () => {
    const raw = 'Jane Smith\nWebsite: www.acme.com\nCTO'
    const r = parseContactInfo(raw)
    assert.equal(r.name, 'Jane Smith')
    assert.equal(r.title, 'CTO')
  })

  it('returns null lastName when name is single word', () => {
    const raw = 'Madonna\nCEO'
    const r = parseContactInfo(raw)
    assert.equal(r.firstName, 'Madonna')
    assert.equal(r.lastName, null)
  })

  it('does not set title from lines containing @', () => {
    const raw = 'Jane Smith\njanedoe@company.com'
    const r = parseContactInfo(raw)
    assert.equal(r.title, null)
  })

})
