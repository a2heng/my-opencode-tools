#!/usr/bin/env sh
# Run the Live Compact test suite.
#
#   ./test.sh              # unit + hook tests
#   E2E_FREE=1 ./test.sh   # also run the free-model end-to-end test
#
# The e2e test only uses free models (never a paid one): this project tests
# context compaction, not model capability.
set -eu

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "node not found in PATH (Node 22+ required)" >&2
  exit 1
fi

node --test tests/*.test.mjs

if [ "${E2E_FREE:-0}" = "1" ]; then
  sh e2e/free-model.sh
fi
