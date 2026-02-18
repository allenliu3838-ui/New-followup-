"""
KidneySphere AI — Paper Pack Analysis (Phase 1)

This script:
- reads de-identified long tables from analysis/data/
- produces Table 1, QC report, trend plots, 12-month outcomes,
  eGFR slope (LME), eGFR decline / remission endpoints, drug summary
- writes outputs into analysis/outputs/

Phase 1 additions:
  - events_long: manual events + computed 40%/57% eGFR decline endpoints
  - eGFR slope: Linear Mixed-Effects Model (LME, random intercept per patient)
  - IgAN remission endpoints: complete remission (CR) and partial remission (PR)
  - Drug data (meds_long) included in Table 1

Notes:
- Starter kit for research workflows. PI must review outputs before submission.
- Does NOT provide clinical decision support.
- eGFR decline definition: first visit where eGFR < baseline × threshold.
  Sustained confirmation (≥2 visits) is recommended but not enforced here;
  investigators should verify using the raw endpoints CSV.
- CR definition (IgAN): UPCR < 300 mg/g at any visit.
- PR definition (IgAN): UPCR ≥50% reduction from baseline AND UPCR < 1000 mg/g.
"""

from __future__ import annotations

from pathlib import Path
import json
import math
import warnings

import numpy as np
import pandas as pd
import matplotlib.pyplot as plt

warnings.filterwarnings("ignore", category=FutureWarning)

# Optional: statsmodels for LME eGFR slope
try:
    import statsmodels.formula.api as smf
    HAS_STATSMODELS = True
except ImportError:
    HAS_STATSMODELS = False

BASE = Path(__file__).resolve().parent
DATA = BASE / "data"
OUT = BASE / "outputs"
OUT.mkdir(parents=True, exist_ok=True)

# ---------------------------
# Helpers
# ---------------------------

def read_csv(name: str, required: bool = True) -> pd.DataFrame:
    path = DATA / name
    if not path.exists():
        if required:
            raise FileNotFoundError(
                f"Missing file: {path}. Please check analysis/data/ structure."
            )
        return pd.DataFrame()
    return pd.read_csv(path, encoding="utf-8-sig")

def to_dt(s) -> pd.Series:
    return pd.to_datetime(s, errors="coerce")

def to_num(s) -> pd.Series:
    return pd.to_numeric(s, errors="coerce")

def ckdepi2021(scr_mg_dl: float, age: float, sex: str) -> float | None:
    """CKD-EPI 2021 creatinine equation (race-free)."""
    if scr_mg_dl is None or age is None or sex is None:
        return None
    if not np.isfinite(scr_mg_dl) or not np.isfinite(age):
        return None
    sx = str(sex).upper()
    is_f = sx == "F"
    k = 0.7 if is_f else 0.9
    alpha = -0.241 if is_f else -0.302
    mn = min(scr_mg_dl / k, 1.0)
    mx = max(scr_mg_dl / k, 1.0)
    egfr = 142.0 * (mn ** alpha) * (mx ** -1.200) * (0.9938 ** age)
    if is_f:
        egfr *= 1.012
    return float(egfr)

def safe_mean(x):
    x = pd.to_numeric(x, errors="coerce")
    if x.notna().sum() == 0:
        return np.nan
    return float(x.mean())

def safe_median(x):
    x = pd.to_numeric(x, errors="coerce")
    if x.notna().sum() == 0:
        return np.nan
    return float(x.median())

def safe_iqr(x):
    x = pd.to_numeric(x, errors="coerce")
    if x.notna().sum() == 0:
        return (np.nan, np.nan)
    q1 = float(x.quantile(0.25))
    q3 = float(x.quantile(0.75))
    return (q1, q3)

def pct(n, d):
    if d == 0:
        return np.nan
    return 100.0 * n / d

def write_excel(path: Path, sheets: dict[str, pd.DataFrame]) -> None:
    with pd.ExcelWriter(path, engine="openpyxl") as w:
        for name, df in sheets.items():
            df.to_excel(w, index=False, sheet_name=name[:31])

# ---------------------------
# Load
# ---------------------------

