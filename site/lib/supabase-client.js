import { createClient } from "/lib/vendor/supabase.js?v=registry-20261030-cn-v8";

let _client = null;

export function supabase(authOverrides = {}) {
  if (_client) return _client;
  const cfg = window.CONFIG || {};
  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY || cfg.SUPABASE_URL.includes("YOUR_PROJECT")) {
    // 该提示可能直接显示给用户：只说明现象与求助方式；运维排查要点见 docs/CN_MIGRATION.md（config.js 的数据库地址与公开密钥）。
    throw new Error("系统配置不完整，暂时无法连接数据库，请稍后再试或联系管理员。");
  }
  _client = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, ...authOverrides }
  });
  return _client;
}
