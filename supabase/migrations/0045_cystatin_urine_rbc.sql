-- 0045: serum cystatin C and urine red-cell counts in the laboratory dictionary.
-- Additive, transactional and safe to re-run. No stored value is changed and no function,
-- trigger or policy is re-created: the existing lab normalization (0040) handles the new tests.
--  * CYSC: serum cystatin C in mg/L (no other unit). Recorded so that cystatin C based eGFR
--    equations can be chosen in the analysis pack; the eGFR stored with each visit stays the
--    creatinine equation.
--  * URBC_UL and URBC_HPF: urine red cells counted by an analyser per microlitre, and by
--    microscopy of the centrifuged sediment per high-power field. They are two tests on
--    purpose: there is no exact conversion between the two methods, so neither unit is
--    converted into the other. Common spellings of each unit are accepted (multiplier 1).
--  * Display dictionary: abbreviations CysC and HPF.
BEGIN;

DO $$
DECLARE missing text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.registry_schema_versions WHERE version='0044_project_fields') THEN
    RAISE EXCEPTION '迁移 0045 已中止：尚未执行迁移 0044。请先按顺序执行 0032–0044，需人工核对后再迁移。';
  END IF;
  SELECT string_agg(t,'、' ORDER BY t) INTO missing
    FROM unnest(ARRAY['public.lab_test_catalog','public.lab_test_unit_map','public.unit_catalog',
      'public.abbreviation_dictionary','public.labs_long']) AS t
    WHERE to_regclass(t) IS NULL;
  IF missing IS NULL AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.labs_long'::regclass
      AND tgname='trg_normalize_lab_row' AND NOT tgisinternal) THEN
    missing := 'trigger trg_normalize_lab_row';
  END IF;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '迁移 0045 已中止：缺少本迁移依赖的对象（%）。请先确认数据库已按 0001–0044 完整升级，需人工核对后再迁移。',missing;
  END IF;
END $$;

INSERT INTO public.unit_catalog(symbol, description) VALUES
  ('cells/HPF', '细胞数每高倍视野（尿沉渣显微镜检；HPF 为高倍视野）'),
  ('个/HPF',    '个每高倍视野（同 cells/HPF）'),
  ('/HPF',      '每高倍视野（同 cells/HPF）'),
  ('个/HP',     '个每高倍视野（同 cells/HPF，HP 为高倍视野的另一种写法）'),
  ('/HP',       '每高倍视野（同 cells/HPF）'),
  ('个/μL',     '个每微升（同 cells/μL）'),
  ('/μL',       '每微升（同 cells/μL）')
ON CONFLICT (symbol) DO NOTHING;

INSERT INTO public.lab_test_catalog(code, name_cn, name_en, module, is_core, loinc_code, standard_unit, display_note)
VALUES
  ('CYSC',     '血清胱抑素C',               'Serum cystatin C',                                    'GENERAL', false, '33863-2', 'mg/L',
               '用于胱抑素 C 公式或肌酐–胱抑素 C 联合公式估算 eGFR（在分析包中选择公式）。这些公式要求检测可溯源至国际参考物质 ERM-DA471/IFCC；请在备注中记录检测方法或试剂。参考范围以检测实验室为准。'),
  ('URBC_UL',  '尿红细胞计数（仪器，/μL）',  'Urine erythrocytes per microlitre (analyser)',        'GENERAL', false, NULL,      'cells/μL',
               '尿沉渣分析仪报告的每微升红细胞数（个/μL）。与显微镜检的每高倍视野（/HPF）结果没有准确的换算关系，系统不互相换算，请按报告单位选择对应项目。“满视野”等无法计数的结果填在结果文字。'),
  ('URBC_HPF', '尿红细胞计数（镜检，/HPF）', 'Urine erythrocytes per high-power field (microscopy)', 'GENERAL', false, '13945-1', 'cells/HPF',
               '离心尿沉渣显微镜检每高倍视野红细胞数（个/HPF，也写作 /HP）。报告为范围（如 3–5）或“满视野”时，原文填在结果文字；是否另填数值、取范围的哪个值，按项目约定执行。与仪器的每微升（/μL）结果没有准确的换算关系，系统不互相换算。')
ON CONFLICT (code) DO NOTHING;

INSERT INTO public.lab_test_unit_map(lab_test_code, unit_symbol, multiplier, offset_val, is_standard)
VALUES
  ('CYSC',     'mg/L',      1, 0, true),
  ('URBC_UL',  'cells/μL',  1, 0, true),
  ('URBC_UL',  '个/μL',     1, 0, false),
  ('URBC_UL',  '/μL',       1, 0, false),
  ('URBC_HPF', 'cells/HPF', 1, 0, true),
  ('URBC_HPF', '个/HPF',    1, 0, false),
  ('URBC_HPF', '/HPF',      1, 0, false),
  ('URBC_HPF', '个/HP',     1, 0, false),
  ('URBC_HPF', '/HP',       1, 0, false)
ON CONFLICT (lab_test_code, unit_symbol) DO NOTHING;

INSERT INTO public.abbreviation_dictionary(abbr, full_name_cn, category_cn, first_use_note_cn) VALUES
  ('CysC', '胱抑素 C',   '化验指标', '首次显示建议：胱抑素 C（Cystatin C，CysC）'),
  ('HPF',  '高倍视野',   '化验指标', '首次显示建议：高倍视野（HPF，尿沉渣显微镜检计数单位）')
ON CONFLICT (abbr) DO NOTHING;

INSERT INTO public.registry_schema_versions(version) VALUES('0045_cystatin_urine_rbc') ON CONFLICT(version) DO NOTHING;
COMMIT;
