import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import api from '../lib/api'
import { parseContactInfo } from '../lib/parseContact'
import SignalTypeBadge from '../components/SignalTypeBadge'
import PriorityBadge from '../components/PriorityBadge'
import StatusDropdown from '../components/StatusDropdown'
import HubSpotButton from '../components/HubSpotButton'

// ── Helpers ───────────────────────────────────────────────────────────────────

// Pre-compute missing fields client-side so the warning shows immediately
// without waiting for an API call. Mirrors the server-side validation in
// pushSignalToHubSpot.js so users see problems before clicking push.
function computeMissingFields(signal) {
  if (!signal) return []
  const missing = []

  if (!signal.contact_info || !signal.contact_info.includes('@')) {
    missing.push('Email address not found in contact info')
  }
  if (!signal.company_name) {
    missing.push('Company name is missing')
  }
  if (!signal.industry || signal.industry.toLowerCase() === 'unknown' || signal.industry.trim() === '') {
    missing.push('Industry is missing or "Unknown" — must be a real industry')
  }
  if (signal.signal_type === 'M&A Activity' && !signal.acquired_company) {
    missing.push('M&A signal requires the acquired company name (for {{TargetCo}} token)')
  }
  if (signal.signal_type === 'Funding' && (!signal.industry || signal.industry.toLowerCase() === 'unknown')) {
    missing.push('Funding signal requires a real industry (for {{Sector}} token)')
  }

  return missing
}

// Ensures a URL has a protocol so browsers don't treat it as a relative path.
// e.g. "linkedin.com/in/foo" → "https://linkedin.com/in/foo"
function safeUrl(url) {
  if (!url) return null
  const trimmed = url.trim()
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed
  return 'https://' + trimmed
}

// ── Formatters ────────────────────────────────────────────────────────────────

function formatDate(dateStr) {
  if (!dateStr) return '—'
  const d = new Date(dateStr + 'T00:00:00')
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
}

function formatDatetime(isoStr) {
  if (!isoStr) return '—'
  return new Date(isoStr).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  })
}

