"""KidneySphere reproducible descriptive analysis (integrity-v1).

No database/network access. Strict project/record identity; original CSVs are never
changed. Candidate thresholds are descriptive checks, not adjudicated endpoints.
KFRE and cohort inferential models remain disabled pending protocol validation.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import importlib.metadata
import json
import math
import os
import re
from pathlib import Path
import shutil
import tempfile
from datetime import datetime, timezone

import numpy as np
import pandas as pd

VERSION = "integrity-v1"
BASE = Path(__file__).resolve().parent
KEY = ["project_id", "center_code", "patient_code"]
TABLE_COLUMNS = {
    "patients_baseline": KEY + ["id", "module", "sex", "birth_year", "baseline_date", "baseline_scr", "baseline_upcr", "baseline_upcr_unit"],
    "visits_long": KEY + ["id", "module", "visit_date", "sbp", "dbp", "scr_umol_l", "upcr", "egfr", "egfr_formula_version"],
    "labs_long": KEY + ["id", "module", "lab_date", "lab_test_code", "lab_name", "lab_value", "lab_unit", "value_raw", "unit_symbol", "value_standard", "standard_unit", "measured_at"],
    "meds_long": KEY + ["id", "module", "drug_name", "drug_class", "dose", "route", "frequency", "start_date", "end_date"],
    "variants_long": KEY + ["id", "module", "test_date", "gene", "variant", "hgvs_c", "hgvs_p"],
    "events_long": KEY + ["id", "module", "event_type", "event_date", "confirmed", "source"],
}
EGFR_REFERENCE = "https://escholarship.org/content/qt3gj2d8m2/qt3gj2d8m2.pdf"


class DataContractError(ValueError):
    """Input is ambiguous; do not emit an apparently successful analysis."""


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def number(value):
    try:
        result = float(value)
        return result if math.isfinite(result) else np.nan
    except (TypeError, ValueError):
        return np.nan


def date(value):
    if value is None or pd.isna(value) or not str(value).strip():
        return pd.NaT
    # Registry dates are ISO calendar dates. Do not guess locale/day-month order.
    if not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", str(value)):
        return pd.NaT
    try:
        return pd.Timestamp(datetime.strptime(str(value), "%Y-%m-%d"))
    except ValueError:
        return pd.NaT


def ckdepi2021(scr_mg_dl, age, sex):
    """Adult creatinine equation: Inker 2021 Table 2; age here is year-derived.

    Missing/unknown sex, nonpositive creatinine, or age outside 18..120 => NaN.
    This does not validate suitability for an individual clinical application.
    """
    scr, age = number(scr_mg_dl), number(age)
    sx = str(sex).strip().upper()
    if not (np.isfinite(scr) and scr > 0 and np.isfinite(age) and 18 <= age <= 120 and sx in {"M", "F"}):
        return np.nan
    k, alpha = (0.7, -0.241) if sx == "F" else (0.9, -0.302)
    return 142 * min(scr/k, 1)**alpha * max(scr/k, 1)**-1.200 * 0.9938**age * (1.012 if sx == "F" else 1)


def issue(issues, table, row, code, detail):
    issues.append({"table": table, **{k: row.get(k, "") for k in KEY}, "record_id": row.get("id", ""), "code": code, "detail": detail})


def read_table(path, table, required=False, allow_duplicates=False):
    """No numeric inference for identifiers; even 'NA' is a literal identifier."""
    path = Path(path)
    if not path.exists():
        if required:
            raise DataContractError(f"Missing required {path.name}")
        return pd.DataFrame(columns=TABLE_COLUMNS[table])
    with path.open(encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        fields = reader.fieldnames
        if not fields or len(fields) != len(set(fields)):
            raise DataContractError(f"{path.name}: missing or duplicate CSV header")
        rows = list(reader)
    if any(None in r or any(v is None for v in r.values()) for r in rows):
        raise DataContractError(f"{path.name}: malformed CSV row width")
    df = pd.DataFrame(rows, columns=fields, dtype=object)
    if not df.empty:
        missing = set(KEY + ["id", "module"]) - set(df.columns)
        if missing:
            raise DataContractError(f"{path.name}: missing identity columns {sorted(missing)}; re-export using the updated registry. Never infer project identity.")
        for col in KEY + ["id", "module"]:
            if df[col].map(lambda v: not v or v != v.strip()).any():
                raise DataContractError(f"{path.name}: blank or surrounding whitespace in {col}; correct source explicitly")
        if not allow_duplicates and df.duplicated(["project_id", "id"]).any():
            raise DataContractError(f"{path.name}: duplicate record IDs; resolve or merge exact retransmissions first")
        if not allow_duplicates and table == "patients_baseline" and df.duplicated(KEY).any():
            raise DataContractError("patients_baseline.csv: multiple baselines for one project/center/patient")
    for col in TABLE_COLUMNS[table]:
        if col not in df:
            df[col] = ""
    return df


def load_tables(data_dir):
    frames = {t: read_table(Path(data_dir)/f"{t}.csv", t, t in {"patients_baseline", "visits_long"}) for t in TABLE_COLUMNS}
    baseline = frames["patients_baseline"]
    identity = {tuple(r[k] for k in KEY): r["module"] for r in baseline.to_dict("records")}
    # A project/center must be mapped consistently to the same study module.
    if not baseline.empty and (baseline.groupby(["project_id", "center_code"])["module"].nunique() > 1).any():
        raise DataContractError("One project/center has conflicting disease modules")
    for table, df in frames.items():
        if table == "patients_baseline":
            continue
        for r in df.to_dict("records"):
            key = tuple(r[k] for k in KEY)
            if key not in identity:
                raise DataContractError(f"{table}: orphan record {r['id']}; no matching project/center/patient baseline")
            if r["module"] != identity[key]:
                raise DataContractError(f"{table}: module differs from patient baseline for record {r['id']}")
    return frames


def upcr_mg_g(value, unit):
    n = number(value)
    converted = n * {"mg/g": 1, "g/g": 1000}.get(str(unit), np.nan) if np.isfinite(n) and n >= 0 else np.nan
    return converted if np.isfinite(converted) else np.nan


def derive(frames, issues):
    patients = frames["patients_baseline"].copy()
    for c in ["baseline_anchor", "age_baseline", "baseline_egfr", "baseline_upcr_final"]:
        patients[c] = pd.Series(index=patients.index, dtype=object)
    for idx, r in patients.iterrows():
        anchor = date(r["baseline_date"])
        by = number(r["birth_year"])
        age = anchor.year - by if pd.notna(anchor) and np.isfinite(by) and by.is_integer() else np.nan
        if np.isfinite(age) and not 0 <= age <= 120:
            issue(issues, "patients_baseline", r, "invalid_baseline_age", "Impossible year-derived age excluded from age summaries")
            age = np.nan
        patients.at[idx, "baseline_anchor"] = anchor
        patients.at[idx, "age_baseline"] = age
        patients.at[idx, "baseline_egfr"] = ckdepi2021(number(r["baseline_scr"])/88.4, age, r["sex"])
        if not np.isfinite(patients.at[idx, "baseline_egfr"]):
            issue(issues, "patients_baseline", r, "baseline_egfr_not_evaluable", "Requires positive creatinine, valid baseline date, M/F sex, and adult year-derived age; no later-visit substitution")
        patients.at[idx, "baseline_upcr_final"] = upcr_mg_g(r["baseline_upcr"], r["baseline_upcr_unit"])
        if pd.isna(anchor):
            issue(issues, "patients_baseline", r, "missing_or_invalid_baseline_date", "No first-visit substitution; anchored outcomes not evaluable")
        if r["baseline_upcr"] and not np.isfinite(patients.at[idx, "baseline_upcr_final"]):
            issue(issues, "patients_baseline", r, "unverified_baseline_upcr", "UPCR excluded from change/ratio calculations until its original unit and value are verified")
        if str(r["sex"]).upper() not in {"M", "F"}:
            issue(issues, "patients_baseline", r, "sex_missing_or_unknown", "No sex-specific eGFR calculation; unknown is not male")
    v = frames["visits_long"].copy()
    v["egfr_recorded"] = v["egfr"]
    v["visit_date_raw"] = v["visit_date"]
    v["visit_date"] = v["visit_date"].map(date)
    for col in ["sbp", "dbp", "scr_umol_l", "upcr"]:
        raw = v[col].copy()
        v[col] = raw.map(number)
        for idx in raw.index:
            if raw[idx] and not np.isfinite(v.at[idx, col]):
                issue(issues, "visits_long", v.loc[idx], "invalid_numeric", col)
            if np.isfinite(v.at[idx, col]) and v.at[idx, col] < 0:
                issue(issues, "visits_long", v.loc[idx], "negative_measurement", col)
                v.at[idx, col] = np.nan
    v = v.merge(patients[KEY + ["baseline_anchor", "baseline_egfr", "baseline_upcr_final", "sex", "birth_year"]], on=KEY, how="left", validate="many_to_one")
    v["baseline_anchor"] = pd.to_datetime(v["baseline_anchor"])
    v["visit_date"] = pd.to_datetime(v["visit_date"])
    v["days_from_baseline"] = (v["visit_date"]-v["baseline_anchor"]).dt.days
    v["time_yr"] = v["days_from_baseline"] / 365.25
    v["egfr"] = np.nan
    v["egfr_analysis_source"] = "not_evaluable"
    for idx, r in v.iterrows():
        if pd.notna(r["days_from_baseline"]) and r["days_from_baseline"] < 0:
            issue(issues, "visits_long", r, "visit_before_baseline", "Excluded from post-baseline outcomes, slopes and trends")
        if pd.isna(r["visit_date"]):
            issue(issues, "visits_long", r, "missing_or_invalid_visit_date", "Excluded from dated outcomes")
        recorded = number(r["egfr_recorded"])
        version = r["egfr_formula_version"]
        if version == "manual" and np.isfinite(recorded) and recorded > 0:
            v.at[idx, "egfr"] = recorded
            v.at[idx, "egfr_analysis_source"] = "recorded_manual"
        elif version == "CKD-EPI-2021-Cr":
            by = number(r["birth_year"])
            age = r["visit_date"].year-by if pd.notna(r["visit_date"]) and np.isfinite(by) and by.is_integer() else np.nan
            calculated = ckdepi2021(r["scr_umol_l"]/88.4, age, r["sex"])
            v.at[idx, "egfr"] = calculated
            if not np.isfinite(calculated):
                issue(issues, "visits_long", r, "egfr_inputs_unavailable", "Current creatinine/date/sex/adult age cannot support recalculation")
            if np.isfinite(calculated):
                v.at[idx, "egfr_analysis_source"] = "recomputed_CKD-EPI-2021-Cr_year_age"
                if np.isfinite(recorded) and abs(calculated-recorded) > 0.11:
                    issue(issues, "visits_long", r, "stored_egfr_mismatch", "Analysis recomputed from current creatinine/demographics; original retained in egfr_recorded")
        elif np.isfinite(recorded):
            issue(issues, "visits_long", r, "egfr_source_unverified", "Value retained as egfr_recorded, excluded from derived analysis until source is verified")
    return patients, v


# Explicit per-row conversions; no inference from magnitude or cohort distribution.
LAB_UNITS = {
    "ALB": ("g/dL", {"g/dL": 1, "g/L": 0.1}),
    "CREAT": ("mg/dL", {"mg/dL": 1, "μmol/L": 1/88.4, "umol/L": 1/88.4}),
    "UPCR": ("mg/g", {"mg/g": 1, "g/g": 1000}),
    "UACR": ("mg/g", {"mg/g": 1}),
    "PHOS": ("mg/dL", {"mg/dL": 1, "mmol/L": 3.097}),
    "CA": ("mg/dL", {"mg/dL": 1, "mmol/L": 4.008}),
    "CO2": ("mmol/L", {"mmol/L": 1, "mEq/L": 1}),
    "CD19": ("cells/μL", {"cells/μL": 1}),
    "BKV": ("copies/mL", {"copies/mL": 1}),
    "CMV": ("IU/mL", {"IU/mL": 1}),
}


def normalize_labs(df, issues):
    out = df.copy()
    out["analysis_value"] = np.nan
    out["analysis_unit"] = ""
    out["analysis_status"] = "unverified"
    for idx, r in out.iterrows():
        code = r["lab_test_code"]
        has_raw = r["value_raw"] != ""
        has_unit = r["unit_symbol"] != ""
        if has_raw != has_unit:
            issue(issues, "labs_long", r, "incomplete_raw_unit_pair", "Partial structured value/unit; never mix with a legacy value/unit pair")
            continue
        if has_raw:
            raw, unit = number(r["value_raw"]), r["unit_symbol"]
        else:
            raw, unit = number(r["lab_value"]), r["lab_unit"]
        std, su = number(r["value_standard"]), r["standard_unit"]
        if (r["value_standard"] != "" and not np.isfinite(std)) or ((r["value_standard"] != "") != (su != "")):
            issue(issues, "labs_long", r, "invalid_standard_value_unit_pair", "Stored standard value/unit is malformed or partial; excluded pending correction")
            continue
        target, factors = LAB_UNITS.get(code, (su, {su: 1} if su else {}))
        if not np.isfinite(raw) or raw < 0 or unit not in factors:
            issue(issues, "labs_long", r, "lab_conversion_unverified", "Original value/unit retained; no guessed standard value")
            continue
        expected = raw*factors[unit]
        if not np.isfinite(expected):
            issue(issues, "labs_long", r, "converted_value_nonfinite", "Unit conversion overflow; no usable analysis value")
            continue
        if np.isfinite(std):
            if su not in factors or not math.isclose(std*factors[su], expected, rel_tol=0.001, abs_tol=0.001):
                issue(issues, "labs_long", r, "lab_standard_mismatch", "Stored standard value/unit conflicts with original; excluded pending correction")
                continue
        out.at[idx, "analysis_value"] = expected
        out.at[idx, "analysis_unit"] = target
        out.at[idx, "analysis_status"] = "explicit_unit_conversion"
    return out


def choose_12month(patients, visits):
    rows = []
    for r in patients.to_dict("records"):
        sub = visits
        for k in KEY:
            sub = sub[sub[k] == r[k]]
        sub = sub[sub.days_from_baseline.between(270, 450)].copy()
        result = {k: r[k] for k in KEY}
        result.update(baseline_record_id=r["id"], baseline_date=r["baseline_anchor"], egfr_baseline=r["baseline_egfr"], upcr_baseline=r["baseline_upcr_final"], status="no_evaluable_annual_visit", visit_id="", visit_12m_date=pd.NaT, days_from_baseline=np.nan, egfr_12m=np.nan, upcr_12m=np.nan, scr_12m_umol_l=np.nan, egfr_delta=np.nan, upcr_delta=np.nan, tie_count=0)
        if pd.isna(r["baseline_anchor"]):
            result["status"] = "baseline_date_unavailable"
        elif not sub.empty:
            sub["distance"] = (sub.days_from_baseline-365).abs()
            sub = sub.sort_values(["distance", "visit_date", "id"], kind="stable")
            picked = sub.iloc[0]  # One entire row; missing values stay missing.
            result.update(status="visit_selected", visit_id=picked["id"], visit_12m_date=picked.visit_date, days_from_baseline=picked.days_from_baseline, egfr_12m=picked.egfr, upcr_12m=picked.upcr, scr_12m_umol_l=picked.scr_umol_l, egfr_delta=picked.egfr-number(r["baseline_egfr"]), upcr_delta=picked.upcr-number(r["baseline_upcr_final"]), tie_count=int((sub.distance == picked.distance).sum()))
        rows.append(result)
    return pd.DataFrame(rows, columns=KEY + ["baseline_record_id", "baseline_date", "egfr_baseline", "upcr_baseline", "status", "visit_id", "visit_12m_date", "days_from_baseline", "egfr_12m", "upcr_12m", "scr_12m_umol_l", "egfr_delta", "upcr_delta", "tie_count"])


def candidates(patients, visits):
    """Threshold candidates only. No sustained/adjudicated endpoint claim."""
    declines, protein = [], []
    for r in patients.to_dict("records"):
        sub = visits
        for k in KEY:
            sub = sub[sub[k] == r[k]]
        sub = sub[sub.days_from_baseline > 0].sort_values(["visit_date", "id"], kind="stable")
        dr = {k:r[k] for k in KEY}
        pr = dict(dr)
        for threshold, label in [(0.60,"40pct"),(0.43,"57pct")]:
            base = number(r["baseline_egfr"])
            valid = sub[sub.egfr.notna()] if np.isfinite(base) and base > 0 else sub.iloc[0:0]
            hit = valid[valid.egfr <= base*threshold]
            dr[f"status_{label}"] = "candidate_not_adjudicated" if not hit.empty else ("not_observed_in_available_followup" if not valid.empty else "not_evaluable")
            dr[f"candidate_{label}"] = bool(not hit.empty) if not valid.empty else None
            dr[f"visit_id_{label}"] = hit.iloc[0]["id"] if not hit.empty else ""
            dr[f"date_{label}"] = hit.iloc[0].visit_date if not hit.empty else pd.NaT
        declines.append(dr)
        if str(r["module"]).upper() != "IGAN":
            continue
        valid = sub[sub.upcr.notna()]
        base = number(r["baseline_upcr_final"])
        for label in ["upcr_below_300", "upcr_half_and_below_1000"]:
            eligible = valid if label == "upcr_below_300" or (np.isfinite(base) and base > 0) else valid.iloc[0:0]
            hit = eligible[eligible.upcr < 300] if label == "upcr_below_300" else eligible[(eligible.upcr <= base*0.5) & (eligible.upcr < 1000)]
            pr[label] = bool(not hit.empty) if not eligible.empty else None
            pr[label+"_status"] = "candidate_not_adjudicated" if not hit.empty else ("not_observed_in_available_followup" if not eligible.empty else "not_evaluable")
            pr[label+"_visit_id"] = hit.iloc[0]["id"] if not hit.empty else ""
        protein.append(pr)
    dcols=KEY+[f"{x}_{label}" for label in ["40pct","57pct"] for x in ["status","candidate","visit_id","date"]]
    pcols=KEY+[label+s for label in ["upcr_below_300","upcr_half_and_below_1000"] for s in ["","_status","_visit_id"]]
    return pd.DataFrame(declines,columns=dcols), pd.DataFrame(protein,columns=pcols)


def manual_events(events, patients):
    out = events.merge(patients[KEY+["baseline_anchor"]], on=KEY, how="left", validate="many_to_one")
    out["analysis_status"] = pd.Series(index=out.index, dtype=object)
    for idx,r in out.iterrows():
        ed=date(r.event_date)
        confirmed=str(r.confirmed).strip().lower() in {"true","t","1"}
        if not confirmed: status="not_confirmed"
        elif pd.isna(ed): status="event_date_unavailable"
        elif pd.isna(r.baseline_anchor): status="baseline_date_unavailable"
        elif ed <= r.baseline_anchor: status="baseline_or_prebaseline_event"
        else: status="confirmed_in_followup"
        out.at[idx,"analysis_status"]=status
    return out


def patient_slopes(patients, visits):
    rows=[]
    for r in patients.to_dict("records"):
        sub=visits
        for k in KEY: sub=sub[sub[k]==r[k]]
        sub=sub[(sub.days_from_baseline>=0)&sub.egfr.notna()].copy()
        # Multiple observations per date get one date mean, explicitly reported.
        daily=sub.groupby("visit_date",as_index=False).agg(time_yr=("time_yr","first"),egfr=("egfr","mean"))
        row={**{k:r[k] for k in KEY},"status":"insufficient_distinct_dates","slope_mL_yr":np.nan,"follow_up_yr":0.0,"n_visits_used":len(sub),"n_distinct_dates":len(daily)}
        if len(daily)>=2:
            x=daily.time_yr.to_numpy(dtype=float);y=daily.egfr.to_numpy(dtype=float)
            dx=x-x.mean();denom=float(np.dot(dx,dx))
            if denom>0 and np.isfinite(denom):
                slope=float(np.dot(dx,y-y.mean())/denom)
                if np.isfinite(slope): row.update(status="descriptive_ols",slope_mL_yr=slope,follow_up_yr=float(x.max()-x.min()))
        rows.append(row)
    return pd.DataFrame(rows,columns=KEY+["status","slope_mL_yr","follow_up_yr","n_visits_used","n_distinct_dates"])


def trend_summary(visits, metric):
    df=visits[(visits.days_from_baseline>=0)&visits[metric].notna()].copy()
    if df.empty: return pd.DataFrame(columns=["month","mean","n_patients","sd_between_patient_month_means"])
    df["month"]=(df.days_from_baseline/30.4375).round().astype(int)
    per_patient=df.groupby(KEY+["month"],as_index=False)[metric].mean()
    return per_patient.groupby("month",as_index=False).agg(mean=(metric,"mean"),n_patients=(metric,"count"),sd_between_patient_month_means=(metric,"std"))


def table_one(patients, visits, meds):
    n=len(patients)
    rows=[{"Variable":"Patients","n":n,"denominator":n,"Value":n}, {"Variable":"Project-center groups","n":len(patients[["project_id","center_code"]].drop_duplicates()),"denominator":"","Value":""}]
    for sex in ["F","M"]:
        count=int((patients.sex.str.strip().str.upper()==sex).sum())
        rows.append({"Variable":f"Sex {sex}","n":count,"denominator":n,"Value":100*count/n if n else np.nan})
    for field in ["age_baseline","baseline_egfr","baseline_upcr_final"]:
        s=pd.to_numeric(patients[field],errors="coerce").dropna()
        rows.append({"Variable":field+" (median)","n":len(s),"denominator":n,"Value":s.median() if len(s) else np.nan,"Notes":f"IQR {s.quantile(.25):g}–{s.quantile(.75):g}" if len(s) else "not evaluable"})
        rows.append({"Variable":field+" (mean)","n":len(s),"denominator":n,"Value":s.mean() if len(s) else np.nan,"Notes":f"SD {s.std():g}" if len(s)>1 else "SD not evaluable"})
    for field,levels in [("oxford_m",[0,1]),("oxford_e",[0,1]),("oxford_s",[0,1]),("oxford_t",[0,1,2]),("oxford_c",[0,1,2])]:
        if field not in patients: continue
        applicable=patients[patients.module.str.upper()=="IGAN"]
        values=pd.to_numeric(applicable[field],errors="coerce")
        valid=values[values.isin(levels)]
        for level in levels:
            count=int((valid==level).sum())
            rows.append({"Variable":f"{field}={level}","n":count,"denominator":len(valid),"Value":100*count/len(valid) if len(valid) else np.nan,"Notes":f"IgAN applicable n={len(applicable)}; missing/invalid n={len(applicable)-len(valid)}"})
    if not meds.empty:
        any_n=len(meds[KEY].drop_duplicates())
        rows.append({"Variable":"Any medication recorded","n":any_n,"denominator":n,"Value":100*any_n/n if n else np.nan})
        for cls,sub in meds[meds.drug_class!=""].groupby("drug_class"):
            count=len(sub[KEY].drop_duplicates())
            rows.append({"Variable":"Medication class: "+cls,"n":count,"denominator":n,"Value":100*count/n if n else np.nan})
    return pd.DataFrame(rows)


def write_xlsx(path, sheets):
    # Literal strings in Excel, including strings beginning '='; no formula execution.
    from openpyxl import Workbook
    wb=Workbook();wb.remove(wb.active)
    for name,df in sheets.items():
        ws=wb.create_sheet(name[:31])
        for values in [list(df.columns)]+list(df.itertuples(index=False,name=None)):
            safe=[None if pd.isna(v) else (v.to_pydatetime() if isinstance(v,pd.Timestamp) else v) for v in values]
            ws.append(safe)
            for cell in ws[ws.max_row]:
                if isinstance(cell.value,str): cell.data_type="s"
    wb.save(path)


def plot_descriptive_trend(df, metric, path):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig, ax = plt.subplots(figsize=(8, 4.5), dpi=140)
    if df.empty:
        ax.text(0.5, 0.5, "No evaluable dated observations", ha="center", va="center", transform=ax.transAxes)
    else:
        ax.plot(df["month"], df["mean"], marker="o")
    ax.set(xlabel="Months from baseline", ylabel="eGFR (mL/min/1.73m²)" if metric=="egfr" else "UPCR (mg/g)", title="Descriptive mean: equal weight per patient-month; no confidence interval")
    ax.grid(alpha=0.2)
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)


def actual_methods(log):
    return f"""# Methods actually executed — {VERSION}

