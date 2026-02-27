-- LN（狼疮性肾炎）病理分型字段
-- 依据 ISN/RPS 2003 分类标准（2018修订版）
-- 对 IgAN 项目无影响；所有新字段默认 NULL，无破坏性变更。

alter table public.patients_baseline
  add column if not exists ln_biopsy_date       date,
  add column if not exists ln_class             text,
  add column if not exists ln_activity_index    smallint,
  add column if not exists ln_chronicity_index  smallint,
  add column if not exists ln_podocytopathy     boolean;

-- ISN/RPS 分型约束：I / II / III-A / III-A/C / III-C /
--   IV-S(A) / IV-G(A) / IV-S(A/C) / IV-G(A/C) / IV-S(C) / IV-G(C) / V / VI
alter table public.patients_baseline
  add constraint ln_class_check check (
    ln_class is null or ln_class in (
      'I','II',
      'III-A','III-A/C','III-C',
      'IV-S(A)','IV-G(A)','IV-S(A/C)','IV-G(A/C)','IV-S(C)','IV-G(C)',
      'V','VI'
    )
  );

-- NIH 活动指数 0-24
alter table public.patients_baseline
  add constraint ln_activity_index_check check (
    ln_activity_index is null or (ln_activity_index >= 0 and ln_activity_index <= 24)
  );

-- NIH 慢性化指数 0-12
alter table public.patients_baseline
  add constraint ln_chronicity_index_check check (
    ln_chronicity_index is null or (ln_chronicity_index >= 0 and ln_chronicity_index <= 12)
  );

comment on column public.patients_baseline.ln_biopsy_date      is '狼疮肾肾穿日期';
comment on column public.patients_baseline.ln_class            is 'ISN/RPS 2003/2018 分型：I II III-A III-A/C III-C IV-S(A) IV-G(A) IV-S(A/C) IV-G(A/C) IV-S(C) IV-G(C) V VI';
comment on column public.patients_baseline.ln_activity_index   is 'NIH 活动指数（AI），0–24';
comment on column public.patients_baseline.ln_chronicity_index is 'NIH 慢性化指数（CI），0–12';
comment on column public.patients_baseline.ln_podocytopathy    is '是否合并足细胞病变（2018 修订版新增）';
