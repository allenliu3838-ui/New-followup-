"""Tests for site/assets/template/imaging_metrics.py (htTKV, Mayo imaging class, kidney length).

Run: python3 -I -m unittest discover -s tests -p "test_analysis*.py"
Synthetic data only: fictitious project IDs and patient codes built inside the tests.
"""
from __future__ import annotations

import csv
import json
import math
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "site" / "assets" / "template"
sys.path.insert(0, str(TEMPLATE))
import run_analysis as ra  # noqa: E402
import imaging_metrics as im  # noqa: E402

PID = "00000000-0000-4000-8000-0000000000e1"
IDENT = {"project_id": PID, "center_code": "PKD01", "module": "ADPKD"}
BASE_HEADER = ra.KEY + ["id", "module", "sex", "birth_year", "baseline_date", "baseline_scr", "baseline_upcr", "baseline_upcr_unit", "consent_status"]
VISIT_HEADER = ra.KEY + ["id", "module", "visit_date", "sbp", "scr_umol_l", "height_cm"]
IMAGING_HEADER = ra.TABLE_COLUMNS["imaging_long"]


def write_csv(path, header, rows):
    with Path(path).open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=header, lineterminator="\n")
        w.writeheader()
        w.writerows([{k: r.get(k, "") for k in header} for r in rows])


def tkv(l1, w1, d1, l2, w2, d2):
    return round(math.pi / 6 * (l1 * w1 * d1 + l2 * w2 * d2), 1)


class ImagingMetricsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.data = self.tmp / "data"
        self.data.mkdir()
        patients = [("A1", 1985, "consented"), ("A2", 1985, "consented"), ("A3", 2015, "consented"), ("A4", 1985, "declined")]
        write_csv(self.data / "patients_baseline.csv", BASE_HEADER,
                  [{**IDENT, "patient_code": c, "id": f"b{i}", "sex": "F", "birth_year": y, "baseline_date": "2024-01-01",
                    "baseline_scr": "90", "consent_status": s} for i, (c, y, s) in enumerate(patients)])
        write_csv(self.data / "visits_long.csv", VISIT_HEADER, [
            {**IDENT, "patient_code": "A1", "id": "v1", "visit_date": "2024-01-01", "scr_umol_l": "90", "height_cm": "170"},
            {**IDENT, "patient_code": "A1", "id": "v2", "visit_date": "2025-06-20", "scr_umol_l": "90", "height_cm": "160"},
            {**IDENT, "patient_code": "A1", "id": "v3", "visit_date": "2024-07-01", "scr_umol_l": "90", "height_cm": "166"},
            {**IDENT, "patient_code": "A1", "id": "v4", "visit_date": "2024-07-01", "scr_umol_l": "91", "height_cm": "168"},
            {**IDENT, "patient_code": "A2", "id": "v5", "visit_date": "2022-01-01", "scr_umol_l": "90", "height_cm": "165"},
            {**IDENT, "patient_code": "A3", "id": "v6", "visit_date": "2024-02-01", "scr_umol_l": "40", "height_cm": "120"},
        ])
        big = dict(left_length_cm="18.2", left_width_cm="9.1", left_depth_cm="8.4", right_length_cm="17.5", right_width_cm="8.8", right_depth_cm="8.0")
        self.big_tkv = tkv(18.2, 9.1, 8.4, 17.5, 8.8, 8.0)
        write_csv(self.data / "imaging_long.csv", IMAGING_HEADER, [
            # A1, 2024-06-30: height = median of the two 2024-07-01 heights (one day away, nearer than 2024-01-01).
            {**IDENT, "patient_code": "A1", "id": "i1", "exam_date": "2024-06-30", "modality": "mri", **big, "tkv_ml": str(self.big_tkv),
             "liver_cysts": "present", "mayo_image_class": "typical"},
            {**IDENT, "patient_code": "A1", "id": "i2", "exam_date": "2024-06-30", "modality": "ultrasound", "left_length_cm": "17.0",
             "right_length_cm": "16.2"},
            {**IDENT, "patient_code": "A1", "id": "i3", "exam_date": "2024-05-01", "modality": "ct", **big, "tkv_ml": str(self.big_tkv),
             "mayo_image_class": "atypical"},
            # A2: the only height is more than a year before the examination.
            {**IDENT, "patient_code": "A2", "id": "i4", "exam_date": "2024-06-01", "modality": "mri", **big, "tkv_ml": str(self.big_tkv),
             "mayo_image_class": "typical"},
            # A3 is 9 years old: outside the Mayo age range.
            {**IDENT, "patient_code": "A3", "id": "i5", "exam_date": "2024-02-01", "modality": "mri", **big, "tkv_ml": str(self.big_tkv),
             "mayo_image_class": "typical"},
            # A4 declined consent: not in the population.
            {**IDENT, "patient_code": "A4", "id": "i6", "exam_date": "2024-02-01", "modality": "ultrasound", "left_length_cm": "15"},
        ])

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def test_classes_follow_irazabal_growth_rate(self):
        # Growth = ((htTKV/150)^(1/age) - 1) x 100; class limits 1.5, 3, 4.5, 6 % per year.
        self.assertEqual(im.mayo_class(150 * 1.01 ** 40, 40)[1], "1A")
        self.assertEqual(im.mayo_class(150 * 1.0149 ** 40, 40)[1], "1A")
        self.assertEqual(im.mayo_class(150 * 1.0151 ** 40, 40)[1], "1B")
        self.assertEqual(im.mayo_class(150 * 1.035 ** 40, 40)[1], "1C")
        self.assertEqual(im.mayo_class(150 * 1.05 ** 40, 40)[1], "1D")
        self.assertEqual(im.mayo_class(150 * 1.061 ** 40, 40)[1], "1E")
        growth, _ = im.mayo_class(150 * 1.02 ** 30, 30)
        self.assertAlmostEqual(growth, 2.0, places=9)

    def test_records_heights_reasons_and_population(self):
        out, log = im.run(self.data, self.tmp / "out")
        with (out / "imaging_metrics.csv").open(encoding="utf-8-sig") as f:
            rows = {r["imaging_id"]: r for r in csv.DictReader(f)}
        self.assertEqual(set(rows), {"i1", "i2", "i3", "i4", "i5"}, "the declined patient is not in the population")
        r = rows["i1"]
        self.assertEqual((r["height_cm_used"], r["height_date_used"]), ("167.0", "2024-07-01"), "nearest day; same day -> median")
        httkv = self.big_tkv / 1.67
        self.assertEqual(r["httkv_ml_m"], f"{httkv:.1f}")
        self.assertEqual(r["age_years"], "39")
        growth, cls = im.mayo_class(httkv, 39)
        self.assertEqual((r["mayo_class"], r["mayo_growth_pct_per_year"], r["mayo_reason"]), (cls, f"{growth:.2f}", "graded"))
        self.assertEqual((rows["i2"]["mayo_class"], rows["i2"]["mayo_reason"]), ("", "not_ct_or_mri"))
        self.assertEqual((rows["i2"]["max_length_cm"], rows["i2"]["length_over_16_5_cm"]), ("17.0", "yes"))
        self.assertEqual(rows["i2"]["httkv_ml_m"], "", "no TKV without six diameters")
        self.assertEqual(rows["i3"]["mayo_reason"], "atypical_class_2_not_graded")
        self.assertEqual((rows["i4"]["mayo_reason"], rows["i4"]["height_cm_used"]), ("no_height_in_window", ""))
        self.assertEqual(rows["i5"]["mayo_reason"], "age_outside_15_80")
        self.assertEqual((log["records_n"], log["patients_n"], log["mayo_graded_n"]), (5, 3, 1))
        self.assertIn("须由研究者核对", log["note"])

    def test_wider_height_window_and_refusals(self):
        _, log = im.run(self.data, self.tmp / "wide", height_window=900)
        self.assertEqual(log["mayo_graded_n"], 2, "A2's earlier height counts with a 900-day window")
        (self.tmp / "busy").mkdir()
        (self.tmp / "busy" / "old.csv").write_text("x", encoding="utf-8")
        with self.assertRaises(ra.DataContractError):
            im.run(self.data, self.tmp / "busy")
        with self.assertRaises(ra.DataContractError):
            im.run(self.data, self.data / "inside")
        (self.data / "imaging_long.csv").unlink()
        with self.assertRaisesRegex(ra.DataContractError, "imaging_long.csv is missing"):
            im.run(self.data, self.tmp / "none")

    def test_command_line(self):
        self.assertEqual(im.main(["--data", str(self.data), "--out", str(self.tmp / "cli")]), 0)
        log = json.loads((self.tmp / "cli" / "IMAGING_METRICS_LOG.json").read_text(encoding="utf-8"))
        self.assertEqual(log["classes"][next(c for c, n in log["classes"].items() if n)], 1)


if __name__ == "__main__":
    unittest.main()