This run is a descriptive data review, not an adjudicated clinical endpoint report.
Input: {log['patients_n']} patients and {log['visits_n']} visits, keyed by project_id,
center_code and the literal patient_code. Counts and file hashes are in RUN_LOG.json.

Dates were parsed as ISO calendar dates; no missing baseline date or baseline unit
was imputed from subsequent visits or numeric magnitude. Unknown sex was not male.
Baseline eGFR and visits explicitly tagged CKD-EPI-2021-Cr used the adult creatinine
equation from Inker 2021 Table 2; serum creatinine conversion was 88.4 μmol/L per
mg/dL. Age was approximated by calendar year minus birth year (not exact birthday).
Manual eGFR remained tagged manual; values of unverified origin were excluded.
Reference: {EGFR_REFERENCE}

Annual review selected one whole visit within days 270–450, minimizing distance
to day 365, then earliest date, then lexical stable record ID. Ties are counted.
Missing values on that row remain missing. No annual visit means not evaluable.
This window is a descriptive preset and requires protocol review before inference.

Candidate eGFR declines use <=60% or <=43% of baseline, strictly after baseline.
IgAN proteinuria candidates use UPCR<300 mg/g or <=50% baseline and <1000 mg/g.
These are unconfirmed numerical candidates, not sustained or adjudicated outcomes,
not validated remission definitions. Manual events remain individually retained;
only explicitly confirmed, dated, post-baseline events are labelled in followup.

