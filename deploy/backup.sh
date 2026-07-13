#!/bin/sh
set -eu
OUT=/var/backups/ovsyannikov-crm
STAMP=$(date +%Y-%m-%d_%H%M%S)
mkdir -p "$OUT"
sqlite3 /var/lib/ovsyannikov-crm/crm.db ".backup '$OUT/crm-$STAMP.sqlite'"
gzip "$OUT/crm-$STAMP.sqlite"
find "$OUT" -type f -name 'crm-*.sqlite.gz' -mtime +30 -delete
