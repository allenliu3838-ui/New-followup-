"""Merge complete registry CSV exports without guessing identity or dropping conflicts.

Run from package root:
  python analysis/merge_centers.py --dirs centers/A centers/B --out analysis/merged-data
  python analysis/run_analysis.py --data analysis/merged-data

Every nonempty table needs project_id, center_code, patient_code, id and module.
Exact retransmissions of one stable record are idempotent; conflicting content or
multiple baselines for one scoped patient stop the merge and preserve QC evidence.
Center exports must have the same columns: a center whose export lacks a column the
others have (for example consent_status or followup_status from an older registry
version) stops the merge, because blank-filled consent would exclude that whole center
from analysis and blank follow-up status would silently disable its censoring. Only
--allow-missing-columns proceeds; the gaps are then recorded in MERGE_MANIFEST.json.
"""
from __future__ import annotations
import argparse
from pathlib import Path
import json
import os
import shutil
import tempfile

import pandas as pd
from run_analysis import (KEY, TABLE_COLUMNS, VERSION, DataContractError, load_tables,
                          read_table, sha256, write_xlsx)

# Columns whose absence changes analysis results rather than only completeness.
CRITICAL_COLUMNS = {
    "consent_status": "知情同意状态：缺失时该中心患者在分析中会全部被排除（consent status: blank is excluded）",
    "followup_status": "随访状态：缺失时该中心患者不按随访状态截尾（follow-up status: no censoring by status）",
    "followup_status_date": "随访状态日期：缺失时随访状态无法用作截尾日期（status date: cannot censor）",
    "baseline_upcr_unit": "基线 UPCR 单位：缺失时基线 UPCR 不参与计算（baseline UPCR unit）",
    "upcr_unit": "随访 UPCR 单位声明（visit UPCR unit declaration）",
    "egfr_formula_version": "eGFR 来源标记：缺失时 eGFR 视为来源未核实（eGFR provenance tag）",
    "unit_symbol": "化验原始单位（lab unit）",
    "lab_unit": "化验单位（lab unit）",
    "standard_unit": "化验标准单位（lab standard unit）",
}


def discover_center_dirs(base):
    return sorted(p for p in Path(base).iterdir() if p.is_dir() and (p/"patients_baseline.csv").is_file())


def column_mismatches(center_dirs, headers):
    """Per table, the columns a center's nonempty export lacks relative to the union of
    all center headers. An empty table loses no data and is not reported."""
    out=[]
    for table in TABLE_COLUMNS:
        union=set().union(*(set(headers[(table,d)][0] or []) for d in center_dirs))
        for d in center_dirs:
            cols,n=headers[(table,d)]
            missing=sorted(union-set(cols or []))
            if n and missing:
                out.append({"source_dir":str(d),"table":table,"missing_columns":missing,
                            "critical_missing":[c for c in missing if c in CRITICAL_COLUMNS]})
    return out


def mismatch_message(mismatches):
    lines=["各中心导出的列不一致，已停止合并（column sets differ between center exports; merge stopped）："]
    for m in mismatches:
        lines.append(f"  {m['source_dir']} 的 {m['table']}.csv 缺少列：{', '.join(m['missing_columns'])}")
        lines.extend(f"    - {c}：{CRITICAL_COLUMNS[c]}" for c in m["critical_missing"])
    lines.append("解决：请用同一版本的工作台重新导出所有中心（新版导出包含知情同意与随访状态列）。确需合并旧导出时，加 --allow-missing-columns："
                 "缺失列以空值填充，并记录在 MERGE_MANIFEST.json 与 QC 文件；分析时缺少 consent_status 的中心患者会被排除（分析脚本会因此停止，"
                 "除非另加 --allow-fully-excluded-centers），缺少 followup_status 的中心不按随访状态截尾。")
    lines.append("Fix: re-export every center with the same registry version, or pass --allow-missing-columns to fill the missing "
                 "columns with blanks (recorded in MERGE_MANIFEST.json); blank consent_status is excluded from analysis.")
    return "\n".join(lines)


