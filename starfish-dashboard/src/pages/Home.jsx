import { useNavigate } from 'react-router-dom'
import { useEffect, useRef, useState } from 'react'
import SignalTypeBadge from '../components/SignalTypeBadge'

const SIGNAL_CARDS = [
  { type: 'Job Change',            name: 'Job Change',            desc: 'A senior marketing or executive leader has joined a new company in the last 90 days.' },
  { type: 'M&A Activity',          name: 'M&A Activity',          desc: 'A company has acquired, merged with, or received financing from another organization.' },
  { type: 'Brand Strategy Intent', name: 'Brand Strategy Intent', desc: 'An off-site visitor showing category-level research behavior tracked via AudienceLab.' },
  { type: 'Website Visitor',       name: 'Website Visitor',       desc: 'A company has visited the Starfish website, identified via the AudienceLab SuperPixel.' },
  { type: 'News/Press',            name: 'News/Press',            desc: 'A wire service press release signals a funding round, executive appointment, or M&A deal.' },
  { type: 'Rebrand',               name: 'Rebrand',               desc: 'A company has publicly initiated a rebrand, identified via PredictLeads event tracking.' },
]

const STEPS = [
  { num: 'STEP 01', title: 'Monitor',  desc: 'Six data sources run automatically at 5 AM EST: Apollo, PDL, PredictLeads, MediaStack, NewsAPI, and AudienceLab.' },
  { num: 'STEP 02', title: 'Filter',   desc: 'Signals are filtered for US-based companies with $50M+ revenue or Series A+ funding and 250+ employees.' },
  { num: 'STEP 03', title: 'Score',    desc: 'Claude AI scores each signal HIGH, MEDIUM, or LOW and writes a brief explaining why it matters to Starfish.' },
  { num: 'STEP 04', title: 'Act',      desc: 'Carly reviews signals in this dashboard, updates status, and pushes qualified contacts directly to HubSpot.' },
]

