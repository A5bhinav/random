import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let instance: SupabaseClient | null = null;

/**
 * Initialise the server-side Supabase client (service-role, bypasses RLS).
 * Call once at startup.
 */
export function initSupabase(url: string, serviceRoleKey: string): SupabaseClient {
  if (instance) {
    throw new Error('Supabase client already initialised');
  }
  instance = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return instance;
}

/**
 * Return the initialised Supabase client.
 * Throws if called before `initSupabase()`.
 */
export function getSupabase(): SupabaseClient {
  if (!instance) {
    throw new Error('Supabase client not initialised -- call initSupabase() first');
  }
  return instance;
}

/** Reset for testing only. */
export function _resetSupabase(): void {
  instance = null;
}
