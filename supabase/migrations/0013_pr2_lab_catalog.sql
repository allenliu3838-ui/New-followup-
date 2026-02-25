-- =============================================================
-- PR-2 化验项目字典 + 单位字典 + 自动换算
-- 目的：消灭"自由文本单位"乱象，让多中心数据可以直接合并分析
--
-- 背景举例：
--   A中心填 scr=1.2 mg/dL，B中心填 scr=106 μmol/L
--   过去合并时数据会乱掉；启用本 migration 后
--   两者都会自动换算为标准值，可直接比较
-- =============================================================

-- ─── 1. 化验项目字典：lab_test_catalog ─────────────────────────────────────
-- 每种化验项目在这里登记一次，防止"血肌酐"/"血清肌酐"/"Scr"各写各的
CREATE TABLE IF NOT EXISTS lab_test_catalog (
  code           text PRIMARY KEY,   -- 系统内部编码，例：CREAT
  name_cn        text NOT NULL,      -- 中文名，例：血肌酐
  name_en        text,               -- 英文名，例：Serum Creatinine
  module         text NOT NULL DEFAULT 'GENERAL',
                                     -- 适用模块：GENERAL/IGAN/LN/MN/KTX
  is_core        boolean NOT NULL DEFAULT false,
                                     -- 是否"核心指标"（缺失会触发质控警告）
  loinc_code     text,               -- LOINC 编码（选填，方便与国际数据库对接）
  standard_unit  text NOT NULL,      -- 标准单位，所有值都会换算到这个单位
  display_note   text,               -- 前端提示语，例：正常参考范围 0.6-1.2 mg/dL
  created_at     timestamptz DEFAULT now()
);

COMMENT ON TABLE lab_test_catalog IS
  '化验项目字典：统一编码，防止多中心录入时名称不一致导致合并失败';
COMMENT ON COLUMN lab_test_catalog.code IS
  '系统内部编码，建议全大写+下划线，例：CREAT、UPCR、HGB';
COMMENT ON COLUMN lab_test_catalog.standard_unit IS
  '所有中心的数据都换算到这个单位后存储，保证可直接合并分析';
COMMENT ON COLUMN lab_test_catalog.is_core IS
  '核心指标缺失会在质控系统中自动生成警告（Issue）';

-- ─── 2. 单位字典：unit_catalog ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS unit_catalog (
  symbol      text PRIMARY KEY,    -- 单位符号，例：mg/dL
  description text,                -- 说明，例：毫克每分升
  created_at  timestamptz DEFAULT now()
);

COMMENT ON TABLE unit_catalog IS
  '允许使用的单位列表，防止"mg/dl"/"mg/dL"/"MG/DL"写法混用';

-- ─── 3. 项目-单位对应表：lab_test_unit_map ──────────────────────────────────
-- 每个化验项目只允许特定几个单位，并记录如何换算到标准单位
-- 换算公式：value_standard = value_raw * multiplier + offset_val
-- 举例：血肌酐 μmol/L → mg/dL：multiplier=1/88.4≈0.01131，offset_val=0
CREATE TABLE IF NOT EXISTS lab_test_unit_map (
  lab_test_code  text NOT NULL REFERENCES lab_test_catalog(code),
  unit_symbol    text NOT NULL REFERENCES unit_catalog(symbol),
  multiplier     numeric NOT NULL DEFAULT 1,   -- 换算系数
  offset_val     numeric NOT NULL DEFAULT 0,   -- 换算偏移（温度转换用，肾病一般为0）
  is_standard    boolean NOT NULL DEFAULT false, -- 是否就是标准单位（换算系数=1）
  PRIMARY KEY (lab_test_code, unit_symbol)
);

COMMENT ON TABLE lab_test_unit_map IS
  '每个化验项目允许哪些单位输入，以及如何换算到标准单位';
COMMENT ON COLUMN lab_test_unit_map.multiplier IS
  '换算系数：value_standard = value_raw × multiplier + offset_val。
  例：μmol/L→mg/dL，multiplier=0.01131（即1/88.4）';

