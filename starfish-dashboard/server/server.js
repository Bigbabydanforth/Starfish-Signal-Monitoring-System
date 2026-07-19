import app from './app.js'
import { warmSignalsCache } from './lib/airtable.js'

const PORT = process.env.PORT || 4000

app.listen(PORT, () => {
  console.log(`[Server] Running on http://localhost:${PORT}`)
  warmSignalsCache()
})
