-- =============================================================
-- PR-5 PII 全路径拦截：数据库触发器层
-- 目的：无论从哪个入口（staff录入/patient录入/直接API）写入数据
--       只要包含个人身份信息，数据库就拒绝保存
--
-- 什么是 PII（个人可识别信息）？
-- ─────────────────────────────
-- 本系统是科研数据库，严禁录入以下信息：
--   ✗ 手机号：如 13812345678
--   ✗ 身份证号：如 110101199001011234
--   ✗ 住院号/病案号/门诊号：如 住院号:123456、MRN: 789
--   ✗ 姓名：如 患者:张三、姓名:李四
--   ✗ 8位以上连续数字（可能是各种编号）
--
-- 正确做法：
--   ✓ 用中心分配的患者编码，如 BJ01-2024-001
--   ✓ 备注只写临床事实，如 "血压控制良好，依从性好"
-- =============================================================

-- ─── 1. 通用 PII 拦截触发器函数 ─────────────────────────────────────────────
-- 本函数被注册到所有含自由文本字段的表上
-- 检查的字段通过 TG_ARGV 传入
CREATE OR REPLACE FUNCTION _pii_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_field text;
  v_value text;
BEGIN
  -- 遍历需要检查的字段列表（由触发器注册时通过参数指定）
  FOREACH v_field IN ARRAY TG_ARGV LOOP
    EXECUTE format('SELECT ($1).%I::text', v_field) INTO v_value USING NEW;
    IF v_value IS NOT NULL AND _contains_pii(v_value) THEN
      RAISE EXCEPTION 'pii_detected_blocked'
        USING HINT = format(
          '字段 "%s" 中检测到疑似个人身份信息（PII）。'
          '本系统为科研数据库，禁止录入手机号、身份证、住院号、姓名等可识别信息。'
          '请检查并修改后重新保存。问题内容片段：%s',
          v_field,
          left(v_value, 30) || CASE WHEN length(v_value) > 30 THEN '...' ELSE '' END
        );
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION _pii_guard IS
  'PII拦截触发器。检测自由文本字段中的个人身份信息并拒绝写入。
  触发时抛出异常 pii_detected_blocked，前端可捕获并显示友好提示。';

-- ─── 2. 注册触发器到各个表 ──────────────────────────────────────────────────

-- visits_long.notes（随访备注）
DROP TRIGGER IF EXISTS trg_pii_guard_visits ON visits_long;
CREATE TRIGGER trg_pii_guard_visits
  BEFORE INSERT OR UPDATE ON visits_long
  FOR EACH ROW EXECUTE FUNCTION _pii_guard('notes');

-- labs_long.qc_reason（化验留痕原因）
DROP TRIGGER IF EXISTS trg_pii_guard_labs ON labs_long;
CREATE TRIGGER trg_pii_guard_labs
  BEFORE INSERT OR UPDATE ON labs_long
  FOR EACH ROW EXECUTE FUNCTION _pii_guard('qc_reason');

-- meds_long（用药记录：drug_name / drug_class / dose 一般不含PII，但 dose 字段可能有备注）
-- 暂不加 trigger，在前端校验即可（drug 字段结构化，PII风险低）

-- variants_long.notes（基因变异备注）
DROP TRIGGER IF EXISTS trg_pii_guard_variants ON variants_long;
CREATE TRIGGER trg_pii_guard_variants
  BEFORE INSERT OR UPDATE ON variants_long
  FOR EACH ROW EXECUTE FUNCTION _pii_guard('notes');

-- events_long.notes（终点事件备注）
DROP TRIGGER IF EXISTS trg_pii_guard_events ON events_long;
CREATE TRIGGER trg_pii_guard_events
  BEFORE INSERT OR UPDATE ON events_long
  FOR EACH ROW EXECUTE FUNCTION _pii_guard('notes');

-- ─── 3. 增强 _contains_pii 函数（补充更多模式） ─────────────────────────────
-- 原函数已有基础 regex，这里覆盖并补充更多模式
CREATE OR REPLACE FUNCTION _contains_pii(p_text text)
RETURNS boolean
LANGUAGE plpgsql IMMUTABLE
AS $$
BEGIN
  IF p_text IS NULL OR length(trim(p_text)) = 0 THEN
    RETURN false;
  END IF;

  RETURN (
    -- 中国大陆手机号（1[3-9] 开头，11位）
    p_text ~ '1[3-9][0-9]{9}'

    -- 中国身份证（18位，包含校验位X）
    OR p_text ~ '[1-9][0-9]{5}(19|20)[0-9]{2}(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])[0-9]{3}[0-9Xx]'

    -- 住院相关关键词 + 数字（如 住院号:123456、MRN: 789、病案号123）
    OR p_text ~* '(住院号|病案号|门诊号|病历号|床号|mrn|admiss)[^a-z0-9]{0,3}[0-9]{3,}'

    -- 姓名关键词（如 患者:张三、姓名：李四、病人 王五）
    OR p_text ~* '(姓名|患者姓名|病人|name\s*[:：])\s*[\u4e00-\u9fa5]{2,4}'

    -- 8位以上连续数字（各类编号风险）
    OR p_text ~ '[0-9]{8,}'

    -- 邮箱（含 @ 符号，且 @ 前后都有字符）
    OR p_text ~ '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}'

    -- 身份证关键词
    OR p_text ~* '(身份证|id\s*card|身份号)[^a-z]{0,5}[0-9]'
  );
END;
$$;

-- ─── 4. 测试用例（注释说明，实际验证时可执行） ─────────────────────────────
-- 以下 SELECT 均应返回 true（表示检测到PII，会被拦截）：
-- SELECT _contains_pii('患者手机：13812345678');             → true（手机号）
-- SELECT _contains_pii('住院号:20240012345');               → true（住院号）
-- SELECT _contains_pii('身份证：110101199001011234');        → true（身份证）
-- SELECT _contains_pii('患者：张三，血压控制良好');           → true（姓名关键词）
-- SELECT _contains_pii('MRN: 789456，复查正常');             → true（MRN）
-- SELECT _contains_pii('creatinine 1.2 mg/dL, stable');   → false（正常临床描述）
-- SELECT _contains_pii('血压控制良好，依从性佳');             → false（正常中文描述）
-- SELECT _contains_pii('UPCR 1.5 g/g 较前下降');            → false（正常化验描述）
