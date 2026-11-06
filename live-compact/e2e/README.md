# End-to-end test (real OpenCode runtime, real provider)

This directory keeps the fixture used to verify the plugin against a real
OpenCode server and a real DeepSeek model. The commands below use a private
`--standalone` server, so they do not touch the main service or session.

## Run

```sh
cd live-compact/e2e

# Turn 1: make the model call a tool so the turn contains a large result.
OPENCODE_LIVE_COMPACT_DEBUG=1 \
OPENCODE_LIVE_COMPACT_MIN_CONTEXT=100 \
OPENCODE_LIVE_COMPACT_MIN_CUT=50 \
opencode run --standalone --format json --auto \
  -m opencode-go/deepseek-v4.1-flash \
  "Use the read tool to read fixture.txt, then reply with only the first line."

# Take the session id printed in the JSON output, then start a second turn.
OPENCODE_LIVE_COMPACT_DEBUG=1 \
OPENCODE_LIVE_COMPACT_MIN_CONTEXT=100 \
OPENCODE_LIVE_COMPACT_MIN_CUT=50 \
opencode run --standalone --format json --auto \
  -s <session-id> -m opencode-go/deepseek-v4.1-flash \
  "Reply with exactly: OK"
```

The second request compacts the finished first turn. Check:

```sh
tail -2 ~/.local/share/opencode/live-compact/debug.log
ls -la ~/.local/share/opencode/live-compact/shadow/
```

A successful run logs a cut and writes one shadow file containing the removed
original text.

## Measured result (2026-11-03)

First turn: read `fixture.txt` (7,895 bytes), answer. Second turn: `OK`.

| request | input | cache read | hit ratio |
|---|---:|---:|---:|
| first turn, final call | 2,120 | 22,784 | 91.5% |
| second turn (after cut) | 354 | 22,784 | 98.5% |

Debug log:

```json
{"sessionID":"ses_...","cut":1,"cutTokens":2076,"cardTokens":207,"ms":2}
```

The cut removed 2,076 tokens and inserted a 207-token digest. The 22,784-token
prefix before the cut still hit the cache; only the digest, the kept final
answer, and the new user message were re-prefilled. That is the intended
behaviour: one small miss per compacted turn, not a whole-prefix miss.

## Notes

- This test uses environment overrides so the global config (20k threshold) is
  untouched. Without overrides, a small two-turn test would not reach the
  threshold.
- Delete the test session afterwards with `opencode session delete <id>` and
  remove its shadow file if you do not want to keep it.
