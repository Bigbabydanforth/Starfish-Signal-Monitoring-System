import { useState, useEffect, useRef } from 'react'
import api from '../lib/api'
import { STATUS_COLORS, STATUSES } from '../lib/constants'

export default function StatusDropdown({ signalId, currentStatus, onStatusChange }) {
  const [status, setStatus]     = useState(currentStatus || 'New')
  const [feedback, setFeedback] = useState(null) // 'saved' | 'error'
  const [saving, setSaving]     = useState(false)

  // Track the last server-confirmed status so we revert to the right value on failure
  const confirmedRef = useRef(currentStatus || 'New')

  // Track mount state so we never update state after unmount
  const mountedRef = useRef(true)
  useEffect(() => () => { mountedRef.current = false }, [])

  useEffect(() => {
    confirmedRef.current = currentStatus || 'New'
    setStatus(currentStatus || 'New')
  }, [currentStatus])

  async function handleChange(e) {
    const newStatus = e.target.value
    const rollbackTo = confirmedRef.current

    setStatus(newStatus)
    setSaving(true)
    setFeedback(null)

    try {
      await api.patch(`/api/signals/${signalId}/status`, { status: newStatus })
      if (!mountedRef.current) return
      confirmedRef.current = newStatus
      setFeedback('saved')
      if (onStatusChange) onStatusChange(newStatus)
      setTimeout(() => { if (mountedRef.current) setFeedback(null) }, 2000)
    } catch {
      if (!mountedRef.current) return
      setStatus(rollbackTo)
      setFeedback('error')
      setTimeout(() => { if (mountedRef.current) setFeedback(null) }, 3000)
    } finally {
      if (mountedRef.current) setSaving(false)
    }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }} onClick={e => e.stopPropagation()}>
      <select
        value={status}
        onChange={handleChange}
        disabled={saving}
        aria-label="Signal status"
        style={{
          fontSize: '12px',
          fontWeight: 500,
          padding: '3px 6px',
          borderRadius: '4px',
          border: '1px solid #d1d5db',
          color: STATUS_COLORS[status] || '#2d2d2d',
          backgroundColor: '#ffffff',
          cursor: saving ? 'not-allowed' : 'pointer',
          outline: 'none',
        }}
      >
        {STATUSES.map(s => (
          <option key={s} value={s}>{s}</option>
        ))}
      </select>
      {feedback === 'saved' && (
        <span role="status" aria-live="polite" style={{ fontSize: '11px', color: '#16A34A', fontWeight: 500 }}>Saved ✓</span>
      )}
      {feedback === 'error' && (
        <span role="alert" aria-live="assertive" style={{ fontSize: '11px', color: '#EF4444', fontWeight: 500 }}>Save failed</span>
      )}
    </div>
  )
}