patients = read_csv("patients_baseline.csv")
visits   = read_csv("visits_long.csv")
labs     = read_csv("labs_long.csv")
meds     = read_csv("meds_long.csv")
vars_    = read_csv("variants_long.csv")
events   = read_csv("events_long.csv", required=False)  # Phase 1; may be empty

# Normalize columns
for df in [patients, visits, labs, meds, vars_]:
    for c in ["center_code", "module", "patient_code"]:
        if c not in df.columns:
            raise ValueError(f"Required column missing: {c}")

patients["birth_year"]     = to_num(patients.get("birth_year"))
patients["baseline_date"]  = to_dt(patients.get("baseline_date")).dt.date
patients["baseline_scr"]   = to_num(patients.get("baseline_scr"))
patients["baseline_upcr"]  = to_num(patients.get("baseline_upcr"))

for c in ["oxford_m", "oxford_e", "oxford_s", "oxford_t", "oxford_c"]:
    if c in patients.columns:
        patients[c] = to_num(patients[c])

visits["visit_date"]   = to_dt(visits.get("visit_date")).dt.date
visits["sbp"]          = to_num(visits.get("sbp"))
visits["dbp"]          = to_num(visits.get("dbp"))
visits["scr_umol_l"]   = to_num(visits.get("scr_umol_l"))
visits["upcr"]         = to_num(visits.get("upcr"))
visits["egfr"]         = to_num(visits.get("egfr"))

if not events.empty:
    for c in ["center_code", "module", "patient_code"]:
        if c not in events.columns:
            events[c] = ""
    if "event_date" in events.columns:
        events["event_date"] = to_dt(events["event_date"]).dt.date

if not meds.empty:
    for c in ["drug_name", "drug_class", "start_date", "end_date"]:
        if c not in meds.columns:
            meds[c] = None
    meds["start_date"] = to_dt(meds.get("start_date")).dt.date
    meds["end_date"]   = to_dt(meds.get("end_date")).dt.date

# ---------------------------
# Derive baseline anchors
# ---------------------------

first_visit = (
    visits.dropna(subset=["visit_date"])
    .groupby(["center_code", "patient_code"], as_index=False)["visit_date"].min()
    .rename(columns={"visit_date": "first_visit_date"})
)

patients = patients.merge(first_visit, on=["center_code", "patient_code"], how="left")

def pick_baseline_date(row):
    if pd.notna(row.get("baseline_date")):
        return row["baseline_date"]
    return row.get("first_visit_date")

patients["baseline_anchor"] = patients.apply(pick_baseline_date, axis=1)

def compute_baseline_egfr(row):
    scr = row.get("baseline_scr")
    if pd.isna(scr):
        return np.nan
    scr_mg_dl = float(scr) / 88.4
    sex = row.get("sex")
    by  = row.get("birth_year")
    bd  = row.get("baseline_anchor")
    if pd.isna(by) or bd is None or pd.isna(bd):
        return np.nan
    age = int(pd.Timestamp(bd).year) - int(by)
    return ckdepi2021(scr_mg_dl, age, sex)

patients["baseline_egfr_calc"] = patients.apply(compute_baseline_egfr, axis=1)

first_visit_egfr = (
    visits.dropna(subset=["visit_date"])
    .sort_values("visit_date")
    .groupby(["center_code", "patient_code"], as_index=False)
    .first()[["center_code", "patient_code", "egfr", "upcr", "scr_umol_l", "visit_date"]]
    .rename(columns={
        "egfr":        "first_visit_egfr",
        "upcr":        "first_visit_upcr",
        "scr_umol_l":  "first_visit_scr_umol_l",
        "visit_date":  "first_visit_date2",
    })
)
patients = patients.merge(first_visit_egfr, on=["center_code", "patient_code"], how="left")

patients["baseline_egfr"] = patients["baseline_egfr_calc"]
patients.loc[patients["baseline_egfr"].isna(), "baseline_egfr"] = patients["first_visit_egfr"]

patients["baseline_upcr_final"] = patients["baseline_upcr"]
patients.loc[patients["baseline_upcr_final"].isna(), "baseline_upcr_final"] = patients["first_visit_upcr"]

