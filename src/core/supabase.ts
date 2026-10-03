import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { CLOUD_ENABLED, SUPABASE_ANON_KEY, SUPABASE_URL } from './config'

export const supabase: SupabaseClient | null = CLOUD_ENABLED
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
    })
  : null
