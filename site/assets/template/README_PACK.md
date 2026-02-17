# Paper Pack · {{PROJECT_NAME}} (export {{EXPORT_DATE}})

This folder is generated from KidneySphere AI (research registry). It contains:

- `analysis/data/*.csv` de-identified long tables
- `analysis/run_analysis.py` one-click analysis script
- `analysis/outputs/` generated outputs
- `manuscript/METHODS_AUTO_EN.md` auto Methods draft (PI final review required)

## Quick start

1) Install Python 3.10+ (Anaconda is recommended)
2) In this folder, run:

```bash
pip install -r analysis/requirements.txt
python analysis/run_analysis.py
```

## Outputs

- `analysis/outputs/table1_baseline.xlsx` : Table 1
- `analysis/outputs/qc_report.xlsx` : QC report (missingness / duplicates / outliers / center summary)
- `analysis/outputs/plot_egfr_trend.png` : eGFR trend plot
- `analysis/outputs/plot_upcr_trend.png` : UPCR trend plot
- `analysis/outputs/outcomes_12m.csv` : 12-month outcomes