def compute_age(row):
    by = row.get("birth_year")
    bd = row.get("baseline_anchor")
    if pd.isna(by) or bd is None or pd.isna(bd):
        return np.nan
    return int(pd.Timestamp(bd).year) - int(by)

patients["age_baseline"] = patients.apply(compute_age, axis=1)

# Merge key for visit timeline
anchor = patients[["center_code", "patient_code", "baseline_anchor",
                   "baseline_egfr", "baseline_upcr_final", "sex", "birth_year",
                   "module"]].copy()
anchor = anchor.dropna(subset=["baseline_anchor"])
anchor["baseline_anchor"] = pd.to_datetime(anchor["baseline_anchor"])

v2 = visits.dropna(subset=["visit_date"]).copy()
v2["visit_date"] = pd.to_datetime(v2["visit_date"])
v2 = v2.merge(anchor, on=["center_code", "patient_code"], how="inner", suffixes=("", "_b"))
v2["days_from_baseline"] = (v2["visit_date"] - v2["baseline_anchor"]).dt.days
v2["time_yr"] = v2["days_from_baseline"] / 365.25

# ---------------------------
# Table 1
# ---------------------------

n_patients = int(patients.shape[0])
n_visits   = int(visits.shape[0])
centers    = patients["center_code"].nunique()

female_n = int((patients["sex"].astype(str).str.upper() == "F").sum())
male_n   = int((patients["sex"].astype(str).str.upper() == "M").sum())

age_mean          = safe_mean(patients["age_baseline"])
age_med           = safe_median(patients["age_baseline"])
age_q1, age_q3   = safe_iqr(patients["age_baseline"])

egfr_mean          = safe_mean(patients["baseline_egfr"])
egfr_med           = safe_median(patients["baseline_egfr"])
egfr_q1, egfr_q3  = safe_iqr(patients["baseline_egfr"])

upcr_med          = safe_median(patients["baseline_upcr_final"])
upcr_q1, upcr_q3 = safe_iqr(patients["baseline_upcr_final"])

def fmt_f(v, d=1):
    return f"{v:.{d}f}" if np.isfinite(v) else ""

def fmt_sd(s, d=1):
    sd = s.std(skipna=True)
    return f"{sd:.{d}f}" if s.notna().sum() > 1 and np.isfinite(sd) else ""

table1_rows = [
    ["Patients, n",                            n_patients, ""],
    ["Centers, n",                             centers,    ""],
    ["Female, n (%)",                          female_n,   f"{pct(female_n, n_patients):.1f}%"],
    ["Male, n (%)",                            male_n,     f"{pct(male_n, n_patients):.1f}%"],
    ["Age at baseline, mean (SD)",             fmt_f(age_mean),
                                               fmt_sd(patients["age_baseline"])],
    ["Age at baseline, median (IQR)",          fmt_f(age_med),
                                               f"{fmt_f(age_q1)}–{fmt_f(age_q3)}"],
    ["Baseline eGFR (mL/min/1.73m²), mean (SD)", fmt_f(egfr_mean),
                                               fmt_sd(patients["baseline_egfr"])],
    ["Baseline eGFR, median (IQR)",            fmt_f(egfr_med),
                                               f"{fmt_f(egfr_q1)}–{fmt_f(egfr_q3)}"],
    ["Baseline UPCR, median (IQR)",            fmt_f(upcr_med, 2),
                                               f"{fmt_f(upcr_q1,2)}–{fmt_f(upcr_q3,2)}"],
]

# IgAN MEST-C
if {"oxford_m", "oxford_e", "oxford_s", "oxford_t", "oxford_c"}.issubset(patients.columns):
    for col, label in [("oxford_m","M"), ("oxford_e","E"), ("oxford_s","S"),
                       ("oxford_t","T"), ("oxford_c","C")]:
        vals = patients[col].dropna()
        if vals.empty:
            continue
        for vv in sorted(vals.unique()):
            n = int((patients[col] == vv).sum())
            table1_rows.append([f"Oxford {label}={int(vv)}, n (%)", n,
                                 f"{pct(n, n_patients):.1f}%"])

