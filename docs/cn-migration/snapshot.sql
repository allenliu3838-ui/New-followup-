-- 迁移对比快照（只读）。见 docs/CN_MIGRATION.md。
-- 输出一个 JSON：关键表行数、每张业务表的内容指纹（md5 聚合）、账号登录指纹、随访链接摘要指纹、
-- 附件对象清单指纹、迁移版本。只输出计数与摘要，不输出任何患者字段值、随访链接、邮箱或密码哈希。
-- 旧环境（#110 之前的结构）与新环境（0032–0039 之后）都能执行；不存在的表输出 null。
--
-- 用法（连接串只放在本机环境变量里，不要写进命令历史或聊天）：
--   psql "$DB_URL" -X -q -t -A -v ON_ERROR_STOP=1 -f docs/cn-migration/snapshot.sql > snapshot-旧环境-冻结后.json
-- 比较：python3 -I docs/cn-migration/compare_snapshots.py --phase restore 旧.json 新.json
BEGIN READ ONLY;
SET LOCAL TimeZone = 'UTC';                 -- 指纹与数据库默认时区无关
SET LOCAL DateStyle = 'ISO, YMD';
SET LOCAL IntervalStyle = 'postgres';
SET LOCAL extra_float_digits = 1;
SET LOCAL bytea_output = 'hex';
SET LOCAL search_path = pg_catalog;
WITH
key_tables(name) AS (VALUES
  ('public.projects'), ('public.patients_baseline'), ('public.visits_long'), ('public.labs_long'),
  ('public.meds_long'), ('public.events_long'), ('public.variants_long'), ('public.patient_tokens'),
  ('auth.users'), ('auth.identities'), ('storage.buckets'), ('storage.objects')),
business_tables AS (
  SELECT format('%I.%I', n.nspname, c.relname) AS name, c.oid::regclass AS rel
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p') AND n.nspname IN ('public', 'registry_private')),
token_columns AS (
  SELECT
    EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('public.patient_tokens')
            AND attname = 'token_hash' AND NOT attisdropped) AS has_hash,
    EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('public.patient_tokens')
            AND attname = 'token' AND NOT attisdropped) AS has_token)
SELECT jsonb_pretty(jsonb_build_object(
  'snapshot_version', 'cn-migration-snapshot-v1',
  'checked_at', clock_timestamp(),
  'database', current_database(),
  'server_version', current_setting('server_version'),
  'session_default_timezone', (SELECT reset_val FROM pg_settings WHERE name = 'TimeZone'),
  'key_counts', (SELECT jsonb_object_agg(k.name,
      CASE WHEN to_regclass(k.name) IS NULL THEN NULL ELSE
        (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM %s', to_regclass(k.name)),
          false, true, '')))[1]::text::bigint END) FROM key_tables k),
  'tables', (SELECT jsonb_object_agg(t.name, jsonb_build_object(
      'rows', (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM %s', t.rel),
          false, true, '')))[1]::text::bigint,
      'md5', (xpath('/row/h/text()', query_to_xml(format(
          'SELECT md5(coalesce(string_agg(r::text, E''\n'' ORDER BY r::text), '''')) AS h FROM %s r', t.rel),
          false, true, '')))[1]::text)) FROM business_tables t),
  'auth_users_login_md5', CASE WHEN to_regclass('auth.users') IS NULL THEN NULL ELSE
      (xpath('/row/h/text()', query_to_xml(
        'SELECT md5(coalesce(string_agg(id::text || '':'' || coalesce(lower(email), '''') || '':'' '
        || '|| coalesce(encrypted_password, ''''), '','' ORDER BY id), '''')) AS h FROM auth.users',
        false, true, '')))[1]::text END,
  'patient_token_digest_md5', (SELECT CASE
      WHEN to_regclass('public.patient_tokens') IS NULL THEN NULL
      WHEN tc.has_hash AND tc.has_token THEN (xpath('/row/h/text()', query_to_xml(
        'SELECT md5(coalesce(string_agg(id::text || '':'' || coalesce(token_hash, '
        || 'encode(sha256(convert_to(token, ''UTF8'')), ''hex'')), '','' ORDER BY id), '''')) AS h '
        || 'FROM public.patient_tokens', false, true, '')))[1]::text
      WHEN tc.has_hash THEN (xpath('/row/h/text()', query_to_xml(
        'SELECT md5(coalesce(string_agg(id::text || '':'' || token_hash, '','' ORDER BY id), '''')) AS h '
        || 'FROM public.patient_tokens', false, true, '')))[1]::text
      ELSE (xpath('/row/h/text()', query_to_xml(
        'SELECT md5(coalesce(string_agg(id::text || '':'' || encode(sha256(convert_to(token, ''UTF8'')), ''hex''), '
        || ''','' ORDER BY id), '''')) AS h FROM public.patient_tokens', false, true, '')))[1]::text
      END FROM token_columns tc),
  'patient_tokens_plaintext_rows', (SELECT CASE
      WHEN to_regclass('public.patient_tokens') IS NULL OR NOT tc.has_token THEN 0
      ELSE (xpath('/row/n/text()', query_to_xml(
        'SELECT count(*) AS n FROM public.patient_tokens WHERE token IS NOT NULL', false, true, '')))[1]::text::bigint
      END FROM token_columns tc),
  'storage_objects_md5', CASE WHEN to_regclass('storage.objects') IS NULL THEN NULL ELSE
      (xpath('/row/h/text()', query_to_xml(
        'SELECT md5(coalesce(string_agg(bucket_id || ''/'' || name || '':'' || coalesce(metadata->>''size'', '''') '
        || '|| '':'' || coalesce(metadata->>''mimetype'', ''''), '','' ORDER BY bucket_id, name), '''')) AS h '
        || 'FROM storage.objects', false, true, '')))[1]::text END,
  'storage_buckets', CASE WHEN to_regclass('storage.buckets') IS NULL THEN NULL ELSE
      (xpath('/row/b/text()', query_to_xml(
        'SELECT coalesce(string_agg(id || ''='' || CASE WHEN public THEN ''public'' ELSE ''private'' END '
        || '|| '':'' || (SELECT count(*) FROM storage.objects o WHERE o.bucket_id = b.id), '','' ORDER BY id), '''') '
        || 'AS b FROM storage.buckets b', false, true, '')))[1]::text END,
  'registry_schema_versions', CASE WHEN to_regclass('public.registry_schema_versions') IS NULL THEN NULL ELSE
      (xpath('/row/v/text()', query_to_xml(
        'SELECT string_agg(version, '','' ORDER BY version) AS v FROM public.registry_schema_versions',
        false, true, '')))[1]::text END,
  'auth_migrations', CASE WHEN to_regclass('auth.schema_migrations') IS NULL THEN NULL ELSE
      (xpath('/row/v/text()', query_to_xml(
        'SELECT string_agg(version, '','' ORDER BY version) AS v FROM auth.schema_migrations',
        false, true, '')))[1]::text END,
  'storage_migrations', CASE WHEN to_regclass('storage.migrations') IS NULL THEN NULL ELSE
      (xpath('/row/v/text()', query_to_xml(
        'SELECT string_agg(name, '','' ORDER BY id) AS v FROM storage.migrations', false, true, '')))[1]::text END,
  'extensions', (SELECT jsonb_object_agg(extname, extversion) FROM pg_extension)
)) AS cn_migration_snapshot;
ROLLBACK;
