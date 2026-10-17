#!/usr/bin/env python3
"""Run the reviewed read-only preflight inside the registry database container.

Run on the database host (Aliyun cn-shanghai). psql runs inside the local
container over its Unix socket, so no database password or network listener is
involved. The database identity is pinned by PostgreSQL's system_identifier,
checked before and after the preflight.
"""
import argparse
import json
import hashlib
import os
import re
from pathlib import Path
import subprocess

PROJECT_REF='ksr-aliyun-cn-shanghai-1'
SYSTEM_IDENTIFIER='7697419573917356067'
CONTAINER='supabase-db'
IDENTITY_SQL='SELECT system_identifier FROM pg_control_system();'
ROOT=Path(__file__).resolve().parents[1]


def approved_preflight_sql(root=ROOT):
    manifest_hash=hashlib.sha256((root/'supabase/migration-manifest.json').read_bytes()).hexdigest()
    contract=(root/'scripts/database_contract.sql').read_text().strip().removesuffix(';')
    contract_hash=hashlib.sha256((root/'scripts/database_contract.sql').read_bytes()).hexdigest()
    return (root/'scripts/database_preflight.sql.in').read_text().replace('__MIGRATION_MANIFEST_SHA256__',manifest_hash).replace('__DATABASE_CONTRACT_SHA256__',contract_hash).replace('__DATABASE_CONTRACT_QUERY__',contract)


def validate_preflight_sql(sql,root=ROOT):
    if re.search(r'^\s*\\',sql,re.MULTILINE) or sql.strip()!=approved_preflight_sql(root).strip():
        raise ValueError('Only the exact reviewed preflight SQL from this release is accepted; arbitrary SQL is forbidden')
    return sql


def container_command(container=CONTAINER):
    if not re.fullmatch(r'[a-z0-9][a-z0-9_.-]{0,62}',container or ''):
        raise ValueError('Invalid container name')
    # Every statement runs in a read-only transaction; psql reads SQL from stdin only.
    return ['docker','exec','-i','-e','PGOPTIONS=-c default_transaction_read_only=on',container,
            'psql','-U','postgres','-d','postgres','-X','-q','-t','-A','-v','ON_ERROR_STOP=1']


def run_sql(command,sql,runner=subprocess.run):
    # Never pass caller libpq routing/TLS/password variables to the docker client.
    env={k:v for k,v in os.environ.items() if not k.startswith('PG')}
    completed=runner(command,input=sql,env=env,text=True,capture_output=True,timeout=90)
    if completed.returncode:raise SystemExit('Database preflight failed. Check the container locally; no deployment allowed.')
    return completed.stdout.strip()


def database_identity(command,runner=subprocess.run):
    ident=run_sql(command,IDENTITY_SQL,runner)
    if ident!=SYSTEM_IDENTIFIER:
        raise SystemExit('Database system_identifier does not match the registry database; refusing to report')
    return ident


def capture(sql,container=CONTAINER,runner=subprocess.run):
    sql=validate_preflight_sql(sql)
    command=container_command(container)
    before=database_identity(command,runner)
    report=json.loads(run_sql(command,sql,runner))
    after=database_identity(command,runner)
    if before!=after:raise SystemExit('Database identity changed during capture')
    report.update(project_ref=PROJECT_REF,identity_source='verified_system_identifier',system_identifier=after)
    return report


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sql',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--container',default=CONTAINER)
    args=parser.parse_args()
    report=capture(args.sql.read_text(),args.container)
    with os.fdopen(os.open(args.output,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600),'w') as out:
        json.dump(report,out,indent=2);out.write('\n')
    print('Read-only database report saved; inspect every check before frontend deployment')


if __name__=='__main__':main()