function formatRevenue(rev) {
  if (rev === null || rev === undefined || rev === '') return null
  const n = Number(rev)
  if (isNaN(n)) return null
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1).replace(/\.0$/, '')}B`
  if (n >= 1e6) return `$${Math.round(n / 1e6)}M`
  if (n >= 1e3) return `$${Math.round(n / 1e3)}K`
  return `$${n}`
}

// ── Primitives ─────────────────────────────────────────────────────────────────

function DataPill({ label, value }) {
  if (!value) return null
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: '5px',
      padding: '4px 10px',
      backgroundColor: '#f5f7f8',
      border: '1px solid #e5e7eb',
      borderRadius: '20px',
      fontSize: '12px',
    }}>
      <span style={{ color: '#6da3ab', fontWeight: 500 }}>{label}</span>
      <span style={{ color: '#2d2d2d', fontFamily: 'JetBrains Mono, monospace' }}>{value}</span>
    </span>
  )
}

function SectionHeading({ children }) {
  return (
    <h3 style={{
      fontSize: '11px',
      fontWeight: 600,
      color: '#6da3ab',
      textTransform: 'uppercase',
      letterSpacing: '0.08em',
      margin: '0 0 10px',
    }}>
      {children}
    </h3>
  )
}

function TextBlock({ text, placeholder = '—' }) {
  if (!text) return <p style={{ color: '#9ca3af', fontSize: '13px', margin: 0 }}>{placeholder}</p>
  return (
    <p style={{ margin: 0, fontSize: '13px', lineHeight: '1.65', color: '#2d2d2d', whiteSpace: 'pre-wrap' }}>
      {text}
    </p>
  )
}

// A single labelled row in the metadata grid
function MetaRow({ label, children }) {
  return (
    <div style={{ display: 'contents' }}>
      <span style={{ fontSize: '12px', color: '#6da3ab', fontWeight: 500, paddingBottom: '8px' }}>
        {label}
      </span>
      <span style={{ fontSize: '12px', color: '#2d2d2d', paddingBottom: '8px', fontFamily: 'JetBrains Mono, monospace', wordBreak: 'break-all' }}>
        {children}
      </span>
    </div>
  )
}

function Card({ children, style }) {
  return (
    <div style={{
      backgroundColor: '#ffffff',
      border: '1px solid #e5e7eb',
      borderRadius: '8px',
      padding: '20px 24px',
      marginBottom: '16px',
      ...style,
    }}>
      {children}
    </div>
  )
}

function TextBox({ children, accent = '#6da3ab' }) {
  return (
    <div style={{
      borderLeft: `3px solid ${accent}`,
      backgroundColor: accent === '#004b5c' ? 'rgba(0,75,92,0.05)' : '#f5f7f8',
      padding: '12px 14px',
      borderRadius: '0 4px 4px 0',
    }}>
      {children}
    </div>
  )
}

// ── Skeleton ───────────────────────────────────────────────────────────────────

function Bone({ w = '100%', h = '14px', style }) {
  return (
    <div style={{
      width: w, height: h,
      backgroundColor: '#f3f4f6',
      borderRadius: '4px',
      animation: 'pulse 1.5s ease-in-out infinite',
      ...style,
    }} />
  )
}

function SkeletonDetail() {
  return (
    <div className="detail-grid" style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 320px', gap: '20px', alignItems: 'start' }}>
      <div>
        <Card>
          <Bone w="240px" h="28px" style={{ marginBottom: '12px' }} />
          <Bone w="180px" h="20px" style={{ marginBottom: '16px' }} />
          <div style={{ display: 'flex', gap: '8px' }}>
            {[120, 100, 130].map((w, i) => <Bone key={i} w={`${w}px`} h="28px" style={{ borderRadius: '20px' }} />)}
          </div>
        </Card>
        {[1, 2, 3, 4].map(i => (
          <Card key={i}>
            <Bone w="140px" h="11px" style={{ marginBottom: '12px' }} />
            <Bone h="14px" style={{ marginBottom: '6px' }} />
            <Bone w="80%" h="14px" style={{ marginBottom: '6px' }} />
            <Bone w="55%" h="14px" />
          </Card>
        ))}
      </div>
      <div>
        <Card>
          <Bone w="70px" h="11px" style={{ marginBottom: '14px' }} />
          <Bone w="160px" h="18px" style={{ marginBottom: '6px' }} />
          <Bone w="110px" h="13px" style={{ marginBottom: '12px' }} />
          <Bone w="190px" h="13px" />
        </Card>
      </div>
    </div>
  )
}

// ── BSI Broadcast Contacts ─────────────────────────────────────────────────────

function BSIContactsTable({ contacts }) {
  return (
    <Card>
      <SectionHeading>Broadcast Contacts</SectionHeading>
      {(!contacts || contacts.length === 0) ? (
        <p style={{ fontSize: '13px', color: '#9ca3af', margin: 0 }}>No broadcast contacts found.</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #e5e7eb' }}>
                {['Send Day', 'Name', 'Title', 'Email'].map(col => (
                  <th key={col} style={{
                    padding: '6px 10px', textAlign: 'left', fontSize: '11px',
                    fontWeight: 600, color: '#6da3ab', textTransform: 'uppercase',
                    letterSpacing: '0.05em', whiteSpace: 'nowrap',
                  }}>
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {contacts.map((c, i) => (
                <tr key={c.id || i} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <td style={{ padding: '8px 10px', fontFamily: 'JetBrains Mono, monospace', color: '#6da3ab', whiteSpace: 'nowrap' }}>
                    {c.send_day ? `Day ${c.send_day}` : '—'}
                  </td>
                  <td style={{ padding: '8px 10px', fontWeight: 500, color: '#2d2d2d', whiteSpace: 'nowrap' }}>
                    {c.name || '—'}
                  </td>
                  <td style={{ padding: '8px 10px', color: '#6da3ab', whiteSpace: 'nowrap' }}>
                    {c.title || '—'}
                  </td>
                  <td style={{ padding: '8px 10px' }}>
                    {c.email
                      ? <a href={`mailto:${c.email}`} style={{ color: '#004b5c', textDecoration: 'none', fontFamily: 'JetBrains Mono, monospace' }}>{c.email}</a>
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

// ── Acquired Company Editor (M&A signals only) ────────────────────────────────
// Shows inline for any M&A signal — whether or not contact info exists.

function AcquiredCompanyEditor({ signalId, initialValue, onSaved }) {
  const [editing, setEditing] = useState(false)
  const [value,   setValue]   = useState(initialValue || '')
  const [saving,  setSaving]  = useState(false)
  const [error,   setError]   = useState('')

  async function handleSave() {
    if (!value.trim()) { setError('Required.'); return }
    setSaving(true)
    setError('')
    try {
      await api.patch(`/api/signals/${signalId}/acquired-company`, { acquired_company: value.trim() })
      onSaved(value.trim())
      setEditing(false)
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save.')
    } finally {
      setSaving(false)
    }
  }

  if (!editing) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span style={{ fontSize: '13px', color: value ? '#2d2d2d' : '#9ca3af', fontFamily: value ? 'JetBrains Mono, monospace' : 'Inter, sans-serif' }}>
          {value || 'Not set'}
        </span>
        <button
          onClick={() => setEditing(true)}
          style={{ fontSize: '11px', color: '#004b5c', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline' }}
        >
          {value ? 'Edit' : 'Add'}
        </button>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <input
        value={value}
        onChange={e => { setValue(e.target.value); setError('') }}
        placeholder="e.g. Acme Corp"
        autoFocus
        style={{
          width: '100%', padding: '7px 9px', border: `1px solid ${error ? '#f87171' : '#d1d5db'}`,
          borderRadius: '6px', fontSize: '13px', boxSizing: 'border-box',
        }}
      />
      {error && <span style={{ fontSize: '11px', color: '#dc2626' }}>{error}</span>}
      <div style={{ display: 'flex', gap: '6px' }}>
        <button
          onClick={handleSave}
          disabled={saving}
          style={{
            flex: 1, padding: '7px', backgroundColor: saving ? '#9ca3af' : '#004b5c',
            color: '#fff', border: 'none', borderRadius: '6px', fontSize: '12px',
            fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer',
          }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          onClick={() => { setEditing(false); setValue(initialValue || ''); setError('') }}
          style={{
            padding: '7px 12px', background: 'none', border: '1px solid #d1d5db',
            borderRadius: '6px', fontSize: '12px', cursor: 'pointer', color: '#6b7280',
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

// ── Add Contact Form (inline, shown when signal has no contact info) ──────────

function AddContactForm({ signalId, signalType, onSaved }) {
  const isMA = signalType === 'M&A Activity'
  const [form, setForm]     = useState({ name: '', title: '', email: '', linkedin: '', acquired_company: '' })
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)
  const [apiError, setApiError] = useState('')

  function handleChange(e) {
    const { name, value } = e.target
    setForm(f => ({ ...f, [name]: value }))
    if (errors[name]) setErrors(prev => ({ ...prev, [name]: '' }))
  }

  function validate() {
    const errs = {}
    if (!form.name.trim() && !form.email.trim()) {
      errs.name = 'Enter at least a name or email.'
    }
    if (form.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) {
      errs.email = 'Please enter a valid email address.'
    }
    setErrors(errs)
    return Object.keys(errs).length === 0
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (saving) return
    if (!validate()) return

    setSaving(true)
    setApiError('')
    try {
      const res = await api.patch(`/api/signals/${signalId}/contact`, {
        name:     form.name.trim()     || undefined,
        title:    form.title.trim()    || undefined,
        email:    form.email.trim()    || undefined,
        linkedin: form.linkedin.trim() || undefined,
      })
      // For M&A signals, also save acquired company if entered (non-fatal if it fails)
      let savedAcquiredCompany
      if (isMA && form.acquired_company.trim()) {
        try {
          await api.patch(`/api/signals/${signalId}/acquired-company`, {
            acquired_company: form.acquired_company.trim(),
          })
          savedAcquiredCompany = form.acquired_company.trim()
        } catch (_) { /* non-fatal */ }
      }
      onSaved(res.data.contact_info, savedAcquiredCompany)
    } catch (err) {
      setApiError(err.response?.data?.error || 'Failed to save contact. Please try again.')
      setSaving(false)
    }
  }

  const iStyle = (field) => ({
    width: '100%',
    padding: '8px 10px',
    border: `1px solid ${errors[field] ? '#f87171' : '#d1d5db'}`,
    borderRadius: '6px',
    fontSize: '13px',
    fontFamily: 'Inter, sans-serif',
    color: '#111827',
    boxSizing: 'border-box',
    outline: 'none',
  })

  return (
    <form onSubmit={handleSubmit} noValidate>
      <p style={{ fontSize: '12px', color: '#9ca3af', margin: '0 0 12px' }}>
        No contact found. Add one manually.
      </p>

      {apiError && (
        <p style={{ fontSize: '12px', color: '#dc2626', margin: '0 0 10px' }}>{apiError}</p>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <div>
          <input name="name" value={form.name} onChange={handleChange}
            placeholder="Full name" style={iStyle('name')} />
          {errors.name && <p style={{ fontSize: '11px', color: '#dc2626', margin: '3px 0 0' }}>{errors.name}</p>}
        </div>
        <input name="title" value={form.title} onChange={handleChange}
          placeholder="Job title" style={iStyle('title')} />
        <div>
          <input name="email" type="email" value={form.email} onChange={handleChange}
            placeholder="Email address" style={iStyle('email')} />
          {errors.email && <p style={{ fontSize: '11px', color: '#dc2626', margin: '3px 0 0' }}>{errors.email}</p>}
        </div>
        <input name="linkedin" value={form.linkedin} onChange={handleChange}
          placeholder="LinkedIn URL (optional)" style={iStyle('linkedin')} />
        {isMA && (
          <div>
            <p style={{ fontSize: '11px', color: '#6da3ab', fontWeight: 600, margin: '0 0 4px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Acquired Company (M&A)
            </p>
            <input name="acquired_company" value={form.acquired_company} onChange={handleChange}
              placeholder="e.g. Acme Corp (the company being acquired)" style={iStyle('acquired_company')} />
          </div>
        )}
      </div>

      <button
        type="submit"
        disabled={saving}
        style={{
          marginTop: '12px',
          width: '100%',
          padding: '9px',
          backgroundColor: saving ? '#9ca3af' : '#004b5c',
          color: '#ffffff',
          border: 'none',
          borderRadius: '6px',
          fontSize: '13px',
          fontWeight: 600,
          fontFamily: 'Inter, sans-serif',
          cursor: saving ? 'not-allowed' : 'pointer',
        }}
      >
        {saving ? 'Saving…' : 'Save Contact'}
      </button>
    </form>
  )
}

// ── EmailTouchAccordion ───────────────────────────────────────────────────────

function EmailTouchAccordion({ touchNum, subject, body }) {
  const [open, setOpen] = useState(touchNum === 1) // Touch 1 open by default

  return (
    <div style={{
      border: '1px solid #e8edf0',
      borderRadius: '6px',
      marginBottom: '8px',
      overflow: 'hidden',
    }}>
      <button
        onClick={() => setOpen(prev => !prev)}
        style={{
          width: '100%',
          padding: '12px 16px',
          background: open ? '#f5f7f8' : '#ffffff',
          border: 'none',
          textAlign: 'left',
          cursor: 'pointer',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          fontFamily: 'Inter, sans-serif',
          fontSize: '14px',
          color: '#2d2d2d',
          fontWeight: open ? 600 : 400,
        }}
      >
        <span>
          Touch {touchNum}
          {subject && (
            <span style={{ color: '#6da3ab', fontWeight: 400, marginLeft: '8px' }}>— {subject}</span>
          )}
          {!subject && touchNum > 1 && (
            <span style={{ color: '#6da3ab', fontWeight: 400, marginLeft: '8px' }}>— reply thread</span>
          )}
        </span>
        <span style={{ color: '#6da3ab', fontSize: '12px' }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div style={{
          padding: '16px',
          background: '#ffffff',
          borderTop: '1px solid #e8edf0',
          fontFamily: 'Inter, sans-serif',
          fontSize: '13px',
          color: '#2d2d2d',
          lineHeight: 1.7,
          whiteSpace: 'pre-wrap',
        }}>
          {body}
        </div>
      )}
    </div>
  )
}

// ── Inline Edit Field (validation banner — Signal Detail only) ────────────────
// Lets the team fix missing fields (industry, acquired_company) without navigating away.
// Only rendered when the validate endpoint returns missingFields > 0.

function InlineEditField({ label, currentValue, signalId, fieldName, onSaved }) {
  const [editing,   setEditing]   = useState(false)
  const [value,     setValue]     = useState(currentValue)
  const [saving,    setSaving]    = useState(false)
  const [saveError, setSaveError] = useState(null)

  async function handleSave() {
    if (!value.trim()) return
    setSaving(true)
    setSaveError(null)
    try {
      await api.patch(`/api/signals/${signalId}/field`, {
        field: fieldName,
        value: value.trim(),
      })
      setEditing(false)
      onSaved(value.trim())
    } catch (err) {
      setSaveError('Save failed. Try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ marginBottom: '10px' }}>
      <label style={{
        fontSize: '11px', color: '#6da3ab', fontWeight: 600,
        display: 'block', marginBottom: '4px', textTransform: 'uppercase',
        letterSpacing: '0.05em',
      }}>
        {label}
      </label>
      {editing ? (
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          <input
            type="text"
            value={value}
            onChange={e => setValue(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') setEditing(false) }}
            autoFocus
            style={{
              flex: 1, height: '36px', padding: '0 10px',
              border: '1.5px solid #004b5c', borderRadius: '6px',
              fontFamily: 'Inter', fontSize: '13px', color: '#2d2d2d',
              outline: 'none',
            }}
          />
          <button onClick={handleSave} disabled={saving} style={{
            background: '#004b5c', color: '#ffffff', border: 'none',
            padding: '0 12px', height: '36px', borderRadius: '6px',
            fontSize: '12px', cursor: saving ? 'not-allowed' : 'pointer',
            fontFamily: 'Inter',
          }}>
            {saving ? '...' : 'Save'}
          </button>
          <button onClick={() => setEditing(false)} style={{
            background: 'transparent', color: '#6da3ab', border: 'none',
            padding: '0 8px', height: '36px', cursor: 'pointer', fontSize: '12px',
          }}>
            Cancel
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{
            fontSize: '13px',
            color: value ? '#2d2d2d' : '#9CA3AF',
            fontStyle: value ? 'normal' : 'italic',
          }}>
            {value || 'Not set'}
          </span>
          <button onClick={() => setEditing(true)} style={{
            background: 'transparent', color: '#6da3ab', border: '1px solid #e8edf0',
            padding: '2px 8px', borderRadius: '4px', fontSize: '11px', cursor: 'pointer',
          }}>
            Edit
          </button>
        </div>
      )}
      {saveError && (
        <div style={{ fontSize: '11px', color: '#dc2626', marginTop: '4px' }}>{saveError}</div>
      )}
    </div>
  )
}

// ── ContactRow (D4 + D5) ───────────────────────────────────────────────────────
// Renders a single contact card with name/title/email/LinkedIn + per-contact HubSpot push.
// isOnly=true suppresses the DAY badge for single-contact signals.

function ContactRow({ contact, signalId, isOnly }) {
  const [pushed,    setPushed]    = useState(false)
  const [pushing,   setPushing]   = useState(false)
  const [pushError, setPushError] = useState(null)

  async function handlePush() {
    setPushing(true)
    setPushError(null)
    try {
      const res = await api.post(`/api/signals/${signalId}/push-contact`, {
        contactEmail: contact.email,
        contactName:  contact.name,
        contactTitle: contact.title,
        sendDay:      contact.send_day,
        linkedinUrl:  contact.linkedin_url || null,
      })
      if (res.data.success) {
        setPushed(true)
      } else {
        setPushError(res.data.error || 'Push failed. Try again.')
      }
    } catch (err) {
      setPushError(err.response?.data?.error || 'Push failed. Try again.')
    } finally {
      setPushing(false)
    }
  }

  return (
    <div style={{
      background: '#f5f7f8', borderRadius: '8px', padding: '14px 16px',
      marginBottom: '10px', border: '1px solid #e8edf0',
    }}>
      {!isOnly && (
        <div style={{
          display: 'inline-block', background: '#004b5c', color: '#ffffff',
          fontSize: '10px', fontWeight: 700, padding: '2px 8px', borderRadius: '3px',
          marginBottom: '8px', letterSpacing: '0.05em',
        }}>
          DAY {contact.send_day}
        </div>
      )}

      <div style={{ fontWeight: 600, fontSize: '14px', color: '#2d2d2d', marginBottom: '2px' }}>
        {contact.name || 'Unknown'}
      </div>
      <div style={{ fontSize: '12px', color: '#6da3ab', marginBottom: '8px' }}>
        {contact.title || ''}
      </div>

      {contact.email ? (
        <div style={{ fontSize: '13px', color: '#2d2d2d', marginBottom: '4px' }}>
          <a href={`mailto:${contact.email}`} style={{ color: '#004b5c', textDecoration: 'none', fontFamily: 'JetBrains Mono, monospace' }}>
            {contact.email}
          </a>
          {contact.email_verified && !contact.email_flagged && (
            <span style={{
              marginLeft: '6px', fontSize: '10px', color: '#16A34A', fontWeight: 600,
              background: '#F0FDF4', padding: '1px 6px', borderRadius: '3px', border: '1px solid #86EFAC',
            }}>✓ verified</span>
          )}
          {contact.email_flagged && (
            <span style={{
              marginLeft: '6px', fontSize: '10px', color: '#D97706', fontWeight: 600,
              background: '#FFFBEB', padding: '1px 6px', borderRadius: '3px', border: '1px solid #FCD34D',
            }}>⚠ risky</span>
          )}
        </div>
      ) : (
        <div style={{ fontSize: '13px', color: '#9CA3AF', fontStyle: 'italic', marginBottom: '4px' }}>
          No email found
        </div>
      )}

      {/* D4 — LinkedIn URL */}
      {contact.linkedin_url && (
        <div style={{ marginBottom: '8px' }}>
          <a
            href={safeUrl(contact.linkedin_url)}
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: '12px', color: '#004b5c', textDecoration: 'none' }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style={{ marginRight: '4px', verticalAlign: 'middle' }}>
              <path d="M19 0H5a5 5 0 00-5 5v14a5 5 0 005 5h14a5 5 0 005-5V5a5 5 0 00-5-5zM8 19H5V8h3v11zM6.5 6.7A1.7 1.7 0 115.2 5a1.7 1.7 0 011.3 1.7zM20 19h-3v-5.6c0-1.4-.5-2.3-1.7-2.3A1.8 1.8 0 0013.6 12a2.3 2.3 0 00-.1.8V19h-3V8h3v1.5a3.4 3.4 0 013-1.7c2.2 0 3.8 1.4 3.8 4.5z"/>
            </svg>
            View LinkedIn →
          </a>
        </div>
      )}

      {/* Per-contact HubSpot push */}
      {contact.email && (
        <div style={{ marginTop: '8px' }}>
          {pushed ? (
            <span style={{ fontSize: '12px', color: '#16A34A', fontWeight: 600 }}>✓ Pushed to HubSpot</span>
          ) : (
            <button
              onClick={handlePush}
              disabled={pushing}
              style={{
                background: pushing ? '#9CA3AF' : '#004b5c', color: '#ffffff',
                border: 'none', padding: '6px 12px', borderRadius: '5px',
                fontSize: '12px', cursor: pushing ? 'not-allowed' : 'pointer', fontFamily: 'Inter',
              }}
            >
              {pushing ? 'Pushing...' : 'Push to HubSpot'}
            </button>
          )}
          {pushError && (
            <div style={{ fontSize: '11px', color: '#dc2626', marginTop: '4px' }}>{pushError}</div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Main Page ──────────────────────────────────────────────────────────────────

export default function SignalDetail() {
  const { id }   = useParams()
  const navigate = useNavigate()

  const [signal,   setSignal]   = useState(null)
  const [loading,  setLoading]  = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [error,    setError]    = useState(null)

  // Validation state — populated by GET /api/signals/:id/validate on page load
  const [validationReady,   setValidationReady]   = useState(null) // null = not yet checked
  const [validationMissing, setValidationMissing] = useState([])
  const [validationLoading, setValidationLoading] = useState(false)

  useEffect(() => {
    const controller = new AbortController()

    api.get(`/api/signals/${id}`, { signal: controller.signal })
      .then(res => {
        setSignal(res.data.signal)
        setLoading(false)
      })
      .catch(err => {
        if (err.code === 'ERR_CANCELED') return // aborted — keep loading, second effect run will fetch
        if (err.response?.status === 404) setNotFound(true)
        else setError('Failed to load signal. Please try again.')
        setLoading(false)
      })

    return () => controller.abort()
  }, [id])

  // Runs validation check against the server after signal data loads.
  // Using signal?.id as the dep means this fires once when the signal first appears
  // and again if the user navigates to a different signal without unmounting.
  async function checkValidation(signalId) {
    setValidationLoading(true)
    try {
      const res = await api.get(`/api/signals/${signalId}/validate`)
      setValidationReady(res.data.ready)
      setValidationMissing(res.data.missing_fields || [])
    } catch (err) {
      // If the validate call fails, default to normal push flow —
      // the push endpoint will catch any validation problems at that point.
      setValidationReady(true)
      setValidationMissing([])
      console.warn('[SignalDetail] Validation check failed:', err.message)
    } finally {
      setValidationLoading(false)
    }
  }

  useEffect(() => {
    if (signal?.id) {
      checkValidation(signal.id)
    }
  }, [signal?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!loading && (notFound || error)) {
    return (
      <div style={{
        minHeight: '60vh',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        padding: '40px 24px',
      }}>
        <p style={{ fontSize: '16px', color: '#2d2d2d', marginBottom: '16px' }}>
          {notFound ? 'Signal not found.' : error}
        </p>
        <button
          onClick={() => navigate('/signals')}
          style={{
            fontSize: '13px', padding: '8px 18px', borderRadius: '6px',
            border: '1px solid #004b5c', background: '#004b5c', color: '#ffffff', cursor: 'pointer',
          }}
        >
          ← Back to Signals
        </button>
      </div>
    )
  }

  const contact = signal ? parseContactInfo(signal.contact_info) : {}
  const isBSI   = signal?.signal_type === 'Brand Strategy Intent'

  return (
    <div className="detail-page" style={{ padding: '24px' }}>

      {/* Back nav */}
      <button
        onClick={() => navigate(-1)}
        aria-label="Back to signals list"
        style={{
          display: 'inline-flex', alignItems: 'center', gap: '4px',
          fontSize: '13px', color: '#004b5c', background: 'none', border: 'none',
          cursor: 'pointer', padding: 0, marginBottom: '20px', fontWeight: 500,
        }}
      >
        ← Back to Signals
      </button>

      <style>{`
        .detail-grid {
          display: grid;
          grid-template-columns: minmax(0, 1fr) 320px;
          gap: 20px;
          align-items: start;
        }
        @media (max-width: 1023px) {
          .detail-grid {
            grid-template-columns: 1fr !important;
          }
        }
        @media (max-width: 600px) {
          .detail-page { padding: 16px !important; }
        }
      `}</style>

      {loading ? <div aria-busy="true" aria-label="Loading signal details"><SkeletonDetail /></div> : (
        <div className="detail-grid">

          {/* ── LEFT COLUMN ───────────────────────────────────────────────── */}
          <div>

            {/* 1 — Company Header */}
            <Card>
              <h1 style={{ fontSize: '24px', fontWeight: 700, color: '#2d2d2d', margin: '0 0 10px' }}>
                {signal.company_name || '—'}
              </h1>

              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
                <SignalTypeBadge type={signal.signal_type} />
                <PriorityBadge priority={signal.priority} />
                {signal.send_day && (
                  <span style={{
                    fontSize: '11px', fontWeight: 600, padding: '3px 8px',
                    borderRadius: '4px', backgroundColor: 'rgba(0,75,92,0.08)',
                    color: '#004b5c', fontFamily: 'JetBrains Mono, monospace',
                  }}>
                    Day {signal.send_day}
                  </span>
                )}
              </div>

              {/* All data pills — every field */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '14px' }}>
                <DataPill label="Industry"     value={signal.industry} />
                <DataPill label="Revenue"      value={formatRevenue(signal.company_revenue)} />
                <DataPill label="Funding"      value={signal.company_funding_stage} />
                <DataPill label="Status"       value={signal.status} />
                <DataPill label="AB Group"     value={signal.ab_test_group} />
              </div>

              {/* Dates */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                <p style={{ fontSize: '12px', color: '#6da3ab', fontFamily: 'JetBrains Mono, monospace', margin: 0 }}>
                  Detected {formatDate(signal.date_detected)}
                </p>
                {signal.created_at && (
                  <p style={{ fontSize: '11px', color: '#9ca3af', fontFamily: 'JetBrains Mono, monospace', margin: 0 }}>
                    Record created {formatDatetime(signal.created_at)}
                  </p>
                )}
              </div>
            </Card>

            {/* 2 — What Triggered This Signal */}
            <Card>
              <SectionHeading>What Triggered This Signal</SectionHeading>
              <TextBox accent="#6da3ab">
                <TextBlock text={signal.signal_details} placeholder="No signal details recorded." />
              </TextBox>
            </Card>

            {/* 3 — Claude Brief */}
            <Card>
              <span style={{
                display: 'block', fontSize: '10px', fontWeight: 600,
                color: '#6da3ab', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '6px',
              }}>
                AI Analysis
              </span>
              <SectionHeading>Why This Matters to Starfish</SectionHeading>
              <TextBox accent="#004b5c">
                <TextBlock text={signal.brief} placeholder="No AI analysis available for this signal." />
              </TextBox>
            </Card>

            {/* 4 — Contact Approach */}
            <Card>
              <SectionHeading>How to Reach Out</SectionHeading>
              <TextBox accent="#6da3ab">
                <TextBlock text={signal.contact_approach} placeholder="No contact approach generated." />
              </TextBox>
            </Card>

            {/* 4b — Generated Outreach Emails (Claude A/B group only) */}
            {signal.claude_generated && signal.email_1_subject && (
              <Card>
                <div style={{ display: 'flex', alignItems: 'center', marginBottom: '20px' }}>
                  <h3 style={{ color: '#2d2d2d', fontFamily: 'Inter, sans-serif', fontSize: '16px', fontWeight: 600, margin: 0 }}>
                    Generated Outreach Emails
                  </h3>
                  <span style={{
                    marginLeft: '12px',
                    background: '#004b5c',
                    color: '#ffffff',
                    fontSize: '10px',
                    fontWeight: 700,
                    padding: '3px 8px',
                    borderRadius: '3px',
                    letterSpacing: '0.05em',
                  }}>
                    CLAUDE · A/B TEST
                  </span>
                  {signal.claude_generated_at && (
                    <span style={{ marginLeft: 'auto', color: '#6da3ab', fontSize: '12px', fontFamily: 'JetBrains Mono, monospace' }}>
                      Generated {new Date(signal.claude_generated_at).toLocaleDateString()}
                    </span>
                  )}
                </div>

                {[1, 2, 3, 4, 5, 6, 7].map(touchNum => {
                  const body = signal[`email_${touchNum}_body`]
                  if (!body) return null
                  return (
                    <EmailTouchAccordion
                      key={touchNum}
                      touchNum={touchNum}
                      subject={touchNum === 1 ? signal.email_1_subject : null}
                      body={body}
                    />
                  )
                })}
              </Card>
            )}

            {/* 5 — Full Contact Info (raw) */}
            <Card>
              <SectionHeading>Full Contact Info</SectionHeading>
              <TextBox accent="#6da3ab">
                <TextBlock text={signal.contact_info} placeholder="No contact info on record." />
              </TextBox>
            </Card>

            {/* 6 — Source */}
            <Card>
              <SectionHeading>Source</SectionHeading>
              {signal.source_url ? (
                <div>
                  <a
                    href={safeUrl(signal.source_url)}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ fontSize: '13px', color: '#004b5c', textDecoration: 'underline', fontWeight: 500, wordBreak: 'break-all' }}
                  >
                    Open Source →
                  </a>
                  <p style={{ margin: '8px 0 0', fontSize: '11px', color: '#6da3ab', wordBreak: 'break-all', fontFamily: 'JetBrains Mono, monospace', userSelect: 'text' }}>
                    {signal.source_url}
                  </p>
                </div>
              ) : (
                <p style={{ fontSize: '13px', color: '#9ca3af', margin: 0 }}>No source URL on record.</p>
              )}
            </Card>

            {/* 7 — Proof Clients */}
            {signal.proof_clients && (
              <Card>
                <SectionHeading>Proof Clients</SectionHeading>
                <TextBox accent="#6da3ab">
                  <TextBlock text={signal.proof_clients} />
                </TextBox>
              </Card>
            )}

            {/* 8 — Record Metadata */}
            <Card>
              <SectionHeading>Record Metadata</SectionHeading>
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'max-content 1fr',
                columnGap: '24px',
                alignItems: 'start',
              }}>
                <MetaRow label="Airtable ID">{signal.id}</MetaRow>
                <MetaRow label="Signal Type">{signal.signal_type || '—'}</MetaRow>
                <MetaRow label="Priority">{signal.priority || '—'}</MetaRow>
                <MetaRow label="Status">{signal.status || '—'}</MetaRow>
                <MetaRow label="HubSpot Pushed">{signal.hubspot_pushed ? 'Yes' : 'No'}</MetaRow>
                {signal.send_day && <MetaRow label="Send Day">Day {signal.send_day}</MetaRow>}
                {signal.ab_test_group && <MetaRow label="AB Test Group">{signal.ab_test_group}</MetaRow>}
                {signal.industry && <MetaRow label="Industry">{signal.industry}</MetaRow>}
                {signal.signal_type === 'M&A Activity' && signal.acquired_company && (
                  <MetaRow label="Acquired Company">{signal.acquired_company}</MetaRow>
                )}
                <MetaRow label="Date Detected">{signal.date_detected || '—'}</MetaRow>
                <MetaRow label="Created At">{signal.created_at || '—'}</MetaRow>
              </div>
            </Card>
          </div>

          {/* ── RIGHT COLUMN ──────────────────────────────────────────────── */}
          <div>

            {/* Contact Card */}
            <Card>
              <SectionHeading>Contact</SectionHeading>

              {/* D5 — Multi-contact display with D4 LinkedIn URLs integrated in ContactRow */}
              {(() => {
                // Resolve contacts from available data — three fallback tiers:
                // 1. broadcast_contacts JSONB (preferred — populated by pipeline after Supabase sync is built)
                // 2. bsi_contacts (BSI signals only — pre-existing from Prompt 9)
                // 3. contact_info text (single-contact fallback for all other signals)
                let contacts = []

                if (signal.broadcast_contacts && signal.broadcast_contacts.length > 0) {
                  contacts = signal.broadcast_contacts
                } else if (signal.signal_type === 'Brand Strategy Intent' && signal.bsi_contacts?.length > 0) {
                  contacts = signal.bsi_contacts.map(c => ({
                    name:           c.name  || '',
                    title:          c.title || '',
                    email:          c.email || '',
                    linkedin_url:   null,
                    send_day:       c.send_day || 1,
                    email_verified: true,   // BSI contacts from AudienceLab are pre-verified
                    email_flagged:  false,
                  }))
                } else if (signal.contact_info) {
                  const nameMatch     = signal.contact_info.match(/Name:\s*([^\n]+)/i)
                  const titleMatch    = signal.contact_info.match(/Title:\s*([^\n]+)/i)
                  const emailMatch    = signal.contact_info.match(/Email:\s*([^\s\n]+)/i)
                  const linkedinMatch = signal.contact_info.match(/LinkedIn:\s*(https?:\/\/[^\s\n]+)/i)
                  contacts = [{
                    name:           nameMatch     ? nameMatch[1].trim()     : (contact.name  || 'Unknown'),
                    title:          titleMatch    ? titleMatch[1].trim()    : (contact.title || ''),
                    email:          emailMatch    ? emailMatch[1].trim()    : (contact.email || ''),
                    linkedin_url:   linkedinMatch ? linkedinMatch[1].trim() : (signal.contact_linkedin_url || null),
                    send_day:       1,
                    email_verified: false,
                    email_flagged:  false,
                  }]
                }

                if (contacts.length === 0) {
                  return (
                    <AddContactForm
                      signalId={signal.id}
                      signalType={signal.signal_type}
                      onSaved={(newContactInfo, newAcquiredCompany) => {
                        setSignal(prev => ({
                          ...prev,
                          contact_info: newContactInfo,
                          ...(newAcquiredCompany !== undefined ? { acquired_company: newAcquiredCompany } : {}),
                        }))
                      }}
                    />
                  )
                }

                return (
                  <div>
                    {contacts.length > 1 && (
                      <div style={{
                        fontSize: '12px', color: '#6da3ab', fontWeight: 600,
                        textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '12px',
                      }}>
                        {contacts.length} contacts — staggered outreach
                      </div>
                    )}
                    {contacts.map((c, i) => (
                      <ContactRow
                        key={i}
                        contact={c}
                        signalId={signal.id}
                        isOnly={contacts.length === 1}
                      />
                    ))}
                  </div>
                )
              })()}

              {/* Acquired Company — M&A signals only */}
              {signal.signal_type === 'M&A Activity' && (
                <>
                  <div style={{ height: '1px', backgroundColor: '#e5e7eb', margin: '14px 0' }} />
                  <div style={{ marginBottom: '4px' }}>
                    <p style={{ fontSize: '11px', fontWeight: 600, color: '#6da3ab', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 6px' }}>
                      Acquired Company
                    </p>
                    <AcquiredCompanyEditor
                      signalId={signal.id}
                      initialValue={signal.acquired_company}
                      onSaved={(val) => setSignal(prev => ({ ...prev, acquired_company: val }))}
                    />
                  </div>
                </>
              )}

              <div style={{ height: '1px', backgroundColor: '#e5e7eb', margin: '14px 0' }} />

              {/* Status */}
              <div style={{ marginBottom: '12px' }}>
                <p style={{ fontSize: '11px', fontWeight: 600, color: '#6da3ab', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 6px' }}>
                  Status
                </p>
                <StatusDropdown
                  signalId={signal.id}
                  currentStatus={signal.status}
                  onStatusChange={(newStatus) => setSignal(prev => ({ ...prev, status: newStatus }))}
                />
              </div>

              {/* Validation banner — shown while checking or when fields are missing */}
              {validationLoading && (
                <div style={{ fontSize: '12px', color: '#6da3ab', padding: '8px 0' }}>
                  Checking requirements...
                </div>
              )}

              {!validationLoading && validationReady === false && validationMissing.length > 0 && (
                <div style={{
                  background: '#FFFBEB',
                  border: '1px solid #F59E0B',
                  borderRadius: '6px',
                  padding: '12px 14px',
                  marginBottom: '12px',
                }}>
                  <div style={{ color: '#92400E', fontWeight: 600, fontSize: '13px', marginBottom: '8px' }}>
                    Needs Review Before Push
                  </div>
                  <p style={{ fontSize: '12px', color: '#78350F', marginBottom: '8px', lineHeight: 1.5 }}>
                    The following fields must be filled in before this contact can be pushed to HubSpot:
                  </p>
                  <ul style={{ margin: 0, paddingLeft: '16px', fontSize: '12px', color: '#78350F', lineHeight: 1.8 }}>
                    {validationMissing.map((field, i) => <li key={i}>{field}</li>)}
                  </ul>

                  <div style={{ marginTop: '12px' }}>
                    <p style={{ fontSize: '12px', color: '#6da3ab', marginBottom: '8px' }}>
                      Fix the missing fields below and save — the push button will activate automatically.
                    </p>

                    {validationMissing.some(f => f.toLowerCase().includes('industry')) && (
                      <InlineEditField
                        label="Industry"
                        currentValue={signal.industry || ''}
                        signalId={signal.id}
                        fieldName="industry"
                        onSaved={(newValue) => {
                          setSignal(prev => ({ ...prev, industry: newValue }))
                          checkValidation(signal.id)
                        }}
                      />
                    )}

                    {validationMissing.some(f => f.toLowerCase().includes('acquired_company')) && (
                      <InlineEditField
                        label="Acquired Company"
                        currentValue={signal.acquired_company || ''}
                        signalId={signal.id}
                        fieldName="acquired_company"
                        onSaved={(newValue) => {
                          setSignal(prev => ({ ...prev, acquired_company: newValue }))
                          checkValidation(signal.id)
                        }}
                      />
                    )}
                  </div>
                </div>
              )}

              {/* HubSpot */}
              <div>
                <p style={{ fontSize: '11px', fontWeight: 600, color: '#6da3ab', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 6px' }}>
                  HubSpot
                </p>
                <HubSpotButton
                  signalId={signal.id}
                  alreadyPushed={signal.hubspot_pushed}
                  bespoke={signal.bespoke}
                  bespokeReason={signal.bespoke_reason}
                  missingFields={validationReady === false ? validationMissing : []}
                />
              </div>
            </Card>

            {/* BSI Broadcast Contacts */}
            {isBSI && <BSIContactsTable contacts={signal.bsi_contacts} />}

          </div>
        </div>
      )}
    </div>
  )
}
