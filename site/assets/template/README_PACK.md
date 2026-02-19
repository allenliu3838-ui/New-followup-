# Paper Pack · {{PROJECT_NAME}} (export {{EXPORT_DATE}})

This folder is generated from KidneySphere AI (research registry). It contains:

- `analysis/data/*.csv` de-identified long tables
- `analysis/run_analysis.py` one-click analysis script (Phase 1)
- `analysis/outputs/` generated outputs
- `manuscript/METHODS_AUTO_EN.md` auto Methods draft (PI final review required)

## Quick start (single center)

1) Install Python 3.10+ (Anaconda is recommended)
2) In this folder, run:

```bash
pip install -r analysis/requirements.txt
python analysis/run_analysis.py
```

## Multi-center merge (Phase 2)

Collect paper packs from all participating centers. Place each center's `data/` folder into a `centers/` directory:

```
centers/
  center_HK/
    patients_baseline.csv
    visits_long.csv
    ...
  center_BJ/
    patients_baseline.csv
    visits_long.csv
    ...
```

Then run:

```bash
# Auto-discover centers/ subdirectories
python analysis/merge_centers.py

# Or explicit paths
python analysis/merge_centers.py --dirs centers/center_HK centers/center_BJ --out analysis/data/
```

This writes merged CSVs to `analysis/data/` and generates `merge_qc.xlsx`. **Review `merge_qc.xlsx` before running analysis.** Then:

```bash
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
| `kfre_scores.csv` | KFRE 4-var and 8-var 2-yr/5-yr kidney failure risk per patient |
| `endpoints_egfr_decline.csv` | First ≥40% and ≥57% eGFR decline events per patient |
| `endpoints_igan_remission.csv` | CR and PR dates per IgAN patient (if applicable) |
| `egfr_slope_lme.csv` | LME cohort-level eGFR slope estimate (mL/min/1.73m²/yr) |
| `egfr_slope_per_patient.csv` | Individual OLS eGFR slopes per patient |
| `plot_egfr_trend.png` | eGFR trend plot (mean ± 95% CI by month) |
| `plot_upcr_trend.png` | UPCR trend plot |
| `plot_egfr_slope_hist.png` | Distribution of individual eGFR slopes |
| `RUN_LOG.json` | Run summary (patient/visit counts, files generated) |

## Notes

- **Multi-center**: Run `merge_centers.py` before `run_analysis.py`. Review `merge_qc.xlsx` for duplicates and patient code collisions.
- **KFRE**: 4-variable requires age, sex, eGFR, and UPCR (used as uACR proxy). 8-variable additionally requires albumin, phosphate, bicarbonate, calcium from `labs_long`. Verify unit auto-conversion in `kfre_scores.csv` before reporting. Citation: Tangri et al. JAMA 2011;305:1553–9.
- **eGFR decline**: First visit where eGFR < 60% (≥40% decline) or < 43% (≥57% decline) of baseline. Investigators should verify sustained confirmation (≥2 visits) before reporting.
- **Remission (IgAN)**: CR = UPCR < 300 mg/g; PR = ≥50% reduction AND < 1000 mg/g. Confirm unit conventions.
- **eGFR slope**: LME requires ≥5 patients and ≥10 eGFR observations. Falls back to individual OLS otherwise.
- **PI review required** for all Methods drafts before submission.
