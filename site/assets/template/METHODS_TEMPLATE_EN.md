# METHODS (AUTO DRAFT) — {{PROJECT_NAME}}

> Auto-generated draft. Principal investigator (PI) must review and edit before submission.

## Study design
We conducted a multicenter observational registry study using de-identified follow-up data collected in KidneySphere AI.
The merge key for multicenter integration was `center_code + patient_code`.

## Cohort and data capture
- Disease module: {{MODULE}}
- Center code: {{CENTER_CODE}}
- Export date: {{EXPORT_DATE}}
- Number of patients: {{N_PATIENTS}}
- Number of follow-up visits: {{N_VISITS}}

The registry captured baseline characteristics and longitudinal follow-up visits. The minimal core follow-up items were visit date, blood pressure, serum creatinine, and proteinuria (UPCR).
Estimated glomerular filtration rate (eGFR) was calculated using a creatinine-based equation (race-free), when age and sex were available.

## Pathology (IgA nephropathy)
For IgA nephropathy projects, Oxford MEST-C classification (M, E, S, T, C) could be recorded if biopsy data were available.

## Genetic data (if available)
If genetic testing was performed, variants could be recorded in a long-table format including gene, variant description, HGVS notation, zygosity, and ACMG classification.

## Quality control
A standardized QC report was generated to assess missingness of core variables, duplicated visits (same patient and date), and outlier values by center.

## Outcomes
A 12-month outcomes table was derived by selecting the visit closest to 12 months (within a prespecified window) from baseline and computing changes in eGFR and proteinuria.

