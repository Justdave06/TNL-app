/**
 * Supabase configuration for the TNL app.
 *
 * The app talks to Supabase directly (no Express server).
 * Point EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY
 * in your .env file or EAS secrets.
 */
export const SUPABASE_URL: string =
  process.env.EXPO_PUBLIC_SUPABASE_URL ?? ''

export const SUPABASE_ANON_KEY: string =
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? ''