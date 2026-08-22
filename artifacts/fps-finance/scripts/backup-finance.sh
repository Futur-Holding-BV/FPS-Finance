#!/usr/bin/env bash
set -euo pipefail

: "${AGE_RECIPIENT:?AGE_RECIPIENT must contain the public Finance backup recipient}"
: "${FINANCE_BACKUP_DIRECTORY:?FINANCE_BACKUP_DIRECTORY is required}"
: "${FINANCE_BACKUP_REMOTE:?FINANCE_BACKUP_REMOTE is required}"

command -v pg_dump >/dev/null
command -v age >/dev/null
command -v rclone >/dev/null

umask 077
service_name="${PGSERVICE:-finance_backup}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
filename="fps_finance_${timestamp}.dump.age"
temporary_file="${FINANCE_BACKUP_DIRECTORY%/}/.${filename}.tmp"
final_file="${FINANCE_BACKUP_DIRECTORY%/}/${filename}"
remote_file="${FINANCE_BACKUP_REMOTE%/}/${filename}"

mkdir -p "$FINANCE_BACKUP_DIRECTORY"
trap 'rm -f "$temporary_file"' EXIT

pg_dump \
  --dbname="service=${service_name}" \
  --format=custom \
  --no-owner \
| age \
    --recipient "$AGE_RECIPIENT" \
    --output "$temporary_file"

test -s "$temporary_file"
rclone copyto --checksum "$temporary_file" "$remote_file"
mv -T "$temporary_file" "$final_file"
trap - EXIT

printf 'Encrypted Finance backup completed: %s\n' "$filename"