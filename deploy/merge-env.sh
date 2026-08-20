#!/usr/bin/env bash
#
# Merge a newer .env.example into an existing .env.
#
# Keeps every value you already set, adds keys that are new in the template,
# and preserves keys that exist only in your file. Writes a timestamped backup
# before touching anything.
#
# Usage:
#   ./merge-env.sh [current-env] [template]
# Defaults:
#   current-env = .env
#   template    = .env.example

set -euo pipefail

ENV_FILE="${1:-.env}"
TEMPLATE="${2:-.env.example}"

[ -f "$ENV_FILE" ] || { echo "not found: $ENV_FILE" >&2; exit 1; }
[ -f "$TEMPLATE" ] || { echo "not found: $TEMPLATE" >&2; exit 1; }

BACKUP="${ENV_FILE}.bak.$(date +%Y%m%d-%H%M%S)"
cp "$ENV_FILE" "$BACKUP"

OUT="$(mktemp)"
trap 'rm -f "$OUT"' EXIT

# Keys already present in the current file, in order of appearance.
existing_keys="$(grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' "$ENV_FILE" | tr -d '=' || true)"

added=0
kept=0

# Walk the template. Comments and blank lines are copied as is. For every
# assignment, reuse the current value when the key already exists.
while IFS= read -r line || [ -n "$line" ]; do
  if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)= ]]; then
    key="${BASH_REMATCH[1]}"
    current="$(grep -m1 -E "^${key}=" "$ENV_FILE" || true)"
    if [ -n "$current" ]; then
      printf '%s\n' "$current" >> "$OUT"
      kept=$((kept + 1))
    else
      printf '%s\n' "$line" >> "$OUT"
      added=$((added + 1))
    fi
  else
    printf '%s\n' "$line" >> "$OUT"
  fi
done < "$TEMPLATE"

# Anything that exists only in the current file is appended rather than lost.
template_keys="$(grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' "$TEMPLATE" | tr -d '=' || true)"
extra_written=0
while IFS= read -r key; do
  [ -n "$key" ] || continue
  if ! printf '%s\n' "$template_keys" | grep -qx "$key"; then
    if [ "$extra_written" -eq 0 ]; then
      {
        printf '\n'
        printf '# ---------------------------------------------------------------------------\n'
        printf '# Kept from the previous file, not present in the template\n'
        printf '# ---------------------------------------------------------------------------\n'
      } >> "$OUT"
      extra_written=1
    fi
    grep -m1 -E "^${key}=" "$ENV_FILE" >> "$OUT"
  fi
done <<< "$existing_keys"

cp "$OUT" "$ENV_FILE"
chmod 600 "$ENV_FILE"

echo "backup:   $BACKUP"
echo "kept:     $kept values from the previous file"
echo "added:    $added new keys from the template"
if [ "$extra_written" -eq 1 ]; then
  echo "appended: keys that exist only in your file, see the end of $ENV_FILE"
fi
echo
echo "Review the result, then restart:  docker compose up -d"
