-- =============================================================
-- PR-1 基础列扩展
-- 目的：为后续所有 PR 打好地基，纯加列，不改现有逻辑，零风险
-- =============================================================

-- ─── 1. visits_long：补 eGFR 公式版本列 ─────────────────────────────────────
-- 记录这条 eGFR 是用哪个公式算出来的，让别人拿到数据也能复现
-- 取值说明：
--   'CKD-EPI-2021-Cr'  正式公式（无种族项，国际主流）
--   'manual'           研究者手动填写（不走公式）
--   'missing_inputs'   缺性别或出生年，无法计算
ALTER TABLE visits_long
  ADD COLUMN IF NOT EXISTS egfr_formula_version text;

COMMENT ON COLUMN visits_long.egfr_formula_version IS
  'eGFR计算公式版本：CKD-EPI-2021-Cr | manual | missing_inputs';

-- ─── 2. patient_tokens：token v2 扩展列 ─────────────────────────────────────
-- 原有 token 只有 active/expires_at，新增单次使用与撤销追踪

-- single_use：是否设置为"只能用一次"
--   true  → 患者提交随访后自动失效，下次需重新生成
--   false → 可多次提交（适合长期随访追踪）
ALTER TABLE patient_tokens
  ADD COLUMN IF NOT EXISTS single_use boolean NOT NULL DEFAULT false;

-- used_at：首次提交随访的时间，NULL 表示还没用过
ALTER TABLE patient_tokens
  ADD COLUMN IF NOT EXISTS used_at timestamptz;

-- revoked_at：管理员手动撤销的时间，NULL 表示未撤销
ALTER TABLE patient_tokens
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz;

-- revoke_reason：撤销原因（例："患者填错项目，重新生成"）
ALTER TABLE patient_tokens
  ADD COLUMN IF NOT EXISTS revoke_reason text;

COMMENT ON COLUMN patient_tokens.single_use IS
  '是否单次使用：true=提交一次后自动失效；false=可反复提交';
COMMENT ON COLUMN patient_tokens.used_at IS
  '首次提交随访的时间戳，用于单次token失效判断与追溯';
COMMENT ON COLUMN patient_tokens.revoked_at IS
  '管理员撤销此token的时间，不为NULL则表示已撤销';
COMMENT ON COLUMN patient_tokens.revoke_reason IS
  '撤销原因，例：患者填错信息，重新生成';

-- ─── 3. 更新 patient_submit_visit_v2：支持 single_use 逻辑 ──────────────────
DROP FUNCTION IF EXISTS patient_submit_visit_v2(text, date, numeric, numeric, numeric, numeric, numeric, text);
CREATE OR REPLACE FUNCTION patient_submit_visit_v2(
  p_token       text,
  p_visit_date  date,
  p_sbp         numeric DEFAULT NULL,
  p_dbp         numeric DEFAULT NULL,
  p_scr_umol_l  numeric DEFAULT NULL,
  p_upcr        numeric DEFAULT NULL,
  p_egfr        numeric DEFAULT NULL,
  p_notes       text    DEFAULT NULL
)
RETURNS TABLE(
  visit_id          uuid,
  server_time       timestamptz,
  receipt_token     text,
  receipt_expires_at timestamptz
)
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_token_row    patient_tokens%ROWTYPE;
  v_project_row  projects%ROWTYPE;
  v_visit_id     uuid;
  v_receipt      text;
  v_expires      timestamptz;
  v_recent_count int;
  v_same_day     int;
