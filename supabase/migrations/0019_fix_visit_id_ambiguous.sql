-- 修复：patient_submit_visit_v2 中 "column reference visit_id is ambiguous"
-- 原因：RETURNS TABLE(visit_id uuid,...) 将 visit_id 注册为函数输出变量，
--       导致 ON CONFLICT (visit_id) 里 PostgreSQL 无法区分列名与输出变量。
-- 修复：改用 ON CONFLICT ON CONSTRAINT visit_receipts_pkey，消除歧义。

DROP FUNCTION IF EXISTS public.patient_submit_visit_v2(text, date, numeric, numeric, numeric, numeric, numeric, text);

CREATE OR REPLACE FUNCTION public.patient_submit_visit_v2(
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
  visit_id           uuid,
  server_time        timestamptz,
  receipt_token      text,
  receipt_expires_at timestamptz
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
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
  WHERE project_id  = v_token_row.project_id
    AND patient_code = v_token_row.patient_code
    AND created_at  > now() - interval '1 minute';

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
  WHERE project_id  = v_token_row.project_id
    AND patient_code = v_token_row.patient_code
    AND visit_date  = p_visit_date;

  IF v_same_day >= 6 THEN
    UPDATE patient_tokens SET active = false WHERE token = p_token;
    RAISE EXCEPTION 'same_day_limit_exceeded'
      USING HINT = '同一日期已提交 ' || v_same_day || ' 条记录，链接已被暂停，请联系管理员';
  END IF;

  -- ⑫ 写入随访记录
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
  -- 使用 ON CONFLICT ON CONSTRAINT 而非 ON CONFLICT (visit_id)
  -- 避免与 RETURNS TABLE 中同名输出列产生歧义（PostgreSQL ambiguous 错误）
  v_receipt := encode(gen_random_bytes(16), 'hex');
  v_expires  := now() + interval '24 hours';
  INSERT INTO visit_receipts(visit_id, receipt_token, expires_at)
  VALUES (v_visit_id, v_receipt, v_expires)
  ON CONFLICT ON CONSTRAINT visit_receipts_pkey DO UPDATE
    SET receipt_token = v_receipt,
        expires_at    = v_expires;

  -- ⑮ 审计日志
  INSERT INTO security_audit_logs(
    project_id, patient_code, token_hash, event_type, severity, details
  ) VALUES (
    v_token_row.project_id, v_token_row.patient_code,
    encode(digest(p_token,'sha256'),'hex'),
    'visit_submitted', 'INFO',
    jsonb_build_object(
      'visit_id',   v_visit_id,
      'visit_date', p_visit_date,
      'single_use', v_token_row.single_use
    )
  );

  RETURN QUERY SELECT v_visit_id, now(), v_receipt, v_expires;
END;
$$;

GRANT EXECUTE ON FUNCTION public.patient_submit_visit_v2(text, date, numeric, numeric, numeric, numeric, numeric, text) TO anon, authenticated;
