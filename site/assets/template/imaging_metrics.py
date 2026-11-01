"""Kidney imaging measures from imaging_long.csv (KidneySphere analysis pack).

For every imaging record of an included patient it reports:
  * tkv_ml: total kidney volume as the registry computed it (ellipsoid, pi/6 x length x width x
    depth, both kidneys added); empty unless all six diameters were recorded;
  * height-adjusted TKV (htTKV, mL/m) = tkv_ml / height in metres, with the visit height
    (visits_long.height_cm) nearest to the examination day within --height-window-days
    (default 365; equally near -> the earlier day; several heights on one day -> median);
  * the Mayo imaging class 1A-1E (Irazabal et al., J Am Soc Nephrol 2015;26:160-172), only for
    CT or MRI records marked typical (class 1), with htTKV and an age of 15-80 years:
        estimated yearly growth = ((htTKV / 150) ** (1 / age) - 1) x 100 %
        1A < 1.5, 1B 1.5 to < 3, 1C 3 to < 4.5, 1D 4.5 to < 6, 1E >= 6;
    records that are not graded say why (mayo_reason);
  * the longer of the two ultrasound kidney lengths and whether it exceeds 16.5 cm (the cut-off
    reported by Bhutani et al., Kidney Int 2015;88:146-151, in the CRISP cohort aged 15-46).

Age is the calendar-year age (examination year - birth year), as elsewhere in the pack, so it can
be one year off; the Mayo class near a boundary must be checked against the exact age.
Every value here is computed by this program from the registry's records. It is not a clinical
report: the TKV is an ellipsoid estimate, not a segmentation, and the class must be reviewed by
the investigators before use. The population is that of run_analysis.py (consent_status
consented/waiver when the column exists).

Run:  python3 imaging_metrics.py --data data --out imaging
No database/network access; the input CSVs are never changed.
"""
from __future__ import annotations

import argparse
import csv
import json
import statistics
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from run_analysis import (KEY, VERSION, DataContractError, apply_consent_filter, consent_failure_message,  # noqa: E402
                          date, load_tables, number, sha256)

SCRIPT_VERSION = "imaging-metrics-v1"
MAYO_BASE_HTTKV = 150.0  # mL/m, the assumed htTKV at birth of the Mayo classification
MAYO_CLASSES = ((1.5, "1A"), (3.0, "1B"), (4.5, "1C"), (6.0, "1D"))
MAYO_AGE = (15, 80)
LENGTH_CUTOFF_CM = 16.5
DIMENSIONS = ("left_length_cm", "left_width_cm", "left_depth_cm", "right_length_cm", "right_width_cm", "right_depth_cm")
COLUMNS = KEY + ["module", "imaging_id", "exam_date", "modality", *DIMENSIONS, "tkv_ml", "liver_cysts", "mayo_image_class",
                 "age_years", "height_cm_used", "height_date_used", "httkv_ml_m", "mayo_growth_pct_per_year", "mayo_class",
                 "mayo_reason", "max_length_cm", "length_over_16_5_cm"]


def _fmt(value, decimals):
    return "" if value is None or not np.isfinite(value) else f"{value:.{decimals}f}"


def mayo_class(httkv, age):
    """(estimated growth % per year, class 1A-1E) from htTKV (mL/m) and age (years)."""
    growth = ((httkv / MAYO_BASE_HTTKV) ** (1 / age) - 1) * 100
    for limit, name in MAYO_CLASSES:
        if growth < limit:
            return growth, name
    return growth, "1E"


def nearest_height(points, day, window):
    """The height nearest to day within +/- window days; equally near -> earlier; same day -> median."""
    by_day = {}
    for d, cm in points:
        if abs((d - day).days) <= window:
            by_day.setdefault(d, []).append(cm)
    if not by_day:
        return None
    d = min(by_day, key=lambda x: (abs((x - day).days), x))
    return d, statistics.median(by_day[d])


