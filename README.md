# KidneySphere AI · Follow-up Registry (Clean v1)

A **static** (no-build) research registry for nephrology follow-up:
- `/staff` admin portal (magic-link login)
- `/p/<token>` follow-up entry page (no login)
- `/guide` world-class training + FAQ (for all trial users)
- Supabase Postgres schema includes:
  - multicenter merge key: **center_code + patient_code**
  - IgAN pathology: **Oxford MEST‑C**
  - genetics: `variants_long` long-table
  - trial write lock (post-expiry read-only)

> **Research-first only**. No clinical decision support. **Do NOT enter PII** (name/phone/MRN/ID).

---

## 1) What you need to do (from scratch)

### A. Create Supabase project
1. Go to Supabase → **New project**
2. After project is ready:
   - Copy **Project URL**
   - Copy **anon public key** (Project Settings → API)

### B. Run database SQL (IMPORTANT)
Open Supabase → **SQL Editor** → paste and run:

- `supabase/migrations/0001_core.sql`

This will create all tables, RLS policies, and RPC functions (token follow-up).

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
   - choose module (IGAN / LN / MN / GENERAL)
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

---

## 6) Commercialization reference

- Pricing and billing strategy (CN): `docs/BILLING_PLAN_CN.md`
