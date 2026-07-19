import { useState } from 'react'
import api from '../lib/api'

const SIGNAL_TYPES = [
  'Job Change',
  'M&A Activity',
  'Brand Strategy Intent',
  'Website Visitor',
  'News/Press',
  'Rebrand',
]

const NOTES_MAX = 2000

const EMPTY_FORM = {
  firstName:      '',
  lastName:       '',
  email:          '',
  title:          '',
  companyName:    '',
  companyWebsite: '',
  industry:       '',
  signalType:     '',
  priority:       'MEDIUM',
  notes:          '',
}

const EMPTY_ERRORS = {
  firstName:      '',
  lastName:       '',
  email:          '',
  title:          '',
  companyName:    '',
  companyWebsite: '',
  signalType:     '',
  priority:       '',
}

// ── Styles ────────────────────────────────────────────────────────────────────

const labelStyle = {
  display: 'block',
  fontSize: '13px',
  fontWeight: 500,
  color: '#374151',
  marginBottom: '5px',
}

function inputStyle(hasError) {
  return {
    width: '100%',
    padding: '10px 12px',
    border: `1px solid ${hasError ? '#f87171' : '#d1d5db'}`,
    borderRadius: '6px',
    fontSize: '14px',
    fontFamily: 'Inter, sans-serif',
    color: '#111827',
    backgroundColor: '#ffffff',
    boxSizing: 'border-box',
    outline: 'none',
  }
}

const errorTextStyle = {
  fontSize: '12px',
  color: '#dc2626',
  marginTop: '4px',
}