Individual descriptive OLS slopes were produced for {log['ols_evaluable_n']}
patients with at least two distinct dates. Same-date eGFR values were first averaged.
Month summaries first average within patient/month, then equally across patients.
No confidence intervals, cohort mixed-effects model, causal comparisons, survival
analysis, KFRE risk predictions or clinical endpoint adjudication were executed.
Missing values and exclusion reasons are recorded in qc_issues.csv. No imputation.
"""


def analyze(data_dir, output_dir):
    if Path(output_dir).is_symlink():
        raise DataContractError("Output must not be a symlink")
    data_dir,output_dir=Path(data_dir).resolve(),Path(output_dir).resolve()
    if output_dir.is_symlink() or (output_dir.exists() and any(p.name!=".keep" for p in output_dir.iterdir())):
        raise DataContractError("Output directory must be new/empty; use a new run folder to avoid stale results")
    input_hashes={p.name:sha256(p) for p in sorted(data_dir.glob("*.csv"))}
    frames=load_tables(data_dir);issues=[]
    patients,visits=derive(frames,issues)
    labs=normalize_labs(frames["labs_long"],issues)
    outcomes=choose_12month(patients,visits)
    declines,protein=candidates(patients,visits)
    events=manual_events(frames["events_long"],patients)
    slopes=patient_slopes(patients,visits)
    qc=pd.DataFrame(issues,columns=["table"]+KEY+["record_id","code","detail"])
    if input_hashes != {p.name:sha256(p) for p in sorted(data_dir.glob("*.csv"))}:
        raise DataContractError("Input CSVs changed while reading; freeze the input files and retry")
    extra_csv=[name for name in input_hashes if name not in {t+".csv" for t in TABLE_COLUMNS}]
    log={"additional_csv_not_analyzed":extra_csv,"analysis_version":VERSION,"generated_at":datetime.now(timezone.utc).isoformat(),"status":"completed_descriptive_review","patients_n":len(patients),"visits_n":len(visits),"ols_evaluable_n":int((slopes.status=="descriptive_ols").sum()),"annual_selected_n":int((outcomes.status=="visit_selected").sum()),"qc_issue_count":len(qc),"input_dir":str(data_dir),"input_sha256":input_hashes,"script_sha256":sha256(__file__),"dependencies":{x:importlib.metadata.version(x) for x in ["pandas","numpy","openpyxl","matplotlib"]},"identity_key":KEY,"missingness":"no imputation; see per-record status","statsmodels_used":False,"kfre_used":False,"endpoint_adjudication":False}
    output_dir.parent.mkdir(parents=True,exist_ok=True)
    stage=Path(tempfile.mkdtemp(prefix=".analysis-stage-",dir=output_dir.parent))
    try:
        tables={"patients_derived.csv":patients,"visits_derived.csv":visits,"labs_review.csv":labs,"outcomes_12m.csv":outcomes,"candidates_egfr_decline.csv":declines,"candidates_igan_proteinuria.csv":protein,"manual_events_review.csv":events,"egfr_slope_per_patient.csv":slopes,"qc_issues.csv":qc}
        for metric in ["egfr","upcr"]:
            trend=trend_summary(visits,metric)
            tables[f"trend_{metric}_patient_month.csv"]=trend
            plot_descriptive_trend(trend,metric,stage/f"plot_{metric}_trend.png")
        for name,df in tables.items(): df.to_csv(stage/name,index=False,encoding="utf-8-sig",date_format="%Y-%m-%d")
        write_xlsx(stage/"table1_baseline.xlsx",{"Table1":table_one(patients,visits,frames["meds_long"])})
        write_xlsx(stage/"qc_report.xlsx",{"Issues":qc})
        models={"KFRE":{"status":"disabled_pending_validated_model_and_UACR_contract","risk_values_emitted":False},"LME":{"status":"not_executed_no_protocol_specification"},"clinical_endpoint_adjudication":{"status":"not_executed_candidates_only"}}
        (stage/"MODEL_STATUS.json").write_text(json.dumps(models,indent=2))
        (stage/"METHODS_ACTUAL_EN.md").write_text(actual_methods(log),encoding="utf-8")
        log["output_sha256"]={p.name:sha256(p) for p in sorted(stage.iterdir())}
        log["generated_files"]=sorted(log["output_sha256"])+["RUN_LOG.json"]
        (stage/"RUN_LOG.json").write_text(json.dumps(log,indent=2,ensure_ascii=False,allow_nan=False),encoding="utf-8")
        if output_dir.exists():
            keep=output_dir/".keep"
            if keep.exists(): keep.unlink()
            output_dir.rmdir()
        os.replace(stage,output_dir)
    finally:
        if stage.exists(): shutil.rmtree(stage)
    return log


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data",type=Path,default=BASE/"data")
    parser.add_argument("--out",type=Path,default=None,help="New/empty directory; default outputs/run-UTC timestamp")
    args=parser.parse_args()
    out=args.out or BASE/"outputs"/("run-"+datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ"))
    try:
        log=analyze(args.data,out)
    except (DataContractError,OSError,ValueError) as exc:
        parser.exit(2,f"ANALYSIS_FAILED: {exc}\nNo successful report produced; resolve source issues then use a new run directory.\n")
    print(f"DESCRIPTIVE_REVIEW_OK: {out.resolve()}\nPatients: {log['patients_n']}; visits: {log['visits_n']}; QC issues: {log['qc_issue_count']}. Review MODEL_STATUS and METHODS_ACTUAL_EN before using results.")


if __name__=="__main__":
    main()
