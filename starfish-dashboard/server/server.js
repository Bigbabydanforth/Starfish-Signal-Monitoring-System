const app = require('./app')
const { warmSignalsCache } = require('./lib/airtable')

const PORT = process.env.PORT || 4000

app.listen(PORT, () => {
  console.log(`[Server] Running on http://localhost:${PORT}`)
  // Pre-warm the signals cache so the first user request is fast
  warmSignalsCache()
})
