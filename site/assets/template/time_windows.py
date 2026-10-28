"""Time-window table aligned on the kidney biopsy date (KidneySphere analysis pack).

Day 0 of every included patient is the anchor biopsy date. By default that is the index
biopsy in biopsies_long.csv (the one biopsy marked is_index for that patient), then the
disease module's biopsy date in patients_baseline.csv (ln_biopsy_date for LN,
c3g_biopsy_date for C3G, biopsy_date otherwise); "earliest_native_biopsy" can be added to
the configured anchor sources. For every configured time point and variable, one value is
taken from the measurements dated inside that time point's window:

  1. measurements of one variable on the same calendar day are combined into their median
     (the number of values and the values themselves are reported);
  2. the day nearest to the time point's target day is chosen;
  3. when two days are equally near, the earlier day is chosen.
Window limits are inclusive, in whole days from the anchor date.

eGFR is not selected on its own. It is recomputed from the creatinine value selected for that
time point, with the year-derived age on that day and the sex; adults (18-120 years) by the
CKD-EPI 2021 creatinine equation, 1-17-year-olds by the bedside Schwartz 2009 equation with
the height nearest to that day within the configured height window (same rules for ties and
same-day values). These are the registry's own equations (run_analysis.py, database trigger).
Stored eGFR values are not used.

The population is that of run_analysis.py (consent_status consented/waiver when the column
exists). Time points, windows and variables come from the configuration file only (see
time_windows_template.json). Until the study teams mark the configuration confirmed, the
output file names start with UNCONFIRMED_.

Run:  python3 time_windows.py --data data --config time_windows_config.json --out time_windows
No database/network access; the input CSVs are never changed.
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import statistics
import sys
from datetime import datetime, timezone
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from run_analysis import (KEY, VERSION, DataContractError, apply_consent_filter, ckdepi2021,  # noqa: E402
                          consent_failure_message, date, load_tables, normalize_labs, number, schwartz2009, sha256,
                          upcr_mg_g)

CONFIG_FORMAT = "kidneysphere-time-windows-v1"
SCRIPT_VERSION = "time-windows-v1"
ANCHOR_SOURCES = ("index_biopsy", "baseline_biopsy_date", "earliest_native_biopsy")
BASELINE_BIOPSY_COLUMN = {"LN": "ln_biopsy_date", "C3G": "c3g_biopsy_date"}
SELECTION = {"rule": "nearest", "tie": "earlier", "same_day": "median"}
# Measurement columns a variable may read, with the unit the registry stores them in.
VISIT_COLUMNS = {"scr_umol_l": "μmol/L", "upcr": "mg/g", "sbp": "mmHg", "dbp": "mmHg", "height_cm": "cm"}
BASELINE_COLUMNS = {"baseline_scr": "μmol/L", "baseline_upcr": "mg/g"}
NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,29}$")
TRUE = {"true", "t", "1", "yes"}
EGFR_UNIT = "mL/min/1.73m²"
LONG_COLUMNS = KEY + ["module", "anchor_date", "anchor_source", "timepoint", "target_days", "window_from_days", "window_to_days",
                      "variable", "unit", "status", "value", "value_date", "offset_days", "n_values_on_day", "values_on_day", "sources",
                      "egfr_formula", "age_years", "height_cm_used", "height_date_used"]


class ConfigError(ValueError):
    """The configuration file is incomplete or contradictory; no table is produced."""


def _int(value, where):
    if isinstance(value, bool) or not isinstance(value, int):
        raise ConfigError(f"{where} must be a whole number of days")
    return value


def validate_config(raw):
    """Check the configuration completely before any data is read; return a normalised copy."""
    if not isinstance(raw, dict):
        raise ConfigError("configuration must be a JSON object")
    if raw.get("format") != CONFIG_FORMAT:
        raise ConfigError(f"format must be {CONFIG_FORMAT!r}")
    confirmed = raw.get("confirmed")
    if not isinstance(confirmed, bool):
        raise ConfigError("confirmed must be true or false")
    if confirmed:
        if not str(raw.get("confirmed_by") or "").strip():
            raise ConfigError("confirmed_by is required when confirmed is true")
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(raw.get("confirmed_date") or "")) or pd.isna(date(raw.get("confirmed_date"))):
            raise ConfigError("confirmed_date (YYYY-MM-DD) is required when confirmed is true")
    selection = raw.get("selection", SELECTION)
    if selection != SELECTION:
        raise ConfigError(f"selection is fixed: {json.dumps(SELECTION)} (nearest day; equally near -> earlier; same day -> median)")
    anchor = raw.get("anchor") or {}
    sources = anchor.get("sources") if isinstance(anchor, dict) else None
    if not isinstance(sources, list) or not sources or len(set(sources)) != len(sources) or any(s not in ANCHOR_SOURCES for s in sources):
        raise ConfigError(f"anchor.sources must be a non-empty list of distinct values from {list(ANCHOR_SOURCES)}")
    points = raw.get("timepoints")
    if not isinstance(points, list) or not points:
        raise ConfigError("timepoints must be a non-empty list")
    timepoints = []
    for i, tp in enumerate(points):
        where = f"timepoints[{i}]"
        if not isinstance(tp, dict) or not NAME.match(str(tp.get("name", ""))):
            raise ConfigError(f"{where}.name must start with a letter and use letters, digits or _ (max 30)")
        target = _int(tp.get("target_days"), f"{where}.target_days")
        window = tp.get("window_days")
        if not isinstance(window, list) or len(window) != 2:
            raise ConfigError(f"{where}.window_days must be [from, to]")
        lo, hi = _int(window[0], f"{where}.window_days[0]"), _int(window[1], f"{where}.window_days[1]")
        if not lo <= target <= hi:
            raise ConfigError(f"{where}: the window must contain the target day ({lo} <= {target} <= {hi})")
        timepoints.append({"name": tp["name"], "target_days": target, "window_days": [lo, hi]})
    if len({tp["name"] for tp in timepoints}) != len(timepoints):
        raise ConfigError("timepoint names must be unique")
    specs = raw.get("variables")
    if not isinstance(specs, list) or not specs:
        raise ConfigError("variables must be a non-empty list")
    variables = []
    for i, spec in enumerate(specs):
        where = f"variables[{i}]"
        if not isinstance(spec, dict) or not NAME.match(str(spec.get("name", ""))):
            raise ConfigError(f"{where}.name must start with a letter and use letters, digits or _ (max 30)")
        unit = spec.get("unit")
        if not isinstance(unit, str) or not unit.strip():
            raise ConfigError(f"{where}.unit is required")
        decimals = spec.get("decimals", 2)
        if isinstance(decimals, bool) or not isinstance(decimals, int) or not 0 <= decimals <= 6:
            raise ConfigError(f"{where}.decimals must be 0-6")
        srcs = spec.get("sources")
        if not isinstance(srcs, list) or not srcs:
            raise ConfigError(f"{where}.sources must be a non-empty list")
        clean = []
        for j, src in enumerate(srcs):
            w = f"{where}.sources[{j}]"
            table = src.get("table") if isinstance(src, dict) else None
            if table == "visits_long":
                column = src.get("column")
                if column not in VISIT_COLUMNS:
                    raise ConfigError(f"{w}.column must be one of {sorted(VISIT_COLUMNS)}")
                if VISIT_COLUMNS[column] != unit:
                    raise ConfigError(f"{w}: visits_long.{column} is stored in {VISIT_COLUMNS[column]}, not {unit}")
                clean.append({"table": table, "column": column})
            elif table == "patients_baseline":
                column = src.get("column")
                if column not in BASELINE_COLUMNS:
                    raise ConfigError(f"{w}.column must be one of {sorted(BASELINE_COLUMNS)}")
                if BASELINE_COLUMNS[column] != unit:
                    raise ConfigError(f"{w}: patients_baseline.{column} is read in {BASELINE_COLUMNS[column]}, not {unit}")
                clean.append({"table": table, "column": column})
            elif table == "labs_long":
                code, analysis_unit, factor = src.get("lab_test_code"), src.get("analysis_unit"), src.get("factor", 1)
                if not isinstance(code, str) or not re.fullmatch(r"[A-Z0-9_]{1,30}", code):
                    raise ConfigError(f"{w}.lab_test_code must be a dictionary code such as CREAT")
                if not isinstance(analysis_unit, str) or not analysis_unit:
                    raise ConfigError(f"{w}.analysis_unit is required (the unit run_analysis.normalize_labs converts this test to)")
                if isinstance(factor, bool) or not isinstance(factor, (int, float)) or not np.isfinite(factor) or factor <= 0:
                    raise ConfigError(f"{w}.factor must be a positive number (analysis unit -> variable unit)")
                clean.append({"table": table, "lab_test_code": code, "analysis_unit": analysis_unit, "factor": float(factor)})
            else:
                raise ConfigError(f"{w}.table must be visits_long, patients_baseline or labs_long")
        variables.append({"name": spec["name"], "label": str(spec.get("label") or spec["name"]), "unit": unit,
                          "decimals": decimals, "sources": clean})
    names = [v["name"] for v in variables]
    if len(set(names)) != len(names) or "egfr" in names:
        raise ConfigError("variable names must be unique; 'egfr' is reserved for the recomputed eGFR")
    egfr = raw.get("egfr")
    if egfr is not None:
        if not isinstance(egfr, dict):
            raise ConfigError("egfr must be an object")
        by_name = {v["name"]: v for v in variables}
        scr, height = by_name.get(egfr.get("creatinine_variable")), by_name.get(egfr.get("height_variable"))
        if scr is None or scr["unit"] != "μmol/L":
            raise ConfigError("egfr.creatinine_variable must name a variable in μmol/L")
        if height is None or height["unit"] != "cm":
            raise ConfigError("egfr.height_variable must name a variable in cm")
        hw = _int(egfr.get("height_window_days"), "egfr.height_window_days")
        if hw < 0:
            raise ConfigError("egfr.height_window_days must be >= 0")
        if egfr.get("adult_equation", "CKD-EPI-2021-Cr") != "CKD-EPI-2021-Cr" or egfr.get("child_equation", "Schwartz-2009-bedside") != "Schwartz-2009-bedside":
            raise ConfigError("egfr equations available: adult CKD-EPI-2021-Cr, child Schwartz-2009-bedside "
                              "(other equations are added only after both study teams agree on them)")
        egfr = {"creatinine_variable": scr["name"], "height_variable": height["name"], "height_window_days": hw,
                "adult_equation": "CKD-EPI-2021-Cr", "child_equation": "Schwartz-2009-bedside"}
    return {"format": CONFIG_FORMAT, "confirmed": confirmed, "confirmed_by": raw.get("confirmed_by") or "",
            "confirmed_date": raw.get("confirmed_date") or "", "anchor": {"sources": list(sources)}, "selection": dict(SELECTION),
            "timepoints": timepoints, "variables": variables, "egfr": egfr}


def load_config(path):
    path = Path(path)
    if path.is_symlink() or not path.is_file():
        raise ConfigError(f"configuration file not found: {path}")
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except ValueError as exc:
        raise ConfigError(f"configuration is not valid JSON: {exc}") from None
    return validate_config(raw)


def _key(row):
    return tuple(row[k] for k in KEY)


def find_anchors(patients, biopsies, sources):
    """{patient key: (anchor date, source, biopsy kind)} and {patient key: reason without anchor}."""
    by_patient = {}
    for b in biopsies.to_dict("records"):
        by_patient.setdefault(_key(b), []).append(b)
    anchors, missing = {}, {}
    for p in patients.to_dict("records"):
        key = _key(p)
        rows = by_patient.get(key, [])
        index = [b for b in rows if str(b.get("is_index", "")).strip().lower() in TRUE]
        reason = "biopsy_records_without_index_biopsy" if rows and not index else "no_biopsy_date"
        for source in sources:
            if source == "index_biopsy":
                if len(index) > 1:
                    reason = "several_index_biopsies"
                    break
                if index and pd.notna(date(index[0]["biopsy_date"])):
                    anchors[key] = (date(index[0]["biopsy_date"]), source, index[0].get("biopsy_kind", ""))
                    break
            elif source == "baseline_biopsy_date":
                column = BASELINE_BIOPSY_COLUMN.get(str(p.get("module", "")).upper(), "biopsy_date")
                d = date(p.get(column, ""))
                if pd.notna(d):
                    anchors[key] = (d, f"baseline_biopsy_date:{column}", "")
                    break
            elif source == "earliest_native_biopsy":
                native = sorted((date(b["biopsy_date"]), b) for b in rows
                                if str(b.get("biopsy_kind", "")) == "native" and pd.notna(date(b["biopsy_date"])))
                if native:
                    anchors[key] = (native[0][0], source, "native")
                    break
        if key not in anchors:
            missing[key] = reason
    return anchors, missing


def measurements(frames, labs_norm, variable):
    """{patient key: [(day, value text, value, source label)]} for one variable; unusable values skipped and counted."""
    out, skipped = {}, 0
    for src in variable["sources"]:
        if src["table"] == "labs_long":
            label = f"labs_long:{src['lab_test_code']}"
            rows = labs_norm[labs_norm["lab_test_code"] == src["lab_test_code"]]
            for r in rows.to_dict("records"):
                d = date(r["lab_date"])
                ok = r["analysis_status"] == "explicit_unit_conversion" and r["analysis_unit"] == src["analysis_unit"] and pd.notna(d)
                value = float(r["analysis_value"]) * src["factor"] if ok else np.nan
                if not np.isfinite(value) or value < 0:
                    skipped += 1
                    continue
                out.setdefault(_key(r), []).append((d, repr(round(value, 6)), value, label))
        else:
            table = frames[src["table"]]
            column = src["column"]
            label = f"{src['table']}:{column}"
            date_column = "visit_date" if src["table"] == "visits_long" else "baseline_date"
            if column not in table.columns:
                continue
            for r in table.to_dict("records"):
                text = str(r.get(column, "")).strip()
                if not text:
                    continue
                d = date(r.get(date_column, ""))
                value = upcr_mg_g(text, r.get("baseline_upcr_unit", "")) if column == "baseline_upcr" else number(text)
                if pd.isna(d) or not np.isfinite(value) or value < 0:
                    skipped += 1
                    continue
                out.setdefault(_key(r), []).append((d, text if column != "baseline_upcr" else repr(value), value, label))
    return out, skipped


def select(points, anchor, target, lo, hi):
    """The nearest day to anchor+target inside [anchor+lo, anchor+hi]; equally near -> earlier; same day -> median."""
    days = {}
    for d, text, value, source in points:
        days.setdefault(d, []).append((text, value, source))
    best = None
    for d, values in days.items():
        offset = (d - anchor).days
        if lo <= offset <= hi:
            rank = (abs(offset - target), d)
            if best is None or rank < best[0]:
                best = (rank, d, offset, values)
    if best is None:
        return None
    _, d, offset, values = best
    return {"date": d, "offset": offset, "value": statistics.median(v for _, v, _ in values), "n": len(values),
            "values": ";".join(t for t, _, _ in sorted(values, key=lambda x: x[1])), "sources": "+".join(sorted({s for _, _, s in values}))}


def _fmt(value, decimals):
    """Round half up at the shortest decimal form of the value (103.05 -> 103.1), not at its binary expansion."""
    if value is None or not np.isfinite(value):
        return ""
    return str(Decimal(repr(float(value))).quantize(Decimal(1).scaleb(-decimals), rounding=ROUND_HALF_UP))


def recompute_egfr(scr_pick, height_points, patient, config):
    """eGFR from the creatinine selected for a time point (registry equations); returns (value, formula, status, age, height pick)."""
    day = scr_pick["date"]
    by = number(patient.get("birth_year", ""))
    age = day.year - by if np.isfinite(by) and float(by).is_integer() else np.nan
    sex = str(patient.get("sex", "")).strip().upper()
    if not np.isfinite(age) or sex not in {"M", "F"}:
        return np.nan, "", "missing_sex_or_birth_year", age, None
    scr_mg_dl = scr_pick["value"] / 88.4
    if 18 <= age <= 120:
        return ckdepi2021(scr_mg_dl, age, sex), config["adult_equation"], "computed", age, None
    if 1 <= age <= 17:
        hw = config["height_window_days"]
        height = select(height_points, day, 0, -hw, hw)
        if height is None:
            return np.nan, config["child_equation"], "missing_height", age, None
        value = schwartz2009(scr_mg_dl, height["value"], age)
        return value, config["child_equation"], "computed" if np.isfinite(value) else "height_out_of_range", age, height
    return np.nan, "", "age_outside_equations", age, None


def build(data_dir, config, allow_fully_excluded_centers=False):
    frames = load_tables(data_dir)
    frames, consent = apply_consent_filter(frames)
    message = consent_failure_message(consent)
    if message and not allow_fully_excluded_centers:
        raise DataContractError(message)
    patients = frames["patients_baseline"]
    anchors, missing = find_anchors(patients, frames["biopsies_long"], config["anchor"]["sources"])
    issues = []
    labs_norm = normalize_labs(frames["labs_long"], issues)
    series = {v["name"]: measurements(frames, labs_norm, v) for v in config["variables"]}
    by_key = {_key(p): p for p in patients.to_dict("records")}
    long_rows, wide_rows = [], []
    egfr = config["egfr"]
    for key in sorted(anchors):
        p = by_key[key]
        anchor, source, kind = anchors[key]
        base = {**dict(zip(KEY, key)), "module": p.get("module", ""), "anchor_date": anchor.date().isoformat(), "anchor_source": source}
        wide = {**base, "anchor_biopsy_kind": kind}
        for tp in config["timepoints"]:
            lo, hi = tp["window_days"]
            frame = {**base, "timepoint": tp["name"], "target_days": tp["target_days"], "window_from_days": lo, "window_to_days": hi}
            picks = {}
            for v in config["variables"]:
                pick = select(series[v["name"]][0].get(key, []), anchor, tp["target_days"], lo, hi)
                picks[v["name"]] = pick
                prefix = f"{tp['name']}_{v['name']}"
                if pick is None:
                    long_rows.append({**frame, "variable": v["name"], "unit": v["unit"], "status": "no_value_in_window"})
                    wide.update({prefix: "", f"{prefix}_date": "", f"{prefix}_n": ""})
                    continue
                value = _fmt(pick["value"], v["decimals"])
                long_rows.append({**frame, "variable": v["name"], "unit": v["unit"], "status": "selected", "value": value,
                                  "value_date": pick["date"].date().isoformat(), "offset_days": pick["offset"], "n_values_on_day": pick["n"],
                                  "values_on_day": pick["values"], "sources": pick["sources"]})
                wide.update({prefix: value, f"{prefix}_date": pick["date"].date().isoformat(), f"{prefix}_n": pick["n"]})
            if egfr:
                prefix = f"{tp['name']}_egfr"
                scr = picks[egfr["creatinine_variable"]]
                if scr is None:
                    long_rows.append({**frame, "variable": "egfr", "unit": EGFR_UNIT, "status": "no_creatinine_in_window"})
                    wide.update({prefix: "", f"{prefix}_formula": ""})
                    continue
                value, formula, status, age, height = recompute_egfr(scr, series[egfr["height_variable"]][0].get(key, []), p, egfr)
                long_rows.append({**frame, "variable": "egfr", "unit": EGFR_UNIT, "status": status, "value": _fmt(value, 1),
                                  "value_date": scr["date"].date().isoformat(), "offset_days": scr["offset"], "sources": egfr["creatinine_variable"],
                                  "egfr_formula": formula, "age_years": "" if not np.isfinite(age) else int(age),
                                  "height_cm_used": "" if height is None else _fmt(height["value"], 1),
                                  "height_date_used": "" if height is None else height["date"].date().isoformat()})
                wide.update({prefix: _fmt(value, 1), f"{prefix}_formula": formula if np.isfinite(value) else ""})
        wide_rows.append(wide)
    excluded = [{**dict(zip(KEY, key)), "module": by_key[key].get("module", ""), "reason": reason} for key, reason in sorted(missing.items())]
    counts = {}
    for tp in config["timepoints"]:
        rows_tp = [r for r in long_rows if r["timepoint"] == tp["name"]]
        counts[tp["name"]] = {v["name"]: sum(1 for r in rows_tp if r["variable"] == v["name"] and r["status"] == "selected") for v in config["variables"]}
        if egfr:
            counts[tp["name"]]["egfr"] = sum(1 for r in rows_tp if r["variable"] == "egfr" and r["status"] == "computed")
    summary = {"patients_included_n": len(patients), "patients_with_anchor_n": len(anchors), "patients_without_anchor_n": len(missing),
               "anchor_sources": {s: sum(1 for a in anchors.values() if a[1].split(":")[0] == s) for s in config["anchor"]["sources"]},
               "without_anchor_by_reason": {r: sum(1 for x in missing.values() if x == r) for r in sorted(set(missing.values()))},
               "values_selected": counts, "unusable_measurements_skipped": {v: series[v][1] for v in series}, "consent": consent}
    return long_rows, wide_rows, excluded, summary


def write_rows(path, header, rows):
    with Path(path).open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=header, lineterminator="\n", extrasaction="raise")
        w.writeheader()
        for r in rows:
            w.writerow({k: r.get(k, "") for k in header})


def run(data_dir, config_path, out_dir, allow_fully_excluded_centers=False):
    config = load_config(config_path)
    data_dir, out_dir = Path(data_dir), Path(out_dir)
    if out_dir.is_symlink() or (out_dir.exists() and any(out_dir.iterdir())):
        raise DataContractError("output directory must be new or empty")
    if out_dir.resolve() == data_dir.resolve() or data_dir.resolve() in out_dir.resolve().parents:
        raise DataContractError("output directory must be outside the data directory")
    inputs = {p.name: sha256(p) for p in sorted(data_dir.glob("*.csv"))}
    long_rows, wide_rows, excluded, summary = build(data_dir, config, allow_fully_excluded_centers)
    if any(sha256(data_dir/name) != digest for name, digest in inputs.items()):
        raise DataContractError("input files changed during the run; freeze the export and retry")
    out_dir.mkdir(parents=True, exist_ok=True)
    prefix = "" if config["confirmed"] else "UNCONFIRMED_"
    wide_header = KEY + ["module", "anchor_date", "anchor_source", "anchor_biopsy_kind"]
    for tp in config["timepoints"]:
        for v in config["variables"]:
            wide_header += [f"{tp['name']}_{v['name']}", f"{tp['name']}_{v['name']}_date", f"{tp['name']}_{v['name']}_n"]
        if config["egfr"]:
            wide_header += [f"{tp['name']}_egfr", f"{tp['name']}_egfr_formula"]
    files = {f"{prefix}time_windows_long.csv": (LONG_COLUMNS, long_rows),
             f"{prefix}time_windows_wide.csv": (wide_header, wide_rows),
             f"{prefix}time_windows_no_anchor.csv": (KEY + ["module", "reason"], excluded)}
    for name, (header, rows) in files.items():
        write_rows(out_dir/name, header, rows)
    log = {"script": SCRIPT_VERSION, "analysis_core": VERSION, "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
           "confirmed": config["confirmed"], "confirmed_by": config["confirmed_by"], "confirmed_date": config["confirmed_date"],
           "note": ("配置已由研究团队确认。" if config["confirmed"] else
                    "配置尚未确认：时间点、窗口与变量为模板或草稿，输出文件以 UNCONFIRMED_ 开头，不能作为正式分析数据。"),
           "selection_rule": "窗口内取距目标日最近的一天；距离相同取较早的一天；同一天多个值取中位数。窗口边界包含在内。",
           "allow_fully_excluded_centers": bool(allow_fully_excluded_centers),
           "config": config, "config_sha256": sha256(config_path), "input_sha256": inputs,
           "output_sha256": {name: sha256(out_dir/name) for name in files}, **summary}
    (out_dir/f"{prefix}TIME_WINDOWS_LOG.json").write_text(json.dumps(log, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    return out_dir, log


def main(argv=None):
    parser = argparse.ArgumentParser(description="Biopsy-anchored time-window table (nearest day; ties -> earlier; same day -> median).")
    parser.add_argument("--data", required=True, help="directory with the exported CSV files (analysis/data)")
    parser.add_argument("--config", required=True, help="time-window configuration JSON (see time_windows_template.json)")
    parser.add_argument("--out", required=True, help="new or empty output directory")
    parser.add_argument("--allow-fully-excluded-centers", action="store_true",
                        help="proceed when consent filtering leaves a project/center with no patient (recorded in the log)")
    args = parser.parse_args(argv)
    try:
        out_dir, log = run(args.data, args.config, args.out, args.allow_fully_excluded_centers)
    except (ConfigError, DataContractError) as exc:
        print(f"未生成时间窗数据表：{exc}", file=sys.stderr)
        return 2
    state = "已确认配置" if log["confirmed"] else "配置未确认（文件名带 UNCONFIRMED_）"
    print(f"时间窗数据表已写入 {out_dir}（{state}）：纳入 {log['patients_included_n']} 人，有对齐日期 {log['patients_with_anchor_n']} 人，"
          f"无对齐日期 {log['patients_without_anchor_n']} 人。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
