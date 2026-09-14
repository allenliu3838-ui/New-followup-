# Registry PostgreSQL 17 v3 release evidence

Release identity: `registry-20260914-integrated-pg17-v3`.
Contract protocol: `registry-contract-v3-pg17`.

This release retains the 58 reviewed frontend payload files and the original
38 migration source files. Migration `0037_concept_view_security.sql` is added
as canonical migration 39. Existing databases require the reviewed incremental
upgrade, not replay of `all_migrations_combined.sql`.

The source-only reference was generated on native PostgreSQL 17.6 from the
committed migrations, independently for canonical LF and historical-CRLF
profiles. Its SHA-256 is
`d7aa38f2c6bd54c468868d63a33c4bc02c930f131bb05f9efe8e443310cbf2b4`.
The eight pre-existing contract categories are unchanged from v2; v3 adds the
view definition, owner, options, columns and effective read/write privileges.
Both complete profiles must reproduce exactly. Production inventories are not
reference-generation inputs and are not included in this repository.

## Reproducible validation

The `Registry recovery acceptance` workflow runs:

- Exact release bytes and migration bundle verification, JavaScript/Python syntax,
  and 24 release-gate tests.
- Nine PGlite regression groups and eight native PostgreSQL 17 upgrade groups.
- Five native view-privilege groups, including independent column grants,
  row-policy enforcement, and a positive control for owner-mode RLS bypass.
- Reproduction of both contract profiles and execution of the exact read-only
  preflight through the v3 release verifier.
- Five native backup/restore groups: actual custom-format `pg_dump`, deletion of
  the source test cluster, `pg_restore` into a new empty cluster, comparison of
  all test table rows/sequences/catalogs/ACLs, and incremental upgrade validation.
- Deterministic offline package construction.

Use the checks on the reviewed PR commit as execution evidence. This file
describes the test contract and does not stand in for a successful CI run.

## Operational boundary

The test database uses synthetic Auth, Storage metadata and business records.
It has no production credentials and listens only on a private Unix socket.
The restore test rejects external database addresses and arbitrary backup files.
PostgreSQL 17 backup clients are installed only in the disposable CI runner.

Storage file bytes are not part of this rehearsal. Hosted authentication,
email, object upload/download, production-backup restoration, concurrent access,
and checks of all five shared-server websites remain separate acceptance work.
No production database, Alibaba server or Storage mutation is performed by CI.

See [deployment notes](../../docs/REGISTRY_PG17_RELEASE.md). Historical v1/v2
evidence remains separate; do not mix older bundles or preflight reports with v3.
