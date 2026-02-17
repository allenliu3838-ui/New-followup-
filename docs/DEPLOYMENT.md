# Deployment (step-by-step)

This project is designed to be **no-build static hosting** + **Supabase Postgres**.

---

## 0) Prerequisites
- A GitHub repo (you already created: `New-followup-`)
- A Supabase account
- A Netlify account

---

## 1) Database (Supabase)

### 1.1 Create Supabase project
Supabase → New project → set a password → create.

### 1.2 Run SQL migration
Supabase → SQL Editor → new query → paste:

- `supabase/migrations/0001_core.sql`

Run once.

✅ Verification queries (SQL Editor):

```sql
select table_name from information_schema.tables
where table_schema='public'
order by table_name;

select column_name, data_type
from information_schema.columns
where table_schema='public' and table_name='patients_baseline'
order by ordinal_position;
```

You should see:
- `projects`, `patients_baseline`, `visits_long`, `variants_long`, `patient_tokens`
- `patients_baseline` contains `oxford_m/e/s/t/c`

### 1.3 Auth configuration (critical for magic link)
Supabase → Authentication → URL Configuration:

- Site URL: `https://YOUR_NETLIFY_DOMAIN`
- Redirect URLs add:
  - `https://YOUR_NETLIFY_DOMAIN/staff`
  - `https://YOUR_NETLIFY_DOMAIN/p/*`

If you test locally, add:
- `http://localhost:8888/staff`

---

## 2) Frontend config

Edit `site/config.js` and fill:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`

---

## 3) Deploy to Netlify

### Option A (recommended): Connect GitHub repo
1. Netlify → “Add new site” → “Import an existing project”
2. Choose GitHub → select your repo
3. Build settings:
   - Publish directory: `site`
   - Build command: (empty) / already `echo 'no build'`
4. Deploy

### Option B: Drag & drop
1. `zip` the `site/` folder content
2. Netlify → deploy manually

---

## 4) Post-deploy checklist (online)

Open these URLs in **your deployed site domain**:

### 4.1 `/`
✅ Home page loads.

### 4.2 `/guide`
✅ Guide page loads with role switch + stepper + FAQ.

### 4.3 `/staff`
✅ Login page appears, and after magic link login you see:
- Create project
- Create patient baseline
- Generate token
- Export + paper pack

If magic link returns but you stay logged out:
- check Supabase Redirect URLs (Section 1.3)

### 4.4 Create a project and test writes
- Create a project with `center_code=TEST01`
- Create a patient baseline with patient_code `0001`
- Generate a token

Open the token link:
- `/p/<token>`
✅ Enter a visit and submit
✅ Refresh history shows the visit

---

## 5) Trial expiry behavior (expected)

In `projects` table:
- `trial_expires_at` defaults to now + 56 days
- After expiry, **all writes are blocked** (backend trigger)
  - baseline insert/update/delete blocked
  - visit insert/update/delete blocked
  - token creation blocked

Reads and exports remain available.

---

## 6) Backup and export

From `/staff` you can export:
- baseline / visits / labs / meds / variants (CSV)
- paper pack zip (CSV + analysis starter kit)

For multi-center DCC merge:
- merge by `center_code + patient_code`.

