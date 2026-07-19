import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

// ── Error mapping — never expose raw Supabase strings ─────────────────────────
function mapAuthError(err) {
  if (!err) return 'Something went wrong. Please try again.'
  const msg = err.message?.toLowerCase() || ''
  if (msg.includes('invalid login') || msg.includes('invalid credentials') || msg.includes('email not confirmed')) {
    return 'Incorrect email or password. Please try again.'
  }
  return 'Something went wrong. Please try again.'
}

// ── SVG icons ─────────────────────────────────────────────────────────────────

function EyeOpenIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
      <circle cx="12" cy="12" r="3"/>
    </svg>
  )
}

function EyeClosedIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
      <line x1="1" y1="1" x2="23" y2="23"/>
    </svg>
  )
}

function WarningIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <circle cx="12" cy="12" r="10"/>
      <line x1="12" y1="8" x2="12" y2="12"/>
      <line x1="12" y1="16" x2="12.01" y2="16"/>
    </svg>
  )
}

function Spinner() {
  return (
    <>
      <div className="login-spinner" />
      <style>{`
        @keyframes login-spin {
          to { transform: rotate(360deg); }
        }
        .login-spinner {
          width: 16px;
          height: 16px;
          border: 2px solid rgba(255,255,255,0.3);
          border-top-color: #ffffff;
          border-radius: 50%;
          animation: login-spin 0.7s linear infinite;
          flex-shrink: 0;
        }
      `}</style>
    </>
  )
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function Login() {
  const navigate      = useNavigate()
  const passwordRef   = useRef(null)

  const [email,       setEmail]       = useState('')
  const [password,    setPassword]    = useState('')
  const [showPass,    setShowPass]    = useState(false)
  const [error,       setError]       = useState('')
  const [loading,     setLoading]     = useState(false)
  const [eyeHover,    setEyeHover]    = useState(false)
  const [btnHover,    setBtnHover]    = useState(false)
  const [btnActive,   setBtnActive]   = useState(false)

  // If already logged in, skip the form
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) navigate('/signals', { replace: true })
    })
  }, [])

  // Clear error when user starts typing again
  function handleEmailChange(e) {
    if (error) setError('')
    setEmail(e.target.value)
  }
  function handlePasswordChange(e) {
    if (error) setError('')
    setPassword(e.target.value)
  }

  // Enter on email field → focus password (don't submit)
  function handleEmailKeyDown(e) {
    if (e.key === 'Enter') {
      e.preventDefault()
      passwordRef.current?.focus()
    }
  }

  // Enter on password field → submit
  function handlePasswordKeyDown(e) {
    if (e.key === 'Enter') handleSubmit(e)
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')

    // Client-side validation — no Supabase call for empty fields
    if (!email.trim()) {
      setError('Please enter your email address.')
      return
    }
    if (!password) {
      setError('Please enter your password.')
      return
    }

    setLoading(true)
    const { error: authError } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
    setLoading(false)

    if (authError) {
      setError(mapAuthError(authError))
      return
    }

    navigate('/signals', { replace: true })
  }

  // ── Shared input style ───────────────────────────────────────────────────────
  const inputStyle = {
    width: '100%',
    height: '48px',
    border: '1.5px solid #e8edf0',
    borderRadius: '8px',
    padding: '0 16px',
    fontFamily: 'Inter, sans-serif',
    fontSize: '15px',
    fontWeight: 400,
    color: '#2d2d2d',
    backgroundColor: '#ffffff',
    boxSizing: 'border-box',
    outline: 'none',
    transition: 'border-color 150ms ease, box-shadow 150ms ease',
  }

  function handleInputFocus(e) {
    e.target.style.borderColor = '#004b5c'
    e.target.style.boxShadow   = '0 0 0 3px rgba(0,75,92,0.08)'
  }
  function handleInputBlur(e) {
    e.target.style.borderColor = '#e8edf0'
    e.target.style.boxShadow   = 'none'
  }

  const labelStyle = {
    display: 'block',
    fontFamily: 'Inter, sans-serif',
    fontSize: '13px',
    fontWeight: 500,
    color: '#2d2d2d',
    marginBottom: '8px',
  }

  return (
    <>
      <div style={{
        display: 'flex',
        minHeight: '100vh',
        fontFamily: 'Inter, sans-serif',
      }}>

        {/* ── LEFT COLUMN (desktop only) ─────────────────────────────────── */}
        <div className="login-left" style={{
          width: '40%',
          backgroundColor: '#004b5c',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          flexShrink: 0,
        }}>

          {/* Top: wordmark */}
          <div style={{ padding: '48px' }}>
            <div style={{ fontWeight: 700, fontSize: '22px', color: '#ffffff', lineHeight: 1 }}>
              STARFISH
            </div>
            <div style={{
              fontWeight: 400, fontSize: '12px', color: '#6da3ab',
              textTransform: 'uppercase', letterSpacing: '0.12em', marginTop: '6px',
            }}>
              Signal Intelligence
            </div>
          </div>

          {/* Middle: quote */}
          <div style={{ padding: '0 48px', textAlign: 'left' }}>
            <div style={{
              fontWeight: 700, fontSize: '80px', color: '#6da3ab',
              opacity: 0.4, lineHeight: 1, marginBottom: '8px',
              fontFamily: 'Georgia, serif',
            }}>
              "
            </div>
            <p style={{
              fontWeight: 300, fontSize: '20px', color: '#ffffff',
              opacity: 0.85, lineHeight: 1.6, maxWidth: '320px', margin: 0,
            }}>
              Every brand now exists simultaneously across two worlds: human and AI. We build for both.
            </p>
            <p style={{ marginTop: '16px', fontWeight: 400, fontSize: '13px', color: '#6da3ab' }}>
              — Starfish Co.
            </p>
          </div>

          {/* Bottom: stats */}
          <div style={{ padding: '48px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {[
              { value: '500+', label: 'Brands Served' },
              { value: '20+',  label: 'Years of Brand Experience' },
              { value: '6',    label: 'Intent Signal Sources' },
            ].map(stat => (
              <div key={stat.label}>
                <div style={{ fontWeight: 700, fontSize: '18px', color: '#ffffff', lineHeight: 1 }}>
                  {stat.value}
                </div>
                <div style={{
                  fontWeight: 400, fontSize: '11px', color: '#6da3ab',
                  textTransform: 'uppercase', letterSpacing: '0.08em', marginTop: '4px',
                }}>
                  {stat.label}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ── RIGHT COLUMN ──────────────────────────────────────────────────── */}
        <div style={{
          flex: 1,
          backgroundColor: '#f5f7f8',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '24px',
          boxSizing: 'border-box',
        }}>

          {/* Mobile-only wordmark */}
          <div className="login-mobile-header" style={{ display: 'none', marginBottom: '32px', textAlign: 'center' }}>
            <div style={{ fontWeight: 700, fontSize: '20px', color: '#004b5c' }}>STARFISH</div>
          </div>

          {/* Card */}
          <div className="login-card" style={{
            backgroundColor: '#ffffff',
            borderRadius: '12px',
            padding: '48px',
            maxWidth: '480px',
            width: '100%',
            boxSizing: 'border-box',
            boxShadow: '0 4px 24px rgba(0,75,92,0.08)',
          }}>

            {/* Greeting */}
            <h1 style={{ margin: 0, fontWeight: 700, fontSize: '28px', color: '#2d2d2d', lineHeight: 1.2 }}>
              Welcome back.
            </h1>
            <p style={{ margin: '8px 0 0', fontWeight: 400, fontSize: '15px', color: '#6da3ab' }}>
              Sign in to your Signal Dashboard.
            </p>

            {/* Divider */}
            <div style={{ height: '1px', backgroundColor: '#e8edf0', margin: '28px 0' }} />

            {/* Form */}
            <form onSubmit={handleSubmit} noValidate>

              {/* Email */}
              <div>
                <label htmlFor="email" style={labelStyle}>Email address</label>
                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={handleEmailChange}
                  onKeyDown={handleEmailKeyDown}
                  onFocus={handleInputFocus}
                  onBlur={handleInputBlur}
                  placeholder="you@starfishco.com"
                  autoComplete="email"
                  style={{ ...inputStyle }}
                />
              </div>

              {/* Password */}
              <div style={{ marginTop: '24px' }}>
                <label htmlFor="password" style={labelStyle}>Password</label>
                <div style={{ position: 'relative' }}>
                  <input
                    id="password"
                    ref={passwordRef}
                    type={showPass ? 'text' : 'password'}
                    value={password}
                    onChange={handlePasswordChange}
                    onKeyDown={handlePasswordKeyDown}
                    onFocus={handleInputFocus}
                    onBlur={handleInputBlur}
                    autoComplete="current-password"
                    style={{ ...inputStyle, paddingRight: '44px' }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPass(s => !s)}
                    onMouseEnter={() => setEyeHover(true)}
                    onMouseLeave={() => setEyeHover(false)}
                    title={showPass ? 'Hide password' : 'Show password'}
                    style={{
                      position: 'absolute',
                      right: '12px',
                      top: '50%',
                      transform: 'translateY(-50%)',
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      padding: '4px',
                      color: eyeHover ? '#004b5c' : '#9ca3af',
                      display: 'flex',
                      alignItems: 'center',
                      transition: 'color 150ms ease',
                    }}
                  >
                    {showPass ? <EyeClosedIcon /> : <EyeOpenIcon />}
                  </button>
                </div>
              </div>

              {/* Error */}
              {error && (
                <div
                  role="alert"
                  aria-live="assertive"
                  style={{
                  marginTop: '16px',
                  background: '#fef2f2',
                  border: '1px solid #fecaca',
                  borderRadius: '6px',
                  padding: '10px 14px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  color: '#dc2626',
                }}>
                  <WarningIcon />
                  <span style={{ fontFamily: 'Inter, sans-serif', fontSize: '13px', fontWeight: 400 }}>
                    {error}
                  </span>
                </div>
              )}

              {/* Sign In button */}
              <button
                type="submit"
                disabled={loading}
                aria-busy={loading}
                aria-label={loading ? 'Signing in, please wait' : 'Sign in'}
                onMouseEnter={() => setBtnHover(true)}
                onMouseLeave={() => { setBtnHover(false); setBtnActive(false) }}
                onMouseDown={() => setBtnActive(true)}
                onMouseUp={() => setBtnActive(false)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '10px',
                  width: '100%',
                  height: '52px',
                  marginTop: '24px',
                  backgroundColor: loading
                    ? 'rgba(0,75,92,0.85)'
                    : btnActive
                      ? '#003d4d'
                      : btnHover
                        ? '#005f75'
                        : '#004b5c',
                  color: '#ffffff',
                  fontFamily: 'Inter, sans-serif',
                  fontWeight: 600,
                  fontSize: '15px',
                  borderRadius: '8px',
                  border: 'none',
                  cursor: loading ? 'not-allowed' : 'pointer',
                  transform: btnActive && !loading ? 'scale(0.99)' : 'scale(1)',
                  transition: 'background-color 150ms ease, transform 80ms ease',
                }}
              >
                {loading && <Spinner />}
                {loading ? 'Signing in...' : 'Sign In'}
              </button>
            </form>

            {/* Footer note */}
            <div style={{ marginTop: '24px' }}>
              <div style={{ height: '1px', backgroundColor: '#e8edf0' }} />
              <p style={{
                marginTop: '16px',
                fontFamily: 'Inter, sans-serif',
                fontWeight: 400,
                fontSize: '12px',
                color: '#9ca3af',
                textAlign: 'center',
                margin: '16px 0 0',
              }}>
                This is a private system. Access is by invitation only.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* ── Responsive styles ────────────────────────────────────────────── */}
      <style>{`
        @media (max-width: 1023px) {
          .login-left          { display: none !important; }
          .login-mobile-header { display: block !important; }
          .login-card {
            box-shadow: none !important;
            border-radius: 0 !important;
            padding: 32px !important;
            max-width: 100% !important;
          }
        }
      `}</style>
    </>
  )
}
