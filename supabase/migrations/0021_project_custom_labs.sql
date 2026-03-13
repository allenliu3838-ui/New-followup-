-- =============================================================
-- 0021 项目自定义化验目录
--
-- 每个研究项目可维护自己的化验目录（不在全局 lab_test_catalog 中的项目）。
-- 首次添加自定义化验时自动保存到本表，后续所有患者可直接从下拉中选用，
-- 保证同项目多患者、多中心录入时化验名称/单位一致。
-- =============================================================

CREATE TABLE IF NOT EXISTS project_custom_labs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        text NOT NULL,          -- 化验名，例如：补体因子H
  unit        text NOT NULL DEFAULT '',  -- 单位，例如：mg/L
  sort_order  int  NOT NULL DEFAULT 0,
  created_by  uuid REFERENCES auth.users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, name)            -- 同一项目化验名不重复
);

COMMENT ON TABLE project_custom_labs IS
  '研究项目自定义化验目录；用户首次录入自定义化验时自动保存，后续同项目可直接选用。';

-- RLS：只有项目创建者可以读写
ALTER TABLE project_custom_labs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "pcl_select" ON project_custom_labs;
CREATE POLICY "pcl_select" ON project_custom_labs
  FOR SELECT TO authenticated
  USING (project_id IN (
    SELECT id FROM projects WHERE created_by = auth.uid()
  ));

DROP POLICY IF EXISTS "pcl_insert" ON project_custom_labs;
CREATE POLICY "pcl_insert" ON project_custom_labs
  FOR INSERT TO authenticated
  WITH CHECK (project_id IN (
    SELECT id FROM projects WHERE created_by = auth.uid()
  ));

DROP POLICY IF EXISTS "pcl_update" ON project_custom_labs;
CREATE POLICY "pcl_update" ON project_custom_labs
  FOR UPDATE TO authenticated
  USING (project_id IN (
    SELECT id FROM projects WHERE created_by = auth.uid()
  ));

DROP POLICY IF EXISTS "pcl_delete" ON project_custom_labs;
CREATE POLICY "pcl_delete" ON project_custom_labs
  FOR DELETE TO authenticated
  USING (project_id IN (
    SELECT id FROM projects WHERE created_by = auth.uid()
  ));
