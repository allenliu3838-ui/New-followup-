-- RCT Phase 1：在 patients_baseline 增加随机化字段
-- 观察性队列可全部留空（NULL）；无破坏性变更。

alter table public.patients_baseline
  add column if not exists treatment_arm text,
  add column if not exists randomization_id text,
  add column if not exists randomization_date date,
  add column if not exists stratification_factors jsonb;

comment on column public.patients_baseline.treatment_arm      is '干预组别：intervention（干预组）/ control（对照组）/ placebo（安慰剂组）或自定义；观察性队列留空';
comment on column public.patients_baseline.randomization_id   is '随机号（盲底管理编号）；观察性队列留空';
comment on column public.patients_baseline.randomization_date is '随机化日期；观察性队列留空';
comment on column public.patients_baseline.stratification_factors is '分层因素 JSON，如 {"中心":"BJ01","eGFR分层":"高风险"}；观察性队列留空';
