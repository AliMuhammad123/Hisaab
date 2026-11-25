#!/bin/sh
# Runs the database checks on a local PostgreSQL (needs the postgres superuser).
set -e
cd "$(dirname "$0")"
psql -q -d postgres -c "drop database if exists cftest" -c "drop role if exists anon" -c "drop role if exists authenticated" >/dev/null
psql -q -d postgres -c "create database cftest" >/dev/null
psql -q -d cftest -v ON_ERROR_STOP=1 -f fake_supabase.sql -f ../schema.sql -f rls_test.sql 2>&1 | grep -E 'ERROR|FAILED|PASSED'
