"""Tests for the eGFR equations in site/assets/template/run_analysis.py.

Run: python3 -I -m unittest discover -s tests -p "test_analysis*.py"
Reference values were computed from the published piecewise forms (separately from the
implementation's min/max form): CKD-EPI 2012 cystatin C and CKD-EPI 2021 creatinine-cystatin C
(Inker 2012, 2021) and the CKiD U25 creatinine and cystatin C equations (Pierce 2021). The two
adult values for a 50-year-old man with creatinine 1.0 mg/dL and cystatin C 1.0 mg/L agree with
the NKF calculators (81 and 88 mL/min/1.73 m²).
"""
from __future__ import annotations

import math
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "site" / "assets" / "template"))
import run_analysis as ra  # noqa: E402


class CystatinEquationTests(unittest.TestCase):
    def close(self, actual, expected):
        self.assertTrue(math.isclose(actual, expected, rel_tol=1e-9), f"{actual} != {expected}")

    def test_adult_cystatin_c_equation_ckd_epi_2012(self):
        self.close(ra.ckdepi2012_cys(1.0, 50, "M"), 80.93233394899187)
        self.close(ra.ckdepi2012_cys(0.7, 30, "F"), 117.48588361483512)
        self.close(ra.ckdepi2012_cys(0.8, 40, "m"), 133 * 0.996**40)
        for args in [(0, 50, "M"), (-1, 50, "M"), (1.0, 17, "M"), (1.0, 121, "F"), (1.0, 50, ""), (1.0, 50, "U"), ("", 50, "M")]:
            self.assertTrue(math.isnan(ra.ckdepi2012_cys(*args)), args)

    def test_adult_creatinine_cystatin_c_equation_ckd_epi_2021(self):
        self.close(ra.ckdepi2021_crcys(1.0, 1.0, 50, "M"), 88.14399054363913)
        self.close(ra.ckdepi2021_crcys(0.6, 1.2, 60, "F"), 77.58875959887894)
        self.close(ra.ckdepi2021_crcys(0.9, 0.8, 40, "M"), 135 * 0.9961**40)
        for args in [(0, 1.0, 50, "M"), (1.0, 0, 50, "M"), (1.0, 1.0, 17, "M"), (1.0, 1.0, 50, "X")]:
            self.assertTrue(math.isnan(ra.ckdepi2021_crcys(*args)), args)

    def test_ckid_u25_creatinine_equation_uses_height_in_metres_and_sex_and_age_specific_k(self):
        self.close(ra.ckid_u25_cr(0.5, 140, 10, "M"), 107.47354497354497)
        self.close(ra.ckid_u25_cr(0.7, 160, 14, "M"), 97.34622857142855)
        self.close(ra.ckid_u25_cr(0.4, 125, 8, "F"), 109.27356076824421)
        self.close(ra.ckid_u25_cr(0.7, 160, 16, "F"), 90.3715392389945)
        self.close(ra.ckid_u25_cr(0.5, 150, 12, "M"), 39.0 * 1.5 / 0.5)
        for args in [(0.5, 140, 18, "M"), (0.5, 140, 0, "M"), (0.5, 29, 10, "M"), (0.5, 251, 10, "F"), (0, 140, 10, "M"), (0.5, 140, 10, "")]:
            self.assertTrue(math.isnan(ra.ckid_u25_cr(*args)), args)

    def test_ckid_u25_cystatin_c_equation(self):
        self.close(ra.ckid_u25_cys(0.9, 10, "M"), 91.73143713228185)
        self.close(ra.ckid_u25_cys(1.0, 16, "M"), 83.712)
        self.close(ra.ckid_u25_cys(0.9, 10, "F"), 88.07179427487043)
        self.close(ra.ckid_u25_cys(1.1, 15, "F"), 67.11675716145453)
        self.close(ra.ckid_u25_cys(1.0, 15, "M"), 87.2)
        self.close(ra.ckid_u25_cys(1.0, 12, "F"), 79.9)
        for args in [(1.0, 18, "M"), (1.0, 0, "F"), (0, 10, "M"), (1.0, 10, "")]:
            self.assertTrue(math.isnan(ra.ckid_u25_cys(*args)), args)

    def test_existing_creatinine_equations_are_unchanged(self):
        self.close(ra.ckdepi2021(1.0, 50, "M"), 142 * (1.0 / 0.9)**-1.200 * 0.9938**50)
        self.close(ra.schwartz2009(0.5, 140, 10), 0.413 * 140 / 0.5)


class UrineRedCellUnitTests(unittest.TestCase):
    def test_counts_per_microlitre_and_per_high_power_field_are_never_converted_into_each_other(self):
        self.assertEqual(ra.LAB_UNITS["CYSC"], ("mg/L", {"mg/L": 1}))
        ul_target, ul_units = ra.LAB_UNITS["URBC_UL"]
        hpf_target, hpf_units = ra.LAB_UNITS["URBC_HPF"]
        self.assertEqual((ul_target, hpf_target), ("cells/μL", "cells/HPF"))
        self.assertFalse(set(ul_units) & set(hpf_units), "no unit spelling belongs to both tests")
        self.assertTrue(all(factor == 1 for factor in [*ul_units.values(), *hpf_units.values()]))
        self.assertEqual(set(hpf_units), {"cells/HPF", "个/HPF", "/HPF", "个/HP", "/HP"})
        self.assertEqual(set(ul_units), {"cells/μL", "个/μL", "/μL"})


if __name__ == "__main__":
    unittest.main()
