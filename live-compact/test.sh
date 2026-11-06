#!/usr/bin/env sh
# Run the live-compact unit and hook tests.
set -eu

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "node not found in PATH (Node 18+ required)" >&2
  exit 1
fi

node test.mjs
node test-hook.mjs
