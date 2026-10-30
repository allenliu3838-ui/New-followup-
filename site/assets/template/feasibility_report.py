"""Per-centre feasibility counts for a planned study (KidneySphere analysis pack).

Counts, for every project/centre in an exported analysis pack, how many registered
patients meet the screening criteria written in a criteria JSON file (see
feasibility_criteria_template.json): disease module, age at baseline, latest usable eGFR,
latest UPCR and recency of the last visit. The population is the same as run_analysis.py
(consent_status consented/waiver when the column exists); eGFR is the analysis eGFR of
run_analysis.py (recomputed from creatinine: CKD-EPI 2021 for adults, bedside Schwartz 2009
for 1-17-year-olds with a recorded visit height; stored values tagged manual).

This is a count against stated criteria for planning purposes. It is not an eligibility
decision for any patient and must not be used to contact or select individuals; the
output contains counts only, never patient codes.

Run:  python3 feasibility_report.py --data data --out feasibility --criteria my_criteria.json
      [--as-of YYYY-MM-DD]   (default: the latest visit date in the data)
No database/network access; the input CSVs are never changed.
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
from datetime import date as date_type, datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from run_analysis import (KEY, VERSION, DataContractError, apply_consent_filter, derive, load_tables,  # noqa: E402
                          number, sha256)

CRITERIA_SCHEMA = "feasibility-criteria-v1"
MODULES = ("IGAN", "LN", "MN", "DKD", "CKD", "KTX", "C3G", "ADPKD", "GENERAL")


class CriteriaError(ValueError):
    """The criteria file is incomplete or contradictory; no counts are produced."""


def _range(block, name, minimum=None, maximum=None):
    """A {min, max} block; None means no bound. Values must be numbers within [minimum, maximum]."""
    if block is None:
        return None
    if not isinstance(block, dict):
        raise CriteriaError(f"{name} must be an object with min/max")
    out = {}
    for bound in ("min", "max"):
        value = block.get(bound)
        if value is None:
            out[bound] = None
            continue
        value = number(value)
        if not np.isfinite(value):
            raise CriteriaError(f"{name}.{bound} must be a number")
        if minimum is not None and value < minimum or maximum is not None and value > maximum:
            raise CriteriaError(f"{name}.{bound} outside {minimum}..{maximum}")
        out[bound] = float(value)
    if out["min"] is not None and out["max"] is not None and out["min"] > out["max"]:
        raise CriteriaError(f"{name}: min above max")
    out["within_days"] = None
    if "within_days" in block and block["within_days"] is not None:
        days = number(block["within_days"])
        if not (np.isfinite(days) and days > 0 and float(days).is_integer()):
            raise CriteriaError(f"{name}.within_days must be a positive whole number of days")
        out["within_days"] = int(days)
    return out


def load_criteria(path):
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    if raw.get("schema") != CRITERIA_SCHEMA:
        raise CriteriaError(f"criteria schema must be {CRITERIA_SCHEMA}")
    if raw.get("status") != "confirmed":
        raise CriteriaError("criteria status must be 'confirmed' (set by the study team after review); the template is not confirmed")
    for field in ("criteria_id", "version", "confirmed_by", "confirmed_date"):
        if not str(raw.get(field, "")).strip():
            raise CriteriaError(f"criteria.{field} is required")
    modules = raw.get("modules")
    if modules is not None:
        if not isinstance(modules, list) or not modules or any(m not in MODULES for m in modules):
            raise CriteriaError(f"criteria.modules must be a non-empty list drawn from {list(MODULES)}")
    out = {
        "criteria_id": raw["criteria_id"], "version": raw["version"], "confirmed_by": raw["confirmed_by"],
        "confirmed_date": raw["confirmed_date"], "modules": modules,
        "age_at_baseline": _range(raw.get("age_at_baseline"), "age_at_baseline", 0, 120),
        "latest_egfr": _range(raw.get("latest_egfr"), "latest_egfr", 0, 200),
        "latest_upcr_mg_g": _range(raw.get("latest_upcr_mg_g"), "latest_upcr_mg_g", 0, 50000),
        "last_visit_within_days": None,
    }
    if raw.get("last_visit_within_days") is not None:
        days = number(raw["last_visit_within_days"])
        if not (np.isfinite(days) and days > 0 and float(days).is_integer()):
            raise CriteriaError("last_visit_within_days must be a positive whole number of days")
        out["last_visit_within_days"] = int(days)
    if not any(out[k] for k in ("modules", "age_at_baseline", "latest_egfr", "latest_upcr_mg_g", "last_visit_within_days")):
        raise CriteriaError("at least one criterion is required")
    return out, raw


def _within(value, block):
    if not np.isfinite(value):
        return False
    return (block["min"] is None or value >= block["min"]) and (block["max"] is None or value <= block["max"])


def _latest(visits, column, as_of, within_days):
    """Latest non-missing value of column dated on or before as_of (and within within_days)."""
    sub = visits[visits.visit_date.notna() & (visits.visit_date <= as_of) & visits[column].notna()]
    if within_days is not None:
        sub = sub[(as_of - sub.visit_date).dt.days <= within_days]
    if sub.empty:
        return np.nan
    sub = sub.sort_values(["visit_date", "id"])
    return float(sub.iloc[-1][column])


def evaluate(patients, visits, criteria, as_of):
    """One row per patient with each criterion's result; counts are derived from it."""
    rows = []
    for r in patients.to_dict("records"):
        mine = visits
        for k in KEY:
            mine = mine[mine[k] == r[k]]
        dated = mine[mine.visit_date.notna() & (mine.visit_date <= as_of)]
        last_visit = dated.visit_date.max() if not dated.empty else pd.NaT
        checks = {}
        if criteria["modules"] is not None:
            checks["module_ok"] = r["module"] in criteria["modules"]
        if criteria["age_at_baseline"] is not None:
            checks["age_ok"] = _within(number(r["age_baseline"]), criteria["age_at_baseline"])
        if criteria["latest_egfr"] is not None:
            checks["egfr_ok"] = _within(_latest(dated, "egfr", as_of, criteria["latest_egfr"]["within_days"]), criteria["latest_egfr"])
        if criteria["latest_upcr_mg_g"] is not None:
            checks["upcr_ok"] = _within(_latest(dated, "upcr", as_of, criteria["latest_upcr_mg_g"]["within_days"]), criteria["latest_upcr_mg_g"])
        if criteria["last_visit_within_days"] is not None:
            checks["recent_visit_ok"] = pd.notna(last_visit) and (as_of - last_visit).days <= criteria["last_visit_within_days"]
        rows.append({"project_id": r["project_id"], "center_code": r["center_code"], "module": r["module"],
                     "has_visit": bool(pd.notna(last_visit)), **checks, "all_ok": all(checks.values())})
    return pd.DataFrame(rows)