# ── Drug data (meds_long) in Table 1 ─────────────────────────────────────────
if not meds.empty and "drug_class" in meds.columns:
    # Patients who received any drug in meds_long
    pts_any_med = meds["patient_code"].nunique()
    table1_rows.append(["--- Medications (meds_long) ---", "", ""])
    table1_rows.append(["Patients with any medication recorded, n (%)",
                        pts_any_med, f"{pct(pts_any_med, n_patients):.1f}%"])

    # Count by drug_class (top 10 most common)
    cls_counts = (
        meds.dropna(subset=["drug_class"])
        .groupby("drug_class")["patient_code"]
        .nunique()
        .sort_values(ascending=False)
    )
    for cls_name, cnt in cls_counts.head(10).items():
        table1_rows.append([
            f"  {cls_name}, n (%)", int(cnt), f"{pct(int(cnt), n_patients):.1f}%"
        ])

    # Also count by drug_name if no class provided (top 10)
    if meds["drug_class"].isna().mean() > 0.5:
        name_counts = (
            meds.dropna(subset=["drug_name"])
            .groupby("drug_name")["patient_code"]
            .nunique()
            .sort_values(ascending=False)
        )
        for drug_name, cnt in name_counts.head(10).items():
            table1_rows.append([
                f"  {drug_name} (drug), n (%)", int(cnt), f"{pct(int(cnt), n_patients):.1f}%"
            ])

table1 = pd.DataFrame(table1_rows, columns=["Variable", "Value", "Notes"])

# ---------------------------
# QC
# ---------------------------

core_cols  = ["visit_date", "sbp", "scr_umol_l", "upcr"]
miss_rows  = []
for c in core_cols:
    miss = int(visits[c].isna().sum())
    miss_rows.append([c, miss, f"{pct(miss, n_visits):.1f}%"])
missingness = pd.DataFrame(miss_rows, columns=["Field", "Missing_n", "Missing_%"])

dup = (
    visits.dropna(subset=["visit_date"])
    .groupby(["center_code", "patient_code", "visit_date"], as_index=False)
    .size()
    .rename(columns={"size": "n"})
)
dup = dup[dup["n"] > 1].sort_values(["center_code", "patient_code", "visit_date"])

def flag_outliers(df: pd.DataFrame) -> pd.DataFrame:
    flags = []
    for _, r in df.iterrows():
        reasons = []
        sbp  = r.get("sbp");   dbp = r.get("dbp")
        scr  = r.get("scr_umol_l"); upcr = r.get("upcr")
        if pd.notna(sbp)  and (sbp  < 60  or sbp  > 250):  reasons.append("SBP_outlier")
        if pd.notna(dbp)  and (dbp  < 30  or dbp  > 150):  reasons.append("DBP_outlier")
        if pd.notna(scr)  and (scr  < 20  or scr  > 2000): reasons.append("Scr_outlier")
        if pd.notna(upcr) and (upcr < 0   or upcr > 20000):reasons.append("UPCR_outlier")
        if reasons:
            flags.append({
                "center_code":  r.get("center_code"),
                "patient_code": r.get("patient_code"),
                "visit_date":   r.get("visit_date"),
                "sbp": sbp, "dbp": dbp, "scr_umol_l": scr, "upcr": upcr,
                "reasons": ";".join(reasons),
            })
    return pd.DataFrame(flags)

outliers = flag_outliers(visits)

center_summary = (
    visits.groupby("center_code", as_index=False)
    .agg(
        visits_n=("patient_code",  "count"),
        patients_n=("patient_code", pd.Series.nunique),
        miss_sbp=("sbp",         lambda x: int(x.isna().sum())),
        miss_scr=("scr_umol_l",  lambda x: int(x.isna().sum())),
        miss_upcr=("upcr",       lambda x: int(x.isna().sum())),
    )
)
center_summary["miss_sbp_%"]  = center_summary["miss_sbp"]  / center_summary["visits_n"] * 100.0
center_summary["miss_scr_%"]  = center_summary["miss_scr"]  / center_summary["visits_n"] * 100.0
center_summary["miss_upcr_%"] = center_summary["miss_upcr"] / center_summary["visits_n"] * 100.0

# ---------------------------
# 12-month outcomes
# ---------------------------