def measure(imaging, patients, visits, height_window=365):
    heights = {}
    for v in visits.to_dict("records"):
        d, cm = date(v.get("visit_date", "")), number(v.get("height_cm", ""))
        if pd.notna(d) and np.isfinite(cm) and cm > 0:
            heights.setdefault(tuple(v[k] for k in KEY), []).append((d, cm))
    people = {tuple(p[k] for k in KEY): p for p in patients.to_dict("records")}
    rows = []
    for r in imaging.to_dict("records"):
        key = tuple(r[k] for k in KEY)
        p = people.get(key)
        if p is None:
            continue
        day = date(r.get("exam_date", ""))
        modality = str(r.get("modality", "")).strip()
        image_class = str(r.get("mayo_image_class", "")).strip()
        tkv = number(r.get("tkv_ml", ""))
        by = number(p.get("birth_year", ""))
        age = day.year - by if pd.notna(day) and np.isfinite(by) and float(by).is_integer() else np.nan
        height = nearest_height(heights.get(key, []), day, height_window) if pd.notna(day) else None
        httkv = tkv / (height[1] / 100) if height and np.isfinite(tkv) else np.nan
        growth, cls, reason = np.nan, "", ""
        if modality not in ("ct", "mri"):
            reason = "not_ct_or_mri"
        elif image_class == "atypical":
            reason = "atypical_class_2_not_graded"
        elif image_class != "typical":
            reason = "image_class_not_recorded"
        elif not np.isfinite(tkv):
            reason = "no_tkv"
        elif height is None:
            reason = "no_height_in_window"
        elif not np.isfinite(age) or not MAYO_AGE[0] <= age <= MAYO_AGE[1]:
            reason = "age_outside_15_80"
        else:
            growth, cls = mayo_class(httkv, age)
            reason = "graded"
        lengths = [number(r.get(c, "")) for c in ("left_length_cm", "right_length_cm")]
        lengths = [x for x in lengths if np.isfinite(x)]
        longest = max(lengths) if lengths else np.nan
        rows.append({**{k: r[k] for k in KEY}, "module": r.get("module", ""), "imaging_id": r.get("id", ""),
                     "exam_date": "" if pd.isna(day) else day.date().isoformat(), "modality": modality,
                     **{c: str(r.get(c, "")).strip() for c in DIMENSIONS}, "tkv_ml": _fmt(tkv, 1),
                     "liver_cysts": str(r.get("liver_cysts", "")).strip(), "mayo_image_class": image_class,
                     "age_years": "" if not np.isfinite(age) else int(age),
                     "height_cm_used": "" if height is None else _fmt(height[1], 1),
                     "height_date_used": "" if height is None else height[0].date().isoformat(),
                     "httkv_ml_m": _fmt(httkv, 1), "mayo_growth_pct_per_year": _fmt(growth, 2), "mayo_class": cls,
                     "mayo_reason": reason, "max_length_cm": _fmt(longest, 1),
                     "length_over_16_5_cm": "" if not np.isfinite(longest) else ("yes" if longest > LENGTH_CUTOFF_CM else "no")})
    rows.sort(key=lambda x: (x["project_id"], x["center_code"], x["patient_code"], x["exam_date"], x["modality"]))
    return rows


