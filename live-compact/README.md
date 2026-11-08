# Live Compact for OpenCode

An independent OpenCode V2 port of
[dsh-live-compact](https://github.com/MerkyorLynn/dsh-live-compact) by Merkyor
(MIT): compact the bulky part of a *finished* turn in place, locally, without
touching anything before the cut. The provider's prefix cache keeps hitting.

This project is unofficial and not affiliated with the original author.

**Stable version:** OpenCode port of dsh-live-compact 1.1.1 (2026-11-08).
31 unit/hook cases plus a free-model end-to-end test; see [Test](#test).

## Principle

DSH compacts at ~80% with a model call. Live Compact does not wait: once the
effective context passes `minContextTokens` (20k), each finished turn gets a
small cut.

- Only a turn that is already finished is touched: a later user message exists,
  and the turn ends with a normal assistant final answer.
- The cut is the newest bulky span immediately before that final answer, at most
  `maxCutTokens` (32k) and at least `minCutTokens` (1k).
- Everything before the span is sent byte-for-byte unchanged, so the prefix
  cache still hits. Only the cut span, the kept final answer, and the new user
  message are re-prefilled once.
- The span is replaced by a locally extracted digest (no model call): repeated
  identifiers, obligation lines, error headers, code/path lines, up to
  `keepChars` (8k) characters. The original text is written to a shadow file.
- The digest is attached to the turn's final assistant message instead of
  creating a new user/assistant turn. The role sequence never changes, so
  providers with strict alternation are unaffected.
- If a hard line cannot be kept, the cut shrinks or is skipped
  (`TRUNK CONFIRMED` safety gate). Tool-call/tool-result pairs are never split.
- Spans whose unclassified prose is >= 20k chars and >= 50% of the span are left
  to OpenCode's native compaction (DSH's wait-80 route).

## Why the prefix stays stable

OpenCode V2's `session.hook("context", ...)` runs immediately before dispatch.
The plugin changes `event.messages` for that request only; persisted history is
never rewritten.

For a given finished turn, the digest is a pure function of frozen data:

- the span text (frozen once the turn is finished),
- the transformed prefix before it (all earlier turns are already finished and
  deterministic),
- a content-hash shadow filename (no timestamps, no random ids).

So every later request sends the same bytes for the same completed history.
The first request after a cut pays one miss for the cut span + tail; later
requests hit the compacted prefix. Turns that were small when they finished are
never retroactively cut, because the pressure gate uses the prefix at the
moment the turn becomes finished.

Only the turn before the last user message is eligible. The active turn is
never touched: if a tool result arrives while the model is still working, the
cut must not move. This is the difference between a stable prefix and the
2026-11-08 cache drop (the old selector cut the running turn, so every tool
round rewrote the prefix and the hit rate sat at ~72%).

One cut is paid once, when a turn finishes; later requests reproduce the same
bytes and hit the provider cache. A plugin reload or server restart also costs
one one-time miss. Measured after the fix: the main session returned to
**99.5–99.9%**, with a single 93.5% blip on a new finished-turn cut.

Measured free-model e2e (`mimo-v2.6-flash-free`, 2026-11-08): a 13,649-token
read result became a 401-token card (**2.9%**, 13,248 tokens saved; effective
13,727 -> 479). Live finished-turn cuts measured 15.6–32.7% card/span
(e.g. 2,224 -> 436, 4,677 -> 1,531, 6,895 -> 1,791, 28,529 -> 4,462).

## Walkthrough: one cut, step by step

> The task, file names, commands, ids and token counts below are a made-up
> example. The shape of the cut and the card is what matters.

### The situation

Turn 7 is a "make the worker start" turn. It has 24 shell calls: compile,
smoke-test, edit, retry, read logs, and so on. The final answer is written;
turn 8 (the current turn) has already started.

```text
turn 7 (finished)                                    turn 8 (active)
┌──────────────────────────────────────────────┐    ┌─────────────────────┐
│ user: "make the worker start"                │    │ user: "next task"   │
│ assistant: compile -> OK                     │    │ assistant: working  │
│ assistant: smoke test -> ERROR out of memory │    │ ...                 │
│ ... 22 more shell calls ...                  │    │                     │
│ assistant: final answer                      │    │                     │
└──────────────────────────────────────────────┘    └─────────────────────┘
```

Only turn 7 is eligible. The running turn 8 is never touched: if a tool
result arrives while the model is still working, the cut must not move.

### What is chosen

```text
[user turn 7] [call 1 + result] [call 2 + result] ... [final answer] [user turn 8] [active...]
                              └──── 3 bulky spans, ~28.5k tokens ────┘
```

The selector walks backward from the final answer:

1. skip the running turn (after the last user message);
2. keep the newest 3 finished tool rounds verbatim;
3. take the newest bulky spans immediately before the final answer;
4. refuse the cut if a hard fact would be lost, if a tool call/result would
   be split, or if the span is mostly unclassified prose (wait-80);
5. extract the card locally; no model call.

### What the card looks like

```text
<live-compact>
Live Compact extract (Spine 1.1.1 semantics).
TRUNK CONFIRMED.
Matched lines: 0. Missing facts: 0. Ordinary tool lines omitted: 240.
Kept lines:
- (none)
Tool evidence:
- turn 7 `python scripts/smoke.py` failed [call_a2]
- turn 7 `python -m compileall src/worker.py` exit 0 [call_a1]
... 18 tool evidence lines
Original pointers:
- * shell "python scripts/smoke.py" (seq msg_a2 -> result msg_b2)
... 18 pointers
[tool] ... a short excerpt of the failed output ...
[tool] 11 more call(s) not excerpted
Full shadowed text: ~/.local/share/opencode/live-compact/shadow/<session>-<hash>.txt
</live-compact>
```

The card keeps the **facts** (which command ran, whether it failed, the call
id), the **pointers** (where the original output lives), and a few **short
excerpts**. It does not keep 240 lines of repeated build logs.

### Before and after

```text
before:
┌──────────────────────────────────────────────────────────────┐
│ turn 7: 24 shell calls + bulky output                        │
│ 3 spans, ~28.5k tokens                                       │
└──────────────────────────────────────────────────────────────┘
                    │ local extraction (no model call)
                    ▼
after:
┌──────────────────────────────────────────────────────────────┐
│ 📌 card, ~4.5k tokens                                        │
│  • tool evidence: command + exit status + call id            │
│  • original pointers: call seq -> result seq                 │
│  • short excerpts: the failure and the last lines            │
│  • 240 ordinary lines omitted                                │
│  • original text in the shadow file                          │
└──────────────────────────────────────────────────────────────┘
final answer is kept; the card is attached to it
```

Illustrative arithmetic: ~28.5k -> ~4.5k, about 84% of the cut span removed.
The effective context in the request drops by about 24k tokens.

### Why the cache survives

```text
request N:     [========== prefix, unchanged ==========][cut span + tail]   one miss
request N+1:   [========== prefix, unchanged ==========][only new work]     ~99%
request N+2:   [========== prefix, unchanged ==========][only new work]     ~99%
```

The bytes before the cut never change. The first request after a cut pays one
miss for the cut span, the kept answer and the new user message; later
requests reuse the compacted prefix.

The card itself is deterministic: same frozen span, same extracted lines, same
content-hash shadow filename. That is why appending new turns or new tool
results does not move an older card.

### What can go wrong

- The cut touches the **running** turn: every tool round grows the span, the
  prefix changes, and the hit rate falls to the uncached share. This port now
  refuses that case (`last user` boundary).
- A plugin reload or server restart costs one full re-prefill; that is a
  one-time miss, not a steady state.
- A hard line that cannot be kept refuses the cut (`TRUNK UNCONFIRMED`); the
  span stays live and native compaction remains the backstop.
- A single enormous turn is not cut until it finishes. The active turn can
  still be large; that is the price of a stable prefix.

## Config

Global config `~/.config/opencode/opencode.json`:

```jsonc
{
  "plugins": [
    {
      "package": "/path/to/live-compact",
      "options": {
        "minContextTokens": 20000,
        "minCutTokens": 1000,
        "maxCutTokens": 32000,
        "tailTokens": 2200,
        "urgentTokens": 48000,
        "keepChars": 8000,
        "shadow": true
      }
    }
  ]
}
```

| Option | Default | Meaning |
|---|---:|---|
| `minContextTokens` | 20000 | Start cutting once the effective prefix is this big. |
| `minCutTokens` | 1000 | Never cut a span smaller than this. |
| `maxCutTokens` | 32000 | Per-cut upper bound. |
| `tailTokens` | 2200 | Keep trailing assistant messages up to this; a longer tail blocks a non-urgent cut. |
| `urgentTokens` | 48000 | Below this total, a long tail wins; above it, cut anyway. |
| `keepChars` | 8000 | Digest budget for extracted lines. |
| `shadow` | true | Write the removed original text to disk. |
| `shadowDir` | `~/.local/share/opencode/live-compact/shadow` | Shadow location. |

Environment overrides (useful for testing without touching global config):

`OPENCODE_LIVE_COMPACT_MIN_CONTEXT`, `..._MIN_CUT`, `..._MAX_CUT`,
`..._KEEP_CHARS`, `..._SHADOW=0`, `..._SHADOW_DIR`,
`OPENCODE_LIVE_COMPACT_DEBUG=1` (append request shape / cut records to
`~/.local/share/opencode/live-compact/debug.log`).

## Test

The test cases are the versioned assets; `test.sh` is only the runner.

```sh
cd live-compact
./test.sh              # 31 unit/hook/engine/card/selection cases
E2E_FREE=1 ./test.sh   # + real OpenCode run with a free model
```

| File | Cases | What it locks down |
|---|---:|---|
| `tests/engine.test.mjs` | 4 | local/cloud endpoint classification, env override, unknown endpoint |
| `tests/card.test.mjs` | 7 | digest extraction, hard-line coverage, assistant decision veto, tool excerpts, pointers |
| `tests/select.test.mjs` | 15 | kept rounds, long-read, pointer cards, cloud/local modes, drain, 650k stopline, tool pairing, wait-80, determinism, **active-turn prefix stability** |
| `tests/hook.test.mjs` | 5 | hook wiring, shadow files, provider failure fallback, per-session engine resolution |
| `tests/helpers.mjs` | — | message builders and assertion helpers |
| `e2e/free-model.sh` | 1 | real free-model run: tool call, cut, shadow, reduction, second-request cache hit |

The old `test.mjs` / `test-hook.mjs` from the 1.0.1 port were moved into the
files above (the git history keeps the old copies). Nothing was dropped; the
coverage was split so a failure names the layer that broke.

`e2e/free-model.sh` refuses a model id without `free` unless
`LC_E2E_ALLOW_PAID=1` is set. The default is
`opencode/mimo-v2.6-flash-free`: this project tests compaction, not model
capability, so the cheapest free model is the right one.

## Logs and shadow

```sh
journalctl --user -u opencode.service -f | grep live-compact
ls -la ~/.local/share/opencode/live-compact/shadow/
```

A cut logs `[live-compact] cut N span(s) in Xms A -> B tokens session=...`.
Shadow files are plain text, append-only, and contain the removed original text.
Clean them yourself; they are the recovery path for details the digest defers.

## Differences from DSH

| Aspect | DSH | This port |
|---|---|---|
| Host hook | DSH compaction engine | V2 `session.hook("context")` |
| When applied | At turn end, persisted as a surface edit | Per request, never persisted |
| Original text | Shadow file / session entries | Shadow file (content-hash name) |
| Digest stability | Persisted once | Recomputed, must be deterministic |
| Cut boundary | Newest non-tail span | Newest non-tail span before the final answer |
| Tail | Short final answer(s) | Final answer(s), long-tail gate |
| Prose route | wait-80 | wait-80 gate |

The per-request model is safer for history (nothing is rewritten) but requires
strict determinism, which the pure-function design and the per-segment cache
provide.

## Caveats

- The digest is lossy by design; the shadow file keeps the original. The model is
  told to read the shadow before relying on deferred detail.
- Token counts are estimated (ASCII ~4 chars/token, CJK ~1.6 chars/token), so
  thresholds are approximate.
- A single enormous turn is not cut mid-turn (that would invalidate the cache on
  every tool round). It is compacted once it finishes; native compaction remains
  the backstop.
- Spans containing media/file tool results, compaction parts, or provider-native
  data are skipped.
- Shadow files are plaintext and grow; clean them manually.
- If OpenCode changes the V2 plugin hook API, the plugin may need an update.

## Rollback

Remove the entry from `~/.config/opencode/opencode.json` (or prefix the package
id with `-`), then reload OpenCode. The plugin only changes outgoing requests, so
no session history needs repair. Shadow files can be deleted at any time.
