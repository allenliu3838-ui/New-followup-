"""Merge complete registry CSV exports without guessing identity or dropping conflicts.

Run from package root:
  python analysis/merge_centers.py --dirs centers/A centers/B --out analysis/merged-data
  python analysis/run_analysis.py --data analysis/merged-data

Every nonempty table needs project_id, center_code, patient_code, id and module.
Exact retransmissions of one stable record are idempotent; conflicting content or
multiple baselines for one scoped patient stop the merge and preserve QC evidence.
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


def discover_center_dirs(base):
    return sorted(p for p in Path(base).iterdir() if p.is_dir() and (p/"patients_baseline.csv").is_file())


def merge_all(center_dirs, out_dir, qc_path, verbose=True):
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
    merged={}; conflicts=[]; duplicates=[]; hashes={}
    for table,default_columns in TABLE_COLUMNS.items():
        frames=[]
        for directory in center_dirs:
            if not directory.is_dir(): raise DataContractError(f"Missing input directory: {directory}")
            src=directory/f"{table}.csv"
            hashes[str(src)]=sha256(src) if src.exists() else None
            df=read_table(src,table,table in {"patients_baseline","visits_long"},allow_duplicates=True)
            df["_source_file"]=str(src)
            frames.append(df)
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
    # Conflict evidence remains available, but no analysis-ready dataset is emitted.
    write_xlsx(qc_path,{"RowCounts":counts,"ExactRetransmissions":pd.DataFrame(duplicates),"Conflicts":pd.DataFrame(conflicts)})
    if conflicts:
        raise DataContractError(f"Merge blocked by {len(conflicts)} conflict evidence rows. Resolve sources; inspect {qc_path}")
    out_dir.parent.mkdir(parents=True,exist_ok=True)
    stage=Path(tempfile.mkdtemp(prefix=".merge-stage-",dir=out_dir.parent))
    try:
        for t,df in merged.items(): df.to_csv(stage/f"{t}.csv",index=False,encoding="utf-8-sig")
        # Verify patient referential integrity across the complete merged output.
        load_tables(stage)
        manifest={"version":VERSION,"status":"merged_no_conflicts","input_sha256":hashes,"identity_key":KEY,"exact_retransmissions_removed":len(duplicates),"counts":{t:len(df) for t,df in merged.items()},"output_sha256":{p.name:sha256(p) for p in sorted(stage.glob('*.csv'))}}
        (stage/"MERGE_MANIFEST.json").write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding="utf-8")
        if out_dir.exists():out_dir.rmdir()
        os.replace(stage,out_dir)
    finally:
        if stage.exists():shutil.rmtree(stage)
    if verbose:print(f"MERGE_OK: {out_dir}\nQC: {qc_path}\nUse --data {out_dir} when running analysis; do not accidentally analyze the old data directory.")
    return merged


def main():
    p=argparse.ArgumentParser(description=__doc__,formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--dirs",nargs="+",type=Path)
    p.add_argument("--centers-root",type=Path,default=Path("centers"))
    p.add_argument("--out",type=Path,default=Path("analysis/merged-data"))
    p.add_argument("--qc",type=Path,default=Path("merge_qc.xlsx"))
    p.add_argument("--quiet",action="store_true")
    args=p.parse_args()
    try:
        dirs=args.dirs or discover_center_dirs(args.centers_root)
        merge_all(dirs,args.out,args.qc,verbose=not args.quiet)
    except (DataContractError,OSError,ValueError) as exc:p.exit(2,f"MERGE_FAILED: {exc}\nNo successful merged dataset produced.\n")

if __name__=="__main__":main()
