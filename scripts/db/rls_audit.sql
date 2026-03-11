-- scripts/db/rls_audit.sql
-- 用途：审计 Postgres public schema 中的 RLS 覆盖率
-- 用法：psql $DB_READONLY_URL -f scripts/db/rls_audit.sql > artifacts/rls_audit.sql.out
-- 需要：DB 只读账号（需凭证/人工批准）
-- 注意：anon key 可以公开（Supabase 设计如此）；真正的风险是
--       未启用 RLS 的 public 表对 anon 角色可读写，请重点关注下方"高风险"部分

\echo '=== RLS 覆盖率审计报告 ==='
\echo '生成时间：'
SELECT NOW() AS report_time;

-- ─── 1. public schema 中所有普通表的 RLS 启用状态 ───────────
\echo ''
\echo '=== [1] 所有表 RLS 状态（重点关注 rls_enabled=false）==='
SELECT
  n.nspname                         AS schema,
  c.relname                         AS table_name,
  c.relrowsecurity                  AS rls_enabled,
  c.relforcerowsecurity             AS rls_forced,
  CASE
    WHEN NOT c.relrowsecurity THEN '⚠️  高风险：未启用 RLS'
    WHEN c.relrowsecurity AND NOT c.relforcerowsecurity THEN '✅ RLS 已启用（表所有者可绕过）'
    WHEN c.relrowsecurity AND c.relforcerowsecurity THEN '✅ RLS 强制（所有角色包括表所有者）'
  END                               AS risk_level
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'r'
  AND n.nspname = 'public'
ORDER BY c.relrowsecurity ASC, c.relname;

-- ─── 2. 已定义的 RLS 策略列表 ────────────────────────────────
\echo ''
\echo '=== [2] 已定义 RLS 策略（无策略 = 默认拒绝所有，有策略但未启用 RLS = 策略无效）==='
SELECT
  schemaname,
  tablename,
  policyname,
  roles,
  cmd,
  qual       AS using_expr,
  with_check AS with_check_expr
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY schemaname, tablename, policyname;

-- ─── 3. 高风险汇总：未启用 RLS 且存在策略（策略形同虚设）──
\echo ''
\echo '=== [3] 高风险：表有策略但未启用 RLS（策略不生效）==='
SELECT
  c.relname AS table_name,
  'RLS 未启用，已定义策略但不生效' AS finding
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'r'
  AND n.nspname = 'public'
  AND NOT c.relrowsecurity
  AND EXISTS (
    SELECT 1 FROM pg_policies p
    WHERE p.schemaname = 'public' AND p.tablename = c.relname
  );

-- ─── 4. 高风险汇总：未启用 RLS 且无策略（完全开放）─────────
\echo ''
\echo '=== [4] 极高风险：未启用 RLS 且无策略（对所有角色完全开放）==='
SELECT
  c.relname AS table_name,
  'RLS 未启用，无策略，anon/authenticated 角色均可访问' AS finding
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'r'
  AND n.nspname = 'public'
  AND NOT c.relrowsecurity
  AND NOT EXISTS (
    SELECT 1 FROM pg_policies p
    WHERE p.schemaname = 'public' AND p.tablename = c.relname
  );

-- ─── 5. 检查是否存在 BYPASSRLS 权限的角色 ───────────────────
\echo ''
\echo '=== [5] 拥有 BYPASSRLS 属性的角色（可绕过所有 RLS 策略）==='
SELECT
  rolname,
  rolbypassrls,
  rolsuper,
  '⚠️  此角色可绕过 RLS，确认是否最小权限' AS note
FROM pg_roles
WHERE rolbypassrls = true OR rolsuper = true
ORDER BY rolname;

\echo ''
\echo '=== 审计完成 ==='
\echo '修复建议：对 [4] 中的表立即执行 ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;'
\echo '并按业务角色添加最小策略（project_id/center_code 隔离）。'