win = v2[(v2["days_from_baseline"] >= 270) & (v2["days_from_baseline"] <= 450)].copy()
if not win.empty:
    win["abs_to_365"] = (win["days_from_baseline"] - 365).abs()
    pick = (
        win.sort_values(["center_code", "patient_code", "abs_to_365"])
        .groupby(["center_code", "patient_code"], as_index=False)
        .first()
    )
else:
    pick = pd.DataFrame(columns=["center_code", "patient_code"])

outcomes = anchor.merge(
    pick[["center_code", "patient_code", "visit_date", "days_from_baseline",
          "egfr", "upcr", "scr_umol_l"]] if not pick.empty else pick,
    on=["center_code", "patient_code"], how="left"
)
outcomes = outcomes.rename(columns={
    "baseline_anchor":       "baseline_date",
    "baseline_egfr":         "egfr_baseline",
    "baseline_upcr_final":   "upcr_baseline",
    "visit_date":            "visit_12m_date",
    "egfr":                  "egfr_12m",
    "upcr":                  "upcr_12m",
    "scr_umol_l":            "scr_12m_umol_l",
})
outcomes["egfr_delta"] = outcomes["egfr_12m"] - outcomes["egfr_baseline"]
outcomes["upcr_delta"] = outcomes["upcr_12m"] - outcomes["upcr_baseline"]

# ---------------------------
# eGFR DECLINE ENDPOINTS
# 40% decline: first visit where eGFR < baseline_egfr * 0.60
# 57% decline: first visit where eGFR < baseline_egfr * 0.43
# ---------------------------

def compute_egfr_decline_endpoints(v2_df: pd.DataFrame) -> pd.DataFrame:
    """
    Returns one row per patient with:
      - first_date_40pct, days_to_40pct, reached_40pct
      - first_date_57pct, days_to_57pct, reached_57pct
    Requires v2_df to have: center_code, patient_code, visit_date,
      days_from_baseline, egfr, baseline_egfr
    """
    records = []
    grp = v2_df.dropna(subset=["egfr", "baseline_egfr"]).copy()
    grp = grp[grp["baseline_egfr"] > 0]
    grp["pct_of_baseline"] = grp["egfr"] / grp["baseline_egfr"]
    grp = grp.sort_values(["center_code", "patient_code", "days_from_baseline"])

    for (cc, pc), sub in grp.groupby(["center_code", "patient_code"]):
        row = {"center_code": cc, "patient_code": pc}
        for thresh, label in [(0.60, "40pct"), (0.43, "57pct")]:
            hit = sub[sub["pct_of_baseline"] < thresh]
            if not hit.empty:
                first_hit = hit.iloc[0]
                row[f"reached_{label}"]    = True
                row[f"first_date_{label}"] = first_hit["visit_date"]
                row[f"days_to_{label}"]    = int(first_hit["days_from_baseline"])
            else:
                row[f"reached_{label}"]    = False
                row[f"first_date_{label}"] = pd.NaT
                row[f"days_to_{label}"]    = np.nan
        records.append(row)

    return pd.DataFrame(records) if records else pd.DataFrame(
        columns=["center_code", "patient_code",
                 "reached_40pct", "first_date_40pct", "days_to_40pct",
                 "reached_57pct", "first_date_57pct", "days_to_57pct"]
    )

egfr_endpoints = compute_egfr_decline_endpoints(v2)

# Merge manual events into endpoint table
if not events.empty:
    manual_events_wide = (
        events.pivot_table(
            index=["center_code", "patient_code"],
            columns="event_type",
            values="event_date",
            aggfunc="min"  # earliest event date per type
        )
        .reset_index()
    )
    # Rename columns to avoid conflict
    manual_events_wide.columns.name = None
    manual_events_wide = manual_events_wide.rename(columns={
        c: f"manual_{c}" for c in manual_events_wide.columns
        if c not in ("center_code", "patient_code")
    })
    egfr_endpoints = egfr_endpoints.merge(
        manual_events_wide, on=["center_code", "patient_code"], how="left"
    )

