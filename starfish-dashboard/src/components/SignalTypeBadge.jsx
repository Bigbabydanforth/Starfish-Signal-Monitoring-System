const TYPE_STYLES = {
  'Job Change': {
    background: 'rgba(0, 75, 92, 0.15)',
    color: '#004b5c',
  },
  'M&A Activity': {
    background: 'rgba(71, 85, 140, 0.15)',
    color: '#47558c',
  },
  'Brand Strategy Intent': {
    background: '#004b5c',
    color: '#ffffff',
  },
  'Website Visitor': {
    background: 'rgba(109, 163, 171, 0.20)',
    color: '#6da3ab',
  },
  'News/Press': {
    background: 'rgba(45, 45, 45, 0.10)',
    color: '#2d2d2d',
  },
  'Rebrand': {
    background: 'rgba(217, 119, 6, 0.15)',
    color: '#b45309',
  },
}

export default function SignalTypeBadge({ type }) {
  const style = TYPE_STYLES[type] || { background: 'rgba(0,0,0,0.08)', color: '#2d2d2d' }

  return (
    <span
      style={{
        ...style,
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: '4px',
        fontSize: '11px',
        fontWeight: 500,
        whiteSpace: 'nowrap',
        letterSpacing: '0.01em',
      }}
    >
      {type}
    </span>
  )
}
