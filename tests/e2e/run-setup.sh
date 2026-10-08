#!/bin/bash
# Fresh Supabase-like test database with a generated schedule (+ one entry filed in the
# wrong week and one stray key), with supabase-backups.sql installed.
# Needs a local Postgres; set PGHOST/PGPORT (defaults /var/tmp/pgt, 5499).
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$HERE/../.."
export PGHOST=${PGHOST:-/var/tmp/pgt} PGPORT=${PGPORT:-5499} PGUSER=${PGUSER:-postgres}
psql -q -c "drop database if exists p1 with (force)" -c "create database p1" >/dev/null
psql -q -d p1 -f "$HERE/setup-db.sql" >/dev/null
psql -q -d p1 -c "alter table profiles add column if not exists created_at timestamptz default now()"
SCHED=$(TZ=Europe/Lisbon node "$HERE/gen-schedule.js" | node -e 'let s=JSON.parse(require("fs").readFileSync(0));s["2026-11-01"]={"2026-11-03_day":["zz"]};s["2026-10-26"]["junk"]=5;process.stdout.write(JSON.stringify(s))')
psql -q -d p1 -c "insert into app_data values ('chbv_doctors','[{\"id\":\"d1\",\"name\":\"Ana Teste\"},{\"id\":\"d2\",\"name\":\"Rui Teste\"}]'),('chbv_terceiros','[]'),('chbv_rotations','{}'),('chbv_schedules','$SCHED')"
psql -q -d p1 -1 -f "$ROOT/supabase-backups.sql" >/dev/null