# Endpoint summary (n with event, pct)
n_with_40pct = int(egfr_endpoints["reached_40pct"].sum()) if "reached_40pct" in egfr_endpoints.columns else 0
n_with_57pct = int(egfr_endpoints["reached_57pct"].sum()) if "reached_57pct" in egfr_endpoints.columns else 0
n_ep_pts     = len(egfr_endpoints)

# ---------------------------
# IgAN REMISSION ENDPOINTS
# CR: UPCR < 300 at any visit (first occurrence)
# PR: UPCR reduced ≥50% from baseline AND UPCR < 1000 (first occurrence)
# ---------------------------

def compute_igan_remission(v2_df: pd.DataFrame) -> pd.DataFrame:
    """
    For IgAN-module patients only.
    Returns one row per patient with CR and PR flags and dates.
    """
    igan_visits = v2_df[v2_df["module"].astype(str).str.upper() == "IGAN"].copy()
    igan_visits = igan_visits.dropna(subset=["upcr"]).copy()
    igan_visits = igan_visits.sort_values(["center_code", "patient_code", "days_from_baseline"])

    records = []
    for (cc, pc), sub in igan_visits.groupby(["center_code", "patient_code"]):
        b_upcr = sub["baseline_upcr_final"].iloc[0] if "baseline_upcr_final" in sub.columns else np.nan
        row    = {"center_code": cc, "patient_code": pc}

        # Complete Remission: UPCR < 300 mg/g
        cr_hits = sub[sub["upcr"] < 300]
        row["reached_cr"]    = not cr_hits.empty
        row["first_date_cr"] = cr_hits.iloc[0]["visit_date"] if not cr_hits.empty else pd.NaT
        row["days_to_cr"]    = int(cr_hits.iloc[0]["days_from_baseline"]) if not cr_hits.empty else np.nan

        # Partial Remission: ≥50% reduction AND UPCR < 1000
        if pd.notna(b_upcr) and b_upcr > 0:
            pr_threshold = b_upcr * 0.50
            pr_hits = sub[(sub["upcr"] <= pr_threshold) & (sub["upcr"] < 1000)]
        else:
            pr_hits = pd.DataFrame()
        row["reached_pr"]    = not pr_hits.empty
        row["first_date_pr"] = pr_hits.iloc[0]["visit_date"] if not pr_hits.empty else pd.NaT
        row["days_to_pr"]    = int(pr_hits.iloc[0]["days_from_baseline"]) if not pr_hits.empty else np.nan

        records.append(row)

    return pd.DataFrame(records) if records else pd.DataFrame(
        columns=["center_code", "patient_code",
                 "reached_cr", "first_date_cr", "days_to_cr",
                 "reached_pr", "first_date_pr", "days_to_pr"]
    )

remission = compute_igan_remission(v2)

# Add remission counts to Table 1 (IgAN only)
n_igan_pts = int(patients[patients.get("module", pd.Series(dtype=str)).astype(str).str.upper() == "IGAN"].shape[0])
if not remission.empty:
    n_cr = int(remission["reached_cr"].sum())
    n_pr = int(remission["reached_pr"].sum())
    denom = max(n_igan_pts, 1)
    table1_rows_igan = [
        ["--- IgAN Remission Endpoints ---",                     "", ""],
        ["IgAN patients analyzed, n",                           n_igan_pts, ""],
        ["Complete remission (CR, UPCR<300), n (%)",            n_cr, f"{pct(n_cr, denom):.1f}%"],
        ["Partial remission (PR, ≥50% reduction+<1000), n (%)", n_pr, f"{pct(n_pr, denom):.1f}%"],
    ]
    table1 = pd.concat([table1, pd.DataFrame(table1_rows_igan, columns=["Variable","Value","Notes"])],
                        ignore_index=True)

# Add eGFR decline counts to Table 1
if n_ep_pts > 0:
    table1_ep = [
        ["--- eGFR Decline Endpoints (composite) ---", "", ""],
        ["Patients with evaluable eGFR (≥1 visit), n", n_ep_pts, ""],
        ["eGFR decline ≥40%, n (%)",                  n_with_40pct, f"{pct(n_with_40pct, n_ep_pts):.1f}%"],
        ["eGFR decline ≥57%, n (%)",                  n_with_57pct, f"{pct(n_with_57pct, n_ep_pts):.1f}%"],
    ]
    table1 = pd.concat([table1, pd.DataFrame(table1_ep, columns=["Variable","Value","Notes"])],
                        ignore_index=True)

