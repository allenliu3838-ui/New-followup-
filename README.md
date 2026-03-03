# KidneySphere AI · Follow-up Registry (Clean v1)

A **static** (no-build) research registry for nephrology follow-up:
- `/staff` admin portal (magic-link login)
- `/p/<token>` follow-up entry page (no login)
- `/guide` world-class training + FAQ (for all trial users)
- `/pricing` progressive pricing details + FAQ
- `/security` security/compliance overview
- `/deployment` SaaS/private deployment options
- Supabase Postgres schema includes:
  - multicenter merge key: **center_code + patient_code**
  - IgAN pathology: **Oxford MEST‑C**
  - genetics: `variants_long` long-table
  - trial write lock (post-expiry read-only)
  - CN-friendly concept layer: `concept_dictionary` + `abbreviation_dictionary`
  - CN/EN export mapping: `v_concept_export_mapping`

> **Research-first only**. No clinical decision support. **Do NOT enter PII** (name/phone/MRN/ID).

---

## 1) What you need to do (from scratch)

### A. Create Supabase project
1. Go to Supabase → **New project**
2. After project is ready:
   - Copy **Project URL**
   - Copy **anon public key** (Project Settings → API)

### B. Run database SQL (IMPORTANT)
Open Supabase → **SQL Editor** → run migrations in order (`supabase/run_all_migrations.sql`),
or at minimum run:

- `supabase/migrations/0001_core.sql`
- `supabase/migrations/0013_pr2_lab_catalog.sql`
- `supabase/migrations/0019_cn_friendly_layer.sql`

This creates core tables/RLS/RPC plus CN-first metadata, abbreviation dictionary,
and CN alias search function (`search_concepts_cn`).

### C. Configure Auth redirect URLs (IMPORTANT)
Supabase → Authentication → URL Configuration:
- **Site URL**: your deployed domain (Netlify) or local dev URL
- **Redirect URLs**: include:
  - `https://YOUR_NETLIFY_DOMAIN/staff`
  - `https://YOUR_NETLIFY_DOMAIN/p/*`
  - (optional local) `http://localhost:8888/staff`

If not set, magic-link login may fail.

### D. Put Supabase keys into the frontend
Edit:

- `site/config.js`

Fill:
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`

Commit this file (or keep a private deploy copy).

### E. Deploy to Netlify (no build)
1. Push this repo to GitHub
2. Netlify → New site from Git
3. Build settings:
   - **Publish directory:** `site`
   - **Build command:** none (already `echo 'no build'`)

---

## 2) How to use (10-min workflow)

### Admin (PI / coordinator)
1. Open `/staff`
2. Login with email magic-link
3. Create a project:
   - set `center_code` (e.g., BJ01, SH02)
   - choose module (IGAN / LN / MN / GENERAL / KTX)
4. Add patients baseline:
   - `patient_code` only (no PII)
   - If IGAN, optionally enter Oxford **MEST‑C**
5. Generate follow-up token link:
   - share `/p/<token>` to follow-up staff

### Follow-up entry (no login)
- open token link → fill core 4 items:
  - date / BP / Scr / UPCR

### Statistics (paper pack)
- `/staff` → “一键生成论文包（zip）”
- unzip → run:
  - `pip install -r analysis/requirements.txt`
  - `python analysis/run_analysis.py`

Outputs go to `analysis/outputs/`.

---

## 3) Data model (high level)

- `projects` (trial settings live here)
- `patients_baseline` (includes IgAN Oxford MEST‑C)
- `visits_long` (core follow-up)
- `labs_long`, `meds_long` (optional)
- `variants_long` (genetics, optional)
- `patient_tokens` (token follow-up)

---

## 4) Notes for multicenter merge

- Each center uses their own `center_code`
- patient research IDs are unique within center
- Merge key for DCC: `center_code + patient_code`

---

## 5) Safety & compliance

- This system is **not** a diagnostic or treatment system.
- **No PII**. Use local mapping table per center if needed.
- PI must review auto-generated Methods before submission.
- For pharma registration trials (Phase I/II/III), this repo is **not** a validated EDC replacement by default; additional GCP/Part11-grade controls are required.

---

## 6) Commercialization reference

- Pricing and billing strategy (CN): `docs/BILLING_PLAN_CN.md`
- Detailed user training manual (CN): `docs/USER_MANUAL_CN.md`


## 7) Snapshot / reproducibility workflow

Snapshot IDs are immutable references for manuscript reproducibility.

In `/staff`:
- Click `生成数据快照（Snapshot）` to create a snapshot ID.
- Click `生成论文包（含 Snapshot）` to bundle data with snapshot metadata.
- Use `Snapshots` list to copy citation text and lock a snapshot for submission.

Paper package now includes:
- `snapshot_readme.txt`
- `qc_summary.json`
- baseline table placeholder (`table1_baseline.csv`)

## 8) KTx template (minimal extension)

Project module now includes `KTX` (kidney transplant post-op cohort).
The migration adds:
- `ktx_baseline_ext`
- `ktx_visits_ext`

These are optional extension tables for structured transplant fields.

## 9) 中文优先（面向中国医生）

`0019_cn_friendly_layer.sql` adds:

- `concept_dictionary`: 中文显示名、短名、帮助文案、填写时机、示例值、单位等字段。
- `abbreviation_dictionary`: 缩写首次出现的中文解释（如 KDPI/KDRI/dnDSA/dd-cfDNA）。
- `concept_alias_dictionary`: 中文别名检索（如“肌酐”“尿蛋白”“排斥”“BK病毒”）。
- `search_concepts_cn(keyword, domain)`: 统一中文搜索入口（支持 code/中文名/中文别名）。
- `v_concept_export_mapping`: 中文列名导出与英文编码映射视图。