def merge_all(center_dirs, out_dir, qc_path, verbose=True, allow_missing_columns=False):
    center_dirs=[Path(p).resolve() for p in center_dirs]
    if Path(out_dir).is_symlink() or Path(qc_path).is_symlink(): raise DataContractError("Merge output and QC must not be symlinks")
    out_dir,qc_path=Path(out_dir).resolve(),Path(qc_path).resolve()
    if not center_dirs: raise DataContractError("No input export directories")
    if qc_path.suffix.lower() != ".xlsx": raise DataContractError("QC path must be an .xlsx file")
    if any(d==qc_path or d in qc_path.parents for d in center_dirs+[out_dir]):
        raise DataContractError("QC path must be outside all input and merged output directories")
    if out_dir.is_symlink() or (out_dir.exists() and any(out_dir.iterdir())):
        raise DataContractError("Merge output must be a new/empty directory; old data must not remain")
    if any(out_dir==d or out_dir in d.parents or d in out_dir.parents for d in center_dirs):
        raise DataContractError("Merge output must be separate from every input export")
    merged={}; conflicts=[]; duplicates=[]; hashes={}; loaded={}; headers={}
    for table in TABLE_COLUMNS:
        for directory in center_dirs:
            if not directory.is_dir(): raise DataContractError(f"Missing input directory: {directory}")
            src=directory/f"{table}.csv"
            hashes[str(src)]=sha256(src) if src.exists() else None
            df=read_table(src,table,table in {"patients_baseline","visits_long"},allow_duplicates=True)
            headers[(table,directory)]=(df.attrs.get("source_columns"),len(df))
            df["_source_file"]=str(src)
            loaded.setdefault(table,[]).append(df)
    mismatches=column_mismatches(center_dirs,headers)
    centers=[{"source_dir":str(d),"project_centers":sorted({(r["project_id"],r["center_code"]) for r in df.to_dict("records")})}
             for d,df in zip(center_dirs,loaded["patients_baseline"])]
    for table,frames in loaded.items():
        combined=pd.concat(frames,ignore_index=True).fillna("")
        cols=[c for c in combined.columns if c!="_source_file"]
        records={};baseline_keys={};keep=[]
        for row in combined.to_dict("records"):
            rid=(row["project_id"],row["id"])
            if rid in records:
                previous=records[rid]
                differences=[c for c in cols if previous[c]!=row[c]]
                if differences:
                    for original in (previous,row):
                        conflicts.append({"table":table,"conflict":"record_content_differs","fields":",".join(differences),**original})
                else:
                    duplicates.append({"table":table,"project_id":row["project_id"],"id":row["id"],"kept_source":previous["_source_file"],"duplicate_source":row["_source_file"]})
                continue
            if table=="patients_baseline":
                pkey=tuple(row[k] for k in KEY)
                if pkey in baseline_keys:
                    for original in (baseline_keys[pkey],row): conflicts.append({"table":table,"conflict":"different_baseline_record_for_patient",**original})
                    continue
                baseline_keys[pkey]=row
            records[rid]=row;keep.append({c:row[c] for c in cols})
        merged[table]=pd.DataFrame(keep,columns=cols).sort_values(KEY+["id"],kind="stable")
    if any((sha256(p) if Path(p).exists() else None)!=digest for p,digest in hashes.items()):
        raise DataContractError("Input exports changed during merge; freeze inputs and retry")
    qc_path.parent.mkdir(parents=True,exist_ok=True)
    counts=pd.DataFrame([{"table":t,"rows_after_exact_retransmission_dedup":len(df)} for t,df in merged.items()])
    mismatch_sheet=pd.DataFrame([{**m,"missing_columns":", ".join(m["missing_columns"]),"critical_missing":", ".join(m["critical_missing"]),
                                  "allowed_by_allow_missing_columns":bool(allow_missing_columns)} for m in mismatches],
                                columns=["source_dir","table","missing_columns","critical_missing","allowed_by_allow_missing_columns"])
    # Conflict evidence remains available, but no analysis-ready dataset is emitted.
    write_xlsx(qc_path,{"RowCounts":counts,"ColumnMismatch":mismatch_sheet,"ExactRetransmissions":pd.DataFrame(duplicates),"Conflicts":pd.DataFrame(conflicts)})
    if mismatches and not allow_missing_columns:
        raise DataContractError(mismatch_message(mismatches)+f"\nQC: {qc_path}")
    if conflicts:
        raise DataContractError(f"Merge blocked by {len(conflicts)} conflict evidence rows. Resolve sources; inspect {qc_path}")
    out_dir.parent.mkdir(parents=True,exist_ok=True)
    stage=Path(tempfile.mkdtemp(prefix=".merge-stage-",dir=out_dir.parent))
    try:
        for t,df in merged.items(): df.to_csv(stage/f"{t}.csv",index=False,encoding="utf-8-sig")
        # Verify patient referential integrity across the complete merged output.
        load_tables(stage)
        manifest={"version":VERSION,"status":"merged_no_conflicts" if not mismatches else "merged_no_conflicts_with_missing_columns_filled_blank",
                  "input_sha256":hashes,"identity_key":KEY,"exact_retransmissions_removed":len(duplicates),
                  "allow_missing_columns":bool(allow_missing_columns),"column_mismatch":mismatches,"centers":centers,
                  "counts":{t:len(df) for t,df in merged.items()},"output_sha256":{p.name:sha256(p) for p in sorted(stage.glob('*.csv'))}}
        (stage/"MERGE_MANIFEST.json").write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding="utf-8")
        if out_dir.exists():out_dir.rmdir()
        os.replace(stage,out_dir)
    finally:
        if stage.exists():shutil.rmtree(stage)
    if verbose:
        print(f"MERGE_OK: {out_dir}\nQC: {qc_path}\nUse --data {out_dir} when running analysis; do not accidentally analyze the old data directory.")
        if mismatches:
            print("WARNING: columns missing in some center exports were filled blank (--allow-missing-columns); see MERGE_MANIFEST.json column_mismatch:")
            for m in mismatches: print(f"  {m['source_dir']} {m['table']}: {', '.join(m['missing_columns'])}")
    return merged


def main(argv=None):
    p=argparse.ArgumentParser(description=__doc__,formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--dirs",nargs="+",type=Path)
    p.add_argument("--centers-root",type=Path,default=Path("centers"))
    p.add_argument("--out",type=Path,default=Path("analysis/merged-data"))
    p.add_argument("--qc",type=Path,default=Path("merge_qc.xlsx"))
    p.add_argument("--allow-missing-columns",action="store_true",help="Merge although some center exports lack columns others have; missing columns are filled blank and recorded in MERGE_MANIFEST.json.")
    p.add_argument("--quiet",action="store_true")
    args=p.parse_args(argv)
    try:
        dirs=args.dirs or discover_center_dirs(args.centers_root)
        merge_all(dirs,args.out,args.qc,verbose=not args.quiet,allow_missing_columns=args.allow_missing_columns)
    except (DataContractError,OSError,ValueError) as exc:p.exit(2,f"MERGE_FAILED: {exc}\nNo successful merged dataset produced.\n")

if __name__=="__main__":main()