export default function Home() {
  const navigate = useNavigate()
  const [scrolled, setScrolled] = useState(false)
  const [hoveredCard, setHoveredCard] = useState(null)
  const [navHover, setNavHover] = useState(false)
  const [ctaHover, setCtaHover] = useState(false)

  useEffect(() => {
    const handleScroll = () => {
      setScrolled(window.scrollY > 100)
    }
    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => window.removeEventListener('scroll', handleScroll)
  }, [])

  return (
    <>
      {/* Fixed Top Nav */}
      <nav
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100%',
          height: '64px',
          backgroundColor: '#004b5c',
          zIndex: 50,
          display: 'flex',
          alignItems: 'center',
          boxSizing: 'border-box',
        }}
      >
        <div
          className="home-nav-inner"
          style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            boxSizing: 'border-box',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
            <span
              style={{
                fontFamily: 'Inter, sans-serif',
                fontWeight: 700,
                fontSize: '20px',
                color: '#ffffff',
                lineHeight: 1,
                letterSpacing: '-0.01em',
              }}
            >
              STARFISH
            </span>
            <span
              style={{
                fontFamily: 'Inter, sans-serif',
                fontWeight: 400,
                fontSize: '11px',
                color: '#6da3ab',
                textTransform: 'uppercase',
                letterSpacing: '0.1em',
                lineHeight: 1,
              }}
            >
              SIGNAL INTELLIGENCE
            </span>
          </div>

          <button
            onClick={() => navigate('/login')}
            onMouseEnter={() => setNavHover(true)}
            onMouseLeave={() => setNavHover(false)}
            style={{
              background: navHover ? '#ffffff' : 'transparent',
              border: '1px solid #ffffff',
              color: navHover ? '#004b5c' : '#ffffff',
              fontFamily: 'Inter, sans-serif',
              fontWeight: 500,
              fontSize: '14px',
              height: '40px',
              padding: '0 20px',
              borderRadius: '4px',
              cursor: 'pointer',
              transition: 'background 150ms ease, color 150ms ease',
              whiteSpace: 'nowrap',
            }}
          >
            Sign In →
          </button>
        </div>
      </nav>

      {/* Hero Section */}
      <section
        style={{
          minHeight: '100vh',
          backgroundColor: '#004b5c',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          paddingTop: '64px',
          boxSizing: 'border-box',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            maxWidth: '700px',
            width: '100%',
            textAlign: 'center',
            padding: '48px 24px',
            boxSizing: 'border-box',
          }}
        >
          {/* Top label with decorative rules */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '12px',
            }}
          >
            <div style={{ width: '30px', height: '1px', backgroundColor: '#6da3ab', flexShrink: 0 }} />
            <span
              style={{
                fontFamily: 'Inter, sans-serif',
                fontWeight: 500,
                fontSize: '11px',
                color: '#6da3ab',
                textTransform: 'uppercase',
                letterSpacing: '0.15em',
                whiteSpace: 'nowrap',
              }}
            >
              BUILT FOR STARFISH CO.
            </span>
            <div style={{ width: '30px', height: '1px', backgroundColor: '#6da3ab', flexShrink: 0 }} />
          </div>

          {/* Main headline */}
          <h1
            className="hero-headline"
            style={{
              fontFamily: 'Inter, sans-serif',
              fontWeight: 700,
              color: '#ffffff',
              lineHeight: 1.1,
              marginTop: '24px',
              marginBottom: 0,
            }}
          >
            Every brand signal. One intelligence layer.
          </h1>

          {/* Sub-headline */}
          <p
            className="hero-sub"
            style={{
              fontFamily: 'Inter, sans-serif',
              fontWeight: 400,
              color: 'rgba(255,255,255,0.75)',
              lineHeight: 1.6,
              maxWidth: '560px',
              margin: '24px auto 0',
            }}
          >
            The Starfish Signal Monitor surfaces companies showing intent to rebrand, change leadership, or accelerate growth — before your competitors call them.
          </p>

          {/* CTA Button */}
          <div style={{ marginTop: '32px' }}>
            <button
              onClick={() => navigate('/login')}
              onMouseEnter={() => setCtaHover(true)}
              onMouseLeave={() => setCtaHover(false)}
              style={{
                backgroundColor: ctaHover ? '#f5f7f8' : '#ffffff',
                color: '#004b5c',
                fontFamily: 'Inter, sans-serif',
                fontWeight: 600,
                fontSize: '15px',
                height: '52px',
                padding: '0 28px',
                borderRadius: '6px',
                border: 'none',
                cursor: 'pointer',
                transition: 'background-color 150ms ease',
                whiteSpace: 'nowrap',
              }}
            >
              Access the Dashboard →
            </button>
          </div>

          {/* Stat Row */}
          <div
            className="stat-row"
            style={{
              marginTop: '48px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {[
              { value: '6',       label: 'Signal Sources' },
              { value: '5 AM EST', label: 'Daily Run Time' },
              { value: '6',       label: 'Signal Types Tracked' },
            ].map((stat, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center' }}>
                <div style={{ textAlign: 'center', padding: '0 24px' }}>
                  <div
                    style={{
                      fontFamily: 'Inter, sans-serif',
                      fontWeight: 700,
                      fontSize: '28px',
                      color: '#ffffff',
                      lineHeight: 1,
                    }}
                  >
                    {stat.value}
                  </div>
                  <div
                    style={{
                      fontFamily: 'Inter, sans-serif',
                      fontWeight: 400,
                      fontSize: '12px',
                      color: '#6da3ab',
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                      marginTop: '6px',
                    }}
                  >
                    {stat.label}
                  </div>
                </div>
                {i < 2 && (
                  <div
                    className="stat-divider"
                    style={{
                      width: '1px',
                      height: '32px',
                      backgroundColor: 'rgba(255,255,255,0.15)',
                      flexShrink: 0,
                    }}
                  />
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Scroll Indicator */}
        <div
          style={{
            position: 'absolute',
            bottom: '32px',
            left: '50%',
            transform: 'translateX(-50%)',
            opacity: scrolled ? 0 : 1,
            pointerEvents: scrolled ? 'none' : 'auto',
            transition: 'opacity 300ms ease',
          }}
        >
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className="bounce-chevron"
            style={{ display: 'block' }}
          >
            <path
              d="M6 9L12 15L18 9"
              stroke="rgba(255,255,255,0.4)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
      </section>

      {/* Signal Types Section */}
      <section
        style={{
          backgroundColor: '#f5f7f8',
          paddingTop: '72px',
          paddingBottom: '72px',
        }}
      >
        <div
          className="section-inner"
          style={{
            maxWidth: '1100px',
            margin: '0 auto',
            boxSizing: 'border-box',
          }}
        >
          <div style={{ textAlign: 'center' }}>
            <div
              style={{
                fontFamily: 'Inter, sans-serif',
                fontWeight: 500,
                fontSize: '11px',
                color: '#6da3ab',
                textTransform: 'uppercase',
                letterSpacing: '0.15em',
              }}
            >
              WHAT THE SYSTEM MONITORS
            </div>
            <h2
              className="section-heading"
              style={{
                fontFamily: 'Inter, sans-serif',
                fontWeight: 700,
                color: '#2d2d2d',
                marginTop: '16px',
                marginBottom: 0,
                lineHeight: 1.2,
              }}
            >
              Six intent signals. Detected every morning.
            </h2>
          </div>

          <div
            className="signals-grid"
            style={{ marginTop: '48px' }}
          >
            {SIGNAL_CARDS.map((card, i) => (
              <div
                key={i}
                onMouseEnter={() => setHoveredCard(i)}
                onMouseLeave={() => setHoveredCard(null)}
                style={{
                  backgroundColor: '#ffffff',
                  border: `1px solid ${hoveredCard === i ? '#6da3ab' : '#e8edf0'}`,
                  borderRadius: '12px',
                  padding: '28px',
                  boxSizing: 'border-box',
                  boxShadow: hoveredCard === i ? '0 4px 16px rgba(0,75,92,0.08)' : 'none',
                  transition: 'border-color 150ms ease, box-shadow 150ms ease',
                  cursor: 'default',
                }}
              >
                <SignalTypeBadge type={card.type} />
                <div
                  style={{
                    fontFamily: 'Inter, sans-serif',
                    fontWeight: 600,
                    fontSize: '17px',
                    color: '#2d2d2d',
                    marginTop: '12px',
                  }}
                >
                  {card.name}
                </div>
                <div
                  style={{
                    fontFamily: 'Inter, sans-serif',
                    fontWeight: 400,
                    fontSize: '14px',
                    color: '#6da3ab',
                    lineHeight: 1.5,
                    marginTop: '8px',
                  }}
                >
                  {card.desc}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How It Works Section */}
      <section
        style={{
          backgroundColor: '#004b5c',
          paddingTop: '72px',
          paddingBottom: '72px',
        }}
      >
        <div
          className="section-inner"
          style={{
            maxWidth: '1100px',
            margin: '0 auto',
            boxSizing: 'border-box',
          }}
        >
          <div style={{ textAlign: 'center' }}>
            <div
              style={{
                fontFamily: 'Inter, sans-serif',
                fontWeight: 500,
                fontSize: '11px',
                color: '#6da3ab',
                textTransform: 'uppercase',
                letterSpacing: '0.15em',
              }}
            >
              THE PROCESS
            </div>
            <h2
              className="section-heading"
              style={{
                fontFamily: 'Inter, sans-serif',
                fontWeight: 700,
                color: '#ffffff',
                marginTop: '16px',
                marginBottom: 0,
                lineHeight: 1.2,
              }}
            >
              From signal to conversation, every morning.
            </h2>
          </div>

          <div
            className="steps-row"
            style={{
              marginTop: '48px',
              display: 'flex',
              alignItems: 'stretch',
            }}
          >
            {STEPS.map((step, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    flex: 1,
                    backgroundColor: 'rgba(255,255,255,0.06)',
                    border: '1px solid rgba(255,255,255,0.12)',
                    borderRadius: '10px',
                    padding: '24px',
                    boxSizing: 'border-box',
                    height: '100%',
                  }}
                >
                  <div
                    style={{
                      fontFamily: 'Inter, sans-serif',
                      fontWeight: 700,
                      fontSize: '11px',
                      color: '#6da3ab',
                      textTransform: 'uppercase',
                      letterSpacing: '0.1em',
                    }}
                  >
                    {step.num}
                  </div>
                  <div
                    style={{
                      fontFamily: 'Inter, sans-serif',
                      fontWeight: 600,
                      fontSize: '16px',
                      color: '#ffffff',
                      marginTop: '8px',
                    }}
                  >
                    {step.title}
                  </div>
                  <div
                    style={{
                      fontFamily: 'Inter, sans-serif',
                      fontWeight: 400,
                      fontSize: '13px',
                      color: 'rgba(255,255,255,0.65)',
                      lineHeight: 1.6,
                      marginTop: '8px',
                    }}
                  >
                    {step.desc}
                  </div>
                </div>
                {i < STEPS.length - 1 && (
                  <div
                    className="step-arrow"
                    style={{
                      color: '#6da3ab',
                      fontSize: '20px',
                      flexShrink: 0,
                      padding: '0 8px',
                      lineHeight: 1,
                      alignSelf: 'center',
                    }}
                  >
                    →
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer
        style={{
          backgroundColor: '#2d2d2d',
          height: '72px',
          display: 'flex',
          alignItems: 'center',
          boxSizing: 'border-box',
        }}
      >
        <div
          className="footer-inner"
          style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            boxSizing: 'border-box',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
            <span
              style={{
                fontFamily: 'Inter, sans-serif',
                fontWeight: 700,
                fontSize: '16px',
                color: '#ffffff',
                lineHeight: 1,
              }}
            >
              STARFISH
            </span>
            <span
              style={{
                fontFamily: 'Inter, sans-serif',
                fontWeight: 400,
                fontSize: '12px',
                color: 'rgba(255,255,255,0.45)',
                lineHeight: 1,
              }}
            >
              Signal Intelligence Dashboard
            </span>
          </div>
          <span
            style={{
              fontFamily: 'Inter, sans-serif',
              fontWeight: 400,
              fontSize: '12px',
              color: 'rgba(255,255,255,0.45)',
            }}
          >
            © 2026 Starfish Co. All rights reserved.
          </span>
        </div>
      </footer>

      <style>{`
        @keyframes bounce {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-8px); }
        }

        .bounce-chevron {
          animation: bounce 1.4s ease-in-out infinite;
        }

        .home-nav-inner {
          padding: 0 48px;
        }

        .signals-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 24px;
        }

        .steps-row {
          flex-direction: row;
        }

        .step-arrow {
          display: flex;
        }

        .section-heading {
          font-size: 36px;
        }

        .hero-headline {
          font-size: 56px;
        }

        .hero-sub {
          font-size: 18px;
        }

        .stat-row {
          flex-direction: row;
        }

        .stat-divider {
          display: block;
        }

        .footer-inner {
          padding: 0 48px;
        }

        .section-inner {
          padding: 0 48px;
        }

        @media (max-width: 1023px) {
          .home-nav-inner {
            padding: 0 24px;
          }

          .hero-headline {
            font-size: 36px;
          }

          .hero-sub {
            font-size: 16px;
          }

          .signals-grid {
            grid-template-columns: repeat(2, 1fr);
          }

          .section-heading {
            font-size: 26px;
          }

          .footer-inner {
            padding: 0 24px;
          }

          .section-inner {
            padding: 0 24px;
          }
        }

        @media (max-width: 767px) {
          .steps-row {
            flex-direction: column;
          }

          .step-arrow {
            display: none;
          }

          .steps-row > div {
            flex: none;
            width: 100%;
          }
        }

        @media (max-width: 639px) {
          .signals-grid {
            grid-template-columns: 1fr;
          }

          .stat-row {
            flex-direction: column;
            gap: 16px;
          }

          .stat-divider {
            display: none;
          }
        }
      `}</style>
    </>
  )
}
