#!/bin/bash
set -euo pipefail
createdb -U "$POSTGRES_USER" -E UTF8 -l ja_JP.utf8 -T template0 jmdict
psql -U "$POSTGRES_USER" -d jmdict -v ON_ERROR_STOP=1 -c 'DROP SCHEMA public;'
pg_restore -U "$POSTGRES_USER" -d jmdict /ichiran.pgdump --no-owner --no-privileges --exit-on-error
psql -U "$POSTGRES_USER" -d jmdict -c 'CREATE TABLE kotoba_dictionary_ready (ready boolean NOT NULL); INSERT INTO kotoba_dictionary_ready VALUES (true);'
