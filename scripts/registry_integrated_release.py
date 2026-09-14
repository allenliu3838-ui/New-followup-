#!/usr/bin/env python3
"""Fixed registry-only offline release. Database migrations are never executed."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import stat
import tempfile
import zipfile
import registry_pages_release as safe
import registry_visual_release as visual

TARGET=Path('/var/www/kidneysphere-registry')
BACKUPS=Path('/root/registry-integrated-releases')
PROJECT_REF='etsyglgpiutflethgirs'
VERSION='registry-20260914-integrated-pg17-v3'
CONTRACT_PROTOCOL='registry-contract-v3-pg17'
CONTRACT_SERVER_MAJOR=17
CONTRACT_CATEGORIES=('functions','triggers','policies','tables','columns','indexes','schema_privileges','buckets','views')
CONTRACT_PROFILE_NAMES={'canonical','historical_crlf'}
ALLOWED=set('''index.html staff.html staff.js patient.html patient.js signup.html login.html auth-callback.html checkout.html checkout.js pricing.html pricing-config.js app.css analytics.js demo.html privacy.html security.html deployment.html terms.html disclaimer.html collaboration.html collaboration-components.js collaboration-data.js slides.html guide.html guide.js guide.css guide-steps.css user-manual-cn.html 404.html robots.txt sitemap.xml _redirects
lib/supabase-client.js lib/utils.js lib/error-logger.js lib/rate-limit.js lib/password-strength.js lib/registry-data.js lib/patient-workflow.js lib/project-members.js lib/auth-navigation.js lib/vendor/supabase.js lib/vendor/jszip.min.js lib/vendor/LICENSES.txt lib/vendor/versions.json
assets/sql/batch1_core.sql assets/sql/batch2_features.sql assets/sql/batch3_admin.sql assets/sql/batch4_pr.sql assets/sql/batch5_qc.sql assets/sql/batch6_latest.sql
assets/registry-tech-hero.png assets/template/run_analysis.py assets/template/merge_centers.py assets/template/requirements.txt assets/template/METHODS_TEMPLATE_EN.md assets/template/README_PACK.md'''.split())
SENTINELS=tuple(map(Path,('/var/www/kidneysphere/index.html','/var/www/kidneysphere-doctor/index.html','/var/www/followup/index.html','/opt/kidneysphere/doctor_remote/index.html','/etc/nginx/nginx.conf','/etc/nginx/conf.d/kidneysphereregistry.conf')))
MAX_BYTES=16*1024*1024
safe.MAX_BYTES=MAX_BYTES
Error=safe.ReleaseError


def stamp():return datetime.now(timezone.utc).isoformat()
def digest(data):return hashlib.sha256(data).hexdigest()
def identity(info):return [info.st_dev,info.st_ino]


def observe(path):
    # Missing future vendor directory is permitted; symlink ancestors never are.
    parent=path.parent
    while not parent.exists():
        if parent.is_symlink():raise Error('Indirect directory: '+str(parent))
        parent=parent.parent
    safe.directory(parent)
    if path.is_symlink():raise Error('Symlink target refused: '+str(path))
    if not path.exists():return None
    data,info=safe.read_file(path)
    return {'sha256':digest(data),'uid':info.st_uid,'gid':info.st_gid,'mode':stat.S_IMODE(info.st_mode),'identity':identity(info)}


def sentinels(paths=SENTINELS):return {str(p):observe(p) for p in paths}


def load_bundle(archive):
    with zipfile.ZipFile(archive) as z:
        if len(z.namelist())!=len(set(z.namelist())):raise Error('Duplicate package member')
        manifest=json.loads(z.read('release-manifest.json'))
        names=set(manifest.get('files',{}))
        if not names or not names<=ALLOWED:raise Error('Release path outside fixed allowlist')
        expected={'__main__.py','registry_integrated_release.py','registry_pages_release.py','registry_visual_release.py','release-manifest.json','database-preflight.sql'}|{'payload/'+n for n in names}
        if set(z.namelist())!=expected:raise Error('Unexpected package members')
        if manifest.get('release')!=VERSION or manifest.get('project_ref')!=PROJECT_REF:raise Error('Wrong release or project')
        contract_profiles(manifest)
        payload={}
        for name in names:
            info=z.getinfo('payload/'+name)
            if info.file_size>MAX_BYTES:raise Error('Oversized payload')
            data=z.read(info)
            if digest(data)!=manifest['files'][name]['new_sha256']:raise Error('Payload checksum mismatch: '+name)
            payload[name]=data
    return manifest,payload


def contract_profiles(manifest):
    """Only complete, independently reviewed PG17 profiles are accepted."""
    if manifest.get('database_contract_protocol')!=CONTRACT_PROTOCOL:
        raise Error('Unsupported database contract protocol; use the matching release')
    major=manifest.get('database_server_major')
    if type(major) is not int or major!=CONTRACT_SERVER_MAJOR:
        raise Error('This release requires a reviewed PostgreSQL 17 contract')
    query_hash=manifest.get('database_contract_sha256')
    if not isinstance(query_hash,str) or not re.fullmatch(r'[0-9a-f]{64}',query_hash):
        raise Error('Missing or invalid reviewed database contract query hash')
    profiles=manifest.get('database_contract_profiles')
    if not isinstance(profiles,dict) or set(profiles)!=CONTRACT_PROFILE_NAMES:
        raise Error('Expected both reviewed canonical and historical CRLF contract profiles')
    for profile in profiles.values():
        if not isinstance(profile,dict) or set(profile)!=set(CONTRACT_CATEGORIES):
            raise Error('Incomplete database contract profile')
        for category in CONTRACT_CATEGORIES:
            rows=profile[category]
            if not isinstance(rows,list) or not rows or any(not isinstance(row,dict) for row in rows):
                raise Error('Missing or malformed database contract category: '+category)
    return profiles


def verify_db(report, manifest, now=None):
    now=now or datetime.now(timezone.utc)
    if not isinstance(report,dict):raise Error('Malformed database report')
    if report.get('database')!='postgres' or report.get('project_ref')!=PROJECT_REF or report.get('release')!=VERSION or report.get('migration_manifest_sha256')!=manifest['migration_manifest_sha256']:
        raise Error('Database report does not match this project/release/migration manifest')
    profiles=contract_profiles(manifest)
    if report.get('contract_protocol')!=CONTRACT_PROTOCOL or report.get('database_contract_sha256')!=manifest['database_contract_sha256']:
        raise Error('Database report protocol/query does not match this reviewed release')
    version=report.get('server_version_num')
    major=report.get('database_server_major')
    if type(version) is not int or type(major) is not int or version//10000!=CONTRACT_SERVER_MAJOR or major!=CONTRACT_SERVER_MAJOR:
        raise Error('Database report must come from PostgreSQL 17; other versions require review')
    if report.get('transaction_read_only')!='on' or report.get('render_timezone')!='UTC' or report.get('render_search_path')!='pg_catalog, public':
        raise Error('Database contract must be captured read-only with the reviewed UTC/search_path settings')
    try:age=(now-datetime.fromisoformat(report['checked_at'].replace('Z','+00:00'))).total_seconds()
    except Exception as exc:raise Error('Invalid database check timestamp') from exc
    if age< -300 or age>86400:raise Error('Database report must be from the last 24 hours')
    checks=report.get('checks',{})
    required=manifest['required_db_checks']
    if not isinstance(checks,dict) or not required or any(checks.get(name) is not True for name in required):
        raise Error('Database schema/permission validation incomplete or failed')
    if report.get('identity_source')!='verified_connection_host':
        raise Error('Database project identity must be verified from connection host/user; use capture_registry_database.py')
    if set(report.get('schema_versions',[]))!=set(manifest['required_schema_versions']):
        raise Error('Unexpected database schema version set; re-review before frontend deployment')
    # Profiles describe whole reviewed upgrade paths. Never select a convenient
    # hash per function: that would accept a hybrid nobody built or reviewed.
    actual={}
    for category in CONTRACT_CATEGORIES:
        rows=report.get(category)
        if not isinstance(rows,list) or not rows or any(not isinstance(row,dict) for row in rows):
            raise Error('Missing or malformed database report category: '+category)
        actual[category]=sorted(json.dumps(row,sort_keys=True) for row in rows)
    for name,profile in profiles.items():
        if all(actual[category]==sorted(json.dumps(row,sort_keys=True) for row in profile[category]) for category in CONTRACT_CATEGORIES):
            return name
    raise Error('Database catalog differs from every complete reviewed PostgreSQL 17 profile; re-review before deployment')


def capture(manifest,target=TARGET,backups=BACKUPS,paths=SENTINELS):
    safe.directory(target);safe.secure_backups(backups)
    folder=Path(tempfile.mkdtemp(prefix='capture-',dir=backups))
    (folder/'old').mkdir(mode=0o700)
    state={n:observe(target/n) for n in sorted(manifest['files'])}
    config=observe(target/'config.js')
    if config is None or config['sha256']!=manifest['config_sha256']:raise Error('Unexpected config.js: verify project before continuing')
    snapshot={'release':VERSION,'captured_at':stamp(),'target':str(target),'files':state,'config':config,'sentinels':sentinels(paths),'release_manifest_sha256':digest(json.dumps(manifest,sort_keys=True).encode())}
    for name,info in state.items():
        if info is not None:
            dest=folder/'old'/name;dest.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
            shutil.copy2(target/name,dest,follow_symlinks=False)
            safe.require_hash(dest,info['sha256'])
            with open(dest,'rb') as stream:os.fsync(stream.fileno())
    safe.write_new(folder/'capture.json',json.dumps(snapshot,indent=2).encode())
    for path in sorted((p for p in folder.rglob('*') if p.is_dir()),reverse=True):safe.sync_dir(path)
    safe.sync_dir(folder);safe.sync_dir(backups)
    return folder


def read_private(folder,name):
    safe.directory(folder)
    info=folder.stat()
    if info.st_uid!=os.geteuid() or stat.S_IMODE(info.st_mode)&0o077:raise Error('Private owned backup directory required')
    return json.loads(safe.read_file(folder/name)[0])


def validate_capture(folder,manifest,target,paths):
    old=read_private(folder,'capture.json')
    if old.get('target')!=str(target) or old.get('release_manifest_sha256')!=digest(json.dumps(manifest,sort_keys=True).encode()):raise Error('Capture belongs to another release/target')
    if set(old.get('files',{}))!=set(manifest['files']):raise Error('Capture file list mismatch')
    if observe(target/'config.js')!=old['config'] or sentinels(paths)!=old['sentinels']:raise Error('Configuration or another site changed since capture')
    for name,info in old['files'].items():
        if observe(target/name)!=info:raise Error('Target changed since capture: '+name)
        if (None if info is None else info['sha256'])!=manifest['files'][name]['old_sha256']:raise Error('Unreviewed production baseline: '+name)
        if info is not None:safe.require_hash(folder/'old'/name,info['sha256'])
    return old


def rollback(folder,manifest,target=TARGET,paths=SENTINELS):
    old=read_private(folder,'capture.json');journal=read_private(folder,'journal.json')
    if old.get('target')!=str(target) or old.get('release_manifest_sha256')!=digest(json.dumps(manifest,sort_keys=True).encode()):raise Error('Wrong backup release')
    items=journal.get('items',{})
    if not set(items)<=set(manifest['files']):raise Error('Invalid recovery file list')
    for name,item in items.items():
        current=observe(target/name);prior=old['files'][name]
        if current is None and prior is None:continue
        if current is not None and prior is not None and current['sha256']==prior['sha256']:continue
        if current is None or current['sha256']!=manifest['files'][name]['new_sha256'] or current['identity']!=item['identity']:raise Error('Third-party file change; recovery stopped: '+name)
        if prior is not None:safe.require_hash(folder/'old'/name,prior['sha256'])
    for name,item in reversed(list(items.items())):
        current=observe(target/name);prior=old['files'][name]
        if current is None or (prior is not None and current['sha256']==prior['sha256']):continue
        if current['sha256']!=manifest['files'][name]['new_sha256'] or current['identity']!=item['identity']:
            raise Error('Third-party file change during recovery; recovery stopped: '+name)
        if prior is None:
            (target/name).unlink();safe.sync_dir((target/name).parent)
        else:
            safe.atomic_copy(folder/'old'/name,target/name,manifest['files'][name]['new_sha256'],dict(prior,reference=str(folder/'old'/name),expected_source=prior['sha256'],expected_identity=item['identity']))
    # Never restore configuration or other sites, even if external changes occurred.
    return list(items)


def save_journal(folder,journal):
    path=folder/'journal.json';temporary=folder/'journal.next'
    if temporary.exists():temporary.unlink()
    safe.write_new(temporary,json.dumps(journal,indent=2).encode());os.replace(temporary,path);safe.sync_dir(folder)


def apply(manifest,payload,folder,db_report,target=TARGET,paths=SENTINELS):
    verify_db(db_report,manifest)
    old=validate_capture(folder,manifest,target,paths)
    journal={'items':{},'started_at':stamp()}
    if (folder/'journal.json').exists():raise Error('Capture already used; preserve it for rollback and take a new capture')
    (folder/'new').mkdir(mode=0o700)
    save_journal(folder,journal)
    try:
        # Assets/scripts first, HTML last. Not a multi-file transaction; schedule a quiet window.
        for name in sorted(payload,key=lambda n:(n.endswith('.html'),n)):
            prior=old['files'][name];data=payload[name]
            if digest(data)!=manifest['files'][name]['new_sha256']:raise Error('Payload changed')
            if prior is not None and prior['sha256']==digest(data):continue
            destination=target/name
            if not destination.parent.exists():
                if destination.parent!=target/'lib/vendor':raise Error('Unexpected new parent directory')
                safe.directory(target/'lib');destination.parent.mkdir(mode=0o755)
            safe.directory(destination.parent)
            staged=folder/'new'/name;staged.parent.mkdir(parents=True,exist_ok=True,mode=0o700);safe.write_new(staged,data)
            if observe(destination)!=prior:raise Error('Concurrent target change: '+name)
            # Persist future inode before atomic installation, enabling crash recovery.
            fd,tmp=tempfile.mkstemp(prefix='.registry-integrated-',dir=destination.parent);tmp=Path(tmp)
            try:
                with os.fdopen(fd,'wb') as stream:stream.write(data);stream.flush();os.fsync(stream.fileno())
                if prior is not None:
                    shutil.copystat(folder/'old'/name,tmp,follow_symlinks=False);os.chown(tmp,prior['uid'],prior['gid']);os.chmod(tmp,prior['mode'])
                else:os.chmod(tmp,0o644)
                safe.require_hash(tmp,digest(data))
                journal['items'][name]={'identity':identity(tmp.stat()),'stage':str(tmp)};save_journal(folder,journal)
                if observe(destination)!=prior:raise Error('Concurrent target change: '+name)
                if prior is None:visual.install_image(tmp,destination)
                else:os.replace(tmp,destination);safe.sync_dir(destination.parent)
                safe.require_hash(destination,digest(data))
            finally:
                if tmp.exists():tmp.unlink()
        if sentinels(paths)!=old['sentinels'] or observe(target/'config.js')!=old['config']:raise Error('Configuration/other-site sentinel changed during release')
    except BaseException:
        try:rollback(folder,manifest,target,paths)
        except Exception as recovery:print('ROLLBACK_STOPPED:',recovery)
        raise
    return folder


def main(archive):
    parser=argparse.ArgumentParser(description=__doc__)
    actions=parser.add_mutually_exclusive_group()
    actions.add_argument('--capture',action='store_true')
    actions.add_argument('--apply',action='store_true')
    actions.add_argument('--rollback',type=Path)
    actions.add_argument('--print-db-sql',action='store_true')
    parser.add_argument('--capture-dir',type=Path)
    parser.add_argument('--db-report',type=Path)
    args=parser.parse_args();manifest,payload=load_bundle(archive)
    if args.print_db_sql:
        with zipfile.ZipFile(archive) as z:print(z.read('database-preflight.sql').decode())
        return
    if args.capture or args.apply or args.rollback:
        if os.geteuid()!=0:raise Error('Fixed-path server operations require root')
        with safe.release_lock(BACKUPS):
            if args.capture:
                print('CAPTURE='+str(capture(manifest)));return
            folder=(args.rollback or args.capture_dir)
            if folder is None:raise Error('--capture-dir is required')
            folder=folder.absolute()
            if folder.parent!=BACKUPS:raise Error('Capture must be directly under '+str(BACKUPS))
            if args.rollback:rollback(folder,manifest);print('ROLLBACK_OK: registry files restored; database unchanged');return
            if args.db_report is None:raise Error('--db-report is required; homepage smoke checks are not database validation')
            apply(manifest,payload,folder,json.loads(safe.read_file(args.db_report)[0]))
            print('RELEASE_OK: registry file hashes verified; no migrations or services changed')
            print('ROLLBACK_COMMAND: python3 '+str(archive)+' --rollback '+str(folder))
            print('Public five-site and authenticated workflow acceptance remains required')
    else:
        state={n:observe(TARGET/n) for n in sorted(manifest['files'])}
        unknown=[n for n,info in state.items() if (None if info is None else info['sha256']) not in {manifest['files'][n]['old_sha256'],manifest['files'][n]['new_sha256']}]
        if unknown:raise Error('Unreviewed files: '+', '.join(unknown))
        print('CHECK_ONLY: file baselines recognized. No database or public-site validation performed.')
