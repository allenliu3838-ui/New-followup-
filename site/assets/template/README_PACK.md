# Paper Pack · {{PROJECT_NAME}} (export {{EXPORT_DATE}})

This folder is generated from KidneySphere AI (research registry). It contains:

- `analysis/data/*.csv` de-identified long tables
- `analysis/run_analysis.py` one-click analysis script (Phase 1)
- `analysis/outputs/` generated outputs
- `manuscript/METHODS_AUTO_EN.md` auto Methods draft (PI final review required)

## Quick start

1) Install Python 3.10+ (Anaconda is recommended)
2) In this folder, run:

```bash
pip install -r analysis/requirements.txt
python analysis/run_analysis.py
```

## Data tables

| File | Description |
|------|-------------|
| `patients_baseline.csv` | Baseline demographics + IgAN Oxford MEST-C |
| `visits_long.csv` | Longitudinal follow-up visits (BP, Scr, UPCR, eGFR) |
| `labs_long.csv` | Additional lab values |
| `meds_long.csv` | Medications (drug name, class, dose, dates) |
| `variants_long.csv` | Genetic variants |
| `events_long.csv` | Clinical endpoint events (manual + auto-computed) |

## Outputs

| File | Description |
|------|-------------|
| `table1_baseline.xlsx` | Table 1: baseline characteristics + drug summary + endpoints |
| `qc_report.xlsx` | QC: missingness / duplicates / outliers / center summary |
| `outcomes_12m.csv` | 12-month eGFR and UPCR changes |
| `endpoints_egfr_decline.csv` | First ≥40% and ≥57% eGFR decline events per patient |
| `endpoints_igan_remission.csv` | CR and PR dates per IgAN patient (if applicable) |
| `egfr_slope_lme.csv` | LME cohort-level eGFR slope estimate (mL/min/1.73m²/yr) |
| `egfr_slope_per_patient.csv` | Individual OLS eGFR slopes per patient |
| `plot_egfr_trend.png` | eGFR trend plot (mean ± 95% CI by month) |
| `plot_upcr_trend.png` | UPCR trend plot |
| `plot_egfr_slope_hist.png` | Distribution of individual eGFR slopes |
| `RUN_LOG.json` | Run summary (patient/visit counts, files generated) |

## Notes

- **eGFR decline**: First visit where eGFR < 60% (≥40% decline) or < 43% (≥57% decline) of baseline. Investigators should verify sustained confirmation (≥2 visits) before reporting.
- **Remission (IgAN)**: CR = UPCR < 300 mg/g; PR = ≥50% reduction AND < 1000 mg/g. Confirm unit conventions.
- **eGFR slope**: LME requires ≥5 patients and ≥10 eGFR observations. Falls back to individual OLS otherwise.
- **PI review required** for all Methods drafts before submission.
