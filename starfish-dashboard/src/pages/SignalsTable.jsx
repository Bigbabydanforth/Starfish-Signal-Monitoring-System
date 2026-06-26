import { useState, useEffect, useRef, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../lib/api'
import { parseContactInfo } from '../lib/parseContact'
import { PAGE_SIZE, PRIORITY_RANK } from '../lib/constants'
import StatsBar from '../components/StatsBar'
import FilterBar from '../components/FilterBar'
import SignalTypeBadge from '../components/SignalTypeBadge'
import PriorityBadge from '../components/PriorityBadge'
import StatusDropdown from '../components/StatusDropdown'
import HubSpotButton from '../components/HubSpotButton'


function formatDate(dateStr) {
  if (!dateStr) return '—'
  const d = new Date(dateStr + 'T00:00:00')
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export default function SignalsTable() {
  const navigate = useNavigate()
  const [signals, setSignals]   = useState([])
  const [total, setTotal]       = useState(0)
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState(null)
  const [filters, setFilters]   = useState({ types: [], priorities: [] })
  const [sortBy, setSortBy]     = useState('airtable') // 'airtable' | 'date' | 'priority'
  const [page, setPage]         = useState(1)

  // Tracks the latest request so stale responses from older filter changes are ignored
  const requestIdRef = useRef(0)

  // Re-fetch from server whenever filters change — server applies type/priority filters
  useEffect(() => {
    setLoading(true)
    setError(null)
    setPage(1)

    const thisRequestId = ++requestIdRef.current
    const params = new URLSearchParams()
    if (filters.types.length > 0)      params.set('types', filters.types.join(','))
    if (filters.priorities.length > 0) params.set('priorities', filters.priorities.join(','))

    const controller = new AbortController()

    api.get(`/api/signals?${params.toString()}`, { signal: controller.signal })
      .then(res => {
        // Discard if a newer request has already been fired
        if (thisRequestId !== requestIdRef.current) return
        setSignals(res.data.signals || [])
        setTotal(res.data.total || 0)
      })
      .catch(err => {
        if (err.code === 'ERR_CANCELED') return
        if (thisRequestId !== requestIdRef.current) return
        setError('Unable to connect to server. Please try again.')
      })
      .finally(() => {
        if (thisRequestId === requestIdRef.current) setLoading(false)
      })

    return () => controller.abort()
  }, [filters])

  function handleStatusChange(id, newStatus) {
    setSignals(prev => prev.map(s => s.id === id ? { ...s, status: newStatus } : s))
  }

  function handleSortChange(newSort) {
    setSortBy(newSort)
    setPage(1)
  }

  // Memoised sort — only re-runs when signals array or sortBy changes, not on every render.
  // 'airtable' preserves the server's ascending date order (matches Airtable row order).
  const sorted = useMemo(() => {
    if (sortBy === 'airtable') return [...signals]
    return [...signals].sort((a, b) => {
      if (sortBy === 'priority') {
        return (PRIORITY_RANK[b.priority] || 0) - (PRIORITY_RANK[a.priority] || 0)
      }
      // 'date' = newest first
      return (b.date_detected || '').localeCompare(a.date_detected || '')
    })
  }, [signals, sortBy])

  // Paginate — show PAGE_SIZE rows at a time
  const totalPages = Math.ceil(sorted.length / PAGE_SIZE)
  const paginated  = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  const hasActiveFilters = filters.types.length > 0 || filters.priorities.length > 0

  return (
    <div className="signals-page" style={{ padding: '24px' }}>

      {/* Header */}
      <div style={{ marginBottom: '20px' }}>
        <h1 style={{ fontSize: '22px', fontWeight: 700, color: '#004b5c', margin: 0 }}>
          Starfish Signals
        </h1>
        <p style={{ fontSize: '13px', color: '#6da3ab', margin: '4px 0 0' }}>
          {loading
            ? 'Loading…'
            : hasActiveFilters
              ? `${total.toLocaleString()} signal${total !== 1 ? 's' : ''} (filtered)`
              : `${total.toLocaleString()} signal${total !== 1 ? 's' : ''} total`}
        </p>
      </div>

      {/* Stats Bar */}
      {!loading && !error && <StatsBar signals={signals} />}

      {/* Filter Bar */}
      {!loading && !error && (
        <FilterBar onFilterChange={setFilters} />
      )}

      {/* Sort Controls */}
      {!loading && !error && (
        <div style={{ display: 'flex', gap: '8px', marginBottom: '12px', flexWrap: 'wrap' }}>
          <SortButton active={sortBy === 'airtable'} onClick={() => handleSortChange('airtable')}>
            # Order (Default)
          </SortButton>
          <SortButton active={sortBy === 'date'} onClick={() => handleSortChange('date')}>
            Newest First
          </SortButton>
          <SortButton active={sortBy === 'priority'} onClick={() => handleSortChange('priority')}>
            Priority
          </SortButton>
        </div>
      )}

      {/* Error */}
      {error && (
        <div role="alert" aria-live="assertive" style={{ background: '#fee2e2', color: '#991b1b', padding: '12px 16px', borderRadius: '8px', fontSize: '14px' }}>
          {error}
        </div>
      )}

      {/* Table */}
      {!error && (
        <div style={{ backgroundColor: '#ffffff', borderRadius: '8px', overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table
              aria-label="Signals"
              aria-busy={loading}
              style={{ width: 'max-content', minWidth: '100%', borderCollapse: 'collapse', fontSize: '13px' }}
            >
              <thead>
                <tr style={{ backgroundColor: '#f5f7f8', borderBottom: '1px solid #e5e7eb' }}>
                  {['#', 'Company Name', 'Signal Type', 'Priority', 'Contact', 'Industry', 'Revenue', 'Funding Stage', 'Signal Details', 'Brief', 'Contact Approach', 'Source URL', 'Date Detected', 'Status', 'HubSpot'].map(col => (
                    <th key={col} style={{
                      padding: '10px 14px',
                      textAlign: 'left',
                      fontSize: '11px',
                      fontWeight: 600,
                      color: '#6da3ab',
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                      whiteSpace: 'nowrap',
                    }}>
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loading && <SkeletonRows />}

                {!loading && paginated.length === 0 && (
                  <tr>
                    <td colSpan={15} style={{ padding: '48px', textAlign: 'center', color: '#6da3ab', fontSize: '14px' }}>
                      {hasActiveFilters
                        ? 'No signals found for the selected filters.'
                        : 'No signals yet. Check back after the next monitoring run.'}
                    </td>
                  </tr>
                )}

                {!loading && paginated.map((signal, idx) => {
                  const { name, title } = parseContactInfo(signal.contact_info)
                  const rowNumber = (page - 1) * PAGE_SIZE + idx + 1
                  return (
                    <TableRow
                      key={signal.id}
                      signal={signal}
                      rowNumber={rowNumber}
                      onClick={() => navigate(`/signals/${signal.id}`)}
                      contactName={name}
                      contactTitle={title}
                      onStatusChange={(newStatus) => handleStatusChange(signal.id, newStatus)}
                    />
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Pagination controls */}
          {!loading && totalPages > 1 && (
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: '8px',
              padding: '12px 16px',
              borderTop: '1px solid #e5e7eb',
              backgroundColor: '#f5f7f8',
            }}>
              <span style={{ fontSize: '13px', color: '#6da3ab' }}>
                Showing {((page - 1) * PAGE_SIZE + 1).toLocaleString()}–{Math.min(page * PAGE_SIZE, sorted.length).toLocaleString()} of {sorted.length.toLocaleString()}
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <PageButton disabled={page === 1} onClick={() => setPage(p => p - 1)}>
                  ← Prev
                </PageButton>
                <span style={{ fontSize: '13px', color: '#2d2d2d', fontWeight: 500 }}>
                  {page} / {totalPages}
                </span>
                <PageButton disabled={page === totalPages} onClick={() => setPage(p => p + 1)}>
                  Next →
                </PageButton>
              </div>
            </div>
          )}
        </div>
      )}

      <style>{`
        @media (max-width: 600px) {
          .signals-page { padding: 12px !important; }
        }
      `}</style>
    </div>
  )
}

function TableRow({ signal, rowNumber, onClick, contactName, contactTitle, onStatusChange }) {
  const [hovered, setHovered] = useState(false)

  return (
    <tr
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        backgroundColor: hovered ? '#f5f7f8' : '#ffffff',
        borderBottom: '1px solid #f3f4f6',
        cursor: 'pointer',
        transition: 'background-color 150ms ease',
      }}
    >
      {/* Row number */}
      <td style={{ padding: '12px 14px', fontFamily: 'JetBrains Mono, monospace', fontSize: '11px', color: '#9ca3af', whiteSpace: 'nowrap', userSelect: 'none' }}>
        {rowNumber}
      </td>

      {/* Company Name */}
      <td style={{ padding: '12px 14px', fontWeight: 600, color: '#2d2d2d', maxWidth: '200px' }}>
        <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {signal.company_name || '—'}
        </span>
      </td>

      {/* Signal Type */}
      <td style={{ padding: '12px 14px', whiteSpace: 'nowrap' }}>
        <SignalTypeBadge type={signal.signal_type} />
      </td>

      {/* Priority */}
      <td style={{ padding: '12px 14px', whiteSpace: 'nowrap' }}>
        <PriorityBadge priority={signal.priority} />
      </td>

      {/* Contact */}
      <td style={{ padding: '12px 14px', maxWidth: '180px' }}>
        <span style={{ display: 'block', fontWeight: 500, color: '#2d2d2d', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {contactName || '—'}
        </span>
        {contactTitle && (
          <span style={{ display: 'block', fontSize: '11px', color: '#6da3ab', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {contactTitle}
          </span>
        )}
      </td>

      {/* Industry */}
      <td style={{ padding: '12px 14px', maxWidth: '120px' }}>
        <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '12px', color: '#2d2d2d' }}>
          {signal.industry || '—'}
        </span>
      </td>

      {/* Revenue */}
      <td style={{ padding: '12px 14px', whiteSpace: 'nowrap', fontFamily: 'JetBrains Mono, monospace', fontSize: '12px', color: '#2d2d2d' }}>
        {signal.company_revenue ? `$${Number(signal.company_revenue).toLocaleString()}` : '—'}
      </td>

      {/* Funding Stage */}
      <td style={{ padding: '12px 14px', whiteSpace: 'nowrap', fontSize: '12px', color: '#2d2d2d' }}>
        {signal.company_funding_stage || '—'}
      </td>

      {/* Signal Details */}
      <td style={{ padding: '12px 14px', maxWidth: '220px' }}>
        <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '12px', color: '#2d2d2d' }} title={signal.signal_details || ''}>
          {signal.signal_details || '—'}
        </span>
      </td>

      {/* Brief */}
      <td style={{ padding: '12px 14px', maxWidth: '220px' }}>
        <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '12px', color: '#2d2d2d' }} title={signal.brief || ''}>
          {signal.brief || '—'}
        </span>
      </td>

      {/* Contact Approach */}
      <td style={{ padding: '12px 14px', maxWidth: '200px' }}>
        <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '12px', color: '#2d2d2d' }} title={signal.contact_approach || ''}>
          {signal.contact_approach || '—'}
        </span>
      </td>

      {/* Source URL */}
      <td style={{ padding: '12px 14px', whiteSpace: 'nowrap' }} onClick={e => e.stopPropagation()}>
        {signal.source_url ? (
          <a
            href={signal.source_url.startsWith('http') ? signal.source_url : 'https://' + signal.source_url}
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: '12px', color: '#6da3ab', textDecoration: 'underline' }}>
            View Source →
          </a>
        ) : '—'}
      </td>

      {/* Date Detected */}
      <td style={{ padding: '12px 14px', whiteSpace: 'nowrap', fontFamily: 'JetBrains Mono, monospace', fontSize: '12px', color: '#2d2d2d' }}>
        {formatDate(signal.date_detected)}
      </td>

      {/* Status */}
      <td style={{ padding: '12px 14px' }} onClick={e => e.stopPropagation()}>
        <StatusDropdown
          signalId={signal.id}
          currentStatus={signal.status}
          onStatusChange={onStatusChange}
        />
      </td>

      {/* HubSpot */}
      <td style={{ padding: '12px 14px' }} onClick={e => e.stopPropagation()}>
        <HubSpotButton
          signalId={signal.id}
          alreadyPushed={signal.hubspot_pushed}
        />
      </td>
    </tr>
  )
}

