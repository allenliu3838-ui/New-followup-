"""Protocol-parameterised endpoint tests for site/assets/template/run_analysis.py.

Run: python3 -I -m unittest discover -s tests -p test_analysis_protocol.py
Requires the pinned analysis dependencies (site/assets/template/requirements.txt:
numpy, pandas, openpyxl, matplotlib). Synthetic fixtures: tests/fixtures/analysis/.
"""
from __future__ import annotations

import csv
import hashlib
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "site" / "assets" / "template"
FIXTURES = ROOT / "tests" / "fixtures" / "analysis"
DATA = FIXTURES / "data"
PROTOCOL = FIXTURES / "protocol_confirmed.json"
sys.path.insert(0, str(TEMPLATE))
try:
    import pandas as pd  # noqa: E402
    import run_analysis as ra  # noqa: E402
except ImportError as exc:  # fail loudly: a silent skip would hide the endpoint logic from CI
    raise ImportError(f"test_analysis_protocol needs the analysis dependencies in {TEMPLATE/'requirements.txt'}: {exc}") from exc

P1 = "00000000-0000-4000-8000-000000000001"
P2 = "00000000-0000-4000-8000-000000000002"


def read_csv(path):
    with Path(path).open(encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


class AnalysisProtocolTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="analysis-protocol-test-"))
        cls.protocol_out = cls.tmp / "protocol-run"
        cls.protocol_log = ra.analyze(DATA, cls.protocol_out, PROTOCOL)
        cls.endpoints = read_csv(cls.protocol_out / "endpoints_per_protocol.csv")
        cls.candidate_out = cls.tmp / "candidate-run"
        cls.candidate_log = ra.analyze(DATA, cls.candidate_out)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def ep(self, project, center, code, endpoint):
        rows = [r for r in self.endpoints if (r["project_id"], r["center_code"], r["patient_code"], r["endpoint"]) == (project, center, code, endpoint)]
        self.assertEqual(len(rows), 1, (project, center, code, endpoint))
        return rows[0]

    def variant_protocol(self, mutate, name="variant.json"):
        raw = json.loads(PROTOCOL.read_text(encoding="utf-8"))
        mutate(raw)
        path = Path(tempfile.mkdtemp(dir=self.tmp)) / name
        path.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
        return path

    def variant_data(self, mutate_baseline=None, mutate_visits=None, dictionary=None):
        out = Path(tempfile.mkdtemp(dir=self.tmp)) / "data"
        shutil.copytree(DATA, out)
        for name, fn in [("patients_baseline.csv", mutate_baseline), ("visits_long.csv", mutate_visits)]:
            if fn is None:
                continue
            rows = read_csv(out / name)
            header, rows = fn(list(rows[0].keys()), rows)
            with (out / name).open("w", encoding="utf-8", newline="") as f:
                w = csv.DictWriter(f, fieldnames=header, lineterminator="\n")
                w.writeheader()
                w.writerows([{k: r.get(k, "") for k in header} for r in rows])
        if dictionary is not None:
            (out / "data_dictionary.json").write_text(json.dumps(dictionary), encoding="utf-8")
        return out

    # --- sustained eGFR decline -------------------------------------------------
    def test_transient_decline_then_recovery_is_not_sustained(self):
        r = self.ep(P1, "A", "001", "egfr_decline_40pct_sustained")
        self.assertEqual((r["status"], r["status_detail"]), ("not_met", "transient_not_confirmed_recovered"))
        self.assertEqual(r["event_date"], "")

    def test_sustained_decline_is_determined_with_event_and_confirmation_dates(self):
        r = self.ep(P1, "B", "001", "egfr_decline_40pct_sustained")
        self.assertEqual(r["status"], "met_per_protocol")
        self.assertEqual((r["event_date"], r["confirmation_date"]), ("2020-03-31", "2020-05-30"))
        self.assertEqual(r["determination"], "已按方案 TEST-SYNTHETIC@1.0 判定")
        self.assertEqual(self.ep(P1, "B", "001", "egfr_decline_57pct_sustained")["status"], "not_met")

    def test_interval_shorter_than_protocol_minimum_is_not_determined(self):
        r = self.ep(P1, "A", "002", "egfr_decline_40pct_sustained")
        self.assertEqual((r["status"], r["status_detail"]), ("not_met", "confirmation_interval_too_short"))

    def test_require_last_below_rejects_later_recovery(self):
        self.assertEqual(self.ep(P1, "A", "008", "egfr_decline_40pct_sustained")["status"], "met_per_protocol")
        path = self.variant_protocol(lambda p: p["egfr_decline"]["confirmation"].update(require_last_below=True))
        ra.analyze(DATA, self.tmp / "last-below", path)
        rows = read_csv(self.tmp / "last-below" / "endpoints_per_protocol.csv")
        r = [x for x in rows if (x["project_id"], x["center_code"], x["patient_code"], x["endpoint"]) == (P1, "A", "008", "egfr_decline_40pct_sustained")][0]
        self.assertEqual((r["status"], r["status_detail"]), ("not_met", "met_then_not_sustained_to_last_measurement"))

    def test_evaluate_sustained_unit_cases(self):
        T = pd.Timestamp
        conf = {"min_measurements": 2, "min_interval_days": 28, "require_last_below": False}
        seq = [(T("2020-01-10"), 9, True), (T("2020-02-10"), 40, True)]
        self.assertEqual(ra.evaluate_sustained(seq, conf)["status"], "met_per_protocol")
        seq = [(T("2020-01-10"), 9, True), (T("2020-01-20"), 19, True), (T("2020-02-20"), 50, False)]
        self.assertEqual(ra.evaluate_sustained(seq, conf)["status_detail"], "confirmation_interval_too_short")
        self.assertEqual(ra.evaluate_sustained([], conf)["status"], "not_evaluable")
        self.assertEqual(ra.evaluate_sustained([(T("2020-01-10"), 9, True)], conf)["status_detail"], "met_at_last_measurement_awaiting_confirmation")

    # --- remission ------------------------------------------------------------
    def test_igan_complete_and_partial_remission_require_persistence(self):
        cr = self.ep(P1, "A", "001", "remission_complete_sustained")
        self.assertEqual((cr["status"], cr["event_date"], cr["confirmation_date"]), ("met_per_protocol", "2020-03-31", "2020-05-10"))
        self.assertEqual(self.ep(P1, "B", "001", "remission_complete_sustained")["status"], "not_met")
        pr = self.ep(P1, "B", "001", "remission_partial_sustained")
        self.assertEqual((pr["status"], pr["baseline_value"]), ("met_per_protocol", "2000.0"))  # 2.0 g/g converted explicitly
        interrupted = self.ep(P1, "A", "003", "remission_complete_sustained")
        self.assertEqual(interrupted["status"], "not_met")
        self.assertEqual(self.ep(P1, "A", "003", "remission_partial_sustained")["status"], "met_per_protocol")
        self.assertEqual(self.ep(P1, "A", "002", "remission_complete_sustained")["status_detail"], "confirmation_interval_too_short")

    def test_uncovered_and_unconfirmed_modules_are_not_computed_and_reported(self):
        p2 = [r["endpoint"] for r in self.endpoints if r["project_id"] == P2]
        self.assertEqual(sorted(p2), ["egfr_decline_40pct_sustained", "egfr_decline_57pct_sustained"])
        qc = read_csv(self.protocol_out / "qc_issues.csv")
        codes = {(r["code"], r["detail"].split(" ")[0]) for r in qc if r["table"] == "protocol"}
        self.assertIn(("protocol_module_not_covered", "Remission"), codes)
        self.assertIn(("protocol_section_not_confirmed", "remission.MN"), codes)
        self.assertEqual(self.protocol_log["protocol"]["sections_skipped"], {"remission.MN": "requires_pi_confirmation=true"})

    def test_template_alone_computes_nothing_until_pi_confirms(self):
        out = self.tmp / "template-run"
        log = ra.analyze(DATA, out, TEMPLATE / "protocol_template.json")
        self.assertEqual(log["protocol"]["sections_computed"], [])
        self.assertEqual(read_csv(out / "endpoints_per_protocol.csv"), [])
        raw = json.loads((TEMPLATE / "protocol_template.json").read_text(encoding="utf-8"))
        for module in ("IGAN", "LN", "MN"):
            self.assertIs(raw["remission"][module]["requires_pi_confirmation"], True)
            self.assertIn("citation", raw["remission"][module]["reference"])
            self.assertIn("示例", raw["remission"][module]["reference"]["note"])
        self.assertIs(raw["egfr_decline"]["requires_pi_confirmation"], True)

    def test_confirmed_section_without_named_confirmer_is_refused(self):
        path = self.variant_protocol(lambda p: p["confirmation"].update(confirmed_by=""))
        with self.assertRaises(ra.DataContractError):
            ra.analyze(DATA, self.tmp / "no-confirmer", path)
        self.assertFalse((self.tmp / "no-confirmer").exists())

    def test_misspelled_protocol_key_is_refused(self):
        path = self.variant_protocol(lambda p: p["egfr_decline"]["confirmation"].update(min_interval_day=28))
        with self.assertRaisesRegex(ra.DataContractError, "不认识的字段"):
            ra.load_protocol(path)

    # --- censoring ------------------------------------------------------------
    def test_followup_status_and_confirmed_events_censor_later_measurements(self):
        lost = self.ep(P1, "B", "002", "egfr_decline_40pct_sustained")
        self.assertEqual((lost["status"], lost["censor_date"], lost["censor_reason"]), ("not_met", "2020-04-30", "followup_status_lost"))
        died = self.ep(P1, "A", "007", "egfr_decline_40pct_sustained")
        self.assertEqual((died["status"], died["censor_reason"]), ("not_met", "event_death"))
        # Unconfirmed death event for A/001 does not censor.
        self.assertEqual(self.ep(P1, "A", "001", "remission_complete_sustained")["censor_date"], "")

    def test_missing_followup_status_columns_are_noted(self):
        data = self.variant_data(mutate_baseline=lambda h, rows: ([c for c in h if not c.startswith("followup_status")], rows))
        log = ra.analyze(data, self.tmp / "no-followup-status", PROTOCOL)
        self.assertEqual(log["followup_status"]["columns_present"], [])
        self.assertIn("未提供随访状态", log["followup_status"]["note"])
        rows = read_csv(self.tmp / "no-followup-status" / "endpoints_per_protocol.csv")
        lost = [r for r in rows if (r["center_code"], r["patient_code"], r["endpoint"]) == ("B", "002", "egfr_decline_40pct_sustained")][0]
        self.assertEqual(lost["status"], "met_per_protocol")  # without status it is not censored

    # --- units ----------------------------------------------------------------
    def test_protocol_unit_differing_from_data_unit_is_refused(self):
        path = self.variant_protocol(lambda p: p["units"].update(upcr="g/g"))
        with self.assertRaisesRegex(ra.DataContractError, "不一致"):
            ra.analyze(DATA, self.tmp / "unit-protocol", path)
        self.assertFalse((self.tmp / "unit-protocol").exists())

    def test_explicit_data_unit_differing_from_protocol_is_refused(self):
        def add_unit(header, rows):
            for r in rows:
                r["upcr_unit"] = "g/g"
            return header + ["upcr_unit"], rows
        with self.assertRaisesRegex(ra.DataContractError, "visits_long.upcr_unit"):
            ra.analyze(self.variant_data(mutate_visits=add_unit), self.tmp / "unit-column", PROTOCOL)
        with self.assertRaisesRegex(ra.DataContractError, "data_dictionary.json"):
            ra.analyze(self.variant_data(dictionary={"visits": {"upcr": "g/g"}}), self.tmp / "unit-dictionary", PROTOCOL)
        ok = ra.analyze(self.variant_data(dictionary={"visits": {"upcr": "mg/g"}}), self.tmp / "unit-dictionary-ok", PROTOCOL)
        self.assertEqual(ok["protocol"]["visit_upcr_unit_declarations"], [{"unit": "mg/g", "source": "data_dictionary.json"}])

    # --- without protocol -----------------------------------------------------
    def test_without_protocol_only_unconfirmed_candidates_are_written(self):
        files = set(self.candidate_log["generated_files"])
        self.assertIn("candidates_unconfirmed_egfr_decline.csv", files)
        self.assertIn("candidates_unconfirmed_igan_proteinuria.csv", files)
        self.assertFalse({"endpoints_per_protocol.csv", "candidates_egfr_decline.csv", "candidates_igan_proteinuria.csv"} & files)
        for name in ["candidates_unconfirmed_egfr_decline.csv", "candidates_unconfirmed_igan_proteinuria.csv"]:
            with (self.candidate_out / name).open(encoding="utf-8-sig", newline="") as f:
                header = next(csv.reader(f))
            self.assertTrue(all(c in ra.KEY or c.startswith("candidate_unconfirmed_") for c in header), header)
        statuses = {r["candidate_unconfirmed_egfr_le_60pct_of_baseline_status"] for r in read_csv(self.candidate_out / "candidates_unconfirmed_egfr_decline.csv")}
        self.assertLessEqual(statuses, {"candidate_unconfirmed", "not_observed_in_available_followup", "not_evaluable"})
        self.assertEqual((self.candidate_log["mode"], self.candidate_log["protocol"]), ("candidates_only", None))
        model = json.loads((self.candidate_out / "MODEL_STATUS.json").read_text(encoding="utf-8"))
        self.assertEqual(model["clinical_endpoint_adjudication"]["status"], "not_executed_unconfirmed_candidates_only")

    def test_table1_has_no_endpoint_rates(self):
        from openpyxl import load_workbook
        for out in (self.candidate_out, self.protocol_out):
            ws = load_workbook(out / "table1_baseline.xlsx").active
            labels = [str(row[0]).lower() for row in ws.iter_rows(min_row=2, values_only=True)]
            for banned in ("remission", "decline", "缓解", "下降", "candidate", "endpoint"):
                self.assertFalse([x for x in labels if banned in x], (out.name, banned))

    # --- identity and consent ---------------------------------------------------
    def test_same_patient_code_across_centers_and_projects_is_not_merged(self):
        code001 = {(r["project_id"], r["center_code"]) for r in self.endpoints if r["patient_code"] == "001"}
        self.assertEqual(code001, {(P1, "A"), (P1, "B"), (P2, "A")})
        a = self.ep(P1, "A", "001", "egfr_decline_40pct_sustained")
        b = self.ep(P1, "B", "001", "egfr_decline_40pct_sustained")
        self.assertNotEqual(a["status"], b["status"])
        self.assertEqual(a["n_followup_measurements"], "3")
        self.assertEqual(b["n_followup_measurements"], "3")

    def test_consent_filter_counts_and_excludes_all_records(self):
        c = self.protocol_log["consent_filter"]
        self.assertEqual((c["column_present"], c["patients_before_n"], c["included_n"], c["excluded_n"]), (True, 10, 8, 2))
        self.assertEqual(c["excluded_by_status"], {"declined": 1, "unconfirmed": 1})
        for out in (self.protocol_out, self.candidate_out):
            for name in ["patients_derived.csv", "visits_derived.csv"]:
                codes = {(r["center_code"], r["patient_code"]) for r in read_csv(out / name)}
                self.assertFalse({("A", "005"), ("A", "006")} & codes)
        self.assertEqual(self.candidate_log["consent_filter"]["excluded_n"], 2)

    def test_without_consent_column_nothing_is_filtered_and_log_says_so(self):
        data = self.variant_data(mutate_baseline=lambda h, rows: ([c for c in h if not c.startswith("consent_")], rows))
        log = ra.analyze(data, self.tmp / "no-consent")
        self.assertEqual((log["consent_filter"]["column_present"], log["consent_filter"]["excluded_n"], log["patients_n"]), (False, 0, 10))
        self.assertIn("未提供同意状态", log["consent_filter"]["note"])

    # --- provenance -----------------------------------------------------------
    def test_protocol_text_and_hash_recorded_in_run_log_and_methods(self):
        digest = hashlib.sha256(PROTOCOL.read_bytes()).hexdigest()
        text = PROTOCOL.read_text(encoding="utf-8")
        log = json.loads((self.protocol_out / "RUN_LOG.json").read_text(encoding="utf-8"))
        self.assertEqual((log["protocol"]["sha256"], log["protocol"]["text"], log["mode"]), (digest, text, "protocol"))
        methods = (self.protocol_out / "METHODS_ACTUAL_EN.md").read_text(encoding="utf-8")
        self.assertIn(digest, methods)
        self.assertIn(text.rstrip(), methods)
        self.assertIn("TEST-SYNTHETIC@1.0", methods)
        self.assertEqual((self.protocol_out / "protocol_used.json").read_bytes(), PROTOCOL.read_bytes())


if __name__ == "__main__":
    unittest.main()
