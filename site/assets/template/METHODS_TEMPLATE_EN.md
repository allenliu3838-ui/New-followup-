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
the last measurement still qualifies), assessment windows, remission eligibility
(baseline UPCR available and at least `baseline_upcr_at_least`, or above the
remission threshold when not set), the reference for a UPCR reduction (protocol
baseline, or peak = highest UPCR from the baseline window start to before the
assessed measurement), handling of confirmed kidney failure (esrd) or death events
before a decline is confirmed (`count_as_event`: composite endpoint; `censor`),
censoring (follow-up status dates and confirmed events; measurements on the
censoring date are used) and units. Module codes and event types must belong to the
registry vocabularies, UPCR thresholds must have a plausible magnitude for the
declared unit, and confirmed modules or event types with no matching record stop the
run unless explicitly allowed.

A measurement that was recorded but excluded (eGFR of unverified source or without
usable inputs, invalid UPCR), and a UPCR date without a usable same-day eGFR when
eGFR stability is required, is UNKNOWN: it is never counted as qualifying and it
interrupts a run of qualifying measurements. The event date is the first measurement
of the qualifying run; with an assessment window, only measurements from the window
start count and that first in-window measurement must fall within the window.
Threshold comparisons are exact on the recorded decimal values. All times are
anchored at the registry baseline date, not at treatment start; for lupus nephritis
and membranous nephropathy responses, which are usually anchored at treatment start,
the investigator must confirm how the baseline date was defined.

`protocol_template.json` contains only examples (IgAN, LN, MN) written as common
research definitions; it names guidelines (e.g. KDIGO 2021 or later updates) only so
the investigator can check the original text, and does not restate guideline
recommendations. Every section is marked `requires_pi_confirmation: true`;
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
`waiver` are analysed by default; the registry default `unconfirmed` and blank values
are excluded. Exclusion counts by status and by project/center are in `RUN_LOG.json`
and `qc_issues.csv`. The run stops when any project/center, or the whole input, has
no included patient, unless `--allow-fully-excluded-centers` is given (recorded).
If the column is absent, no consent-based selection is applied and the log says so.
When merging center exports, differing column sets stop the merge unless
`--allow-missing-columns` is given; the gaps are recorded in `MERGE_MANIFEST.json`
and reported in `RUN_LOG.json`.

KFRE, inferential cohort models, confidence intervals and survival analyses are not
enabled in this release. No unit or missing demographic value should be guessed.

eGFR is recomputed from the stored creatinine for every visit whose formula tag is a
registry formula: adults (year-derived age 18-120) by the CKD-EPI 2021 creatinine
equation (Inker et al., 2021, Table 2; sex and year-derived age, no race term), and
children aged 1-17 years by the bedside Schwartz 2009 equation (0.413 x height in cm /
creatinine in mg/dL) from the height recorded at that visit; a paediatric visit without a
height has no analysis eGFR and is an UNKNOWN measurement. Values tagged manual are used
as stored; eGFR values of unverified provenance are excluded. The stored value is
compared with the recomputed one and differences are listed in the quality report.

## Biopsy-anchored time-window table (optional, `time_windows.py`)

For comparisons with studies that align measurements on the kidney biopsy date, day 0 is
the patient's index biopsy (the one biopsy record marked as index), or, when the
configuration lists it, the disease module's baseline biopsy date or the earliest native
biopsy; patients without an anchor are listed with the reason and are not imputed. For
each pre-specified time point (target day and inclusive window, in days from day 0) and
variable, same-day measurements are first combined into their median, the day nearest to
the target day is then taken, and of two equally near days the earlier one. Laboratory
values are used only after an explicit unit conversion; urine red cells counted per
microlitre (analyser) and per high-power field (microscopy) are separate variables and are
not converted into each other. eGFR at each time point is recomputed with the equations
named in the configuration [state the agreed pair]: for ages 18-120 the CKD-EPI 2021
creatinine equation (default), the CKD-EPI 2012 cystatin C equation or the CKD-EPI 2021
creatinine-cystatin C equation (Inker et al., 2012 and 2021); for ages 1-17 the bedside
Schwartz 2009 equation (default) or the CKiD U25 creatinine, cystatin C or combined (mean
of the two) equations (Pierce et al., 2021), with the height nearest to the measurement day
within the configured height window. Creatinine-based equations start from the creatinine
selected for the time point, and combined equations use the cystatin C measured on the same
day [or within N days, if configured]; cystatin C-only equations start from the cystatin C
selected for the time point. Cystatin C was measured by [assay], traceable to ERM-DA471/IFCC.
The configuration file (time points,
windows, variables, confirming investigators and date) and its SHA-256 are recorded in
`TIME_WINDOWS_LOG.json`; output from an unconfirmed configuration is labelled UNCONFIRMED.

## Descriptive summary (optional, `descriptive_summary.py`)

Baseline characteristics were summarised per centre and for all centres combined among the
included patients (same population as above): counts and percentages for categorical
enrollment fields, with all included patients of the centre and patients with the field
recorded as two stated denominators; n, mean, SD, median, quartiles and range for numeric
fields; the proportion of patients with at least one record of each medication class
[e.g. vasopressin V2 receptor antagonist]; and the proportion with kidney failure, defined as
a recorded end-stage kidney disease, start of dialysis or kidney transplantation event, or a
follow-up status of kidney failure. Fields were combined across centres by field code only
when their type agreed [state whether all centres used the same field draft]. Free-text
fields were counted as recorded or not and their content was not analysed. The output
contains aggregate counts only; small cells were [suppressed below N / reported as is] in
accordance with the data use agreement. Input file SHA-256 values and the consent selection
are recorded in `SUMMARY_RUN_LOG.json`.

