// Express app — exported for both server startup and integration tests.
// server.js imports this and calls app.listen(); tests import this directly.

require('dotenv').config()
const express    = require('express')
const cors       = require('cors')
const rateLimit  = require('express-rate-limit')

const signalsRouter = require('./routes/signals')
const hubspotRouter = require('./routes/hubspot')

const app = express()

const allowedOrigins = [
  'http://localhost:5173',
  process.env.FRONTEND_URL,
].filter(Boolean)

app.use(cors({
  origin: allowedOrigins,
  credentials: true,
}))
app.use(express.json())

// Rate limiting — 120 requests per minute per IP
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
})
app.use(limiter)

// CSRF protection — POST and PATCH must carry our custom header.
app.use((req, res, next) => {
  if (req.method === 'POST' || req.method === 'PATCH') {
    if (req.headers['x-requested-with'] !== 'XMLHttpRequest') {
      return res.status(403).json({ error: 'Forbidden: missing required request header.' })
    }
  }
  next()
})

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' })
})

// Routes
app.use('/api/signals', signalsRouter)
app.use('/api', hubspotRouter)

module.exports = app
