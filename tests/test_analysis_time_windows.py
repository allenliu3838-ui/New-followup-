"""Tests for site/assets/template/time_windows.py (biopsy-anchored time-window table).

Run: python3 -I -m unittest discover -s tests -p "test_analysis*.py"
Synthetic data only: fictitious project IDs and patient codes built inside the tests.
"""
from __future__ import annotations

import copy
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
import time_windows as tw  # noqa: E402

SP = "00000000-0000-4000-8000-0000000000fd"
SB = "00000000-0000-4000-8000-0000000000fc"
A0 = date(2024, 1, 1)
BASE_HEADER = ra.KEY + ["id", "module", "sex", "birth_year", "baseline_date", "baseline_scr", "baseline_upcr", "baseline_upcr_unit",
                        "consent_status", "biopsy_date", "ln_biopsy_date", "c3g_biopsy_date"]
VISIT_HEADER = ra.KEY + ["id", "module", "visit_date", "sbp", "dbp", "scr_umol_l", "upcr", "egfr", "egfr_formula_version", "height_cm"]
LAB_HEADER = ra.KEY + ["id", "module", "lab_date", "lab_test_code", "lab_name", "lab_value", "lab_unit", "value_raw", "unit_symbol",
                       "value_standard", "standard_unit", "measured_at"]
BIOPSY_HEADER = ra.KEY + ["id", "module", "biopsy_date", "biopsy_kind", "is_index", "glomeruli_total", "crescent_pct"]


def d(offset, start=A0):
    return (start + timedelta(days=offset)).isoformat()


def write_csv(path, header, rows):
    with Path(path).open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=header, lineterminator="\n")
        w.writeheader()
        w.writerows([{k: r.get(k, "") for k in header} for r in rows])


