#!/usr/bin/env bash
set -euo pipefail

backup_file="${1:-}"
: "${backup_file:?Pass the encrypted .dump.age backup file as the first argument}"
: "${AGE_IDENTITY_FILE:?AGE_IDENTITY_FILE must point to the protected restore identity}"

command -v age >/dev/null
command -v pg_restore >/dev/null

if [[ ! -f "$backup_file" || "$backup_file" != *.dump.age ]]; then
  printf 'Restore input must be an existing .dump.age file.\n' >&2
  exit 1
fi

service_name="${PGSERVICE:-finance_restore}"

age \
  --decrypt \
  --identity "$AGE_IDENTITY_FILE" \
  "$backup_file" \
| pg_restore \
    --exit-on-error \
    --clean --if-exists --no-owner \
    --dbname="service=${service_name}"

printf 'Encrypted Finance backup restored into service %s.\n' "$service_name"