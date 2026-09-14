import { createClient } from "/lib/vendor/supabase.js?v=registry-20260914-integrated-v1";

let _client = null;

export function supabase(authOverrides = {}) {
  if (_client) return _client;
  const cfg = window.CONFIG || {};
  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY || cfg.SUPABASE_URL.includes("YOUR_PROJECT")) {
    throw new Error("Supabase is not configured. Please edit /site/config.js and set SUPABASE_URL + SUPABASE_ANON_KEY.");
  }
  _client = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, ...authOverrides }
  });
  return _client;
}
