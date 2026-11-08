#!/usr/bin/env sh
# End-to-end test with a FREE model.
#
# This project tests context compaction, not model capability, so the test
# never uses a paid model. It defaults to the smallest free flash model and
# refuses a model id without "free" unless LC_E2E_ALLOW_PAID=1 is set.
#
# It starts a private OpenCode server (`--standalone`), so it does not touch
# the running service. The test session is archived and deleted afterwards.
set -eu

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$DIR/.." && pwd)
MODEL=${LC_E2E_MODEL:-opencode/mimo-v2.6-flash-free}
ROUNDS=${LC_E2E_ROUNDS:-1}
TIMEOUT=${LC_E2E_TIMEOUT:-300}

case "$MODEL" in
  *free*) ;;
  *)
    if [ "${LC_E2E_ALLOW_PAID:-0}" != "1" ]; then
      echo "refusing a non-free model: $MODEL (set LC_E2E_ALLOW_PAID=1 to override)" >&2
      exit 2
    fi
    ;;
esac

command -v opencode >/dev/null 2>&1 || {
  echo "opencode not found in PATH" >&2
  exit 1
}

WORK=$(mktemp -d /tmp/opencode/live-compact-e2e.XXXXXX)
SHADOW="$WORK/shadow"
DEBUG_LOG="$HOME/.local/share/opencode/live-compact/debug.log"
mkdir -p "$SHADOW"
trap 'rm -rf "$WORK"' EXIT

# A code-shaped fixture: the card route stays "local" and the read result is
# large enough to be a long-read round.
python3 - "$WORK/project" <<'PY'
import os, sys
target = sys.argv[1]
os.makedirs(target, exist_ok=True)
lines = [f'export const value_{i} = readConfig("src/config/module_{i}.ts"); // case {i}' for i in range(1600)]
open(os.path.join(target, "big.ts"), "w").write("\n".join(lines))
PY

export OPENCODE_LIVE_COMPACT_DEBUG=1
export OPENCODE_LIVE_COMPACT_MIN_CONTEXT=1000
export OPENCODE_LIVE_COMPACT_MIN_CUT=50
export OPENCODE_LIVE_COMPACT_MAX_CUT=50000
export OPENCODE_LIVE_COMPACT_POINTER_TOKENS=100000
export OPENCODE_LIVE_COMPACT_KEEP_ROUNDS=3
export OPENCODE_LIVE_COMPACT_KEEP_ROUND_TOKENS=100000
export OPENCODE_LIVE_COMPACT_MAX_PASSES=8
export OPENCODE_LIVE_COMPACT_SHADOW_DIR="$SHADOW"

cd "$WORK/project"
BEFORE=$(wc -l < "$DEBUG_LOG" 2>/dev/null || echo 0)

run_turn() {
  local extra="$1" prompt="$2" out="$3" err="$4"
  # shellcheck disable=SC2086
  timeout "$TIMEOUT" opencode run --standalone --format json --archived --auto \
    --print-logs -m "$MODEL" $extra "$prompt" >"$out" 2>"$err"
}

echo "model=$MODEL work=$WORK"
echo "turn 1: read big.ts with the free model"
if ! run_turn "" "Use the read tool to read big.ts exactly once. Do not summarize it. Then reply with the single word READY." "$WORK/turn1.out" "$WORK/turn1.err"; then
  echo "turn 1 failed; see $WORK/turn1.err" >&2
  exit 1
fi
SID=$(grep -o '"sessionID":"[^"]*"' "$WORK/turn1.out" | head -1 | cut -d'"' -f4)
[ -n "$SID" ] || {
  echo "could not read the session id from turn 1" >&2
  exit 1
}
echo "session=$SID"

echo "turn 2: a new user message finishes turn 1, so live-compact may cut"
if ! run_turn "-s $SID" "Reply with exactly: OK" "$WORK/turn2.out" "$WORK/turn2.err"; then
  echo "turn 2 failed; see $WORK/turn2.err" >&2
  exit 1
fi

AFTER=$(wc -l < "$DEBUG_LOG" 2>/dev/null || echo 0)
CUT_RECORD=$(tail -n +$((BEFORE + 1)) "$DEBUG_LOG" 2>/dev/null | grep "\"sessionID\":\"$SID\".*\"cut\"" | tail -1 || true)
SHADOW_COUNT=$(find "$SHADOW" -type f 2>/dev/null | wc -l | tr -d ' ')

python3 - "$WORK/turn2.out" "$CUT_RECORD" "$SHADOW_COUNT" <<'PY'
import json, sys
turn2, record, shadow_count = sys.argv[1], sys.argv[2], int(sys.argv[3])
last = None
for line in open(turn2):
    try:
        item = json.loads(line)
    except Exception:
        continue
    if item.get("type") == "step_finish":
        last = item.get("part", {})
tokens = (last or {}).get("tokens", {})
cache = tokens.get("cache", {})
inp = tokens.get("input", 0)
read = cache.get("read", 0)
hit = read / (inp + read) * 100 if inp + read else 0
print(f"second request: input={inp} cache_read={read} hit={hit:.1f}%")
print(f"shadow_files={shadow_count}")
if not record:
    print("RESULT: FAIL (no live-compact cut record for this session)")
    sys.exit(1)
try:
    data = json.loads(record)
except Exception:
    print(f"RESULT: FAIL (bad cut record: {record})")
    sys.exit(1)
cut = data.get("cutTokens", 0)
card = data.get("cardTokens", 0)
before = data.get("totalBefore", 0)
after = data.get("totalAfter", 0)
saved = before - after
ratio = (card / cut * 100) if cut else 0
print(f"cut: spans={data.get('cut')} cutTokens={cut} cardTokens={card} card/span={ratio:.1f}%")
print(f"effective: {before} -> {after} (saved {saved}) engine={data.get('engine')}")
if shadow_count < 1:
    print("RESULT: FAIL (no shadow file written)")
    sys.exit(1)
if cut <= 0 or card <= 0 or card >= cut:
    print("RESULT: FAIL (the card did not reduce the span)")
    sys.exit(1)
print("RESULT: PASS")
PY

# Keep the archived test session out of the session list. Best effort only.
opencode session delete "$SID" >/dev/null 2>&1 || true
