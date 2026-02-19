/**
 * App-level configuration.
 *
 * In development set these via .env (or app.config.js extra):
 *   EXPO_PUBLIC_BACKEND_URL=http://localhost:3000
 *   EXPO_PUBLIC_SUPABASE_URL=https://xxx.supabase.co
 *   EXPO_PUBLIC_SUPABASE_ANON_KEY=eyJ...
 */
export const Config = {
  BACKEND_URL: process.env.EXPO_PUBLIC_BACKEND_URL ?? 'http://localhost:3000',
  SUPABASE_URL: process.env.EXPO_PUBLIC_SUPABASE_URL ?? '',
  SUPABASE_ANON_KEY: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '',
  APP_VERSION: '0.1.0',
} as const;
