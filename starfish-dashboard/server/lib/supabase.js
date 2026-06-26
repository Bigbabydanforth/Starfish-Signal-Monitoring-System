// Supabase SERVICE ROLE client — server-side only
// Used for all database reads and writes in Express routes
// NEVER expose this in any frontend file

const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

module.exports = { supabase }