def summarize(evaluated, consent_info):
    """Counts per project/centre plus a total row; never patient identifiers.

    A centre whose patients were all excluded by consent keeps a row with zero counts, so
    every centre is listed and the per-centre exclusions add up to the total row.
    """
    excluded = {(c["project_id"], c["center_code"]): c["excluded_n"] for c in consent_info.get("by_center", [])}
    check_cols = [c for c in evaluated.columns if c.endswith("_ok") and c != "all_ok"]
    out = []
    groups = dict(list(evaluated.groupby(["project_id", "center_code"], sort=True))) if not evaluated.empty else {}
    for pid, cc in sorted(set(groups) | set(excluded)):
        sub = groups.get((pid, cc))
        if sub is None:
            row = {"project_id": pid, "center_code": cc, "modules": "", "consent_excluded_n": excluded[(pid, cc)],
                   "included_patients_n": 0, "with_visit_n": 0, **{f"{c[:-3]}_n": 0 for c in check_cols}, "all_criteria_n": 0}
            out.append(row)
            continue
        row = {"project_id": pid, "center_code": cc, "modules": "|".join(sorted(sub.module.unique())),
               "consent_excluded_n": excluded.get((pid, cc), 0), "included_patients_n": len(sub),
               "with_visit_n": int(sub.has_visit.sum())}
        for c in check_cols:
            row[f"{c[:-3]}_n"] = int(sub[c].sum())
        row["all_criteria_n"] = int(sub.all_ok.sum())
        out.append(row)
    total = {"project_id": "ALL", "center_code": "ALL", "modules": "|".join(sorted(evaluated.module.unique())) if not evaluated.empty else "",
             "consent_excluded_n": sum(excluded.values()), "included_patients_n": len(evaluated),
             "with_visit_n": int(evaluated.has_visit.sum()) if not evaluated.empty else 0}
    for c in check_cols:
        total[f"{c[:-3]}_n"] = int(evaluated[c].sum()) if not evaluated.empty else 0
    total["all_criteria_n"] = int(evaluated.all_ok.sum()) if not evaluated.empty else 0
    out.append(total)
    return out


