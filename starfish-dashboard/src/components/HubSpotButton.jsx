import { useState } from 'react'
import api from '../lib/api'

// States: idle → pushing → pushed (permanent) | error (retryable)
// bespoke=true: renders a static warning instead of the push button — no enrollment allowed
// missingFields: pre-computed list from SignalDetail — shows warning panel + "Push Anyway" button
export default function HubSpotButton({ signalId, alreadyPushed, onPushed, bespoke, missingFields: initialMissingFields = [] }) {
  // Hooks must always be called unconditionally — before any early returns
  const [state, setState] = useState(alreadyPushed ? 'pushed' : 'idle')
  const [errorMsg, setErrorMsg] = useState(null)
  const [missingFields, setMissingFields] = useState(initialMissingFields)

  if (bespoke) {
    return (
      <div>
        <button
          style={{
            background: '#E8673A',
            color: '#ffffff',
            border: 'none',
            padding: '8px 16px',
            borderRadius: '6px',
            fontSize: '13px',
            cursor: 'default', // not 'pointer' — this button is display-only, not a blocked action
            fontFamily: 'Inter',
            fontWeight: 600,
            opacity: 0.9,
          }}
          title="This signal requires custom outreach by Andrew or Cole."
          onClick={e => e.preventDefault()} // click does nothing — display only
          aria-disabled="true"
        >
          ⚠ Handle Manually
        </button>
        <div style={{
          fontSize: '11px',
          color: '#E8673A',
          marginTop: '6px',
          lineHeight: 1.4,
        }}>
          This signal requires custom outreach by Andrew or Cole.
        </div>
      </div>
    )
  }

  async function handleClick() {
    if (state === 'pushing' || state === 'pushed') return
    setState('pushing')
    setErrorMsg(null)

    try {
      const res = await api.post(`/api/signals/${signalId}/push-to-hubspot`)
      if (res.status === 207) {
        // Pushed to HubSpot but Airtable flag save failed — warn user, treat as pushed
        // so they don't accidentally push the same contact twice
        setErrorMsg('Pushed to HubSpot but the saved flag failed. Refresh to confirm.')
        setState('pushed')
      } else {
        setState('pushed')
        if (onPushed) onPushed()
      }
    } catch (err) {
      // 422 = validation failure — update missing fields list from API response
      if (err.response?.status === 422 && err.response?.data?.missingFields) {
        setMissingFields(err.response.data.missingFields)
        setErrorMsg(err.response.data.error || 'Some fields need attention.')
        setState('idle')
      } else {
        const msg = err.response?.data?.error || 'Push failed. Try again.'
        setErrorMsg(msg)
        setState('error')
      }
    }
  }

  // ── Missing fields warning panel ──────────────────────────────────────────
  // Shown when pre-computed missing fields exist and the contact hasn't been pushed yet.
  // "Push Anyway" still calls the API — lets Zack override if needed.
  if (missingFields.length > 0 && state !== 'pushed') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <div style={{
          padding: '10px 12px',
          backgroundColor: '#fffbeb',
          border: '1px solid #fcd34d',
          borderRadius: '6px',
        }}>
          <p style={{
            fontSize: '11px', fontWeight: 700, color: '#92400e',
            margin: '0 0 6px', textTransform: 'uppercase', letterSpacing: '0.05em',
          }}>
            ⚠ Needs Review Before Push
          </p>
          <ul style={{ margin: 0, paddingLeft: '14px' }}>
            {missingFields.map((f, i) => (
              <li key={i} style={{ fontSize: '11px', color: '#92400e', lineHeight: 1.6 }}>{f}</li>
            ))}
          </ul>
        </div>
        <button
          onClick={handleClick}
          disabled={state === 'pushing'}
          aria-label="Push to HubSpot anyway despite missing fields"
          style={{
            fontSize: '11px', fontWeight: 500, padding: '3px 8px', borderRadius: '4px',
            border: '1px solid #d1d5db', background: '#f9fafb', color: '#6b7280',
            cursor: state === 'pushing' ? 'not-allowed' : 'pointer',
            whiteSpace: 'nowrap', opacity: state === 'pushing' ? 0.7 : 1,
          }}
        >
          {state === 'pushing' ? 'Pushing…' : 'Push Anyway'}
        </button>
        {errorMsg && (
          <span role="alert" style={{ fontSize: '10px', color: '#EF4444', wordBreak: 'break-word' }}>
            {errorMsg}
          </span>
        )}
      </div>
    )
  }

  const isPushed  = state === 'pushed'
  const isPushing = state === 'pushing'
  const isError   = state === 'error'

  const label = isPushed  ? 'Pushed ✓'
              : isPushing ? 'Pushing…'
              : isError   ? 'Retry'
              : 'Push to HubSpot'

  const ariaLabel = isPushed  ? 'Contact already pushed to HubSpot'
                  : isPushing ? 'Pushing contact to HubSpot'
                  : isError   ? `Retry pushing to HubSpot — ${errorMsg}`
                  : 'Push contact to HubSpot'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
      <button
        onClick={handleClick}
        disabled={isPushed || isPushing}
        aria-label={ariaLabel}
        aria-busy={isPushing}
        title={isError ? errorMsg : undefined}
        style={{
          fontSize: '11px',
          fontWeight: 500,
          padding: '3px 8px',
          borderRadius: '4px',
          border: `1px solid ${isPushed ? '#16A34A' : isError ? '#EF4444' : '#d1d5db'}`,
          background: isPushed  ? '#f0fdf4'
                    : isError   ? '#fef2f2'
                    : '#ffffff',
          color: isPushed  ? '#16A34A'
               : isError   ? '#EF4444'
               : isPushing ? '#6da3ab'
               : '#2d2d2d',
          cursor: isPushed || isPushing ? 'not-allowed' : 'pointer',
          opacity: isPushing ? 0.7 : 1,
          whiteSpace: 'nowrap',
          transition: 'all 150ms ease',
        }}
      >
        {label}
      </button>
      {(isError || (isPushed && errorMsg)) && (
        <span role="alert" aria-live="assertive" style={{ fontSize: '10px', color: isError ? '#EF4444' : '#F59E0B', maxWidth: '120px', wordBreak: 'break-word' }}>
          {errorMsg}
        </span>
      )}
    </div>
  )
}
