"""Regenerate the synthetic analysis fixtures (no real patients; fictitious IDs).

python3 -I tests/fixtures/analysis/make_fixtures.py
Each scenario is documented next to its rows; tests assert these exact outcomes.
"""
import csv
from datetime import date, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent / "data"
BASE = date(2020, 1, 1)
KEY = ["project_id", "center_code", "patient_code"]
P1 = "00000000-0000-4000-8000-000000000001"
P2 = "00000000-0000-4000-8000-000000000002"


def d(day):
    return (BASE + timedelta(days=day)).isoformat()


# (project, center, code, module, consent, followup_status, status_day, baseline_upcr, unit, visits[(day, egfr, upcr)])
PATIENTS = [
    # Transient eGFR dip (d90) then recovery: no sustained decline. UPCR <300 at d90/d130/d200: complete remission confirmed.
    (P1, "A", "001", "IGAN", "consented", "active", None, "2000", "mg/g", [(0, 100, 2000), (90, 55, 250), (130, 90, 260), (200, 92, 270)]),
    # Same code 001 in center B: sustained 40% decline (d90 & d150, 60 days apart); partial (not complete) remission. Baseline UPCR in g/g (explicit).
    (P1, "B", "001", "IGAN", "waiver", "active", None, "2.0", "g/g", [(0, 100, 2000), (90, 55, 900), (150, 50, 800), (250, 48, 850)]),
    # Two qualifying measurements only 10 days apart: neither decline nor remission confirmed.
    (P1, "A", "002", "IGAN", "consented", "active", None, "2000", "mg/g", [(0, 100, 2000), (90, 55, 250), (100, 54, 240)]),
    # Complete remission interrupted (600 at d150): not confirmed; partial remission (all <=1000) confirmed.
    (P1, "A", "003", "IGAN", "consented", "active", None, "2000", "mg/g", [(0, 100, 2000), (90, 95, 250), (150, 96, 600), (210, 97, 280)]),
    # Consent not confirmed / declined: excluded from every output.
    (P1, "A", "005", "IGAN", "unconfirmed", "active", None, "2000", "mg/g", [(0, 100, 2000), (90, 40, 100), (150, 40, 100)]),
    (P1, "A", "006", "IGAN", "declined", "active", None, "2000", "mg/g", [(0, 100, 2000), (90, 40, 100), (150, 40, 100)]),
    # Lost to follow-up at d120: later low values are after censoring, so decline awaits confirmation.
    (P1, "B", "002", "IGAN", "consented", "lost", 120, "2000", "mg/g", [(0, 100, 2000), (90, 55, 2000), (150, 50, 2000), (200, 49, 2000)]),
    # Confirmed death event at d140 (events_long): censored the same way.
    (P1, "A", "007", "IGAN", "consented", "active", None, "2000", "mg/g", [(0, 100, 2000), (90, 55, 2000), (150, 50, 2000)]),
    # Decline confirmed d60->d100 then recovery at d200: met unless require_last_below=true.
    (P1, "A", "008", "IGAN", "consented", "active", None, "2000", "mg/g", [(0, 100, 2000), (60, 55, 2000), (100, 54, 2000), (200, 90, 2000)]),
    # Other project, same code 001, module CKD (no remission definition): sustained decline; remission not covered.
    (P2, "A", "001", "CKD", "consented", "active", None, "500", "mg/g", [(0, 100, 500), (90, 50, 500), (150, 50, 500)]),
]


def write(name, header, rows):
    HERE.mkdir(parents=True, exist_ok=True)
    with (HERE / name).open("w", encoding="utf-8", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(header)
        w.writerows(rows)


def main():
    base_rows, visit_rows = [], []
    for i, (pid, center, code, module, consent, fs, fs_day, upcr, unit, visits) in enumerate(PATIENTS, start=1):
        base_rows.append([pid, center, code, f"b{i:03d}", module, "M", "1970", d(0), "80", upcr, unit,
                          consent, d(0) if consent in ("consented", "waiver") else "", "v1" if consent == "consented" else "",
                          fs, d(fs_day) if fs_day is not None else ""])
        for j, (day, egfr, up) in enumerate(visits, start=1):
            visit_rows.append([pid, center, code, f"v{i:03d}-{j}", module, d(day), "120", "80", "90", str(up), str(egfr), "manual"])
    write("patients_baseline.csv", KEY + ["id", "module", "sex", "birth_year", "baseline_date", "baseline_scr", "baseline_upcr",
                                           "baseline_upcr_unit", "consent_status", "consent_date", "consent_version",
                                           "followup_status", "followup_status_date"], base_rows)
    write("visits_long.csv", KEY + ["id", "module", "visit_date", "sbp", "dbp", "scr_umol_l", "upcr", "egfr", "egfr_formula_version"], visit_rows)
    write("events_long.csv", KEY + ["id", "module", "event_type", "event_date", "confirmed", "source"],
          [[P1, "A", "007", "e001", "IGAN", "death", d(140), "true", "staff"],
           [P1, "A", "001", "e002", "IGAN", "death", d(150), "false", "staff"]])


if __name__ == "__main__":
    main()
