// Supabase browser client — uses public anon key only
// Used for Auth (signInWithPassword, signOut, getSession) only
// NEVER use service_role key here

import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing required env vars: VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set in .env')
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey)