function SkeletonRows() {
  return Array.from({ length: 5 }).map((_, i) => (
    <tr key={i} style={{ borderBottom: '1px solid #f3f4f6' }}>
      {Array.from({ length: 15 }).map((_, j) => (
        <td key={j} style={{ padding: '12px 14px' }}>
          <div style={{
            height: '14px',
            borderRadius: '4px',
            backgroundColor: '#f3f4f6',
            width: j === 0 ? '140px' : j === 3 ? '120px' : '80px',
            animation: 'pulse 1.5s ease-in-out infinite',
          }} />
        </td>
      ))}
    </tr>
  ))
}

function SortButton({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      style={{
        fontSize: '12px',
        padding: '5px 12px',
        borderRadius: '4px',
        border: `1px solid ${active ? '#004b5c' : '#d1d5db'}`,
        background: active ? '#004b5c' : '#ffffff',
        color: active ? '#ffffff' : '#2d2d2d',
        cursor: 'pointer',
        fontWeight: active ? 600 : 400,
        transition: 'all 150ms ease',
      }}
    >
      {children}
    </button>
  )
}

function PageButton({ disabled, onClick, children }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        fontSize: '12px',
        padding: '5px 12px',
        borderRadius: '4px',
        border: '1px solid #d1d5db',
        background: disabled ? '#f3f4f6' : '#ffffff',
        color: disabled ? '#9ca3af' : '#004b5c',
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontWeight: 500,
        transition: 'all 150ms ease',
      }}
    >
      {children}
    </button>
  )
}
