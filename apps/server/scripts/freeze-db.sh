#!/usr/bin/env bash
# Freeze the production DB into a consistent, hashable copy for decision-stats.
#
# The live 4amcasino.db grows as hands settle, so every ratio computed by
# decision-stats.mjs drifts between runs. ALWAYS quote baseline numbers from a
# frozen copy, and record its sha256 + hand id range.
#
# READ-ONLY on the source: the source is opened with `mode=ro` and only read
# through SQLite's online-backup API. Nothing is written back to the source.
#
# Usage:
#   apps/server/scripts/freeze-db.sh [source-db] [dest-db]
#
# Defaults:
#   source = <repo>/apps/server/4amcasino.db
#   dest   = /tmp/4amcasino-frozen-<utc-timestamp>.db
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/../../.." && pwd)"
SRC="${1:-${REPO_ROOT}/apps/server/4amcasino.db}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="${2:-/tmp/4amcasino-frozen-${STAMP}.db}"

if [[ ! -f "${SRC}" ]]; then
  echo "source db not found: ${SRC}" >&2
  exit 1
fi

if [[ -s "${SRC}-wal" ]]; then
  echo "note: source has a non-empty -wal file; .backup produces a consistent snapshot anyway" >&2
fi

# Consistent snapshot (online backup API), source opened read-only.
sqlite3 -readonly "file:${SRC}?mode=ro" ".backup '${DEST}'"

echo "frozen: ${DEST}"
echo "generatedAt: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "sha256: $(sha256sum "${DEST}" | cut -d' ' -f1)"
echo "sourceSha256: $(sha256sum "${SRC}" | cut -d' ' -f1)"
sqlite3 -readonly "file:${DEST}?mode=ro" <<'SQL'
SELECT 'hands: ' || COUNT(*) FROM hands WHERE status = 'settled';
SELECT 'handIdRange: ' || MIN(hand_id) || ' .. ' || MAX(hand_id)
  FROM hands WHERE status = 'settled';
SELECT 'settledAtRange: ' || MIN(settled_at) || ' .. ' || MAX(settled_at)
  FROM hands WHERE status = 'settled';
SQL
