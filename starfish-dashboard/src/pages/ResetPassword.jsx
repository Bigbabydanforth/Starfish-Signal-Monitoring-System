import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

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

export default function ResetPassword() {
  const navigate = useNavigate()
  const [password, setPassword]         = useState('')
  const [confirm, setConfirm]           = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirm, setShowConfirm]   = useState(false)
  const [loading, setLoading]           = useState(false)
  const [error, setError]               = useState('')
  const [done, setDone]                 = useState(false)
  const [validSession, setValidSession] = useState(false)
  const [checking, setChecking]         = useState(true)

  // Supabase puts the recovery token in the URL hash — exchange it for a session
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) setValidSession(true)
      setChecking(false)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY' && session) {
        setValidSession(true)
        setChecking(false)
      }
    })

    // Give Supabase 1.5s to fire the PASSWORD_RECOVERY event before showing invalid
    const timeout = setTimeout(() => setChecking(false), 1500)

    return () => {
      subscription.unsubscribe()
      clearTimeout(timeout)
    }
  }, [])

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')

    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    if (password !== confirm) {
      setError('Passwords do not match.')
      return
    }

    setLoading(true)
    const { error: updateError } = await supabase.auth.updateUser({ password })
    setLoading(false)

    if (updateError) {
      setError('Failed to update password. The link may have expired — request a new one.')
      return
    }

    setDone(true)
    setTimeout(() => navigate('/signals'), 2500)
  }

  const inputStyle = {
    width: '100%', padding: '12px 14px', border: '1.5px solid #e5e7eb',
    borderRadius: '8px', fontSize: '15px', outline: 'none',
    fontFamily: 'Inter, sans-serif', color: '#2d2d2d', boxSizing: 'border-box',
  }

  return (
    <div style={{ minHeight: '100vh', background: '#f5f7f8', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}>
      <div style={{ background: '#fff', borderRadius: '16px', padding: '48px 40px', width: '100%', maxWidth: '420px', boxShadow: '0 4px 24px rgba(0,0,0,0.08)' }}>

        {/* Logo */}
        <div style={{ marginBottom: '32px' }}>
          <div style={{ fontSize: '20px', fontWeight: '700', color: '#004b5c', letterSpacing: '0.12em', fontFamily: 'Inter, sans-serif' }}>STARFISH</div>
          <div style={{ fontSize: '13px', color: '#6da3ab', marginTop: '2px', fontFamily: 'Inter, sans-serif' }}>Signal Dashboard</div>
        </div>

        {checking ? (
          <div style={{ textAlign: 'center', padding: '20px 0', color: '#6b7280', fontFamily: 'Inter, sans-serif', fontSize: '14px' }}>Verifying your link…</div>
        ) : done ? (
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '32px', marginBottom: '12px' }}>✓</div>
            <div style={{ fontSize: '18px', fontWeight: '600', color: '#2d2d2d', marginBottom: '8px', fontFamily: 'Inter, sans-serif' }}>Password updated!</div>
            <div style={{ fontSize: '14px', color: '#6b7280', fontFamily: 'Inter, sans-serif' }}>Taking you to the dashboard…</div>
          </div>
        ) : !validSession ? (
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '15px', color: '#6b7280', fontFamily: 'Inter, sans-serif', lineHeight: '1.6' }}>
              This link is invalid or has expired.<br />
              Please request a new password reset link.
            </div>
          </div>
        ) : (
          <>
            <h1 style={{ fontSize: '22px', fontWeight: '700', color: '#2d2d2d', marginBottom: '8px', fontFamily: 'Inter, sans-serif' }}>Set a new password</h1>
            <p style={{ fontSize: '14px', color: '#6b7280', marginBottom: '28px', fontFamily: 'Inter, sans-serif' }}>Choose a strong password for your account.</p>

            {error && (
              <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: '8px', padding: '12px 14px', marginBottom: '20px', fontSize: '14px', color: '#dc2626', fontFamily: 'Inter, sans-serif' }}>
                {error}
              </div>
            )}

            <form onSubmit={handleSubmit}>
              {/* New password */}
              <div style={{ marginBottom: '16px' }}>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', color: '#374151', marginBottom: '6px', fontFamily: 'Inter, sans-serif' }}>New password</label>
                <div style={{ position: 'relative' }}>
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={e => { setPassword(e.target.value); setError('') }}
                    placeholder="At least 8 characters"
                    required
                    style={{ ...inputStyle, paddingRight: '44px' }}
                  />
                  <button type="button" onClick={() => setShowPassword(v => !v)}
                    style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', display: 'flex', alignItems: 'center' }}>
                    {showPassword ? <EyeClosedIcon /> : <EyeOpenIcon />}
                  </button>
                </div>
              </div>

              {/* Confirm password */}
              <div style={{ marginBottom: '24px' }}>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', color: '#374151', marginBottom: '6px', fontFamily: 'Inter, sans-serif' }}>Confirm password</label>
                <div style={{ position: 'relative' }}>
                  <input
                    type={showConfirm ? 'text' : 'password'}
                    value={confirm}
                    onChange={e => { setConfirm(e.target.value); setError('') }}
                    placeholder="Repeat your new password"
                    required
                    style={{ ...inputStyle, paddingRight: '44px' }}
                  />
                  <button type="button" onClick={() => setShowConfirm(v => !v)}
                    style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', display: 'flex', alignItems: 'center' }}>
                    {showConfirm ? <EyeClosedIcon /> : <EyeOpenIcon />}
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                style={{ width: '100%', padding: '13px', background: loading ? '#6da3ab' : '#004b5c', color: '#fff', border: 'none', borderRadius: '8px', fontSize: '15px', fontWeight: '600', cursor: loading ? 'not-allowed' : 'pointer', fontFamily: 'Inter, sans-serif', transition: 'background 0.15s ease' }}
              >
                {loading ? 'Updating…' : 'Update password'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  )
}