# ---------------------------
# eGFR SLOPE — Linear Mixed-Effects (LME)
# Fixed: time_yr; Random: intercept per patient
# Fallback: individual OLS slopes if statsmodels unavailable
# ---------------------------

slope_results = []
per_patient_slopes = []

lme_data = v2.dropna(subset=["egfr", "time_yr"]).copy()
lme_data = lme_data[lme_data["time_yr"] >= 0]

if HAS_STATSMODELS and lme_data.shape[0] >= 10:
    try:
        lme_data["patient_id"] = lme_data["center_code"].astype(str) + "_" + lme_data["patient_code"].astype(str)
        n_pts_lme = lme_data["patient_id"].nunique()

        if n_pts_lme >= 5:
            model = smf.mixedlm(
                "egfr ~ time_yr",
                data=lme_data,
                groups=lme_data["patient_id"]
            )
            result = model.fit(reml=True, method="lbfgs")

            slope_est  = float(result.fe_params.get("time_yr", np.nan))
            slope_ci   = result.conf_int().loc["time_yr"].tolist() if "time_yr" in result.conf_int().index else [np.nan, np.nan]
            slope_pval = float(result.pvalues.get("time_yr", np.nan))

            slope_results = [{
                "method":               "LME (random intercept per patient)",
                "eGFR_slope_mL_yr":    f"{slope_est:.2f}",
                "95CI_lower":          f"{slope_ci[0]:.2f}",
                "95CI_upper":          f"{slope_ci[1]:.2f}",
                "p_value":             f"{slope_pval:.4f}",
                "n_patients":          n_pts_lme,
                "n_observations":      lme_data.shape[0],
                "note":               "eGFR slope in mL/min/1.73m²/year",
            }]
            print(f"✅ LME eGFR slope: {slope_est:.2f} mL/min/yr (95% CI {slope_ci[0]:.2f}–{slope_ci[1]:.2f}, p={slope_pval:.4f})")
        else:
            slope_results = [{"method": "LME skipped (< 5 patients)", "eGFR_slope_mL_yr": ""}]

    except Exception as e:
        slope_results = [{"method": f"LME error: {e}", "eGFR_slope_mL_yr": ""}]
else:
    if not HAS_STATSMODELS:
        print("⚠️  statsmodels not installed. Install with: pip install statsmodels")
        print("   Falling back to individual OLS slopes.")

# Individual OLS slope per patient (always computed; useful even without LME)
for (cc, pc), sub in lme_data.groupby(["center_code", "patient_code"]):
    sub = sub.dropna(subset=["egfr", "time_yr"])
    if sub.shape[0] < 2:
        continue
    x = sub["time_yr"].values
    y = sub["egfr"].values
    try:
        coef = np.polyfit(x, y, 1)
        per_patient_slopes.append({
            "center_code":       cc,
            "patient_code":      pc,
            "slope_mL_yr":       round(float(coef[0]), 3),
            "intercept_egfr":    round(float(coef[1]), 3),
            "n_visits_used":     int(sub.shape[0]),
            "follow_up_yr":      round(float(x.max() - x.min()), 2),
        })
    except Exception:
        continue

df_slopes = pd.DataFrame(per_patient_slopes)
df_lme    = pd.DataFrame(slope_results)

# ---------------------------
# Trend plots
# ---------------------------

def plot_trend(metric: str, filename: str, ylab: str):
    df = v2.dropna(subset=[metric, "days_from_baseline"]).copy()
    if df.empty:
        return
    df["month"] = (df["days_from_baseline"] / 30.4).round().astype(int)
    g = df.groupby("month")[metric].agg(["mean", "count", "std"]).reset_index()
    g["se"] = g["std"] / np.sqrt(g["count"].clip(lower=1))
    g = g.sort_values("month")

    plt.figure(figsize=(8, 4.5), dpi=140)
    plt.plot(g["month"], g["mean"])
    plt.fill_between(g["month"],
                     g["mean"] - 1.96 * g["se"],
                     g["mean"] + 1.96 * g["se"], alpha=0.2)
    plt.xlabel("Months from baseline")
    plt.ylabel(ylab)
    plt.title(f"{ylab} trend (mean ± 95% CI)")
    plt.grid(True, alpha=0.25)
    plt.tight_layout()
    plt.savefig(OUT / filename)
    plt.close()

