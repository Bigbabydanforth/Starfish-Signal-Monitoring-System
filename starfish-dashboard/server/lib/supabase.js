// Supabase SERVICE ROLE client — server-side only
// Used for all database reads and writes in Express routes
// NEVER expose this in any frontend file

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

export { supabase }
