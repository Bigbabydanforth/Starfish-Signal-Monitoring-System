// Single source of truth for values used across multiple components.
// Change here once — everything picks it up automatically.

export const PAGE_SIZE = 500

export const SIGNAL_TYPES = [
  'Job Change',
  'M&A Activity',
  'Brand Strategy Intent',
  'Website Visitor',
  'News/Press',
  'Rebrand',
]

export const PRIORITIES = ['HIGH', 'MEDIUM', 'LOW']

export const PRIORITY_RANK = { HIGH: 3, MEDIUM: 2, LOW: 1 }

export const STATUSES = ['New', 'In Progress', 'Contacted', 'Won', 'Not a Fit']

export const STATUS_COLORS = {
  'New':         '#004b5c',
  'In Progress': '#F59E0B',
  'Contacted':   '#16A34A',
  'Won':         '#7C3AED',
  'Not a Fit':   '#6B7280',
}
