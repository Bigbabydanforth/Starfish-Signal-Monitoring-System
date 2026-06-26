import { useState } from 'react'
import { SIGNAL_TYPES, PRIORITIES } from '../lib/constants'

export default function FilterBar({ onFilterChange }) {
  const [selectedTypes, setSelectedTypes] = useState([])
  const [selectedPriorities, setSelectedPriorities] = useState([])

  function toggleType(type) {
    const next = selectedTypes.includes(type)
      ? selectedTypes.filter(t => t !== type)
      : [...selectedTypes, type]
    setSelectedTypes(next)
    onFilterChange({ types: next, priorities: selectedPriorities })
  }

  function togglePriority(priority) {
    const next = selectedPriorities.includes(priority)
      ? selectedPriorities.filter(p => p !== priority)
      : [...selectedPriorities, priority]
    setSelectedPriorities(next)
    onFilterChange({ types: selectedTypes, priorities: next })
  }

  function clearAll() {
    setSelectedTypes([])
    setSelectedPriorities([])
    onFilterChange({ types: [], priorities: [] })
  }

  const hasFilters = selectedTypes.length > 0 || selectedPriorities.length > 0

  return (
    <div
      role="search"
      aria-label="Filter signals"
      style={{
        backgroundColor: '#ffffff',
        borderRadius: '8px',
        padding: '12px 20px',
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: '16px',
        marginBottom: '12px',
      }}
    >
      {/* Signal Type group */}
      <div
        role="group"
        aria-label="Filter by signal type"
        style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}
      >
        <span
          id="filter-type-label"
          style={{ fontSize: '11px', fontWeight: 600, color: '#6da3ab', textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' }}
        >
          Signal Type
        </span>
        {SIGNAL_TYPES.map(type => (
          <FilterChip
            key={type}
            label={type}
            active={selectedTypes.includes(type)}
            onClick={() => toggleType(type)}
          />
        ))}
      </div>

      <div style={{ width: '1px', height: '24px', background: '#e5e7eb', flexShrink: 0 }} aria-hidden="true" />

      {/* Priority group */}
      <div
        role="group"
        aria-label="Filter by priority"
        style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}
      >
        <span
          style={{ fontSize: '11px', fontWeight: 600, color: '#6da3ab', textTransform: 'uppercase', letterSpacing: '0.05em' }}
        >
          Priority
        </span>
        {PRIORITIES.map(p => (
          <FilterChip
            key={p}
            label={p}
            active={selectedPriorities.includes(p)}
            onClick={() => togglePriority(p)}
          />
        ))}
      </div>

      {/* Clear */}
      {hasFilters && (
        <button
          onClick={clearAll}
          aria-label="Clear all filters"
          style={{
            marginLeft: 'auto',
            fontSize: '12px',
            color: '#6da3ab',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: '4px 8px',
            borderRadius: '4px',
            fontWeight: 500,
          }}
          onMouseEnter={e => e.target.style.color = '#004b5c'}
          onMouseLeave={e => e.target.style.color = '#6da3ab'}
        >
          Clear Filters
        </button>
      )}
    </div>
  )
}

function FilterChip({ label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      aria-label={`${active ? 'Remove' : 'Add'} ${label} filter`}
      style={{
        padding: '3px 10px',
        borderRadius: '4px',
        fontSize: '12px',
        fontWeight: 500,
        cursor: 'pointer',
        border: `1px solid ${active ? '#004b5c' : '#d1d5db'}`,
        background: active ? '#004b5c' : 'transparent',
        color: active ? '#ffffff' : '#2d2d2d',
        transition: 'all 150ms ease',
      }}
    >
      {label}
    </button>
  )
}
