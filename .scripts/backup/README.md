# Backup and restore

Four scripts and a drill. `docs/native-calling-deployment.md` § "Backups, restore and the retention
runbook" carries the RPO/RTO statements and the operator-facing procedure; this file is the
mechanics.

| Script                | What it produces                                                            |
| --------------------- | --------------------------------------------------------------------------- |
| `pg-backup.sh`        | `pg-<db>.dump` (custom format) per database, `roles.sql`, `pg-<db>.counts`   |
| `jetstream-backup.sh` | `jetstream-streams.tar` (broker snapshots) **or** `jetstream-store.tar.gz`   |
| `objects-backup.sh`   | `objects.tar` **or** `objects-s3.pointer`                                    |
| `backup.sh`           | all three into one dated set, plus `manifest.jsonl` and `SET.json`           |
| `restore.sh`          | rebuilds a stack from a set and verifies it                                  |

## Taking a set

```sh
PG_OWNER_URL=postgresql://postgres:...@db:5432 \
NATS_URL=nats://nats:4222 \
OBJECT_ROOT=/opt/optimiq-voice/recordings \
BACKUP_ROOT=/var/backups/optimiq-voice \
.scripts/backup/backup.sh
```

`PG_OWNER_URL` carries **no database component** — each name from `PG_DATABASES` is appended. It
must be the owner/superuser principal: the runtime logins cannot read `pg_authid`, so a dump taken
as one silently omits the roles half.

## Restoring — into disposable targets by default

```sh
RESTORE_OWNER_URL=postgresql://postgres:...@db:5432 \
RESTORE_DB_SUFFIX=_restore \
RESTORE_CONFIRM=restore \
RESTORE_DROP_EXISTING=1 \
RESTORE_API_DB_PASSWORD=... RESTORE_PBX_DB_PASSWORD=... RESTORE_CDR_DB_PASSWORD=... \
RESTORE_NATS_STORE_DIR=/srv/nats-restore \
RESTORE_OBJECT_ROOT=/srv/objects-restore \
.scripts/backup/restore.sh [SET_DIR]
```

The script **refuses to run** when the prefix/suffix leaves a database name unchanged, unless
`RESTORE_IN_PLACE=yes` is also set. A drill therefore cannot become an outage through a forgotten
variable, and a real recovery is two explicit variables rather than one.

Passwords come from the environment, never from the artifact: the roles dump is taken with
`--no-role-passwords`, so a restored cluster's logins have none until `provision-roles.sql` is
re-applied — which `restore.sh` does, with the target's own credentials.

## What the restore verifies

1. Every artifact against the manifest's SHA-256, before anything is created.
2. Every table's row count against the count file, post-`ANALYZE` on both sides. A count that MOVED
   is reported, not fatal (the source was live during the dump); a table that VANISHED is fatal.
3. A smoke read per database as the owner (`user`, `extension`, `call_legs`, latest leg timestamp).
4. A smoke read per database **as the runtime login**. This is the one that matters: it proves the
   grants, the tenant-role membership and BYPASSRLS survived, and a restore that passes everything
   above and fails here is a database full of data no service can read.

## Gotchas found in the drill

- **Match the `pg_restore` major version to the server's.** A 17 client against a 16 server emits
  `SET transaction_timeout`, which the server rejects: 3–6 harmless "errors" per database that make
  the error count useless as a signal. `restore.sh` warns when the majors differ.
- **A store-dir JetStream copy needs the same account configuration to load.** Streams live under
  `<store>/jetstream/<ACCOUNT>/streams/`, so a bare `nats-server -js -sd <dir>` finds nothing —
  it looks in `$G`. Boot the restore with the deployment's own `nats.conf` and only the store
  directory overridden.
- **A store-dir copy of a running broker tears index files.** In the drill, 10 of 29 streams logged
  `Recovering stream state from index errored: prior state file` on load. The server repaired all of
  them and message counts were intact, but that is a repair, not a guarantee — see the consistency
  caveat in `jetstream-backup.sh`.
- **MEMORY streams are not in either artifact.** Today that is the `presence` KV bucket, which the
  engine re-applies on reconnect. 28 of 29 streams came back; the missing one is that.
