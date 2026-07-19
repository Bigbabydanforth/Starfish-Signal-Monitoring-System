const PRIORITY_STYLES = {
  HIGH:   { background: '#EF4444', label: '🔴 HIGH' },
  MEDIUM: { background: '#F59E0B', label: '🟡 MED' },
  LOW:    { background: '#9CA3AF', label: '⚪ LOW' },
}

export default function PriorityBadge({ priority }) {
  const p = PRIORITY_STYLES[priority] || PRIORITY_STYLES.LOW

  return (
    <span
      style={{
        background: p.background,
        color: '#ffffff',
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: '4px',
        fontSize: '11px',
        fontWeight: 600,
        whiteSpace: 'nowrap',
      }}
    >
      {p.label}
    </span>
  )
}