def run(data_dir, out_dir, height_window=365, allow_fully_excluded_centers=False):
    if height_window < 0:
        raise DataContractError("--height-window-days must be >= 0")
    data_dir, out = Path(data_dir), Path(out_dir)
    if out.is_symlink() or (out.exists() and (not out.is_dir() or any(out.iterdir()))):
        raise DataContractError("--out must be a new or empty directory; earlier results must not be mixed in")
    if out.resolve() == data_dir.resolve() or data_dir.resolve() in out.resolve().parents:
        raise DataContractError("--out must be outside the data directory")
    if not (data_dir/"imaging_long.csv").is_file():
        raise DataContractError("imaging_long.csv is missing: export the analysis pack again from a registry with imaging records (v10 or later)")
    inputs = {p.name: sha256(p) for p in sorted(data_dir.glob("*.csv"))}
    frames = load_tables(data_dir)
    frames, consent = apply_consent_filter(frames)
    failure = consent_failure_message(consent)
    if failure and not allow_fully_excluded_centers:
        raise DataContractError(failure)
    rows = measure(frames["imaging_long"], frames["patients_baseline"], frames["visits_long"], height_window)
    if any(sha256(data_dir/name) != digest for name, digest in inputs.items()):
        raise DataContractError("input files changed during the run; freeze the export and retry")
    out.mkdir(parents=True, exist_ok=True)
    with (out/"imaging_metrics.csv").open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=COLUMNS, lineterminator="\n", extrasaction="raise")
        w.writeheader()
        w.writerows(rows)
    reasons = {}
    for r in rows:
        reasons[r["mayo_reason"]] = reasons.get(r["mayo_reason"], 0) + 1
    log = {"script": SCRIPT_VERSION, "analysis_core": VERSION, "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
           "records_n": len(rows), "patients_n": len({tuple(r[k] for k in KEY) for r in rows}),
           "mayo_graded_n": reasons.get("graded", 0), "mayo_reasons": dict(sorted(reasons.items())),
           "classes": {c: sum(1 for r in rows if r["mayo_class"] == c) for c in ("1A", "1B", "1C", "1D", "1E")},
           "height_window_days": height_window, "consent": consent, "allow_fully_excluded_centers": bool(allow_fully_excluded_centers),
           "input_sha256": inputs, "output_sha256": {"imaging_metrics.csv": sha256(out/"imaging_metrics.csv")},
           "definitions": {
               "tkv_ml": "registry value: ellipsoid pi/6 x length x width x depth, both kidneys added; not a segmentation",
               "httkv_ml_m": "tkv_ml / (height_cm / 100), height from the visit nearest to the examination day within the window",
               "mayo_class": "Irazabal 2015: CT or MRI, typical (class 1), age 15-80; growth = ((htTKV/150)^(1/age) - 1) x 100; 1A <1.5, 1B <3, 1C <4.5, 1D <6, 1E >=6 %/year",
               "age_years": "calendar-year age (examination year - birth year); may be one year off",
               "length_over_16_5_cm": "longer kidney length > 16.5 cm (Bhutani 2015, CRISP cohort aged 15-46)"},
           "note": "以上数值由程序按登记数据计算，不是临床报告。TKV 为椭球公式估算；Mayo 分级须由研究者核对后使用，年龄按年份相减，临界值附近请按实际年龄复核。"}
    (out/"IMAGING_METRICS_LOG.json").write_text(json.dumps(log, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    return out, log


def main(argv=None):
    parser = argparse.ArgumentParser(description="htTKV, Mayo imaging class (1A-1E) and kidney length from imaging_long.csv.")
    parser.add_argument("--data", required=True, help="directory with the exported CSV files (analysis/data)")
    parser.add_argument("--out", required=True, help="new or empty output directory")
    parser.add_argument("--height-window-days", type=int, default=365, help="height taken from the visit nearest to the examination within this many days (default 365)")
    parser.add_argument("--allow-fully-excluded-centers", action="store_true",
                        help="proceed when consent filtering leaves a project/center with no patient (recorded in the log)")
    args = parser.parse_args(argv)
    try:
        out, log = run(args.data, args.out, args.height_window_days, args.allow_fully_excluded_centers)
    except DataContractError as exc:
        print(f"未生成影像指标：{exc}", file=sys.stderr)
        return 2
    print(f"影像指标已写入 {out}：{log['records_n']} 条影像记录，{log['patients_n']} 位患者，Mayo 分级 {log['mayo_graded_n']} 条。"
          "数值由程序计算，须研究者核对后使用。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
