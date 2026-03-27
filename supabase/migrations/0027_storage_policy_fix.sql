-- ============================================================
-- 0027_storage_policy_fix.sql
-- 创建 payment-proofs bucket + 修复 storage policy
--
-- 问题：
--   1. bucket 可能尚未创建
--   2. 现有 policy applied to public（匿名可访问）
--   3. 缺少路径隔离（用户可读写他人文件）
--
-- 修复：
--   - 创建 bucket（如不存在）
--   - 删除旧 policy
--   - 新建 policy：仅 authenticated 用户可操作
--   - INSERT/SELECT/DELETE 均按 auth.uid() 路径隔离
--   - 上传路径格式：{user_id}/{order_id}/{timestamp}.{ext}
-- ============================================================

-- ──────────────────────────────────────────────────────────
-- 0. 创建 bucket（如不存在）
-- ──────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'payment-proofs',
  'payment-proofs',
  false,                                                    -- 私有
  10485760,                                                 -- 10MB
  array['image/png','image/jpeg','image/webp','application/pdf']
)
on conflict (id) do nothing;

-- ──────────────────────────────────────────────────────────
-- 1. 删除所有已存在的 policy（旧的 + 新的，保证幂等）
-- ──────────────────────────────────────────────────────────
drop policy if exists "payment_proofs_user_read" on storage.objects;
drop policy if exists "payment_proofs_user_upload" on storage.objects;
drop policy if exists "payment_proofs_insert_own" on storage.objects;
drop policy if exists "payment_proofs_select_own" on storage.objects;
drop policy if exists "payment_proofs_delete_own" on storage.objects;

-- ──────────────────────────────────────────────────────────
-- 2. INSERT — 仅允许已登录用户上传到自己的目录
--    路径第一段必须是 auth.uid()
-- ──────────────────────────────────────────────────────────
create policy "payment_proofs_insert_own"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'payment-proofs'
  and (storage.foldername(name))[1] = auth.uid()::text
);

-- ──────────────────────────────────────────────────────────
-- 3. SELECT — 仅允许已登录用户读取自己目录下的文件
--    管理员通过 signed URL (service_role) 访问他人凭证
-- ──────────────────────────────────────────────────────────
create policy "payment_proofs_select_own"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'payment-proofs'
  and (storage.foldername(name))[1] = auth.uid()::text
);

-- ──────────────────────────────────────────────────────────
-- 4. DELETE — 仅允许用户删除自己目录下的文件（可选）
-- ──────────────────────────────────────────────────────────
create policy "payment_proofs_delete_own"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'payment-proofs'
  and (storage.foldername(name))[1] = auth.uid()::text
);

-- ──────────────────────────────────────────────────────────
-- 5. UPDATE — 禁止更新已上传的凭证（不创建 update policy）
--    凭证一旦上传即不可修改，只能删除重传
-- ──────────────────────────────────────────────────────────
-- 不创建 update policy = 默认禁止 update