plot_trend("egfr", "plot_egfr_trend.png",  "eGFR (mL/min/1.73m²)")
plot_trend("upcr", "plot_upcr_trend.png",  "UPCR")

# eGFR slope histogram (individual OLS)
if not df_slopes.empty and df_slopes["slope_mL_yr"].notna().sum() > 1:
    plt.figure(figsize=(7, 4), dpi=140)
    plt.hist(df_slopes["slope_mL_yr"].dropna(), bins=20, edgecolor="white", color="#2563eb", alpha=0.85)
    plt.axvline(0, color="black", linestyle="--", linewidth=0.8)
    plt.xlabel("Individual eGFR slope (mL/min/1.73m²/year, OLS)")
    plt.ylabel("Patients")
    plt.title("Distribution of individual eGFR slopes")
    plt.tight_layout()
    plt.savefig(OUT / "plot_egfr_slope_hist.png")
    plt.close()

# ---------------------------
# Write outputs
# ---------------------------

write_excel(OUT / "table1_baseline.xlsx", {"Table1": table1})

write_excel(OUT / "qc_report.xlsx", {
    "Missingness":   missingness,
    "Duplicates":    dup,
    "Outliers":      outliers,
    "CenterSummary": center_summary,
})

outcomes.to_csv(OUT / "outcomes_12m.csv", index=False, encoding="utf-8-sig")

# eGFR endpoints (40% / 57% decline)
egfr_endpoints.to_csv(OUT / "endpoints_egfr_decline.csv", index=False, encoding="utf-8-sig")

# IgAN remission endpoints
if not remission.empty:
    remission.to_csv(OUT / "endpoints_igan_remission.csv", index=False, encoding="utf-8-sig")

# eGFR slope
if not df_lme.empty:
    df_lme.to_csv(OUT / "egfr_slope_lme.csv", index=False, encoding="utf-8-sig")
if not df_slopes.empty:
    df_slopes.to_csv(OUT / "egfr_slope_per_patient.csv", index=False, encoding="utf-8-sig")

# Run log
generated = [
    "table1_baseline.xlsx",
    "qc_report.xlsx",
    "outcomes_12m.csv",
    "endpoints_egfr_decline.csv",
    "plot_egfr_trend.png",
    "plot_upcr_trend.png",
]
if not remission.empty:   generated.append("endpoints_igan_remission.csv")
if not df_lme.empty:      generated.append("egfr_slope_lme.csv")
if not df_slopes.empty:   generated.append("egfr_slope_per_patient.csv")
if (OUT / "plot_egfr_slope_hist.png").exists(): generated.append("plot_egfr_slope_hist.png")

log = {
    "patients_n":       n_patients,
    "visits_n":         n_visits,
    "centers_n":        int(centers),
    "egfr_endpoints":   {"n_40pct": n_with_40pct, "n_57pct": n_with_57pct},
    "statsmodels_used": HAS_STATSMODELS,
    "generated_files":  generated,
}
(OUT / "RUN_LOG.json").write_text(json.dumps(log, indent=2), encoding="utf-8")

print("✅ Done.")
print(f"- Table1:            {OUT / 'table1_baseline.xlsx'}")
print(f"- QC:                {OUT / 'qc_report.xlsx'}")
print(f"- 12m outcomes:      {OUT / 'outcomes_12m.csv'}")
print(f"- eGFR decline:      {OUT / 'endpoints_egfr_decline.csv'}")
if not remission.empty:
    print(f"- IgAN remission:    {OUT / 'endpoints_igan_remission.csv'}")
if not df_lme.empty:
    print(f"- eGFR slope (LME): {OUT / 'egfr_slope_lme.csv'}")
if not df_slopes.empty:
    print(f"- eGFR slope/pt:    {OUT / 'egfr_slope_per_patient.csv'}")
