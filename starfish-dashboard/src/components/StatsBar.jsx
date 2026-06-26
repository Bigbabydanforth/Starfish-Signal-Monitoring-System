// Returns today's date string in Eastern Time (YYYY-MM-DD)
function getTodayEastern() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}

export default function StatsBar({ signals }) {
  const today = getTodayEastern()
  const todaySignals = signals.filter(s => s.date_detected === today)

  const high   = todaySignals.filter(s => s.priority === 'HIGH').length
  const medium = todaySignals.filter(s => s.priority === 'MEDIUM').length
  const low    = todaySignals.filter(s => s.priority === 'LOW').length

  return (
    <div
      style={{
        backgroundColor: '#ffffff',
        borderRadius: '8px',
        padding: '14px 24px',
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: '20px',
        marginBottom: '16px',
      }}
    >
      <Stat label="Today" value={todaySignals.length} />
      <div style={{ width: '1px', height: '28px', background: '#e5e7eb' }} />
      <Stat label="HIGH" value={high} valueColor="#EF4444" />
      <Stat label="MED" value={medium} valueColor="#F59E0B" />
      <Stat label="LOW" value={low} valueColor="#9CA3AF" />
    </div>
  )
}

function Stat({ label, value, valueColor = '#004b5c' }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px' }}>
      <span style={{ fontSize: '22px', fontWeight: 700, color: valueColor, fontFamily: 'JetBrains Mono, monospace' }}>
        {value}
      </span>
      <span style={{ fontSize: '12px', fontWeight: 500, color: '#6da3ab', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}
      </span>
    </div>
  )
}
