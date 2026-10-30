"""Per-centre descriptive summary of an exported analysis pack (KidneySphere analysis pack).

For every project/centre, and for all centres together (rows ALL/ALL), it counts among the
included patients:
  * overview: patients, sex, age at baseline, baseline eGFR and follow-up time;
  * custom enrollment fields (project_fields.csv and patient_field_values.csv): for single-choice,
    yes/no and multi-choice fields the patients with each option; for number fields n, mean, SD,
    median, quartiles, minimum and maximum; for every field how many patients have it recorded.
    Text fields are counted as recorded or not; their content is never written out;
  * medications (meds_long): patients with at least one record of each medication class;
  * events (events_long): patients with each event type, and with kidney failure (an esrd,
    dialysis_start or kidney_transplant event, or follow-up status kidney_failure).
Percentages have two denominators, written side by side: all included patients of the centre
(pct_of_patients) and patients with the item recorded (pct_of_recorded).

The population is the one run_analysis.py uses (consent_status consented/waiver when the
column exists). Age and baseline eGFR are those of run_analysis.py (calendar-year age; CKD-EPI
2021 for adults). The output contains counts and statistics only, never patient codes. Small
counts can still identify people: before sharing a summary outside the study team, apply the
cell-suppression rule of the data use agreement.

Run:  python3 descriptive_summary.py --data data --out summary [--module ADPKD]
No database/network access; the input CSVs are never changed.
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from run_analysis import (KEY, SUPPORTED_MODULES, VERSION, DataContractError, apply_consent_filter,  # noqa: E402
                          consent_failure_message, derive, load_tables, number, sha256)

SUMMARY_SCHEMA = "descriptive-summary-v1"
FIELD_TYPES = ("choice", "multi_choice", "yes_no", "number", "date", "text")
CATEGORICAL = ("choice", "multi_choice", "yes_no")
YES_NO_CHOICES = ({"code": "yes", "label": "是"}, {"code": "no", "label": "否"})
KIDNEY_FAILURE_EVENTS = ("esrd", "dialysis_start", "kidney_transplant")
KIDNEY_FAILURE_ROW = "kidney_failure_any"
NO_CLASS = "(未填类别)"
TRUE = {"true", "t", "1"}
ALL = "ALL"


def _text(value):
    return "" if value is None or (isinstance(value, float) and np.isnan(value)) else str(value).strip()


def _pct(n, d):
    return None if not d else round(100 * n / d, 1)


def _stat(values):
    """n, mean, SD, median, quartiles, min, max of finite numbers (None when not computable)."""
    arr = np.array([v for v in values if np.isfinite(v)], dtype=float)
    if not arr.size:
        return {"n": 0, "mean": None, "sd": None, "median": None, "q1": None, "q3": None, "min": None, "max": None}
    r = lambda x: round(float(x), 2)  # noqa: E731
    return {"n": int(arr.size), "mean": r(arr.mean()), "sd": r(arr.std(ddof=1)) if arr.size > 1 else None,
            "median": r(np.median(arr)), "q1": r(np.percentile(arr, 25)), "q3": r(np.percentile(arr, 75)),
            "min": r(arr.min()), "max": r(arr.max())}


def load_field_definitions(data_dir, values):
    """project_fields.csv → {(project_id, field_key): definition}. Values without a definition stop the run."""
    path = Path(data_dir) / "project_fields.csv"
    if not path.is_file():
        if not values.empty:
            raise DataContractError("patient_field_values.csv has values but project_fields.csv (the field definitions) is missing; "
                                    "re-export the pack, or merge centres with the current merge_centers.py")
        return {}
    with path.open(encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))
    defs = {}
    for r in rows:
        pid, key, kind = _text(r.get("project_id")), _text(r.get("field_key")), _text(r.get("value_type"))
        if not pid or not key or kind not in FIELD_TYPES:
            raise DataContractError(f"project_fields.csv: incomplete or unknown definition (project {pid!r}, field {key!r}, type {kind!r})")
        if (pid, key) in defs:
            raise DataContractError(f"project_fields.csv: field {key} is defined twice for project {pid}")
        choices = []
        if kind in ("choice", "multi_choice"):
            try:
                choices = json.loads(r.get("choices") or "[]")
            except json.JSONDecodeError as e:
                raise DataContractError(f"project_fields.csv: options of {key} (project {pid}) are not valid JSON") from e
            if not isinstance(choices, list) or not choices or not all(isinstance(c, dict) and _text(c.get("code")) for c in choices):
                raise DataContractError(f"project_fields.csv: options of {key} (project {pid}) must be a list of {{code, label}}")
        elif kind == "yes_no":
            choices = [dict(c) for c in YES_NO_CHOICES]
        defs[(pid, key)] = {"field_key": key, "label_cn": _text(r.get("label_cn")) or key, "value_type": kind,
                            "choices": [{"code": _text(c["code"]), "label": _text(c.get("label")) or _text(c["code"])} for c in choices],
                            "unit": _text(r.get("unit")), "active": _text(r.get("active")).lower() in TRUE,
                            "sort_order": number(r.get("sort_order"))}
    undefined = sorted({(v["project_id"], v["field_key"]) for v in values.to_dict("records")} - set(defs))
    if undefined:
        raise DataContractError(f"patient_field_values: fields without a definition in project_fields.csv: {undefined[:5]}")
    return defs


def _field_value(definition, row):
    """The exported value of one patient: a set of codes (categorical), a float (number) or text."""
    kind = definition["value_type"]
    if kind == "multi_choice":
        return {c.strip() for c in _text(row.get("value_codes")).split(";") if c.strip()}
    if kind in ("choice", "yes_no"):
        code = _text(row.get("value_text"))
        return {code} if code else set()
    if kind == "number":
        return number(row.get("value_num"))
    return _text(row.get("value_date") if kind == "date" else row.get("value_text"))


def _recorded(definition, value):
    if definition["value_type"] == "number":
        return bool(np.isfinite(value))
    return bool(value)


def _groups(patients):
    """[(project_id, center_code, module, [patient keys])] per centre, then the ALL group."""
    out = []
    for (pid, cc), sub in patients.groupby(["project_id", "center_code"], sort=True):
        out.append((pid, cc, "|".join(sorted(sub.module.unique())), [tuple(r[k] for k in KEY) for r in sub.to_dict("records")]))
    everyone = [k for g in out for k in g[3]]
    out.append((ALL, ALL, "|".join(sorted(patients.module.unique())) if not patients.empty else "", everyone))
    return out


def overview_rows(patients, visits, groups):
    follow = {}
    if not visits.empty:
        dated = visits[visits.time_yr.notna() & (visits.time_yr >= 0)]
        for key, sub in dated.groupby(KEY, sort=False):
            follow[tuple(key)] = float(sub.time_yr.max())
    by_key = {tuple(r[k] for k in KEY): r for r in patients.to_dict("records")}
    rows = []
    for pid, cc, module, keys in groups:
        sub = [by_key[k] for k in keys]
        sex = [_text(p.get("sex")).upper() for p in sub]
        known = sum(s in ("M", "F") for s in sex)
        age = _stat([number(p.get("age_baseline")) for p in sub])
        egfr = _stat([number(p.get("baseline_egfr")) for p in sub])
        fu = _stat([follow[k] for k in keys if k in follow])
        rows.append({"project_id": pid, "center_code": cc, "module": module, "patients_n": len(sub),
                     "female_n": sex.count("F"), "male_n": sex.count("M"), "sex_unknown_n": len(sub) - known,
                     "female_pct_of_known_sex": _pct(sex.count("F"), known),
                     "age_baseline_n": age["n"], "age_baseline_median": age["median"], "age_baseline_q1": age["q1"], "age_baseline_q3": age["q3"],
                     "baseline_egfr_n": egfr["n"], "baseline_egfr_median": egfr["median"], "baseline_egfr_q1": egfr["q1"], "baseline_egfr_q3": egfr["q3"],
                     "with_followup_visit_n": fu["n"], "followup_years_median": fu["median"], "followup_years_q1": fu["q1"], "followup_years_q3": fu["q3"]})
    return rows


def _merged_definition(key, definitions, warnings):
    """One definition of a field across projects for the ALL rows, or None when the types differ."""
    kinds = {d["value_type"] for d in definitions}
    if len(kinds) > 1:
        warnings.append(f"字段 {key} 在不同项目中的类型不同（{sorted(kinds)}），合计行不汇总该字段 / field {key} has different types across projects; no ALL row")
        return None
    labels, options = [], []
    for d in definitions:
        if d["label_cn"] not in labels:
            labels.append(d["label_cn"])
        for c in d["choices"]:
            hit = next((o for o in options if o["code"] == c["code"]), None)
            if hit is None:
                options.append({"code": c["code"], "labels": [c["label"]]})
            elif c["label"] not in hit["labels"]:
                hit["labels"].append(c["label"])
    if len(labels) > 1:
        warnings.append(f"字段 {key} 在不同项目中的显示名称不同（{' / '.join(labels)}），合计行按代码汇总 / field {key} has different labels across projects")
    units = sorted({d["unit"] for d in definitions if d["unit"]})
    return {"field_key": key, "label_cn": " / ".join(labels), "value_type": definitions[0]["value_type"],
            "choices": [{"code": o["code"], "label": " / ".join(o["labels"])} for o in options], "unit": " / ".join(units),
            "active": any(d["active"] for d in definitions), "sort_order": min(d["sort_order"] for d in definitions)}


def field_rows(patients, values, defs, groups, warnings):
    value_of = {}
    for r in values.to_dict("records"):
        key = (r["project_id"], r["field_key"])
        value_of[(tuple(r[k] for k in KEY), r["field_key"])] = _field_value(defs[key], r)
    completeness, categorical, numeric = [], [], []
    for pid, cc, module, keys in groups:
        if pid == ALL:
            projects = sorted({k[0] for k in keys})
            field_keys = sorted({fk for (p, fk) in defs if p in projects})
            plan = []
            for fk in field_keys:
                merged = _merged_definition(fk, [defs[(p, fk)] for p in projects if (p, fk) in defs], warnings)
                if merged is not None:
                    plan.append((merged, [k for k in keys if (k[0], fk) in defs]))
        else:
            plan = [(defs[(p, fk)], keys) for (p, fk) in defs if p == pid]
        plan.sort(key=lambda item: (item[0]["sort_order"] if np.isfinite(item[0]["sort_order"]) else 1e9, item[0]["field_key"]))
        for d, eligible in plan:
            fk = d["field_key"]
            got = {k: value_of[(k, fk)] for k in eligible if (k, fk) in value_of and _recorded(d, value_of[(k, fk)])}
            base = {"project_id": pid, "center_code": cc, "module": module, "field_key": fk, "label_cn": d["label_cn"]}
            completeness.append({**base, "value_type": d["value_type"], "active": d["active"], "patients_n": len(eligible),
                                 "recorded_n": len(got), "recorded_pct": _pct(len(got), len(eligible))})
            if d["value_type"] in CATEGORICAL:
                known = {c["code"] for c in d["choices"]}
                stray = sorted(set().union(*got.values()) - known) if got else []
                if stray:
                    warnings.append(f"{pid}/{cc} 字段 {fk} 有定义之外的代码 {stray}，未计入 / codes outside the definition were not counted")
                for c in d["choices"]:
                    n = sum(c["code"] in v for v in got.values())
                    categorical.append({**base, "value_type": d["value_type"], "option_code": c["code"], "option_label": c["label"],
                                        "n": n, "patients_n": len(eligible), "recorded_n": len(got),
                                        "pct_of_patients": _pct(n, len(eligible)), "pct_of_recorded": _pct(n, len(got))})
            elif d["value_type"] == "number":
                s = _stat(list(got.values()))
                numeric.append({**base, "unit": d["unit"], "patients_n": len(eligible), **{("recorded_n" if k == "n" else k): v for k, v in s.items()}})
    return completeness, categorical, numeric


def medication_rows(meds, groups):
    classes = sorted({_text(c) for c in meds.drug_class} - {""}) if not meds.empty else []
    if not meds.empty and (meds.drug_class.map(_text) == "").any():
        classes.append(NO_CLASS)
    users = {}
    for r in meds.to_dict("records"):
        users.setdefault(_text(r["drug_class"]) or NO_CLASS, set()).add(tuple(r[k] for k in KEY))
    rows = []
    for pid, cc, module, keys in groups:
        members = set(keys)
        for c in classes:
            n = len(users.get(c, set()) & members)
            rows.append({"project_id": pid, "center_code": cc, "module": module, "drug_class": c, "patients_with_record_n": n,
                         "patients_n": len(keys), "pct_of_patients": _pct(n, len(keys))})
    return rows


def event_rows(patients, events, groups):
    types = sorted({_text(t).lower() for t in events.event_type} - {""}) if not events.empty else []
    confirmed, any_record = {}, {}
    for r in events.to_dict("records"):
        t, key = _text(r["event_type"]).lower(), tuple(r[k] for k in KEY)
        any_record.setdefault(t, set()).add(key)
        if _text(r.get("confirmed")).lower() in TRUE:
            confirmed.setdefault(t, set()).add(key)
    kf_status = set()
    if "followup_status" in patients.columns:
        kf_status = {tuple(r[k] for k in KEY) for r in patients.to_dict("records") if _text(r.get("followup_status")) == "kidney_failure"}
    kf_confirmed = set().union(*(confirmed.get(t, set()) for t in KIDNEY_FAILURE_EVENTS)) | kf_status
    kf_any = set().union(*(any_record.get(t, set()) for t in KIDNEY_FAILURE_EVENTS)) | kf_status
    rows = []
    for pid, cc, module, keys in groups:
        members = set(keys)
        for t, conf, anything in [*[(t, confirmed.get(t, set()), any_record.get(t, set())) for t in types], (KIDNEY_FAILURE_ROW, kf_confirmed, kf_any)]:
            n = len(conf & members)
            rows.append({"project_id": pid, "center_code": cc, "module": module, "event_type": t, "patients_confirmed_n": n,
                         "patients_any_record_n": len(anything & members), "patients_n": len(keys), "pct_of_patients": _pct(n, len(keys))})
    return rows


def _write(path, rows, columns):
    with path.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=columns, lineterminator="\n")
        writer.writeheader()
        writer.writerows([{c: ("" if r.get(c) is None else r.get(c)) for c in columns} for r in rows])


COLUMNS = {
    "summary_overview.csv": ["project_id", "center_code", "module", "patients_n", "female_n", "male_n", "sex_unknown_n", "female_pct_of_known_sex",
                             "age_baseline_n", "age_baseline_median", "age_baseline_q1", "age_baseline_q3",
                             "baseline_egfr_n", "baseline_egfr_median", "baseline_egfr_q1", "baseline_egfr_q3",
                             "with_followup_visit_n", "followup_years_median", "followup_years_q1", "followup_years_q3"],
    "summary_field_completeness.csv": ["project_id", "center_code", "module", "field_key", "label_cn", "value_type", "active", "patients_n", "recorded_n", "recorded_pct"],
    "summary_fields_categorical.csv": ["project_id", "center_code", "module", "field_key", "label_cn", "value_type", "option_code", "option_label",
                                       "n", "patients_n", "recorded_n", "pct_of_patients", "pct_of_recorded"],
    "summary_fields_numeric.csv": ["project_id", "center_code", "module", "field_key", "label_cn", "unit", "patients_n", "recorded_n",
                                   "mean", "sd", "median", "q1", "q3", "min", "max"],
    "summary_medications.csv": ["project_id", "center_code", "module", "drug_class", "patients_with_record_n", "patients_n", "pct_of_patients"],
    "summary_events.csv": ["project_id", "center_code", "module", "event_type", "patients_confirmed_n", "patients_any_record_n", "patients_n", "pct_of_patients"],
}


def run(data_dir, out_dir, module=None, allow_fully_excluded_centers=False):
    if module is not None and module not in SUPPORTED_MODULES:
        raise DataContractError(f"--module must be one of {list(SUPPORTED_MODULES)} (case-sensitive)")
    out = Path(out_dir)
    if out.exists() and (not out.is_dir() or any(out.iterdir())):
        raise DataContractError("--out must be a new or empty directory; earlier results must not be mixed in")
    frames = load_tables(data_dir)
    defs = load_field_definitions(data_dir, frames["patient_field_values"])
    if module is not None:
        keep = {tuple(r[k] for k in KEY) for r in frames["patients_baseline"].to_dict("records") if r["module"] == module}
        if not keep:
            raise DataContractError(f"No patient of module {module} in the data")
        frames = {t: (df[df.apply(lambda r: tuple(r[k] for k in KEY) in keep, axis=1)].reset_index(drop=True) if not df.empty else df)
                  for t, df in frames.items()}
        projects = {k[0] for k in keep}
        defs = {k: v for k, v in defs.items() if k[0] in projects}
    frames, consent_info = apply_consent_filter(frames)
    failure = consent_failure_message(consent_info)
    if failure and not (allow_fully_excluded_centers and consent_info["included_n"] > 0):
        raise DataContractError(failure)
    issues = []
    patients, visits = derive(frames, issues)
    groups = _groups(patients)
    warnings = []
    modules = sorted(patients.module.unique()) if not patients.empty else []
    if len(modules) > 1:
        warnings.append(f"合计行包含多个病种 {modules}；可用 --module 只汇总一个病种 / the ALL rows mix modules {modules}")
    completeness, categorical, numeric = field_rows(patients, frames["patient_field_values"], defs, groups, warnings)
    tables = {
        "summary_overview.csv": overview_rows(patients, visits, groups),
        "summary_field_completeness.csv": completeness,
        "summary_fields_categorical.csv": categorical,
        "summary_fields_numeric.csv": numeric,
        "summary_medications.csv": medication_rows(frames["meds_long"], groups),
        "summary_events.csv": event_rows(patients, frames["events_long"], groups),
    }
    out.mkdir(parents=True, exist_ok=True)
    for name, rows in tables.items():
        _write(out / name, rows, COLUMNS[name])
    log = {
        "program": "descriptive_summary.py", "analysis_version": VERSION, "summary_schema": SUMMARY_SCHEMA,
        "generated_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "input_sha256": {p.name: sha256(p) for p in sorted(Path(data_dir).glob("*.csv"))},
        "module_filter": module, "consent_filter": consent_info,
        "allow_fully_excluded_centers": bool(allow_fully_excluded_centers),
        "centres": [{"project_id": g[0], "center_code": g[1], "module": g[2], "patients_n": len(g[3])} for g in groups if g[0] != ALL],
        "rows": {name: len(rows) for name, rows in tables.items()},
        "definitions": {
            "population": "run_analysis.py population: consent_status consented/waiver when the column exists",
            "percentages": "pct_of_patients = n / included patients of the centre (for fields: of the projects defining the field); pct_of_recorded = n / patients with the item recorded",
            "age_and_egfr": "run_analysis.py: calendar-year age at baseline; baseline eGFR by CKD-EPI 2021 for adults (not computed for children)",
            "followup_years": "latest visit on or after the baseline date, in years from baseline",
            "events": "patients_confirmed_n counts confirmed records only; patients_any_record_n counts any record",
            "kidney_failure_any": "an esrd, dialysis_start or kidney_transplant event, or followup_status kidney_failure",
            "text_fields": "counted as recorded or not; content never written out",
        },
        "warnings": warnings, "data_issues_n": len(issues),
        "note": "描述性汇总，只含人数与统计量，不含研究编号。对外提供前请按数据使用协议的小样本抑制规则处理。",
    }
    (out / "SUMMARY_RUN_LOG.json").write_text(json.dumps(log, indent=2, ensure_ascii=False, allow_nan=False), encoding="utf-8")
    return log, tables


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data", required=True, help="analysis/data directory of an exported pack (or a merge_centers.py output)")
    parser.add_argument("--out", required=True, help="new or empty output directory")
    parser.add_argument("--module", default=None, help=f"only patients of this registry module, e.g. ADPKD; one of {list(SUPPORTED_MODULES)}")
    parser.add_argument("--allow-fully-excluded-centers", action="store_true",
                        help="proceed although a project/centre has no patient with consent_status consented/waiver (recorded in the run log)")
    args = parser.parse_args()
    try:
        log, _ = run(args.data, args.out, module=args.module, allow_fully_excluded_centers=args.allow_fully_excluded_centers)
    except DataContractError as e:
        print(f"SUMMARY_FAILED: {e}", file=sys.stderr)
        sys.exit(2)
    print(f"SUMMARY_OK: {len(log['centres'])} centres; outputs in {args.out}")
    for w in log["warnings"]:
        print(f"WARNING: {w}")


if __name__ == "__main__":
    main()