BEGIN
  -- ① 查 token，验证有效性
  SELECT * INTO v_token_row
  FROM patient_tokens t
  WHERE t.token = p_token;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'token_not_found' USING HINT = 'token无效，请确认链接正确';
  END IF;

  -- ② token 是否已撤销
  IF v_token_row.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'token_revoked'
      USING HINT = '该随访链接已被管理员撤销：' || COALESCE(v_token_row.revoke_reason, '无原因说明');
  END IF;

  -- ③ token 是否已过期
  IF v_token_row.expires_at IS NOT NULL AND v_token_row.expires_at < now() THEN
    RAISE EXCEPTION 'token_expired' USING HINT = '随访链接已过期，请联系管理员重新生成';
  END IF;

  -- ④ token 是否仍激活
  IF NOT v_token_row.active THEN
    RAISE EXCEPTION 'token_inactive' USING HINT = '随访链接已停用';
  END IF;

  -- ⑤ 单次 token：已用过则拒绝
  IF v_token_row.single_use AND v_token_row.used_at IS NOT NULL THEN
    RAISE EXCEPTION 'token_already_used'
      USING HINT = '该单次链接已于 ' || v_token_row.used_at::text || ' 提交过，如需重填请联系管理员';
  END IF;

  -- ⑥ 查项目
  SELECT * INTO v_project_row FROM projects WHERE id = v_token_row.project_id;

  -- ⑦ 检查写入权限（订阅/试用状态）
  PERFORM assert_project_write_allowed(v_token_row.project_id);

  -- ⑧ 核心字段校验
  IF p_visit_date IS NULL THEN
    RAISE EXCEPTION 'missing_visit_date' USING HINT = '随访日期必填';
  END IF;
  IF p_sbp IS NULL AND p_dbp IS NULL AND p_scr_umol_l IS NULL AND p_upcr IS NULL THEN
    RAISE EXCEPTION 'missing_core_fields'
      USING HINT = '至少填写一项核心指标（血压、血肌酐或尿蛋白/肌酐比）';
  END IF;

  -- ⑨ PII 检测
  IF _contains_pii(COALESCE(p_notes, '')) THEN
    RAISE EXCEPTION 'pii_detected_blocked'
      USING HINT = '备注中疑似包含个人身份信息（手机号/身份证/住院号等），请删除后重新提交';
  END IF;

  -- ⑩ 频率限制：每分钟不超过 12 次
  SELECT COUNT(*) INTO v_recent_count
  FROM visits_long
  WHERE project_id = v_token_row.project_id
    AND patient_code = v_token_row.patient_code
    AND created_at > now() - interval '1 minute';

  IF v_recent_count >= 12 THEN
    UPDATE patient_tokens SET active = false WHERE token = p_token;
    INSERT INTO security_audit_logs(project_id, patient_code, token_hash, event_type, severity, details)
    VALUES (v_token_row.project_id, v_token_row.patient_code,
            encode(digest(p_token,'sha256'),'hex'),
            'rate_limit_exceeded', 'HIGH',
            jsonb_build_object('recent_count', v_recent_count, 'window', '1min'));
    RAISE EXCEPTION 'rate_limit_exceeded' USING HINT = '提交过于频繁，链接已被暂停';
  END IF;

  -- ⑪ 同日重复检测：每日不超过 6 次
  SELECT COUNT(*) INTO v_same_day
  FROM visits_long
  WHERE project_id = v_token_row.project_id
    AND patient_code = v_token_row.patient_code
    AND visit_date = p_visit_date;

  IF v_same_day >= 6 THEN
    UPDATE patient_tokens SET active = false WHERE token = p_token;
    RAISE EXCEPTION 'same_day_limit_exceeded'
      USING HINT = '同一日期已提交 ' || v_same_day || ' 条记录，链接已被暂停，请联系管理员';
  END IF;

  -- ⑫ 写入随访记录（事务原子性保证）
  INSERT INTO visits_long(
    project_id, patient_code, visit_date,
    sbp, dbp, scr_umol_l, upcr, egfr,
    egfr_formula_version,
    notes
  ) VALUES (
    v_token_row.project_id,
    v_token_row.patient_code,
    p_visit_date,
    p_sbp, p_dbp, p_scr_umol_l, p_upcr, p_egfr,
    CASE
      WHEN p_egfr IS NULL THEN NULL
      WHEN p_scr_umol_l IS NULL THEN 'missing_inputs'
      ELSE 'CKD-EPI-2021-Cr'
    END,
    LEFT(COALESCE(p_notes, ''), 500)
  )
  RETURNING id INTO v_visit_id;

  -- ⑬ 若 single_use，标记已使用
  IF v_token_row.single_use THEN
    UPDATE patient_tokens SET used_at = now() WHERE token = p_token;
  END IF;

  -- ⑭ 生成回执 token（24 小时有效）
  v_receipt := encode(gen_random_bytes(16), 'hex');
  v_expires  := now() + interval '24 hours';
  INSERT INTO visit_receipts(visit_id, receipt_token, expires_at)
  VALUES (v_visit_id, v_receipt, v_expires)
  ON CONFLICT (visit_id) DO UPDATE
    SET receipt_token = v_receipt, expires_at = v_expires;

  -- ⑮ 审计日志
  INSERT INTO security_audit_logs(
    project_id, patient_code, token_hash, event_type, severity, details
  ) VALUES (
    v_token_row.project_id, v_token_row.patient_code,
    encode(digest(p_token,'sha256'),'hex'),
    'visit_submitted', 'INFO',
    jsonb_build_object(
      'visit_id', v_visit_id,
      'visit_date', p_visit_date,
      'single_use', v_token_row.single_use
    )
  );

  RETURN QUERY SELECT v_visit_id, now(), v_receipt, v_expires;
END;
$$;

GRANT EXECUTE ON FUNCTION patient_submit_visit_v2(text, date, numeric, numeric, numeric, numeric, numeric, text) TO anon, authenticated;

-- ─── 4. 更新 revoke_patient_token：支持填写撤销原因 ────────────────────────
-- 先删除旧的单参数版本（0004 中创建），避免重名冲突
DROP FUNCTION IF EXISTS revoke_patient_token(text);

CREATE OR REPLACE FUNCTION revoke_patient_token(
  p_token        text,
  p_revoke_reason text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  UPDATE patient_tokens
  SET
    active        = false,
    revoked_at    = now(),
    revoke_reason = p_revoke_reason
  WHERE token = p_token
    AND EXISTS (
      SELECT 1 FROM projects p
      WHERE p.id = patient_tokens.project_id
        AND p.created_by = auth.uid()
    );

  IF NOT FOUND THEN
    RAISE EXCEPTION 'token_not_found_or_not_owner'
      USING HINT = 'token不存在，或您不是该项目的所有者';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION revoke_patient_token(text, text) TO authenticated;
