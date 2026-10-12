# Analysis preparation note — {{PROJECT_NAME}}

This file is created at data export, before analysis has run. It is not a completed
Methods section and makes no claim that data integration, model fitting, clinical
endpoint determination or KFRE prediction has occurred.

Project module: {{MODULE}}. Center: {{CENTER_CODE}}. Export: {{EXPORT_DATE}}.
Exported rows: {{N_PATIENTS}} patient baselines; {{N_VISITS}} follow-up records.

Run `analysis/run_analysis.py` as described in the package README. The resulting
run directory contains `METHODS_ACTUAL_EN.md`, `MODEL_STATUS.json` and `RUN_LOG.json`.
Only those run artifacts describe computations actually performed on the identified
input files. The investigator must separately document the approved study design,
cohort selection, data provenance and statistical plan.

## Endpoint definitions come from the study protocol file

Without `--protocol`, the script only writes single-measurement numerical flags
named `candidate_unconfirmed_*`. They are not endpoints, not remission, and are
never summarised as rates.

With `--protocol <file.json>`, sustained eGFR decline and module-specific remission
are determined strictly from the parameters in that file: baseline rule and window,
thresholds, confirmation (minimum number of consecutive qualifying measurements,
minimum days between first and confirming measurement, optional requirement that
the last available measurement still qualifies), assessment windows, censoring
(follow-up status dates and confirmed events) and units. `protocol_template.json`
contains only examples (IgAN, LN, MN; cited, e.g. KDIGO 2021 glomerular disease
guideline chapters) and every section is marked `requires_pi_confirmation: true`;
unconfirmed sections and modules without a definition are not computed and are
listed in `qc_issues.csv`. The principal investigator confirms the definitions,
sets `requires_pi_confirmation` to false and records name and date in
`confirmation`. The UPCR unit in the protocol must equal the explicit data unit
(mg/g); otherwise the run is refused and no threshold is rescaled.

The run records the full protocol text and its SHA-256 in `RUN_LOG.json` and
`METHODS_ACTUAL_EN.md`, and copies the file as `protocol_used.json`. Results are
labelled "determined per protocol <id>@<version>": this is algorithmic
determination from protocol parameters, not manual endpoint-committee adjudication.

## Population

If the baseline table contains `consent_status`, only patients with `consented` or
`waiver` are analysed by default; exclusion counts by status are in `RUN_LOG.json`.
If the column is absent, no consent-based selection is applied and the log says so.

KFRE, inferential cohort models, confidence intervals and survival analyses are not
enabled in this release. No unit or missing demographic value should be guessed.
