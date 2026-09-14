# PostgreSQL 17 v2 review evidence

This is a new release identity, not a replacement of historical v1 evidence.
Frontend and migration source bytes remain bound to the previously reviewed
payload. The reference contract adds version binding and complete catalog guards.

The source-only reference was generated in the isolated native PostgreSQL 17.6
job [34889057713](https://github.com/allenliu3838-ui/New-followup-/actions/runs/34889057713).
That job also passed 8 synthetic historical-upgrade groups and 23 release-gate
tests. Reference SHA-256:

`d7b46defed423468ccb7bdd31e1ebbc81d6dd4a1acf2141f8922b595a7b0993a`

No patient rows, production inventory, credentials, or hosted database connection
were used to generate this reference. Run `npm test` on Linux x64 to reproduce
the reference and validate the final package. This evidence does not represent
production migration, hosted Auth/Storage acceptance, or database restore testing.