const fieldStyle = {
  marginBottom: '20px',
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function AddContact() {
  const [form, setForm]       = useState(EMPTY_FORM)
  const [errors, setErrors]   = useState(EMPTY_ERRORS)
  const [status, setStatus]   = useState(null)    // null | 'loading' | 'success' | 'error'
  const [banner, setBanner]   = useState('')

  function handleChange(e) {
    const { name, value } = e.target
    setForm(f => ({ ...f, [name]: value }))
    // Clear the inline error for this field as the user types
    if (name in errors) {
      setErrors(prev => ({ ...prev, [name]: '' }))
    }
  }

  function resetForm() {
    setForm(EMPTY_FORM)
    setErrors(EMPTY_ERRORS)
  }

  // ── Client-side validation ────────────────────────────────────────────────
  function validate() {
    const errs = { ...EMPTY_ERRORS }
    let valid = true

    const required = ['firstName', 'lastName', 'email', 'title', 'companyName', 'signalType', 'priority']
    for (const field of required) {
      if (!form[field].trim()) {
        errs[field] = 'This field is required.'
        valid = false
      }
    }

    if (form.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) {
      errs.email = 'Please enter a valid email address.'
      valid = false
    }

    if (form.companyWebsite.trim() && !/^https?:\/\/.+/.test(form.companyWebsite.trim())) {
      errs.companyWebsite = 'Please enter a valid URL including https://'
      valid = false
    }

    setErrors(errs)
    return valid
  }

  // ── Submit ────────────────────────────────────────────────────────────────
  async function handleSubmit(e) {
    e.preventDefault()
    if (status === 'loading') return   // prevent double-submit

    if (!validate()) return

    setStatus('loading')
    setBanner('')

    try {
      await api.post('/api/contacts/add', {
        firstName:      form.firstName.trim(),
        lastName:       form.lastName.trim(),
        email:          form.email.trim(),
        title:          form.title.trim(),
        companyName:    form.companyName.trim(),
        companyWebsite: form.companyWebsite.trim() || undefined,
        industry:       form.industry.trim()       || undefined,
        signalType:     form.signalType,
        priority:       form.priority,
        notes:          form.notes.trim()          || undefined,
      })

      setStatus('success')
      setBanner('Contact added successfully. Pushed to HubSpot ✓')
      setTimeout(() => {
        resetForm()
        setStatus(null)
        setBanner('')
      }, 3000)

    } catch (err) {
      setStatus('error')
      const msg = err.response?.data?.error || err.message || 'Something went wrong. Please try again.'
      setBanner(msg)
    }
  }

  const notesLen = form.notes.length

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={{
      minHeight: '100vh',
      backgroundColor: '#f5f7f8',
      padding: '40px 24px',
      fontFamily: 'Inter, sans-serif',
    }}>
      {/* Page heading */}
      <h1 style={{
        fontSize: '24px',
        fontWeight: 700,
        color: '#2d2d2d',
        margin: '0 0 6px',
        maxWidth: '640px',
        marginLeft: 'auto',
        marginRight: 'auto',
      }}>
        Add Contact Manually
      </h1>
      <p style={{
        fontSize: '14px',
        fontWeight: 400,
        color: '#6da3ab',
        margin: '0 0 28px',
        maxWidth: '640px',
        marginLeft: 'auto',
        marginRight: 'auto',
      }}>
        Manually created contacts are saved to Airtable and pushed to HubSpot immediately.
      </p>

      {/* Card */}
      <div style={{
        maxWidth: '640px',
        margin: '0 auto',
        backgroundColor: '#ffffff',
        borderRadius: '12px',
        padding: '48px',
        boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
      }}>

        {/* Status banner */}
        {status === 'success' && (
          <div style={{
            padding: '13px 16px',
            backgroundColor: '#f0fdf4',
            border: '1px solid #86efac',
            borderRadius: '8px',
            marginBottom: '24px',
            fontSize: '14px',
            color: '#166534',
            fontWeight: 500,
          }}>
            {banner}
          </div>
        )}
        {status === 'error' && (
          <div style={{
            padding: '13px 16px',
            backgroundColor: '#fef2f2',
            border: '1px solid #fca5a5',
            borderRadius: '8px',
            marginBottom: '24px',
            fontSize: '14px',
            color: '#991b1b',
          }}>
            {banner}
          </div>
        )}

        <form onSubmit={handleSubmit} noValidate>

          {/* First Name + Last Name */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '20px' }}>
            <div>
              <label style={labelStyle}>
                First Name <span style={{ color: '#dc2626' }}>*</span>
              </label>
              <input
                name="firstName"
                value={form.firstName}
                onChange={handleChange}
                placeholder="Jane"
                style={inputStyle(!!errors.firstName)}
              />
              {errors.firstName && <p style={errorTextStyle}>{errors.firstName}</p>}
            </div>
            <div>
              <label style={labelStyle}>
                Last Name <span style={{ color: '#dc2626' }}>*</span>
              </label>
              <input
                name="lastName"
                value={form.lastName}
                onChange={handleChange}
                placeholder="Smith"
                style={inputStyle(!!errors.lastName)}
              />
              {errors.lastName && <p style={errorTextStyle}>{errors.lastName}</p>}
            </div>
          </div>

          {/* Email */}
          <div style={fieldStyle}>
            <label style={labelStyle}>
              Email <span style={{ color: '#dc2626' }}>*</span>
            </label>
            <input
              name="email"
              type="email"
              value={form.email}
              onChange={handleChange}
              placeholder="jane@company.com"
              style={inputStyle(!!errors.email)}
            />
            {errors.email && <p style={errorTextStyle}>{errors.email}</p>}
          </div>

          {/* Job Title */}
          <div style={fieldStyle}>
            <label style={labelStyle}>
              Job Title <span style={{ color: '#dc2626' }}>*</span>
            </label>
            <input
              name="title"
              value={form.title}
              onChange={handleChange}
              placeholder="VP of Marketing"
              style={inputStyle(!!errors.title)}
            />
            {errors.title && <p style={errorTextStyle}>{errors.title}</p>}
          </div>

          {/* Company Name */}
          <div style={fieldStyle}>
            <label style={labelStyle}>
              Company Name <span style={{ color: '#dc2626' }}>*</span>
            </label>
            <input
              name="companyName"
              value={form.companyName}
              onChange={handleChange}
              placeholder="Acme Corp"
              style={inputStyle(!!errors.companyName)}
            />
            {errors.companyName && <p style={errorTextStyle}>{errors.companyName}</p>}
          </div>

          {/* Company Website */}
          <div style={fieldStyle}>
            <label style={labelStyle}>Company Website</label>
            <input
              name="companyWebsite"
              type="url"
              value={form.companyWebsite}
              onChange={handleChange}
              placeholder="https://acme.com"
              style={inputStyle(!!errors.companyWebsite)}
            />
            {errors.companyWebsite && <p style={errorTextStyle}>{errors.companyWebsite}</p>}
          </div>

          {/* Industry */}
          <div style={fieldStyle}>
            <label style={labelStyle}>Industry</label>
            <input
              name="industry"
              value={form.industry}
              onChange={handleChange}
              placeholder="e.g. Technology, Retail, Healthcare"
              style={inputStyle(false)}
            />
          </div>

          {/* Signal Type + Priority */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '20px' }}>
            <div>
              <label style={labelStyle}>
                Signal Type <span style={{ color: '#dc2626' }}>*</span>
              </label>
              <select
                name="signalType"
                value={form.signalType}
                onChange={handleChange}
                style={{ ...inputStyle(!!errors.signalType), cursor: 'pointer' }}
              >
                <option value="">— Select —</option>
                {SIGNAL_TYPES.map(t => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
              {errors.signalType && <p style={errorTextStyle}>{errors.signalType}</p>}
            </div>
            <div>
              <label style={labelStyle}>
                Priority <span style={{ color: '#dc2626' }}>*</span>
              </label>
              <select
                name="priority"
                value={form.priority}
                onChange={handleChange}
                style={{ ...inputStyle(!!errors.priority), cursor: 'pointer' }}
              >
                <option value="HIGH">HIGH</option>
                <option value="MEDIUM">MEDIUM</option>
                <option value="LOW">LOW</option>
              </select>
              {errors.priority && <p style={errorTextStyle}>{errors.priority}</p>}
            </div>
          </div>

          {/* Notes */}
          <div style={fieldStyle}>
            <label style={labelStyle}>Notes</label>
            <textarea
              name="notes"
              value={form.notes}
              onChange={handleChange}
              maxLength={NOTES_MAX}
              placeholder="e.g. Met at a conference, referred by David..."
              rows={4}
              style={{
                ...inputStyle(false),
                resize: 'vertical',
                lineHeight: '1.6',
              }}
            />
            <p style={{
              fontSize: '12px',
              color: notesLen > NOTES_MAX * 0.9 ? '#dc2626' : '#9ca3af',
              marginTop: '4px',
              textAlign: 'right',
            }}>
              {notesLen.toLocaleString()} / {NOTES_MAX.toLocaleString()}
            </p>
          </div>

          {/* Submit */}
          <button
            type="submit"
            disabled={status === 'loading'}
            style={{
              width: '100%',
              height: '52px',
              backgroundColor: status === 'loading' ? '#9ca3af' : '#004b5c',
              color: '#ffffff',
              border: 'none',
              borderRadius: '8px',
              fontSize: '15px',
              fontWeight: 600,
              fontFamily: 'Inter, sans-serif',
              cursor: status === 'loading' ? 'not-allowed' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '10px',
              transition: 'background-color 150ms ease',
            }}
            onMouseEnter={e => { if (status !== 'loading') e.currentTarget.style.backgroundColor = '#003d4d' }}
            onMouseLeave={e => { if (status !== 'loading') e.currentTarget.style.backgroundColor = '#004b5c' }}
          >
            {status === 'loading' ? (
              <>
                <svg
                  width="16" height="16" viewBox="0 0 24 24"
                  fill="none" stroke="currentColor" strokeWidth="2.5"
                  strokeLinecap="round"
                  style={{ animation: 'spin 0.8s linear infinite' }}
                >
                  <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                </svg>
                Adding Contact…
              </>
            ) : (
              'Add Contact & Push to HubSpot'
            )}
          </button>

        </form>
      </div>

      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  )
}