def read_csv(path):
    with Path(path).open(encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def make_data(folder):
    """Center A (IgAN, project SP) and center B (LN, project SB); see the test docstrings for each patient."""
    a = lambda code, **kw: {"project_id": SP, "center_code": "A", "patient_code": code, "module": "IGAN", **kw}
    b = lambda code, **kw: {"project_id": SB, "center_code": "B", "patient_code": code, "module": "LN", **kw}
    base = [
        a("P1", id="b1", sex="M", birth_year="1980", baseline_date=d(-20), consent_status="consented"),
        a("P2", id="b2", sex="F", birth_year="2014", baseline_date=d(31), consent_status="consented", biopsy_date=d(31)),
        a("P3", id="b3", sex="M", birth_year="2016", baseline_date=d(31), consent_status="waiver", biopsy_date=d(31)),
        b("P4", id="b4", sex="M", birth_year="1990", baseline_date=d(60), baseline_scr="72", baseline_upcr="2.0", baseline_upcr_unit="g/g",
          consent_status="consented", ln_biopsy_date=d(60)),
        a("P5", id="b5", sex="F", birth_year="1975", baseline_date=d(0), consent_status="consented"),
        a("P6", id="b6", sex="F", birth_year="1975", baseline_date=d(0), consent_status="unconfirmed"),
        a("P7", id="b7", sex="M", birth_year="1970", baseline_date=d(0), consent_status="consented"),
        a("P8", id="b8", sex="M", birth_year="1970", baseline_date=d(0), consent_status="consented"),
    ]
    visits = [
        a("P1", id="v1", visit_date=d(-20), scr_umol_l="100", sbp="130", dbp="80", upcr="800"),
        a("P1", id="v2", visit_date=d(20), scr_umol_l="120", sbp="120", dbp="70", upcr="600"),
        a("P1", id="v3", visit_date=d(180), scr_umol_l="90"),
        a("P1", id="v4", visit_date=d(299), scr_umol_l="999"),
        a("P1", id="v5", visit_date=d(300), scr_umol_l="95"),
        a("P2", id="v6", visit_date=d(31), scr_umol_l="50"),
        a("P2", id="v7", visit_date=d(31 - 60), height_cm="140", sbp="100"),
        a("P2", id="v8", visit_date=d(31 + 70), height_cm="142", sbp="102"),
        a("P3", id="v9", visit_date=d(31), scr_umol_l="40"),
        a("P3", id="v10", visit_date=d(31 - 200), height_cm="120", sbp="98"),
        b("P4", id="v11", visit_date=d(64), scr_umol_l="70"),
        a("P6", id="v12", visit_date=d(0), scr_umol_l="80"),
        a("P7", id="v13", visit_date=d(125 + 10), scr_umol_l="110"),
    ]
    labs = [
        a("P1", id="l1", lab_date=d(-20), lab_test_code="CREAT", value_raw="1.2", unit_symbol="mg/dL"),
        a("P1", id="l2", lab_date=d(180), lab_test_code="CREAT", value_raw="1.0", unit_symbol="mg/dL"),
        a("P1", id="l3", lab_date=d(180), lab_test_code="CREAT", value_raw="100", unit_symbol="μmol/L"),
        a("P1", id="l4", lab_date=d(180), lab_test_code="CREAT", value_raw="5", unit_symbol="mmol/L"),
    ]
    biopsies = [
        a("P1", id="x1", biopsy_date=d(0), biopsy_kind="native", is_index="true", glomeruli_total="24", crescent_pct="8.3"),
        a("P1", id="x2", biopsy_date=d(400), biopsy_kind="native", is_index="false"),
        a("P5", id="x3", biopsy_date=d(-214), biopsy_kind="native", is_index="false"),
        a("P5", id="x4", biopsy_date=d(152), biopsy_kind="native", is_index="false"),
        a("P6", id="x5", biopsy_date=d(0), biopsy_kind="native", is_index="true"),
        a("P7", id="x6", biopsy_date=d(125), biopsy_kind="transplant", is_index="true"),
    ]
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    write_csv(folder / "patients_baseline.csv", BASE_HEADER, base)
    write_csv(folder / "visits_long.csv", VISIT_HEADER, visits)
    write_csv(folder / "labs_long.csv", LAB_HEADER, labs)
    write_csv(folder / "biopsies_long.csv", BIOPSY_HEADER, biopsies)
    return folder


def config(folder, **changes):
    raw = json.loads((TEMPLATE / "time_windows_template.json").read_text(encoding="utf-8"))
    raw.update({"confirmed": True, "confirmed_by": "Synthetic PI", "confirmed_date": "2026-01-01",
                "timepoints": [{"name": "Bx", "target_days": 0, "window_days": [-90, 30]},
                               {"name": "M6", "target_days": 182, "window_days": [120, 240]},
                               {"name": "M12", "target_days": 365, "window_days": [300, 430]},
                               {"name": "M24", "target_days": 730, "window_days": [640, 820]}]})
    raw.update(changes)
    path = Path(folder) / "config.json"
    path.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
    return path


class TimeWindowTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="time-windows-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.data = make_data(self.tmp / "data")

    def run_tw(self, name="out", **changes):
        out, log = tw.run(self.data, config(self.tmp, **changes), self.tmp / name)
        prefix = "" if log["confirmed"] else "UNCONFIRMED_"
        rows = read_csv(out / f"{prefix}time_windows_long.csv")
        pick = {(r["patient_code"], r["timepoint"], r["variable"]): r for r in rows}
        return out, log, rows, pick

    def test_nearest_day_ties_go_to_the_earlier_day_and_same_day_values_give_the_median(self):
        """P1: index biopsy on day 0. Day -20 has a visit creatinine (100) and a lab creatinine (1.2 mg/dL = 106.08 μmol/L);
        day +20 has 120. Equally near -> day -20, median of its two values. Day 180 has three usable values (90, 88.4, 100)
        and one lab in an unconvertible unit; day 299 is outside M12's window, day 300 is on its edge."""
        _, log, _, pick = self.run_tw()
        bx = pick[("P1", "Bx", "scr_umol_l")]
        self.assertEqual((bx["value"], bx["value_date"], bx["offset_days"], bx["n_values_on_day"]), ("103.0", d(-20), "-20", "2"))
        self.assertEqual(bx["values_on_day"], "100;106.08")
        self.assertEqual(bx["sources"], "labs_long:CREAT+visits_long:scr_umol_l")
        self.assertEqual((pick[("P1", "Bx", "sbp")]["value"], pick[("P1", "Bx", "sbp")]["value_date"]), ("130", d(-20)), "tie -> earlier day")
        m6 = pick[("P1", "M6", "scr_umol_l")]
        self.assertEqual((m6["value"], m6["n_values_on_day"], m6["offset_days"]), ("90.0", "3", "180"))
        m12 = pick[("P1", "M12", "scr_umol_l")]
        self.assertEqual((m12["value"], m12["offset_days"]), ("95.0", "300"), "the window edge is included, the day before it is not")
        self.assertEqual(pick[("P1", "M24", "scr_umol_l")]["status"], "no_value_in_window")
        self.assertEqual(pick[("P1", "M24", "scr_umol_l")]["value"], "")
        self.assertEqual(log["unusable_measurements_skipped"]["scr_umol_l"], 1, "the mmol/L lab is not converted by guess")
        egfr = pick[("P1", "Bx", "egfr")]
        expected = ra.ckdepi2021(103.04 / 88.4, 2023 - 1980, "M")
        self.assertEqual((egfr["status"], egfr["egfr_formula"], egfr["value"], egfr["age_years"], egfr["value_date"]),
                         ("computed", "CKD-EPI-2021-Cr", f"{expected:.1f}", "43", d(-20)))

    def test_anchor_sources_follow_the_configured_order(self):
        """P1 index biopsy; P2/P3 IgAN baseline biopsy_date; P4 LN ln_biopsy_date; P7 transplant index biopsy;
        P5 has biopsies but none marked index; P8 has no biopsy date; P6 is not consented and appears nowhere."""
        out, log, rows, pick = self.run_tw()
        wide = {r["patient_code"]: r for r in read_csv(out / "time_windows_wide.csv")}
        self.assertEqual(sorted(wide), ["P1", "P2", "P3", "P4", "P7"])
        self.assertEqual((wide["P1"]["anchor_date"], wide["P1"]["anchor_source"], wide["P1"]["anchor_biopsy_kind"]), (d(0), "index_biopsy", "native"))
        self.assertEqual((wide["P2"]["anchor_date"], wide["P2"]["anchor_source"]), (d(31), "baseline_biopsy_date:biopsy_date"))
        self.assertEqual((wide["P4"]["anchor_date"], wide["P4"]["anchor_source"]), (d(60), "baseline_biopsy_date:ln_biopsy_date"))
        self.assertEqual((wide["P7"]["anchor_source"], wide["P7"]["anchor_biopsy_kind"]), ("index_biopsy", "transplant"))
        no_anchor = {r["patient_code"]: r["reason"] for r in read_csv(out / "time_windows_no_anchor.csv")}
        self.assertEqual(no_anchor, {"P5": "biopsy_records_without_index_biopsy", "P8": "no_biopsy_date"})
        self.assertNotIn("P6", {r["patient_code"] for r in rows}, "unconsented patients are excluded from every output")
        self.assertEqual((log["patients_included_n"], log["patients_with_anchor_n"], log["patients_without_anchor_n"]), (7, 5, 2))
        # The baseline creatinine and UPCR are measurements on the baseline date (LN centre B, P4).
        p4 = pick[("P4", "Bx", "scr_umol_l")]
        self.assertEqual((p4["value"], p4["offset_days"], p4["sources"]), ("72.0", "0", "patients_baseline:baseline_scr"))
        self.assertEqual(pick[("P4", "Bx", "upcr_mg_g")]["value"], "2000", "g/g converted explicitly to mg/g")
        # With the earliest native biopsy added, P5 is anchored on its first native biopsy.
        _, log2, _, pick2 = self.run_tw("out2", anchor={"sources": ["index_biopsy", "earliest_native_biopsy"]})
        self.assertEqual(log2["anchor_sources"], {"index_biopsy": 2, "earliest_native_biopsy": 1})
        self.assertEqual(pick2[("P5", "Bx", "scr_umol_l")]["anchor_date"], d(-214))

    def test_child_egfr_uses_the_nearest_height_within_the_height_window(self):
        """P2 (10 years): creatinine 50 on the anchor day; heights 60 days before (140) and 70 days after (142).
        P3 (8 years): the only height is 200 days before, outside the 90-day height window."""
        _, _, _, pick = self.run_tw()
        p2 = pick[("P2", "Bx", "egfr")]
        self.assertEqual((p2["status"], p2["egfr_formula"], p2["height_cm_used"], p2["height_date_used"], p2["age_years"]),
                         ("computed", "Schwartz-2009-bedside", "140.0", d(-29), "10"))
        self.assertEqual(p2["value"], f"{0.413 * 140 / (50 / 88.4):.1f}")
        self.assertEqual(pick[("P2", "Bx", "height_cm")]["value"], "140.0")
        p3 = pick[("P3", "Bx", "egfr")]
        self.assertEqual((p3["status"], p3["value"], p3["egfr_formula"]), ("missing_height", "", "Schwartz-2009-bedside"))
        p7 = pick[("P7", "Bx", "egfr")]
        self.assertEqual((p7["status"], p7["egfr_formula"], p7["offset_days"]), ("computed", "CKD-EPI-2021-Cr", "10"), "adult: no height needed")
        self.assertEqual(pick[("P1", "M24", "egfr")]["status"], "no_creatinine_in_window")

    def test_creatinine_of_zero_gives_no_egfr_and_is_not_counted(self):
        """P9 (adult) and P10 (child with a height) have a creatinine of 0 on their biopsy day: no equation applies."""
        a = lambda code, **kw: {"project_id": SP, "center_code": "A", "patient_code": code, "module": "IGAN", **kw}
        extra = [("patients_baseline.csv", BASE_HEADER, [a("P9", id="b9", sex="F", birth_year="1980", baseline_date=d(0), consent_status="consented", biopsy_date=d(0)),
                                                         a("P10", id="b10", sex="M", birth_year="2014", baseline_date=d(0), consent_status="consented", biopsy_date=d(0))]),
                 ("visits_long.csv", VISIT_HEADER, [a("P9", id="v20", visit_date=d(0), scr_umol_l="0"),
                                                   a("P10", id="v21", visit_date=d(0), scr_umol_l="0", height_cm="140")])]
        for name, header, rows in extra:
            write_csv(self.data / name, header, read_csv(self.data / name) + rows)
        _, log, _, pick = self.run_tw()
        for code in ("P9", "P10"):
            r = pick[(code, "Bx", "egfr")]
            self.assertEqual((r["status"], r["value"], r["egfr_formula"]), ("creatinine_not_positive", "", ""), code)
            self.assertEqual(pick[(code, "Bx", "scr_umol_l")]["value"], "0.0", "the creatinine itself is still reported")
        computed = sum(1 for (_, tp, v), r in pick.items() if tp == "Bx" and v == "egfr" and r["status"] == "computed")
        self.assertEqual(log["values_selected"]["Bx"]["egfr"], computed, "only computed eGFR values are counted")

    def test_unconfirmed_configuration_is_labelled_in_every_file_name(self):
        out, log, _, _ = self.run_tw(confirmed=False, confirmed_by="", confirmed_date="")
        names = sorted(p.name for p in out.iterdir())
        self.assertEqual(names, ["UNCONFIRMED_TIME_WINDOWS_LOG.json", "UNCONFIRMED_time_windows_long.csv",
                                 "UNCONFIRMED_time_windows_no_anchor.csv", "UNCONFIRMED_time_windows_wide.csv"])
        self.assertFalse(log["confirmed"])
        saved = json.loads((out / "UNCONFIRMED_TIME_WINDOWS_LOG.json").read_text(encoding="utf-8"))
        self.assertIn("不能作为正式分析数据", saved["note"])
        self.assertEqual(set(saved["input_sha256"]), {"patients_baseline.csv", "visits_long.csv", "labs_long.csv", "biopsies_long.csv"})
        self.assertEqual(saved["selection_rule"], "窗口内取距目标日最近的一天；距离相同取较早的一天；同一天多个值取中位数。窗口边界包含在内。")

    def test_wide_table_has_one_column_set_per_time_point_and_variable(self):
        out, _, _, _ = self.run_tw()
        with (out / "time_windows_wide.csv").open(encoding="utf-8-sig", newline="") as f:
            header = next(csv.reader(f))
        self.assertEqual(header[:7], ra.KEY + ["module", "anchor_date", "anchor_source", "anchor_biopsy_kind"])
        for column in ["Bx_scr_umol_l", "Bx_scr_umol_l_date", "Bx_scr_umol_l_n", "M24_height_cm", "Bx_egfr", "Bx_egfr_formula"]:
            self.assertIn(column, header)
        wide = {r["patient_code"]: r for r in read_csv(out / "time_windows_wide.csv")}
        self.assertEqual((wide["P1"]["Bx_scr_umol_l"], wide["P1"]["Bx_scr_umol_l_n"], wide["P1"]["M24_scr_umol_l"]), ("103.0", "2", ""))

    def test_configuration_errors_stop_before_any_output(self):
        base = json.loads(config(self.tmp).read_text(encoding="utf-8"))
        bad = [
            ({"selection": {"rule": "nearest", "tie": "later", "same_day": "median"}}, "selection is fixed"),
            ({"timepoints": [{"name": "Bx", "target_days": 0, "window_days": [10, 30]}]}, "must contain the target day"),
            ({"timepoints": [{"name": "Bx", "target_days": 0, "window_days": [-1, 1]}, {"name": "Bx", "target_days": 5, "window_days": [0, 9]}]}, "unique"),
            ({"anchor": {"sources": ["latest_biopsy"]}}, "anchor.sources"),
            ({"confirmed_by": ""}, "confirmed_by"),
            ({"variables": [{"name": "scr", "unit": "mg/dL", "sources": [{"table": "visits_long", "column": "scr_umol_l"}]}], "egfr": None}, "stored in μmol/L"),
            ({"variables": [{"name": "x", "unit": "g/L", "sources": [{"table": "labs_long", "lab_test_code": "IGA", "analysis_unit": "g/L", "factor": 0}]}], "egfr": None}, "factor"),
            ({"variables": [{"name": "x", "unit": "cm", "sources": [{"table": "events_long", "column": "x"}]}], "egfr": None}, "table must be"),
            ({"egfr": {**base["egfr"], "adult_equation": "MDRD"}}, "agree"),
            ({"egfr": {**base["egfr"], "creatinine_variable": "sbp"}}, "creatinine_variable"),
            ({"patient_fields": ["Ethnicity"]}, "patient_fields"),
            ({"patient_fields": ["ethnicity", "ethnicity"]}, "patient_fields"),
            ({"patient_fields": "ethnicity"}, "patient_fields"),
        ]
        for i, (change, message) in enumerate(bad):
            raw = copy.deepcopy(base)
            raw.update(change)
            with self.subTest(message=message):
                with self.assertRaises(tw.ConfigError) as caught:
                    tw.validate_config(raw)
                self.assertIn(message, str(caught.exception))
        self.assertFalse((self.tmp / "out").exists())

    def test_patient_fields_add_one_column_each_to_the_wide_table(self):
        """Custom enrollment fields named in patient_fields become field_<code> columns with the exported value.
        P6 has unconfirmed consent and is excluded; P2 has no value (blank)."""
        a = lambda code, **kw: {"project_id": SP, "center_code": "A", "patient_code": code, "module": "IGAN", **kw}
        write_csv(self.data / "project_fields.csv", ["id", "project_id", "center_code", "module", "field_key", "label_cn", "value_type", "choices"], [
            {"id": "f1", "project_id": SP, "center_code": "A", "module": "IGAN", "field_key": "ethnicity", "label_cn": "民族", "value_type": "choice",
             "choices": json.dumps([{"code": "han", "label": "汉族"}, {"code": "hui", "label": "回族"}], ensure_ascii=False)},
            {"id": "f2", "project_id": SP, "center_code": "A", "module": "IGAN", "field_key": "comorbidities", "label_cn": "合并症", "value_type": "multi_choice",
             "choices": json.dumps([{"code": "hypertension", "label": "高血压"}, {"code": "diabetes", "label": "糖尿病"}], ensure_ascii=False)}])
        write_csv(self.data / "patient_field_values.csv", ra.TABLE_COLUMNS["patient_field_values"], [
            a("P1", id="x1", field_key="ethnicity", value_text="hui"),
            a("P1", id="x2", field_key="comorbidities", value_codes="hypertension;diabetes"),
            a("P6", id="x3", field_key="ethnicity", value_text="han")])
        out, log, _, _ = self.run_tw(patient_fields=["ethnicity", "comorbidities"])
        wide_rows = read_csv(out / "time_windows_wide.csv")
        self.assertEqual(list(wide_rows[0])[:9], ra.KEY + ["module", "anchor_date", "anchor_source", "anchor_biopsy_kind", "field_ethnicity", "field_comorbidities"])
        wide = {r["patient_code"]: r for r in wide_rows}
        self.assertEqual((wide["P1"]["field_ethnicity"], wide["P1"]["field_comorbidities"]), ("hui", "hypertension;diabetes"))
        self.assertEqual((wide["P2"]["field_ethnicity"], wide["P2"]["field_comorbidities"]), ("", ""))
        self.assertNotIn("P6", wide, "excluded patients carry no field values")
        self.assertEqual(log["config"]["patient_fields"], ["ethnicity", "comorbidities"])
        with self.assertRaisesRegex(ra.DataContractError, "not custom fields of this export"):
            self.run_tw("out2", patient_fields=["blood_type"])
        (self.data / "project_fields.csv").unlink()
        with self.assertRaisesRegex(ra.DataContractError, "project_fields.csv"):
            self.run_tw("out3", patient_fields=["ethnicity"])
        _, _, rows, _ = self.run_tw("out4")
        self.assertNotIn("field_ethnicity", read_csv(self.tmp / "out4" / "time_windows_wide.csv")[0], "no field columns unless configured")

    def test_values_are_rounded_half_up_at_their_decimal_form(self):
        self.assertEqual([tw._fmt(v, 1) for v in (103.05, 88.45, 0.05, 2.675 * 10)], ["103.1", "88.5", "0.1", "26.8"])
        self.assertEqual((tw._fmt(1999.5, 0), tw._fmt(float("nan"), 1), tw._fmt(None, 1)), ("2000", "", ""))

    def test_command_line_refuses_a_used_output_directory_and_keeps_inputs(self):
        before = {p.name: p.read_bytes() for p in self.data.iterdir()}
        target = self.tmp / "cli"
        self.assertEqual(tw.main(["--data", str(self.data), "--config", str(config(self.tmp)), "--out", str(target)]), 0)
        self.assertTrue((target / "time_windows_long.csv").is_file())
        self.assertEqual(tw.main(["--data", str(self.data), "--config", str(config(self.tmp)), "--out", str(target)]), 2, "used output directory refused")
        self.assertEqual({p.name: p.read_bytes() for p in self.data.iterdir()}, before, "input CSVs are never changed")
        log = json.loads((target / "TIME_WINDOWS_LOG.json").read_text(encoding="utf-8"))
        for name, digest in log["output_sha256"].items():
            self.assertEqual(ra.sha256(target / name), digest)


if __name__ == "__main__":
    unittest.main()
