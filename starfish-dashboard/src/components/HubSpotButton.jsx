import { useState } from 'react'
import api from '../lib/api'

// States: idle → pushing → pushed (permanent) | error (retryable)
export default function HubSpotButton({ signalId, alreadyPushed, onPushed }) {
  const [state, setState] = useState(alreadyPushed ? 'pushed' : 'idle')
  const [errorMsg, setErrorMsg] = useState(null)

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
      const msg = err.response?.data?.error || 'Push failed. Try again.'
      setErrorMsg(msg)
      setState('error')
    }
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