-- ─── 4. labs_long 扩展列（向后兼容，原有列保留） ────────────────────────────
-- 原有列：lab_name / lab_value / lab_unit（自由文本，旧数据继续可读）
-- 新增列：结构化层，新录入必填，旧数据可为 NULL
ALTER TABLE labs_long
  ADD COLUMN IF NOT EXISTS lab_test_code     text REFERENCES lab_test_catalog(code),
  ADD COLUMN IF NOT EXISTS value_raw         numeric,
  ADD COLUMN IF NOT EXISTS unit_symbol       text REFERENCES unit_catalog(symbol),
  ADD COLUMN IF NOT EXISTS value_standard    numeric,
  ADD COLUMN IF NOT EXISTS standard_unit     text,
  ADD COLUMN IF NOT EXISTS measured_at       timestamptz;
  -- measured_at：精确到分钟的采集时间（比 lab_date 更精准）

COMMENT ON COLUMN labs_long.lab_test_code    IS '化验项目编码，对应 lab_test_catalog.code';
COMMENT ON COLUMN labs_long.value_raw        IS '原始值（录入时的数字，保持用户输入不变）';
COMMENT ON COLUMN labs_long.unit_symbol      IS '录入时使用的单位，对应 unit_catalog.symbol';
COMMENT ON COLUMN labs_long.value_standard   IS '已换算到标准单位的值，可直接用于多中心合并分析';
COMMENT ON COLUMN labs_long.standard_unit    IS '标准单位符号，来自 lab_test_catalog.standard_unit';

-- ─── 5. 化验值标准化函数：normalize_lab_value() ──────────────────────────────
-- 输入：化验编码、原始值、录入单位
-- 输出：标准值（已换算）
-- 举例：normalize_lab_value('CREAT', 88.4, 'μmol/L') → 1.00
--       normalize_lab_value('UPCR', 2000, 'mg/g')    → 2.00
CREATE OR REPLACE FUNCTION normalize_lab_value(
  p_code    text,
  p_value   numeric,
  p_unit    text
)
RETURNS numeric
LANGUAGE plpgsql IMMUTABLE
AS $$
DECLARE
  v_multi numeric;
  v_off   numeric;
BEGIN
  SELECT multiplier, offset_val
    INTO v_multi, v_off
  FROM lab_test_unit_map
  WHERE lab_test_code = p_code
    AND unit_symbol   = p_unit;

  IF NOT FOUND THEN
    -- 单位不在允许列表中，返回 NULL，触发质控 Issue
    RETURN NULL;
  END IF;

  RETURN ROUND(p_value * v_multi + v_off, 4);
END;
$$;

COMMENT ON FUNCTION normalize_lab_value IS
  '将化验原始值换算到标准单位。例：normalize_lab_value(''CREAT'',88.4,''μmol/L'')=1.00';

