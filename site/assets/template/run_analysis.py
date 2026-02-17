"""
KidneySphere AI — Paper Pack Analysis (Starter Kit)

This script:
- reads de-identified long tables from analysis/data/
- produces Table 1, QC report, trend plots, and 12-month outcomes
- writes outputs into analysis/outputs/

Notes:
- This is a starter kit for research workflows.
- PI must review outputs and Methods draft before submission.
- This script does NOT provide clinical decision support.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import json
import math
import warnings

import numpy as np
import pandas as pd
import matplotlib.pyplot as plt

warnings.filterwarnings("ignore", category=FutureWarning)

BASE = Path(__file__).resolve().parent
DATA = BASE / "data"
OUT = BASE / "outputs"
OUT.mkdir(parents=True, exist_ok=True)

# ---------------------------
# Helpers
# ---------------------------

def read_csv(name: str) -> pd.DataFrame:
    path = DATA / name
    if not path.exists():
        raise FileNotFoundError(f"Missing file: {path}. Please check analysis/data/ structure.")
    # UTF-8 BOM is supported by pandas with utf-8-sig
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
visits = read_csv("visits_long.csv")
labs = read_csv("labs_long.csv")
meds = read_csv("meds_long.csv")
vars_ = read_csv("variants_long.csv")

# Normalize columns
for df in [patients, visits, labs, meds, vars_]:
    for c in ["center_code", "module", "patient_code"]:
        if c not in df.columns:
            raise ValueError(f"Required column missing: {c}")

patients["birth_year"] = to_num(patients.get("birth_year"))
patients["baseline_date"] = to_dt(patients.get("baseline_date")).dt.date
patients["baseline_scr"] = to_num(patients.get("baseline_scr"))
patients["baseline_upcr"] = to_num(patients.get("baseline_upcr"))

for c in ["oxford_m","oxford_e","oxford_s","oxford_t","oxford_c"]:
    if c in patients.columns:
        patients[c] = to_num(patients[c])

visits["visit_date"] = to_dt(visits.get("visit_date")).dt.date
visits["sbp"] = to_num(visits.get("sbp"))
visits["dbp"] = to_num(visits.get("dbp"))
visits["scr_umol_l"] = to_num(visits.get("scr_umol_l"))
visits["upcr"] = to_num(visits.get("upcr"))
visits["egfr"] = to_num(visits.get("egfr"))

# ---------------------------
# Derive baseline anchors
# ---------------------------

# first visit date per patient (fallback baseline)
first_visit = (visits.dropna(subset=["visit_date"])
               .groupby(["center_code","patient_code"], as_index=False)["visit_date"].min()
               .rename(columns={"visit_date":"first_visit_date"}))

patients = patients.merge(first_visit, on=["center_code","patient_code"], how="left")

def pick_baseline_date(row):
    if pd.notna(row.get("baseline_date")):
        return row["baseline_date"]
    return row.get("first_visit_date")

patients["baseline_anchor"] = patients.apply(pick_baseline_date, axis=1)

# compute baseline eGFR if possible
def compute_baseline_egfr(row):
    scr = row.get("baseline_scr")
    if pd.isna(scr):
        return np.nan
    scr_mg_dl = float(scr) / 88.4  # μmol/L -> mg/dL
    sex = row.get("sex")
    by = row.get("birth_year")
    bd = row.get("baseline_anchor")
    if pd.isna(by) or bd is None or pd.isna(bd):
        return np.nan
    age = int(pd.Timestamp(bd).year) - int(by)
    return ckdepi2021(scr_mg_dl, age, sex)

patients["baseline_egfr_calc"] = patients.apply(compute_baseline_egfr, axis=1)

# if missing baseline egfr, use first visit egfr
first_visit_egfr = (visits.dropna(subset=["visit_date"])
                    .sort_values("visit_date")
                    .groupby(["center_code","patient_code"], as_index=False)
                    .first()[["center_code","patient_code","egfr","upcr","scr_umol_l","visit_date"]]
                    .rename(columns={
                        "egfr":"first_visit_egfr",
                        "upcr":"first_visit_upcr",
                        "scr_umol_l":"first_visit_scr_umol_l",
                        "visit_date":"first_visit_date2"
                    }))
patients = patients.merge(first_visit_egfr, on=["center_code","patient_code"], how="left")

patients["baseline_egfr"] = patients["baseline_egfr_calc"]
patients.loc[patients["baseline_egfr"].isna(), "baseline_egfr"] = patients["first_visit_egfr"]

patients["baseline_upcr_final"] = patients["baseline_upcr"]
patients.loc[patients["baseline_upcr_final"].isna(), "baseline_upcr_final"] = patients["first_visit_upcr"]

# Age at baseline
def compute_age(row):
    by = row.get("birth_year")
    bd = row.get("baseline_anchor")
    if pd.isna(by) or bd is None or pd.isna(bd):
        return np.nan
    return int(pd.Timestamp(bd).year) - int(by)

patients["age_baseline"] = patients.apply(compute_age, axis=1)

# ---------------------------
# Table 1
# ---------------------------

n_patients = int(patients.shape[0])
n_visits = int(visits.shape[0])
centers = patients["center_code"].nunique()

female_n = int((patients["sex"].astype(str).str.upper() == "F").sum())
male_n = int((patients["sex"].astype(str).str.upper() == "M").sum())

age_mean = safe_mean(patients["age_baseline"])
age_med = safe_median(patients["age_baseline"])
age_q1, age_q3 = safe_iqr(patients["age_baseline"])

egfr_mean = safe_mean(patients["baseline_egfr"])
egfr_med = safe_median(patients["baseline_egfr"])
egfr_q1, egfr_q3 = safe_iqr(patients["baseline_egfr"])

upcr_med = safe_median(patients["baseline_upcr_final"])
upcr_q1, upcr_q3 = safe_iqr(patients["baseline_upcr_final"])

table1_rows = [
    ["Patients, n", n_patients, ""],
    ["Centers, n", centers, ""],
    ["Female, n (%)", female_n, f"{pct(female_n, n_patients):.1f}%"],
    ["Male, n (%)", male_n, f"{pct(male_n, n_patients):.1f}%"],
    ["Age at baseline, mean (SD)", f"{age_mean:.1f}" if np.isfinite(age_mean) else "", f"{patients['age_baseline'].std(skipna=True):.1f}" if patients["age_baseline"].notna().sum()>1 else ""],
    ["Age at baseline, median (IQR)", f"{age_med:.1f}" if np.isfinite(age_med) else "", f"{age_q1:.1f}–{age_q3:.1f}" if np.isfinite(age_q1) else ""],
    ["Baseline eGFR (mL/min/1.73m²), mean (SD)", f"{egfr_mean:.1f}" if np.isfinite(egfr_mean) else "", f"{patients['baseline_egfr'].std(skipna=True):.1f}" if patients["baseline_egfr"].notna().sum()>1 else ""],
    ["Baseline eGFR, median (IQR)", f"{egfr_med:.1f}" if np.isfinite(egfr_med) else "", f"{egfr_q1:.1f}–{egfr_q3:.1f}" if np.isfinite(egfr_q1) else ""],
    ["Baseline UPCR, median (IQR)", f"{upcr_med:.2f}" if np.isfinite(upcr_med) else "", f"{upcr_q1:.2f}–{upcr_q3:.2f}" if np.isfinite(upcr_q1) else ""],
]

# IgAN MEST-C distribution if present
if set(["oxford_m","oxford_e","oxford_s","oxford_t","oxford_c"]).issubset(set(patients.columns)):
    for col, label in [("oxford_m","M"),("oxford_e","E"),("oxford_s","S"),("oxford_t","T"),("oxford_c","C")]:
        vals = patients[col].dropna()
        if vals.empty:
            continue
        for v in sorted(vals.unique()):
            n = int((patients[col] == v).sum())
            table1_rows.append([f"Oxford {label}={int(v)} , n (%)", n, f"{pct(n, n_patients):.1f}%"])

table1 = pd.DataFrame(table1_rows, columns=["Variable","Value","Notes"])

# ---------------------------
# QC
# ---------------------------

# Missingness for core variables in visits
core_cols = ["visit_date","sbp","scr_umol_l","upcr"]
miss_rows = []
for c in core_cols:
    miss = int(visits[c].isna().sum())
    miss_rows.append([c, miss, f"{pct(miss, n_visits):.1f}%"])
missingness = pd.DataFrame(miss_rows, columns=["Field","Missing_n","Missing_%"])

# Duplicates: same center + patient + date
dup = (visits.dropna(subset=["visit_date"])
       .groupby(["center_code","patient_code","visit_date"], as_index=False)
       .size()
       .rename(columns={"size":"n"}))
dup = dup[dup["n"] > 1].sort_values(["center_code","patient_code","visit_date"])

# Outliers (simple rule-based)
def flag_outliers(df: pd.DataFrame) -> pd.DataFrame:
    flags = []
    for _, r in df.iterrows():
        reasons = []
        sbp = r.get("sbp")
        dbp = r.get("dbp")
        scr = r.get("scr_umol_l")
        upcr = r.get("upcr")
        if pd.notna(sbp) and (sbp < 60 or sbp > 250): reasons.append("SBP_outlier")
        if pd.notna(dbp) and (dbp < 30 or dbp > 150): reasons.append("DBP_outlier")
        if pd.notna(scr) and (scr < 20 or scr > 2000): reasons.append("Scr_outlier")
        if pd.notna(upcr) and (upcr < 0 or upcr > 20000): reasons.append("UPCR_outlier")
        if reasons:
            flags.append({
                "center_code": r.get("center_code"),
                "patient_code": r.get("patient_code"),
                "visit_date": r.get("visit_date"),
                "sbp": sbp,
                "dbp": dbp,
                "scr_umol_l": scr,
                "upcr": upcr,
                "reasons": ";".join(reasons)
            })
    return pd.DataFrame(flags)

outliers = flag_outliers(visits)

# Center summary
center_summary = (visits.groupby("center_code", as_index=False)
                  .agg(
                      visits_n=("patient_code","count"),
                      patients_n=("patient_code", pd.Series.nunique),
                      miss_sbp=("sbp", lambda x: int(x.isna().sum())),
                      miss_scr=("scr_umol_l", lambda x: int(x.isna().sum())),
                      miss_upcr=("upcr", lambda x: int(x.isna().sum()))
                  ))
center_summary["miss_sbp_%"] = center_summary["miss_sbp"] / center_summary["visits_n"] * 100.0
center_summary["miss_scr_%"] = center_summary["miss_scr"] / center_summary["visits_n"] * 100.0
center_summary["miss_upcr_%"] = center_summary["miss_upcr"] / center_summary["visits_n"] * 100.0

# ---------------------------
# 12-month outcomes
# ---------------------------

# Prepare baseline anchor per patient
anchor = patients[["center_code","patient_code","baseline_anchor","baseline_egfr","baseline_upcr_final"]].copy()
anchor = anchor.dropna(subset=["baseline_anchor"])
anchor["baseline_anchor"] = pd.to_datetime(anchor["baseline_anchor"])

v2 = visits.dropna(subset=["visit_date"]).copy()
v2["visit_date"] = pd.to_datetime(v2["visit_date"])

v2 = v2.merge(anchor, on=["center_code","patient_code"], how="inner", suffixes=("","_b"))
v2["days_from_baseline"] = (v2["visit_date"] - v2["baseline_anchor"]).dt.days

# 12m window: 270–450 days
win = v2[(v2["days_from_baseline"] >= 270) & (v2["days_from_baseline"] <= 450)].copy()
if not win.empty:
    win["abs_to_365"] = (win["days_from_baseline"] - 365).abs()
    pick = (win.sort_values(["center_code","patient_code","abs_to_365"])
              .groupby(["center_code","patient_code"], as_index=False)
              .first())
else:
    pick = pd.DataFrame(columns=["center_code","patient_code"])

outcomes = anchor.merge(pick[["center_code","patient_code","visit_date","days_from_baseline","egfr","upcr","scr_umol_l"]]
                        if not pick.empty else pick,
                        on=["center_code","patient_code"], how="left")

outcomes = outcomes.rename(columns={
    "baseline_anchor":"baseline_date",
    "baseline_egfr":"egfr_baseline",
    "baseline_upcr_final":"upcr_baseline",
    "visit_date":"visit_12m_date",
    "egfr":"egfr_12m",
    "upcr":"upcr_12m",
    "scr_umol_l":"scr_12m_umol_l"
})

outcomes["egfr_delta"] = outcomes["egfr_12m"] - outcomes["egfr_baseline"]
outcomes["upcr_delta"] = outcomes["upcr_12m"] - outcomes["upcr_baseline"]

# ---------------------------
# Trend plots (simple mean by month)
# ---------------------------

def plot_trend(metric: str, filename: str, ylab: str):
    df = v2.dropna(subset=[metric, "days_from_baseline"]).copy()
    if df.empty:
        return
    df["month"] = (df["days_from_baseline"] / 30.4).round().astype(int)
    g = df.groupby("month")[metric].agg(["mean","count","std"]).reset_index()
    g["se"] = g["std"] / np.sqrt(g["count"].clip(lower=1))
    g = g.sort_values("month")

    plt.figure(figsize=(8,4.5), dpi=140)
    plt.plot(g["month"], g["mean"])
    plt.fill_between(g["month"], g["mean"] - 1.96*g["se"], g["mean"] + 1.96*g["se"], alpha=0.2)
    plt.xlabel("Months from baseline")
    plt.ylabel(ylab)
    plt.title(f"{ylab} trend (mean ± 95% CI)")
    plt.grid(True, alpha=0.25)
    plt.tight_layout()
    plt.savefig(OUT / filename)
    plt.close()

plot_trend("egfr", "plot_egfr_trend.png", "eGFR (mL/min/1.73m²)")
plot_trend("upcr", "plot_upcr_trend.png", "UPCR")

# ---------------------------
# Write outputs
# ---------------------------

write_excel(OUT / "table1_baseline.xlsx", {"Table1": table1})
write_excel(OUT / "qc_report.xlsx", {
    "Missingness": missingness,
    "Duplicates": dup,
    "Outliers": outliers,
    "CenterSummary": center_summary
})
outcomes.to_csv(OUT / "outcomes_12m.csv", index=False, encoding="utf-8-sig")

# Write a small run log
log = {
    "patients_n": n_patients,
    "visits_n": n_visits,
    "centers_n": int(centers),
    "generated_files": [
        "table1_baseline.xlsx",
        "qc_report.xlsx",
        "outcomes_12m.csv",
        "plot_egfr_trend.png",
        "plot_upcr_trend.png"
    ]
}
(OUT / "RUN_LOG.json").write_text(json.dumps(log, indent=2), encoding="utf-8")

print("✅ Done.")
print(f"- Table1: {OUT/'table1_baseline.xlsx'}")
print(f"- QC:     {OUT/'qc_report.xlsx'}")
print(f"- 12m:    {OUT/'outcomes_12m.csv'}")
print(f"- Plots:  {OUT/'plot_egfr_trend.png'}, {OUT/'plot_upcr_trend.png'}")
