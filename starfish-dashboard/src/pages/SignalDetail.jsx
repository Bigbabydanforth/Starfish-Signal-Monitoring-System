import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import api from '../lib/api'
import { parseContactInfo } from '../lib/parseContact'
import SignalTypeBadge from '../components/SignalTypeBadge'
import PriorityBadge from '../components/PriorityBadge'
import StatusDropdown from '../components/StatusDropdown'
import HubSpotButton from '../components/HubSpotButton'

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// ── Add Contact Form (inline, shown when signal has no contact info) ──────────

function AddContactForm({ signalId, onSaved }) {
  const [form, setForm]     = useState({ name: '', title: '', email: '', linkedin: '' })
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
      onSaved(res.data.contact_info)
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

// ── Main Page ──────────────────────────────────────────────────────────────────

export default function SignalDetail() {
  const { id }   = useParams()
  const navigate = useNavigate()

  const [signal,   setSignal]   = useState(null)
  const [loading,  setLoading]  = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [error,    setError]    = useState(null)

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

            {/* 7 — Record Metadata */}
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

              {contact.name ? (
                <>
                  <p style={{ margin: '0 0 2px', fontWeight: 600, color: '#2d2d2d', fontSize: '15px' }}>
                    {contact.name}
                  </p>
                  {contact.title && (
                    <p style={{ margin: '0 0 10px', fontSize: '13px', color: '#6da3ab' }}>
                      {contact.title}
                    </p>
                  )}
                  {contact.email && (
                    <p style={{ margin: '0 0 6px' }}>
                      <a
                        href={`mailto:${contact.email}`}
                        style={{ color: '#004b5c', textDecoration: 'none', fontFamily: 'JetBrains Mono, monospace', fontSize: '12px' }}
                      >
                        {contact.email}
                      </a>
                    </p>
                  )}
                  {contact.linkedin && (
                    <div style={{ margin: '0 0 4px' }}>
                      <a
                        href={safeUrl(contact.linkedin)}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ color: '#004b5c', textDecoration: 'underline', fontWeight: 500, fontSize: '13px' }}
                      >
                        Open LinkedIn →
                      </a>
                      <p style={{ margin: '4px 0 0', fontSize: '11px', color: '#6da3ab', wordBreak: 'break-all', fontFamily: 'JetBrains Mono, monospace', userSelect: 'text' }}>
                        {contact.linkedin}
                      </p>
                    </div>
                  )}
                </>
              ) : (
                <AddContactForm
                  signalId={signal.id}
                  onSaved={(newContactInfo) => {
                    setSignal(prev => ({ ...prev, contact_info: newContactInfo }))
                  }}
                />
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

              {/* HubSpot */}
              <div>
                <p style={{ fontSize: '11px', fontWeight: 600, color: '#6da3ab', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 6px' }}>
                  HubSpot
                </p>
                <HubSpotButton
                  signalId={signal.id}
                  alreadyPushed={signal.hubspot_pushed}
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
