#!/usr/bin/env python3
"""Run a read-only preflight through psql. Credentials come only from local env."""
import argparse
import json
import hashlib
import os
import re
from pathlib import Path
import subprocess
import ssl
from urllib.parse import urlparse,unquote,parse_qs

PROJECT_REF='etsyglgpiutflethgirs'
ROOT=Path(__file__).resolve().parents[1]


def approved_preflight_sql(root=ROOT):
    manifest_hash=hashlib.sha256((root/'supabase/migration-manifest.json').read_bytes()).hexdigest()
    contract=(root/'scripts/database_contract.sql').read_text().strip().removesuffix(';')
    return (root/'scripts/database_preflight.sql.in').read_text().replace('__MIGRATION_MANIFEST_SHA256__',manifest_hash).replace('__DATABASE_CONTRACT_QUERY__',contract)


def validate_preflight_sql(sql,root=ROOT):
    if re.search(r'^\s*\\',sql,re.MULTILINE) or sql.strip()!=approved_preflight_sql(root).strip():
        raise ValueError('Only the exact reviewed preflight SQL from this release is accepted; arbitrary SQL is forbidden')
    return sql


def connection_environment(url,base=None,root_cert=None):
    parsed=urlparse(url)
    username=unquote(parsed.username or '')
    host=parsed.hostname or ''
    direct=host==f'db.{PROJECT_REF}.supabase.co'
    pooled=host.endswith('.pooler.supabase.com') and username==f'postgres.{PROJECT_REF}'
    if parsed.scheme not in ('postgres','postgresql') or not (direct or pooled):
        raise ValueError('Connection must identify the actual registry Supabase project; hostname/user mismatch')
    if unquote(parsed.path.lstrip('/') or 'postgres')!='postgres':
        raise ValueError('Only the registry API database postgres may be verified')
    # libpq PGHOSTADDR/PGSERVICE can redirect the connection independently of the
    # inspected URL. Never inherit a caller's connection routing or TLS overrides.
    env={k:v for k,v in (base if base is not None else os.environ).items() if not k.startswith('PG')}
    env.update(PGHOST=host,PGPORT=str(parsed.port or 5432),PGUSER=username,PGPASSWORD=unquote(parsed.password or ''),PGDATABASE=unquote(parsed.path.lstrip('/') or 'postgres'),PGCONNECT_TIMEOUT='15')
    mode=parse_qs(parsed.query).get('sslmode',['verify-full'])[0]
    if mode!='verify-full':raise ValueError('verify-full TLS is required to verify the database host identity')
    ca=Path(root_cert or ssl.get_default_verify_paths().cafile or '')
    if not ca.is_file():raise ValueError('Provide the trusted database CA bundle using --ssl-root-cert')
    env.update(PGSSLMODE='verify-full',PGSSLROOTCERT=str(ca.resolve()),PGOPTIONS='-c default_transaction_read_only=on')
    return env


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sql',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--ssl-root-cert',type=Path)
    args=parser.parse_args()
    sql=validate_preflight_sql(args.sql.read_text())
    url=os.environ.get('KSR_DATABASE_URL','')
    if not url:raise SystemExit('Set KSR_DATABASE_URL locally; never paste credentials into chat')
    env=connection_environment(url,root_cert=args.ssl_root_cert)
    completed=subprocess.run(['psql','-X','-q','-t','-A','-v','ON_ERROR_STOP=1'],input=sql,env=env,text=True,capture_output=True,timeout=90)
    if completed.returncode:raise SystemExit('Database preflight failed. Check psql connectivity/schema locally; no deployment allowed.')
    report=json.loads(completed.stdout.strip())
    report.update(project_ref=PROJECT_REF,identity_source='verified_connection_host')
    with os.fdopen(os.open(args.output,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600),'w') as out:
        json.dump(report,out,indent=2);out.write('\n')
    print('Read-only database report saved; inspect every check before frontend deployment')


if __name__=='__main__':main()