def run(data_dir, out_dir, criteria_path, as_of=None):
    criteria, raw = load_criteria(criteria_path)
    frames = load_tables(data_dir)
    frames, consent_info = apply_consent_filter(frames)
    issues = []
    patients, visits = derive(frames, issues)
    if as_of is None:
        dated = visits.visit_date.dropna()
        if dated.empty:
            raise DataContractError("No dated visits; give --as-of explicitly")
        as_of = dated.max()
    else:
        as_of = pd.Timestamp(datetime.strptime(as_of, "%Y-%m-%d"))
    evaluated = evaluate(patients, visits, criteria, as_of)
    summary = summarize(evaluated, consent_info)
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    columns = list(summary[0].keys())
    with (out / "feasibility_by_center.csv").open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=columns, lineterminator="\n")
        writer.writeheader()
        writer.writerows(summary)
    inputs = {p.name: sha256(p) for p in sorted(Path(data_dir).glob("*.csv"))}
    log = {
        "program": "feasibility_report.py", "analysis_version": VERSION, "criteria_schema": CRITERIA_SCHEMA,
        "generated_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "as_of_date": as_of.date().isoformat(), "criteria": raw, "criteria_sha256": sha256(criteria_path),
        "input_sha256": inputs, "consent_filter": consent_info,
        "egfr_source": "run_analysis.py analysis eGFR (CKD-EPI 2021 adults; bedside Schwartz 2009 for 1-17 years with visit height; manual values as tagged)",
        "data_issues_n": len(issues),
        "totals": summary[-1],
        "note": "按书面筛选条件的人数统计，用于研究可行性评估；不是任何患者的入组资格判定，输出不含研究编号。",
    }
    (out / "FEASIBILITY_RUN_LOG.json").write_text(json.dumps(log, indent=2, ensure_ascii=False, allow_nan=False), encoding="utf-8")
    return log, summary


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data", required=True, help="analysis/data directory of an exported pack")
    parser.add_argument("--out", required=True, help="output directory (created)")
    parser.add_argument("--criteria", required=True, help="confirmed criteria JSON (see feasibility_criteria_template.json)")
    parser.add_argument("--as-of", default=None, help="reference date YYYY-MM-DD; default = latest visit date in the data")
    args = parser.parse_args()
    try:
        log, summary = run(args.data, args.out, args.criteria, args.as_of)
    except (CriteriaError, DataContractError) as exc:
        print(f"FEASIBILITY_STOPPED: {exc}", file=sys.stderr)
        return 2
    print(f"FEASIBILITY_OK centers={len(summary) - 1} included={log['totals']['included_patients_n']} all_criteria={log['totals']['all_criteria_n']} as_of={log['as_of_date']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
