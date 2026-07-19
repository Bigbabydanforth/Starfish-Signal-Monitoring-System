import { useState, useEffect } from 'react'
import { Outlet, NavLink, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

export default function Layout() {
  const navigate = useNavigate()
  const [userEmail, setUserEmail] = useState(null)
  const [mobileOpen, setMobileOpen] = useState(false)

  useEffect(() => {
    supabase.auth.getUser()
      .then(({ data: { user } }) => setUserEmail(user?.email || null))
      .catch(() => setUserEmail('—'))
  }, [])

  async function handleSignOut() {
    await supabase.auth.signOut()
    navigate('/login', { replace: true })
  }

  return (
    <div style={{ display: 'flex', minHeight: '100vh', fontFamily: 'Inter, sans-serif' }}>

      {/* ── Mobile top bar (< 1024px) ─────────────────────────────────────── */}
      <div style={{
        display: 'none',
        position: 'fixed',
        top: 0, left: 0, right: 0,
        height: '52px',
        backgroundColor: '#004b5c',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 16px',
        zIndex: 100,
        // shown via media query class trick — we'll use inline style + a <style> tag
      }} className="mobile-topbar">
        <span style={{ color: '#ffffff', fontWeight: 800, fontSize: '16px', letterSpacing: '0.12em' }}>
          STARFISH
        </span>
        <button
          onClick={() => setMobileOpen(o => !o)}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: '#ffffff', padding: '4px', display: 'flex', alignItems: 'center',
          }}
          aria-label="Toggle menu"
        >
          {mobileOpen ? (
            // X icon
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          ) : (
            // Hamburger icon
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          )}
        </button>
      </div>

      {/* ── Sidebar ───────────────────────────────────────────────────────── */}
      <aside
        className={mobileOpen ? 'sidebar sidebar-open' : 'sidebar'}
        aria-label="Main navigation"
        style={{
          width: '240px',
          minHeight: '100vh',
          backgroundColor: '#004b5c',
          display: 'flex',
          flexDirection: 'column',
          flexShrink: 0,
          position: 'sticky',
          top: 0,
          height: '100vh',
          overflowY: 'auto',
        }}
      >
        {/* Logo */}
        <div style={{ padding: '24px 20px 20px' }}>
          <span style={{
            color: '#ffffff',
            fontWeight: 800,
            fontSize: '18px',
            letterSpacing: '0.14em',
            display: 'block',
          }}>
            STARFISH
          </span>
          <span style={{ color: 'rgba(255,255,255,0.45)', fontSize: '11px', letterSpacing: '0.04em' }}>
            Signal Dashboard
          </span>
        </div>

        <div style={{ height: '1px', backgroundColor: 'rgba(255,255,255,0.1)', margin: '0 16px' }} />

        {/* Nav links */}
        <nav style={{ padding: '12px 8px', flex: 1 }}>
          <NavLink
            to="/signals"
            end
            onClick={() => setMobileOpen(false)}
            style={({ isActive }) => ({
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              padding: '9px 12px',
              borderRadius: '6px',
              fontSize: '13px',
              fontWeight: isActive ? 600 : 400,
              color: isActive ? '#ffffff' : 'rgba(255,255,255,0.65)',
              textDecoration: 'none',
              borderLeft: isActive ? '3px solid #6da3ab' : '3px solid transparent',
              backgroundColor: isActive ? 'rgba(255,255,255,0.08)' : 'transparent',
              transition: 'all 150ms ease',
            })}
          >
            {/* Signals icon */}
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" />
              <rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" />
            </svg>
            Signals
          </NavLink>

          <NavLink
            to="/add-contact"
            onClick={() => setMobileOpen(false)}
            style={({ isActive }) => ({
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              padding: '9px 12px',
              borderRadius: '6px',
              fontSize: '13px',
              fontWeight: isActive ? 600 : 400,
              color: isActive ? '#ffffff' : 'rgba(255,255,255,0.65)',
              textDecoration: 'none',
              borderLeft: isActive ? '3px solid #6da3ab' : '3px solid transparent',
              backgroundColor: isActive ? 'rgba(255,255,255,0.08)' : 'transparent',
              transition: 'all 150ms ease',
            })}
          >
            {/* Plus icon */}
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="16" />
              <line x1="8" y1="12" x2="16" y2="12" />
            </svg>
            Add Contact
          </NavLink>
        </nav>

        {/* Bottom: user + sign out */}
        <div style={{ padding: '12px 8px 20px', borderTop: '1px solid rgba(255,255,255,0.1)' }}>
          {userEmail && (
            <p style={{
              fontSize: '11px',
              color: 'rgba(255,255,255,0.5)',
              margin: '0 0 10px',
              padding: '0 12px',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
              {userEmail}
            </p>
          )}
          <button
            onClick={handleSignOut}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              width: '100%',
              padding: '9px 12px',
              background: 'none',
              border: 'none',
              borderRadius: '6px',
              fontSize: '13px',
              color: 'rgba(255,255,255,0.65)',
              cursor: 'pointer',
              textAlign: 'left',
              transition: 'all 150ms ease',
            }}
            onMouseEnter={e => {
              e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.08)'
              e.currentTarget.style.color = '#ffffff'
            }}
            onMouseLeave={e => {
              e.currentTarget.style.backgroundColor = 'transparent'
              e.currentTarget.style.color = 'rgba(255,255,255,0.65)'
            }}
          >
            {/* Sign out icon */}
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            Sign Out
          </button>
        </div>
      </aside>

      {/* Mobile overlay — closes menu when clicking outside */}
      {mobileOpen && (
        <div
          onClick={() => setMobileOpen(false)}
          className="mobile-overlay"
          aria-hidden="true"
          style={{
            position: 'fixed', inset: 0,
            backgroundColor: 'rgba(0,0,0,0.4)',
            zIndex: 49,
          }}
        />
      )}

      {/* ── Page content ──────────────────────────────────────────────────── */}
      <main
        style={{
          flex: 1,
          minWidth: 0,
          backgroundColor: '#f5f7f8',
          overflowX: 'hidden',
        }}
        className="main-content"
      >
        <Outlet />
      </main>

      {/* ── Responsive styles ─────────────────────────────────────────────── */}
      <style>{`
        @media (max-width: 1023px) {
          .mobile-topbar { display: flex !important; }
          .main-content  { padding-top: 52px; }

          .sidebar {
            position: fixed !important;
            top: 52px;
            left: 0;
            bottom: 0;
            z-index: 50;
            transform: translateX(-100%);
            transition: transform 200ms ease;
            height: calc(100vh - 52px) !important;
          }
          .sidebar-open {
            transform: translateX(0) !important;
          }
        }

        .sidebar a:hover:not([aria-current="page"]) {
          background-color: rgba(255,255,255,0.06) !important;
          color: #ffffff !important;
        }
      `}</style>
    </div>
  )
}