-- ─── 6. 校验并写入化验记录的 RPC：upsert_lab_record() ────────────────────────
-- 这是前端保存化验记录时调用的函数
-- 步骤：① 校验项目存在 ② 校验单位允许 ③ 自动换算 ④ 写入
CREATE OR REPLACE FUNCTION upsert_lab_record(
  p_project_id   uuid,
  p_patient_code text,
  p_lab_date     date,
  p_lab_test_code text,
  p_value_raw    numeric,
  p_unit_symbol  text,
  p_measured_at  timestamptz DEFAULT NULL,
  p_lab_id       uuid        DEFAULT NULL  -- NULL=新增，有值=更新
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_standard      numeric;
  v_std_unit      text;
  v_result_id     uuid;
  v_map_exists    boolean;
BEGIN
  -- ① 校验项目存在
  IF NOT EXISTS(SELECT 1 FROM lab_test_catalog WHERE code = p_lab_test_code) THEN
    RAISE EXCEPTION 'lab_test_code_not_found'
      USING HINT = '化验项目编码 "' || p_lab_test_code || '" 不在字典中，请从下拉列表选择';
  END IF;

  -- ② 校验单位被允许
  SELECT EXISTS(
    SELECT 1 FROM lab_test_unit_map
    WHERE lab_test_code = p_lab_test_code AND unit_symbol = p_unit_symbol
  ) INTO v_map_exists;

  IF NOT v_map_exists THEN
    RAISE EXCEPTION 'unit_not_allowed'
      USING HINT = '单位 "' || p_unit_symbol || '" 不是 "' || p_lab_test_code
                 || '" 的允许单位，请从下拉列表选择';
  END IF;

  -- ③ 自动换算标准值
  v_standard := normalize_lab_value(p_lab_test_code, p_value_raw, p_unit_symbol);
  SELECT standard_unit INTO v_std_unit FROM lab_test_catalog WHERE code = p_lab_test_code;

  -- ④ 检查项目写入权限
  PERFORM assert_project_write_allowed(p_project_id);

  -- ⑤ 新增或更新
  IF p_lab_id IS NULL THEN
    INSERT INTO labs_long(
      project_id, patient_code, lab_date,
      lab_name,   lab_value,    lab_unit,        -- 保持向后兼容列
      lab_test_code, value_raw, unit_symbol,
      value_standard, standard_unit, measured_at
    ) VALUES (
      p_project_id, p_patient_code, p_lab_date,
      p_lab_test_code, p_value_raw, p_unit_symbol,
      p_lab_test_code, p_value_raw, p_unit_symbol,
      v_standard, v_std_unit, p_measured_at
    )
    RETURNING id INTO v_result_id;
  ELSE
    UPDATE labs_long SET
      lab_date       = p_lab_date,
      lab_name       = p_lab_test_code,
      lab_value      = p_value_raw,
      lab_unit       = p_unit_symbol,
      lab_test_code  = p_lab_test_code,
      value_raw      = p_value_raw,
      unit_symbol    = p_unit_symbol,
      value_standard = v_standard,
      standard_unit  = v_std_unit,
      measured_at    = p_measured_at,
      updated_at     = now(),
      updated_by     = auth.uid()
    WHERE id = p_lab_id
      AND project_id = p_project_id
    RETURNING id INTO v_result_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'lab_not_found' USING HINT = '化验记录不存在或无权修改';
    END IF;
  END IF;

  RETURN v_result_id;
END;
$$;

GRANT EXECUTE ON FUNCTION upsert_lab_record TO authenticated;

-- ─── 7. Seed 数据：常用肾病科化验项目 ─────────────────────────────────────
-- 项目字典
INSERT INTO lab_test_catalog(code, name_cn, name_en, module, is_core, loinc_code, standard_unit, display_note)
VALUES
  -- 核心肾功能
  ('CREAT',  '血肌酐',             'Serum Creatinine',      'GENERAL', true,  '2160-0', 'mg/dL',
   '正常参考范围（成人）：男 0.7-1.2 mg/dL，女 0.5-1.0 mg/dL'),
  ('UPCR',   '尿蛋白/肌酐比',      'Urine PCR',             'GENERAL', true,  '13705-9','g/g',
   '正常 <0.15 g/g；IgAN缓解目标 <0.3 g/g；大量蛋白尿 >3.5 g/g'),
  ('EGFR',   'eGFR（实验室报告）', 'eGFR (lab report)',     'GENERAL', false, '62238-1','mL/min/1.73m²',
   '若有实验室报告的eGFR可录入；系统也会自动用CKD-EPI公式计算'),

  -- 血常规
  ('HGB',    '血红蛋白',           'Hemoglobin',            'GENERAL', false, '718-7',  'g/dL',
   '正常参考范围：男 13.5-17.5 g/dL，女 12-16 g/dL'),
  ('WBC',    '白细胞计数',         'WBC',                   'GENERAL', false, '6690-2', '10^9/L',
   '正常 4-10×10⁹/L'),
  ('PLT',    '血小板',             'Platelet',              'GENERAL', false, '777-3',  '10^9/L',
   '正常 100-300×10⁹/L'),

  -- 肝功能
  ('ALT',    '谷丙转氨酶',         'ALT',                   'GENERAL', false, '1742-6', 'U/L',
   '正常 <40 U/L'),
  ('AST',    '谷草转氨酶',         'AST',                   'GENERAL', false, '1920-8', 'U/L',
   '正常 <40 U/L'),
  ('ALB',    '血清白蛋白',         'Albumin',               'GENERAL', false, '1751-7', 'g/dL',
   '正常 3.5-5.0 g/dL；低于3.5提示低蛋白血症'),

  -- 电解质与代谢
  ('K',      '血钾',               'Potassium',             'GENERAL', false, '2823-3', 'mmol/L',
   '正常 3.5-5.0 mmol/L；>5.5为高钾，<3.5为低钾'),
  ('NA',     '血钠',               'Sodium',                'GENERAL', false, '2951-2', 'mmol/L',
   '正常 135-145 mmol/L'),
  ('CA',     '血钙',               'Calcium',               'GENERAL', false, '17861-6','mmol/L',
   '正常 2.1-2.6 mmol/L'),
  ('PHOS',   '血磷',               'Phosphorus',            'GENERAL', false, '2777-1', 'mmol/L',
   '正常 0.8-1.5 mmol/L'),
  ('UA',     '血尿酸',             'Uric Acid',             'GENERAL', false, '3084-1', 'μmol/L',
   '正常：男 <420 μmol/L，女 <360 μmol/L'),
  ('CO2',    '碳酸氢根（HCO3）',   'Bicarbonate',           'GENERAL', false, '1963-8', 'mmol/L',
   '正常 22-29 mmol/L；低于22提示代谢性酸中毒'),

  -- 血脂
  ('TCHOL',  '总胆固醇',           'Total Cholesterol',     'GENERAL', false, '2093-3', 'mmol/L',
   '正常 <5.2 mmol/L'),
  ('TG',     '甘油三酯',           'Triglycerides',         'GENERAL', false, '2571-8', 'mmol/L',
   '正常 <1.7 mmol/L'),
  ('LDL',    '低密度脂蛋白',       'LDL-C',                 'GENERAL', false, '13457-7','mmol/L',
   '心肾保护目标 <1.8 mmol/L（高危患者）'),
  ('HDL',    '高密度脂蛋白',       'HDL-C',                 'GENERAL', false, '2085-9', 'mmol/L',
   '越高越好，男>1.0，女>1.3 mmol/L'),

  -- 炎症指标
  ('CRP',    'C反应蛋白',          'CRP',                   'GENERAL', false, '1988-5', 'mg/L',
   '正常 <5 mg/L'),

  -- IgA 肾病专项
  ('IGA',    '血清IgA',            'Serum IgA',             'IGAN',    false, '1746-7', 'g/L',
   '正常成人 0.7-4.0 g/L；IgAN患者常偏高'),
  ('IGAG',   'IgA/IgG比值',        'IgA/IgG Ratio',         'IGAN',    false, NULL,     'ratio',
   'IgAN辅助诊断指标'),

  -- 狼疮性肾炎专项
  ('C3',     '补体C3',             'Complement C3',         'LN',      false, '4532-9', 'g/L',
   '正常 0.9-1.8 g/L；LN活动期常降低'),
  ('C4',     '补体C4',             'Complement C4',         'LN',      false, '4533-7', 'g/L',
   '正常 0.1-0.4 g/L'),
  ('DSDNA',  '抗dsDNA抗体',        'Anti-dsDNA',            'LN',      false, '11065-0','IU/mL',
   '<10 IU/mL为阴性；升高提示LN活动'),

  -- 移植专项
  ('TACRO',  '他克莫司血药浓度',   'Tacrolimus Trough',     'KTX',     false, '35151-0','ng/mL',
   '目标谷浓度因时期而异，通常术后1-3月：8-12 ng/mL，稳定期：5-8 ng/mL'),
  ('CSA',    '环孢素血药浓度',      'Cyclosporine Trough',   'KTX',     false, '34533-0','ng/mL',
   '目标因中心和时期不同，参考各中心方案')

ON CONFLICT (code) DO NOTHING;

-- 单位字典
INSERT INTO unit_catalog(symbol, description) VALUES
  ('mg/dL',       '毫克每分升'),
  ('μmol/L',       '微摩尔每升'),
  ('umol/L',       '微摩尔每升（ASCII写法）'),
  ('g/g',          '克每克（尿蛋白/肌酐比）'),
  ('mg/g',         '毫克每克（尿蛋白/肌酐比）'),
  ('g/L',          '克每升'),
  ('g/dL',         '克每分升'),
  ('mmol/L',       '毫摩尔每升'),
  ('U/L',          '单位每升（酶活性）'),
  ('mL/min/1.73m²','毫升/分钟/1.73平方米（eGFR标准单位）'),
  ('10^9/L',       '10的9次方每升（血细胞计数）'),
  ('mg/L',         '毫克每升'),
  ('IU/mL',        '国际单位每毫升'),
  ('ng/mL',        '纳克每毫升（药物浓度）'),
  ('ratio',        '比值（无量纲）')
ON CONFLICT (symbol) DO NOTHING;

-- 项目-单位对应（换算表）
-- 格式说明：value_standard = value_raw × multiplier
INSERT INTO lab_test_unit_map(lab_test_code, unit_symbol, multiplier, offset_val, is_standard)
VALUES
  -- 血肌酐
  ('CREAT', 'mg/dL',  1,          0, true ),  -- 标准单位，直接用
  ('CREAT', 'μmol/L', 0.01130996, 0, false),  -- ÷88.4
  ('CREAT', 'umol/L', 0.01130996, 0, false),  -- 同上，ASCII写法

  -- 尿蛋白/肌酐比
  ('UPCR',  'g/g',    1,          0, true ),  -- 标准单位
  ('UPCR',  'mg/g',   0.001,      0, false),  -- ÷1000
  ('UPCR',  'mg/mmol',0.1130996,  0, false),  -- 1 mg/mmol = 0.113 g/g（近似）

  -- eGFR（实验室报告，单位一致，直接用）
  ('EGFR',  'mL/min/1.73m²', 1,  0, true ),

  -- 血红蛋白
  ('HGB',   'g/dL',   1,          0, true ),
  ('HGB',   'g/L',    0.1,        0, false),  -- ÷10

  -- 白细胞/血小板（10^9/L 是标准）
  ('WBC',   '10^9/L', 1,          0, true ),
  ('PLT',   '10^9/L', 1,          0, true ),

  -- 肝功能
  ('ALT',   'U/L',    1,          0, true ),
  ('AST',   'U/L',    1,          0, true ),

  -- 白蛋白
  ('ALB',   'g/dL',   1,          0, true ),
  ('ALB',   'g/L',    0.1,        0, false),

  -- 电解质（mmol/L 标准）
  ('K',     'mmol/L', 1,          0, true ),
  ('NA',    'mmol/L', 1,          0, true ),
  ('CA',    'mmol/L', 1,          0, true ),
  ('PHOS',  'mmol/L', 1,          0, true ),
  ('CO2',   'mmol/L', 1,          0, true ),

  -- 血尿酸（μmol/L 标准）
  ('UA',    'μmol/L', 1,          0, true ),
  ('UA',    'umol/L', 1,          0, false), -- ASCII 写法
  ('UA',    'mg/dL',  59.485,     0, false), -- ×59.485 → μmol/L

  -- 血脂（mmol/L 标准）
  ('TCHOL', 'mmol/L', 1,          0, true ),
  ('TCHOL', 'mg/dL',  0.02586,    0, false),
  ('TG',    'mmol/L', 1,          0, true ),
  ('TG',    'mg/dL',  0.01129,    0, false),
  ('LDL',   'mmol/L', 1,          0, true ),
  ('LDL',   'mg/dL',  0.02586,    0, false),
  ('HDL',   'mmol/L', 1,          0, true ),
  ('HDL',   'mg/dL',  0.02586,    0, false),

  -- 炎症
  ('CRP',   'mg/L',   1,          0, true ),

  -- IgAN 专项
  ('IGA',   'g/L',    1,          0, true ),
  ('IGAG',  'ratio',  1,          0, true ),

  -- LN 专项
  ('C3',    'g/L',    1,          0, true ),
  ('C4',    'g/L',    1,          0, true ),
  ('DSDNA', 'IU/mL',  1,          0, true ),

  -- KTX 专项
  ('TACRO', 'ng/mL',  1,          0, true ),
  ('CSA',   'ng/mL',  1,          0, true )

ON CONFLICT (lab_test_code, unit_symbol) DO NOTHING;

-- ─── 8. RLS：字典表只读（所有已登录用户可读，不可修改） ─────────────────────
ALTER TABLE lab_test_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE unit_catalog      ENABLE ROW LEVEL SECURITY;
ALTER TABLE lab_test_unit_map ENABLE ROW LEVEL SECURITY;

CREATE POLICY "catalog_select" ON lab_test_catalog FOR SELECT TO authenticated, anon USING (true);
CREATE POLICY "unit_select"    ON unit_catalog      FOR SELECT TO authenticated, anon USING (true);
CREATE POLICY "map_select"     ON lab_test_unit_map FOR SELECT TO authenticated, anon USING (true);
