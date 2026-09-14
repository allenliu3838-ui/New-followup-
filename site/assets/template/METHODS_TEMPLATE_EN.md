# Analysis preparation note — {{PROJECT_NAME}}

This file is created at data export, before analysis has run. It is not a completed
Methods section and makes no claim that data integration, model fitting, clinical
endpoint adjudication or KFRE prediction has occurred.

Project module: {{MODULE}}. Center: {{CENTER_CODE}}. Export: {{EXPORT_DATE}}.
Exported rows: {{N_PATIENTS}} patient baselines; {{N_VISITS}} follow-up records.

Run `analysis/run_analysis.py` as described in the package README. The resulting
run directory contains `METHODS_ACTUAL_EN.md`, `MODEL_STATUS.json` and `RUN_LOG.json`.
Only those run artifacts describe computations actually performed on the identified
input files. The investigator must separately document the approved study design,
cohort selection, data provenance, endpoint definitions and statistical plan.

KFRE, inferential cohort models and adjudicated clinical endpoints are not enabled
in this release. Numerical candidate thresholds are not diagnoses or validated
remission endpoints. No unit or missing demographic value should be guessed.
