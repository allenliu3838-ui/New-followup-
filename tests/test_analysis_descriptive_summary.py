"""Tests for site/assets/template/descriptive_summary.py and the field-definition merge in merge_centers.py.

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
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "site" / "assets" / "template"
sys.path.insert(0, str(TEMPLATE))
import run_analysis as ra  # noqa: E402
import descriptive_summary as ds  # noqa: E402
import merge_centers as mc  # noqa: E402

P1, P2, P3 = ("00000000-0000-4000-8000-0000000000d1", "00000000-0000-4000-8000-0000000000d2", "00000000-0000-4000-8000-0000000000d3")
CENTER = {P1: "PKD01", P2: "PKD02", P3: "IGA01"}
MODULE = {P1: "ADPKD", P2: "ADPKD", P3: "IGAN"}
B0 = date(2024, 1, 1)
V2 = "血管加压素V2受体拮抗剂"
BASE_HEADER = ra.KEY + ["id", "module", "sex", "birth_year", "baseline_date", "baseline_scr", "baseline_upcr", "baseline_upcr_unit",
                        "consent_status", "followup_status", "followup_status_date"]
FIELD_DEF_HEADER = ["id", "project_id", "center_code", "module", "field_key", "label_cn", "value_type", "choices", "unit", "min_value",
                    "max_value", "sort_order", "active", "source", "help_cn"]
NOTE = "随访备注：合成文本"


def day(n):
    return (B0 + timedelta(days=n)).isoformat()


def write_csv(path, header, rows):
    with Path(path).open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=header, lineterminator="\n")
        w.writeheader()
        w.writerows([{k: r.get(k, "") for k in header} for r in rows])


def key(pid, code):
    return {"project_id": pid, "center_code": CENTER[pid], "patient_code": code, "module": MODULE[pid]}


PATIENTS = [  # (project, code, sex, birth year, consent, follow-up status)
    (P1, "K1", "F", 1980, "consented", "active"), (P1, "K2", "M", 1975, "consented", "active"),
    (P1, "K3", "F", 1990, "declined", "active"), (P1, "K4", "M", 2000, "consented", "kidney_failure"),
    (P2, "J1", "F", 1985, "consented", "active"), (P2, "J2", "M", 1970, "waiver", "active"),
    (P3, "G1", "M", 1980, "consented", "active"),
]
YES_NO = None
CHOICES_P1 = [{"code": "yes", "label": "有"}, {"code": "no", "label": "无"}, {"code": "not_assessed", "label": "未评估"}]
HISTORY = [{"code": "gross_hematuria", "label": "肉眼血尿"}, {"code": "flank_pain", "label": "慢性腰腹痛"}, {"code": "none", "label": "无"}]
DEFINITIONS = [  # (project, key, label, type, choices, unit, sort)
    (P1, "hypertension", "高血压", "yes_no", None, "", 10), (P1, "liver_cysts", "肝囊肿", "choice", CHOICES_P1, "", 20),
    (P1, "kidney_history", "肾脏相关病史", "multi_choice", HISTORY, "", 30), (P1, "age_at_diagnosis", "确诊年龄", "number", None, "岁", 40),
    (P1, "note", "备注字段", "text", None, "", 50),
    (P2, "hypertension", "高血压", "yes_no", None, "", 10),
    (P2, "liver_cysts", "肝囊肿（影像）", "choice", [{"code": "yes", "label": "有"}, {"code": "no", "label": "无"}], "", 20),
    (P2, "kidney_history", "肾脏相关病史", "choice", [{"code": "a", "label": "甲"}, {"code": "b", "label": "乙"}], "", 30),
    (P2, "age_at_diagnosis", "确诊年龄", "number", None, "岁", 40),
]
VALUES = [  # (project, code, key, column, value)
    (P1, "K1", "hypertension", "value_text", "yes"), (P1, "K1", "liver_cysts", "value_text", "yes"),
    (P1, "K1", "kidney_history", "value_codes", "gross_hematuria;flank_pain"), (P1, "K1", "age_at_diagnosis", "value_num", "30"),
    (P1, "K1", "note", "value_text", NOTE),
    (P1, "K2", "hypertension", "value_text", "no"), (P1, "K2", "liver_cysts", "value_text", "not_assessed"),
    (P1, "K2", "kidney_history", "value_codes", "none"), (P1, "K2", "age_at_diagnosis", "value_num", "41"),
    (P1, "K3", "hypertension", "value_text", "yes"), (P1, "K3", "age_at_diagnosis", "value_num", "12"),
    (P1, "K4", "hypertension", "value_text", "yes"),
    (P2, "J1", "hypertension", "value_text", "yes"), (P2, "J1", "liver_cysts", "value_text", "yes"),
    (P2, "J1", "age_at_diagnosis", "value_num", "25"), (P2, "J1", "kidney_history", "value_text", "a"),
    (P2, "J2", "liver_cysts", "value_text", "no"),
]
MEDS = [(P1, "K1", V2), (P1, "K1", V2), (P1, "K2", "RAS阻断剂"), (P1, "K3", V2), (P2, "J1", V2), (P2, "J2", ""), (P3, "G1", "糖皮质激素")]
EVENTS = [(P1, "K1", "esrd", "true"), (P2, "J1", "death", "false"), (P1, "K3", "esrd", "true")]
VISITS = [(P1, "K1", 0), (P1, "K1", 365), (P1, "K2", 0), (P1, "K2", 730), (P2, "J1", 182), (P3, "G1", 100)]


def make_pack(folder, projects=(P1, P2, P3), drop=()):
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    keep = lambda pid: pid in projects  # noqa: E731
    write_csv(folder / "patients_baseline.csv", BASE_HEADER, [
        {**key(pid, code), "id": f"b-{code}", "sex": sex, "birth_year": str(by), "baseline_date": day(0), "baseline_scr": "80",
         "baseline_upcr": "500", "baseline_upcr_unit": "mg/g", "consent_status": consent, "followup_status": status,
         "followup_status_date": day(400) if status != "active" else ""}
        for pid, code, sex, by, consent, status in PATIENTS if keep(pid)])
    write_csv(folder / "visits_long.csv", ra.TABLE_COLUMNS["visits_long"], [
        {**key(pid, code), "id": f"v-{code}-{d}", "visit_date": day(d), "sbp": "120", "dbp": "80", "scr_umol_l": "90", "upcr": "300",
         "egfr": "", "egfr_formula_version": "missing_inputs"} for pid, code, d in VISITS if keep(pid)])
    write_csv(folder / "meds_long.csv", ra.TABLE_COLUMNS["meds_long"], [
        {**key(pid, code), "id": f"m-{i}", "drug_name": f"合成药物{i}", "drug_class": cls, "start_date": day(10)}
        for i, (pid, code, cls) in enumerate(MEDS) if keep(pid)])
    write_csv(folder / "events_long.csv", ra.TABLE_COLUMNS["events_long"], [
        {**key(pid, code), "id": f"e-{i}", "event_type": t, "event_date": day(300), "confirmed": c, "source": "manual"}
        for i, (pid, code, t, c) in enumerate(EVENTS) if keep(pid)])
    write_csv(folder / "patient_field_values.csv", ra.TABLE_COLUMNS["patient_field_values"], [
        {**key(pid, code), "id": f"f-{i}", "field_key": fk, column: value} for i, (pid, code, fk, column, value) in enumerate(VALUES) if keep(pid)])
    if "project_fields" not in drop:
        write_csv(folder / "project_fields.csv", FIELD_DEF_HEADER, [
            {"id": f"d-{pid[-2:]}-{fk}", "project_id": pid, "center_code": CENTER[pid], "module": MODULE[pid], "field_key": fk, "label_cn": label,
             "value_type": kind, "choices": json.dumps(choices, ensure_ascii=False) if choices else "", "unit": unit, "sort_order": str(sort),
             "active": "true", "source": "合成草案"}
            for pid, fk, label, kind, choices, unit, sort in DEFINITIONS if keep(pid)])
    return folder


def read(path):
    with Path(path).open(encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def pick(rows, **match):
    hits = [r for r in rows if all(r[k] == v for k, v in match.items())]
    if len(hits) != 1:
        raise AssertionError(f"expected one row for {match}, got {len(hits)}")
    return hits[0]


class DescriptiveSummaryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="ksr-summary-"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_summary(self, data, name="out", **kwargs):
        log, _ = ds.run(data, self.tmp / name, **kwargs)
        out = self.tmp / name
        return log, {f.name: read(f) for f in out.glob("*.csv")}

    def test_fields_per_centre_and_all_with_both_denominators(self):
        log, t = self.run_summary(make_pack(self.tmp / "data"), module="ADPKD")
        cat = t["summary_fields_categorical.csv"]
        row = pick(cat, center_code="PKD01", field_key="hypertension", option_code="yes")
        self.assertEqual((row["n"], row["patients_n"], row["recorded_n"], row["pct_of_patients"], row["pct_of_recorded"], row["option_label"]),
                         ("2", "3", "3", "66.7", "66.7", "是"))
        row = pick(cat, center_code="PKD01", field_key="liver_cysts", option_code="yes")
        self.assertEqual((row["n"], row["recorded_n"], row["pct_of_patients"], row["pct_of_recorded"]), ("1", "2", "33.3", "50.0"))
        self.assertEqual(pick(cat, center_code="PKD01", field_key="kidney_history", option_code="flank_pain")["n"], "1")
        self.assertEqual(pick(cat, center_code="PKD01", field_key="kidney_history", option_code="none")["n"], "1")
        # ALL: patients of the projects defining the field; options merged by code, differing labels joined.
        row = pick(cat, center_code="ALL", field_key="hypertension", option_code="yes")
        self.assertEqual((row["n"], row["patients_n"], row["recorded_n"], row["pct_of_patients"]), ("3", "5", "4", "60.0"))
        row = pick(cat, center_code="ALL", field_key="liver_cysts", option_code="yes")
        self.assertEqual((row["label_cn"], row["n"], row["recorded_n"]), ("肝囊肿 / 肝囊肿（影像）", "2", "4"))
        self.assertEqual(pick(cat, center_code="ALL", field_key="liver_cysts", option_code="not_assessed")["n"], "1")
        self.assertFalse([r for r in cat if r["center_code"] == "ALL" and r["field_key"] == "kidney_history"], "types differ: no ALL row")
        self.assertTrue(any("kidney_history" in w for w in log["warnings"]))
        self.assertTrue(any("liver_cysts" in w for w in log["warnings"]))
        num = t["summary_fields_numeric.csv"]
        row = pick(num, center_code="PKD01", field_key="age_at_diagnosis")
        self.assertEqual((row["recorded_n"], row["mean"], row["median"], row["min"], row["max"], row["unit"]), ("2", "35.5", "35.5", "30.0", "41.0", "岁"))
        self.assertAlmostEqual(float(row["sd"]), math.sqrt(60.5), places=2)
        row = pick(num, center_code="ALL", field_key="age_at_diagnosis")
        self.assertEqual((row["recorded_n"], row["median"], row["patients_n"]), ("3", "30.0", "5"))
        comp = t["summary_field_completeness.csv"]
        self.assertEqual(pick(comp, center_code="ALL", field_key="note")["patients_n"], "3", "only the projects defining the field")
        self.assertEqual(pick(comp, center_code="PKD02", field_key="hypertension")["recorded_pct"], "50.0")

    def test_consent_excluded_patients_and_text_content_never_reach_the_output(self):
        _, t = self.run_summary(make_pack(self.tmp / "data"), module="ADPKD")
        self.assertEqual(pick(t["summary_fields_numeric.csv"], center_code="PKD01", field_key="age_at_diagnosis")["min"], "30.0", "K3 (declined) excluded")
        self.assertEqual(pick(t["summary_field_completeness.csv"], center_code="PKD01", field_key="note")["recorded_n"], "1")
        text = "".join((self.tmp / "out" / f).read_text(encoding="utf-8-sig") for f in ds.COLUMNS)
        for secret in [NOTE, "K1", "K2", "K3", "K4", "J1", "J2", "合成药物"]:
            self.assertNotIn(secret, text)

    def test_medications_events_and_overview(self):
        log, t = self.run_summary(make_pack(self.tmp / "data"), module="ADPKD")
        meds = t["summary_medications.csv"]
        self.assertEqual((pick(meds, center_code="PKD01", drug_class=V2)["patients_with_record_n"], pick(meds, center_code="PKD01", drug_class=V2)["pct_of_patients"]), ("1", "33.3"))
        self.assertEqual(pick(meds, center_code="PKD02", drug_class=V2)["pct_of_patients"], "50.0")
        self.assertEqual((pick(meds, center_code="ALL", drug_class=V2)["patients_with_record_n"], pick(meds, center_code="ALL", drug_class=V2)["pct_of_patients"]), ("2", "40.0"))
        self.assertEqual(pick(meds, center_code="PKD02", drug_class=ds.NO_CLASS)["patients_with_record_n"], "1")
        self.assertFalse([r for r in meds if r["drug_class"] == "糖皮质激素"], "the IGAN centre is outside --module ADPKD")
        ev = t["summary_events.csv"]
        kf = pick(ev, center_code="PKD01", event_type="kidney_failure_any")
        self.assertEqual((kf["patients_confirmed_n"], kf["patients_n"], kf["pct_of_patients"]), ("2", "3", "66.7"), "esrd event (K1) or status kidney_failure (K4)")
        death = pick(ev, center_code="PKD02", event_type="death")
        self.assertEqual((death["patients_confirmed_n"], death["patients_any_record_n"]), ("0", "1"), "an unconfirmed record is reported separately")
        self.assertEqual(pick(ev, center_code="ALL", event_type="esrd")["patients_confirmed_n"], "1")
        ov = t["summary_overview.csv"]
        row = pick(ov, center_code="PKD01")
        self.assertEqual((row["patients_n"], row["female_n"], row["male_n"], row["female_pct_of_known_sex"]), ("3", "1", "2", "33.3"))
        self.assertEqual((row["age_baseline_n"], row["age_baseline_median"]), ("3", "44.0"))
        self.assertEqual(row["with_followup_visit_n"], "2")
        self.assertAlmostEqual(float(row["followup_years_median"]), (365 / 365.25 + 730 / 365.25) / 2, places=2)
        self.assertEqual(pick(ov, center_code="ALL")["patients_n"], "5")
        self.assertEqual(log["module_filter"], "ADPKD")
        self.assertEqual([c["center_code"] for c in log["centres"]], ["PKD01", "PKD02"])

    def test_module_filter_and_mixed_modules(self):
        log, t = self.run_summary(make_pack(self.tmp / "data"))
        self.assertTrue(any("ADPKD" in w and "IGAN" in w for w in log["warnings"]), "ALL mixes modules")
        self.assertEqual(pick(t["summary_overview.csv"], center_code="ALL")["patients_n"], "6")
        _, t = self.run_summary(self.tmp / "data", name="iga", module="IGAN")
        self.assertEqual([r["center_code"] for r in t["summary_overview.csv"]], ["IGA01", "ALL"])
        self.assertEqual(t["summary_fields_categorical.csv"], [])
        with self.assertRaises(ra.DataContractError):
            ds.run(self.tmp / "data", self.tmp / "x", module="adpkd")
        with self.assertRaises(ra.DataContractError):
            ds.run(self.tmp / "data", self.tmp / "y", module="C3G")

    def test_refuses_values_without_definitions_and_a_used_output_directory(self):
        make_pack(self.tmp / "data", drop=("project_fields",))
        with self.assertRaisesRegex(ra.DataContractError, "project_fields.csv"):
            ds.run(self.tmp / "data", self.tmp / "out")
        make_pack(self.tmp / "ok")
        (self.tmp / "used").mkdir()
        (self.tmp / "used" / "old.csv").write_text("x", encoding="utf-8")
        with self.assertRaisesRegex(ra.DataContractError, "empty"):
            ds.run(self.tmp / "ok", self.tmp / "used")

    def test_merged_centres_carry_their_field_definitions(self):
        a = make_pack(self.tmp / "a", projects=(P1,))
        b = make_pack(self.tmp / "b", projects=(P2,))
        merged = self.tmp / "merged"
        mc.merge_all([a, b], merged, self.tmp / "qc.xlsx", verbose=False)
        definitions = read(merged / "project_fields.csv")
        self.assertEqual(sorted((r["project_id"], r["field_key"]) for r in definitions), sorted((d[0], d[1]) for d in DEFINITIONS if d[0] in (P1, P2)))
        self.assertEqual(json.loads((merged / "MERGE_MANIFEST.json").read_text(encoding="utf-8"))["counts"]["project_fields"], 9)
        _, from_merge = self.run_summary(merged, name="m")
        _, direct = self.run_summary(make_pack(self.tmp / "direct", projects=(P1, P2)), name="d")
        self.assertEqual(from_merge["summary_fields_categorical.csv"], direct["summary_fields_categorical.csv"])
        # The same export sent twice is idempotent; a changed definition of the same field stops the merge.
        mc.merge_all([a, b, a], self.tmp / "twice", self.tmp / "qc2.xlsx", verbose=False)
        changed = make_pack(self.tmp / "a2", projects=(P1,))
        rows = read(changed / "project_fields.csv")
        rows[0]["label_cn"] = "高血压（修改后）"
        write_csv(changed / "project_fields.csv", FIELD_DEF_HEADER, rows)
        with self.assertRaisesRegex(ra.DataContractError, "conflict"):
            mc.merge_all([a, changed], self.tmp / "bad", self.tmp / "qc3.xlsx", verbose=False)
        missing = make_pack(self.tmp / "b2", projects=(P2,), drop=("project_fields",))
        with self.assertRaisesRegex(ra.DataContractError, "without a definition"):
            mc.merge_all([a, missing], self.tmp / "bad2", self.tmp / "qc4.xlsx", verbose=False)


if __name__ == "__main__":
    unittest.main()
