"""Tests for site/assets/template/feasibility_report.py (per-centre feasibility counts).

Run: python3 -I -m unittest discover -s tests -p "test_analysis*.py"
Synthetic data only: fictitious project IDs and patient codes built inside the tests.
"""
from __future__ import annotations

import csv
import json
import shutil
import sys
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "site" / "assets" / "template"
sys.path.insert(0, str(TEMPLATE))
import run_analysis as ra  # noqa: E402
import feasibility_report as fr  # noqa: E402

SP = "00000000-0000-4000-8000-0000000000fe"
B0 = date(2024, 1, 1)
BASE_HEADER = ra.KEY + ["id", "module", "sex", "birth_year", "baseline_date", "baseline_scr", "baseline_upcr", "baseline_upcr_unit", "consent_status"]
VISIT_HEADER = ra.KEY + ["id", "module", "visit_date", "sbp", "dbp", "scr_umol_l", "upcr", "egfr", "egfr_formula_version", "height_cm"]


def day(n):
    return (B0 + timedelta(days=n)).isoformat()


def write_csv(path, header, rows):
    with Path(path).open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=header, lineterminator="\n")
        w.writeheader()
        w.writerows([{k: r.get(k, "") for k in header} for r in rows])


def make_data(folder, patients):
    """patients: dicts with code, center, module, birth_year, consent and visits
    [(day, scr_umol_l, upcr_mg_g, formula_version, height_cm)]."""
    base, visits = [], []
    for p in patients:
        center, module = p.get("center", "A"), p.get("module", "IGAN")
        base.append({"project_id": SP, "center_code": center, "patient_code": p["code"], "id": f"b{center}{p['code']}", "module": module,
                     "sex": p.get("sex", "M"), "birth_year": str(p["birth_year"]), "baseline_date": day(0), "baseline_scr": "80",
                     "baseline_upcr": "2000", "baseline_upcr_unit": "mg/g", "consent_status": p.get("consent", "consented")})
        for j, (d, scr, upcr, version, height) in enumerate(p.get("visits", []), start=1):
            visits.append({"project_id": SP, "center_code": center, "patient_code": p["code"], "id": f"v{center}{p['code']}-{j}", "module": module,
                           "visit_date": day(d), "sbp": "120", "dbp": "80", "scr_umol_l": str(scr), "upcr": str(upcr), "egfr": "",
                           "egfr_formula_version": version, "height_cm": "" if height is None else str(height)})
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    write_csv(folder / "patients_baseline.csv", BASE_HEADER, base)
    write_csv(folder / "visits_long.csv", VISIT_HEADER, visits)
    return folder


def criteria(folder, **overrides):
    raw = json.loads((TEMPLATE / "feasibility_criteria_template.json").read_text(encoding="utf-8"))
    raw.update({"status": "confirmed", "confirmed_by": "Synthetic PI", "confirmed_date": "2026-01-01",
                "modules": ["IGAN", "C3G"], "age_at_baseline": {"min": 1, "max": 75},
                "latest_egfr": {"min": 30, "max": None, "within_days": 365},
                "latest_upcr_mg_g": {"min": 1000, "max": None, "within_days": 365},
                "last_visit_within_days": 365})
    raw.update(overrides)
    path = Path(folder) / "criteria.json"
    path.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
    return path


class FeasibilityReportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="feasibility-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        # One disease module per project/centre (analysis contract). A (IgAN): adult meeting
        # everything; adult with low UPCR; unconsented adult. C (C3G): child with height
        # (Schwartz eGFR 0.413*140/(50/88.4) = 102.2); child without height (no eGFR).
        # B (LN, module excluded): one recent patient and one whose only visit is old.
        self.data = make_data(self.tmp / "data", [
            {"code": "001", "birth_year": 1980, "visits": [(30, 100, 1500, "CKD-EPI-2021-Cr", None), (300, 110, 1800, "CKD-EPI-2021-Cr", None)]},
            {"code": "002", "birth_year": 1975, "visits": [(300, 90, 400, "CKD-EPI-2021-Cr", None)]},
            {"code": "005", "birth_year": 1970, "consent": "unconfirmed", "visits": [(300, 100, 1500, "CKD-EPI-2021-Cr", None)]},
            {"code": "003", "center": "C", "module": "C3G", "birth_year": 2014, "visits": [(300, 50, 1200, "Schwartz-2009-bedside", 140)]},
            {"code": "004", "center": "C", "module": "C3G", "birth_year": 2014, "visits": [(300, 50, 1200, "Schwartz-2009-bedside", None)]},
            {"code": "101", "center": "B", "module": "LN", "birth_year": 1985, "visits": [(300, 100, 1500, "CKD-EPI-2021-Cr", None)]},
            {"code": "102", "center": "B", "module": "LN", "birth_year": 1985, "visits": [(-400, 100, 1500, "CKD-EPI-2021-Cr", None)]},
        ])

    def test_template_is_refused_until_confirmed(self):
        with self.assertRaisesRegex(fr.CriteriaError, "confirmed"):
            fr.run(self.data, self.tmp / "out", TEMPLATE / "feasibility_criteria_template.json")
        with self.assertRaisesRegex(fr.CriteriaError, "min above max"):
            fr.run(self.data, self.tmp / "out", criteria(self.tmp, latest_egfr={"min": 90, "max": 30}))
        with self.assertRaisesRegex(fr.CriteriaError, "modules"):
            fr.run(self.data, self.tmp / "out", criteria(self.tmp, modules=["XYZ"]))

    def test_counts_per_center_without_patient_codes(self):
        log, summary = fr.run(self.data, self.tmp / "out", criteria(self.tmp))
        by = {(r["project_id"], r["center_code"]): r for r in summary}
        a, b, c, total = by[(SP, "A")], by[(SP, "B")], by[(SP, "C")], by[("ALL", "ALL")]
        self.assertEqual(log["as_of_date"], day(300), "default reference date is the latest visit")
        self.assertEqual([a["consent_excluded_n"], a["included_patients_n"], a["with_visit_n"]], [1, 2, 2])
        self.assertEqual([a["module_n"], a["age_n"], a["egfr_n"], a["upcr_n"], a["recent_visit_n"], a["all_criteria_n"]], [2, 2, 2, 1, 2, 1], "002 fails on UPCR only")
        self.assertEqual([c["included_patients_n"], c["module_n"], c["age_n"], c["egfr_n"], c["upcr_n"], c["all_criteria_n"]], [2, 2, 2, 1, 2, 1],
                         "child 003 counts through the Schwartz eGFR from its visit height; 004 without height has no eGFR")
        self.assertEqual([b["included_patients_n"], b["module_n"], b["egfr_n"], b["recent_visit_n"], b["all_criteria_n"]], [2, 0, 1, 1, 0])
        self.assertEqual([total["included_patients_n"], total["consent_excluded_n"], total["all_criteria_n"]], [6, 1, 2])
        text = (self.tmp / "out" / "feasibility_by_center.csv").read_text(encoding="utf-8") + (self.tmp / "out" / "FEASIBILITY_RUN_LOG.json").read_text(encoding="utf-8")
        for code in ["001", "002", "003", "004", "005", "101", "102"]:
            self.assertNotRegex(text, rf"\b{code}\b", "outputs carry counts only, never patient codes")
        self.assertEqual(log["criteria"]["criteria_id"], "FEAS-TEMPLATE")
        self.assertIn("patients_baseline.csv", log["input_sha256"])
        self.assertTrue(log["consent_filter"]["applied"])

    def test_explicit_as_of_and_recency_window(self):
        log, summary = fr.run(self.data, self.tmp / "out2", criteria(self.tmp, last_visit_within_days=100), as_of=day(60))
        a = next(r for r in summary if r["center_code"] == "A")
        self.assertEqual(log["as_of_date"], day(60))
        self.assertEqual(a["recent_visit_n"], 1, "only 001's day-30 visit is within 100 days of the reference date")
        self.assertEqual(a["all_criteria_n"], 1)

    def test_pack_template_is_consistent(self):
        raw = json.loads((TEMPLATE / "feasibility_criteria_template.json").read_text(encoding="utf-8"))
        self.assertEqual(raw["schema"], fr.CRITERIA_SCHEMA)
        self.assertNotEqual(raw["status"], "confirmed")


if __name__ == "__main__":
    unittest.main()
