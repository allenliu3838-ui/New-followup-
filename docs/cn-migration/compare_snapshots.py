#!/usr/bin/env python3
"""比较两份 snapshot.sql 输出（见 docs/CN_MIGRATION.md）。只读本地 JSON 文件，不连接数据库。

  python3 -I docs/cn-migration/compare_snapshots.py --phase freeze  冻结开始.json 备份完成后.json
  python3 -I docs/cn-migration/compare_snapshots.py --phase restore 旧环境.json 新环境-恢复后.json
  python3 -I docs/cn-migration/compare_snapshots.py --phase upgrade 旧环境.json 新环境-升级后.json

freeze   旧环境在冻结期间没有任何变化（除检查时间外完全一致）。
restore  新环境恢复后、执行 0032–0041 之前：每张业务表的行数与内容指纹、账号登录指纹、随访链接摘要指纹
         与旧环境一致；新环境 Auth/Storage 服务的迁移版本必须包含旧环境的全部版本。附件对象此时尚未上传，
         不比较（加 --storage-uploaded 则要求一致）。
upgrade  执行 0032–0041 并上传附件之后：关键表行数、账号登录指纹、随访链接摘要指纹、附件对象清单与旧环境一致；
         数据库中明文随访链接为 0；版本登记包含 0032–0041。业务表内容指纹因新增字段而变化，不比较。
退出码：0 一致；1 不一致；2 参数或文件错误。
"""
import argparse
import json
import sys

UPGRADE_VERSIONS = ['0032_security_integrity', '0033_billing_registration', '0034_import_corrections',
                    '0035_frozen_exports', '0036_project_members', '0037_concept_view_security',
                    '0038_followup_workflow', '0039_patient_token_hashing',
                    '0040_batch_import', '0041_followup_board']


def load(path):
    with open(path, encoding='utf-8') as handle:
        text = handle.read().strip()
    data = json.loads(text)
    if isinstance(data, dict) and 'cn_migration_snapshot' in data:
        data = data['cn_migration_snapshot']
    if not isinstance(data, dict) or data.get('snapshot_version') != 'cn-migration-snapshot-v1':
        raise ValueError(f'{path} 不是 snapshot.sql 的输出')
    return data


def split(value):
    return [v for v in (value or '').split(',') if v]


def compare(phase, old, new, storage_uploaded=False):
    problems, notes = [], []

    def same(label, a, b):
        if a != b:
            problems.append(f'{label} 不一致：旧 {a!r} / 新 {b!r}')

    if phase == 'freeze':
        for key in sorted(set(old) | set(new)):
            if key != 'checked_at':
                same(key, old.get(key), new.get(key))
        return problems, notes

    old_counts, new_counts = old.get('key_counts') or {}, new.get('key_counts') or {}
    skip = set() if (phase == 'upgrade' or storage_uploaded) else {'storage.objects'}
    for table in sorted(old_counts):
        if table not in skip:
            same(f'行数 {table}', old_counts.get(table), new_counts.get(table))
    same('账号登录指纹（id+邮箱+密码哈希）', old.get('auth_users_login_md5'), new.get('auth_users_login_md5'))
    same('随访链接摘要指纹', old.get('patient_token_digest_md5'), new.get('patient_token_digest_md5'))
    if phase == 'restore':
        old_tables, new_tables = old.get('tables') or {}, new.get('tables') or {}
        for table in sorted(old_tables):
            same(f'业务表 {table}', old_tables.get(table), new_tables.get(table))
        extra = sorted(set(new_tables) - set(old_tables))
        if extra:
            problems.append('新环境多出业务表（恢复前不应存在）：' + ', '.join(extra))
        same('版本登记', old.get('registry_schema_versions'), new.get('registry_schema_versions'))
        if storage_uploaded:
            same('附件对象清单指纹', old.get('storage_objects_md5'), new.get('storage_objects_md5'))
        else:
            notes.append('附件对象尚未上传，本阶段不比较附件清单')
        for key, label in (('auth_migrations', '认证服务'), ('storage_migrations', '存储服务')):
            missing = sorted(set(split(old.get(key))) - set(split(new.get(key))))
            if missing:
                problems.append(f'新环境{label}版本低于旧环境，缺少迁移：' + ', '.join(missing[:10])
                                + (f' 等 {len(missing)} 项' if len(missing) > 10 else ''))
    else:
        same('附件对象清单指纹（存储桶/名称/大小/类型）', old.get('storage_objects_md5'), new.get('storage_objects_md5'))
        if new.get('patient_tokens_plaintext_rows') != 0:
            problems.append(f'新环境仍有明文随访链接：{new.get("patient_tokens_plaintext_rows")} 行')
        versions = set(split(new.get('registry_schema_versions')))
        missing = [v for v in UPGRADE_VERSIONS if v not in versions]
        if missing:
            problems.append('新环境缺少版本登记：' + ', '.join(missing))
        notes.append('业务表内容指纹因 0032–0041 新增字段而变化，本阶段只比较行数与上述指纹')
    return problems, notes


def main(argv=None):
    parser = argparse.ArgumentParser(description='比较迁移前后的只读快照')
    parser.add_argument('--phase', choices=('freeze', 'restore', 'upgrade'), required=True)
    parser.add_argument('--storage-uploaded', action='store_true', help='restore 阶段也比较附件对象清单')
    parser.add_argument('old')
    parser.add_argument('new')
    args = parser.parse_args(argv)
    try:
        old, new = load(args.old), load(args.new)
    except (OSError, ValueError) as exc:
        print(f'错误：{exc}', file=sys.stderr)
        return 2
    problems, notes = compare(args.phase, old, new, args.storage_uploaded)
    for note in notes:
        print(f'说明：{note}')
    for problem in problems:
        print(f'不一致：{problem}')
    print(f'结论（{args.phase}）：' + ('一致' if not problems else f'发现 {len(problems)} 处不一致'))
    return 1 if problems else 0


if __name__ == '__main__':
    sys.exit(main())
