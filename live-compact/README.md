# Live Compact for OpenCode

An independent OpenCode V2 port of
[dsh-live-compact](https://github.com/MerkyorLynn/dsh-live-compact) by Merkyor
(MIT): compact the bulky part of a *finished* turn in place, locally, without
touching anything before the cut. The provider's prefix cache keeps hitting.

This project is unofficial and not affiliated with the original author.

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

Measured on a real OpenCode + DeepSeek run: after a 2,076-token cut, the next
request read 22,784 tokens from cache and only 354 tokens were uncached
(~98.5% hit). See `e2e/README.md`.

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

```sh
cd live-compact
node test.mjs        # 10 core cases
node test-hook.mjs   # full hook wiring + shadow + cache stability
```

The core cases cover: no-op on small history, cut on a finished bulky turn,
byte stability while the active turn grows, stability after a new turn
finishes, tool pairing, no-op on already-compacted input, determinism,
shrink-to-confirmable-span, the prose wait-80 gate, and the long-tail gate.

The real end-to-end procedure and measured cache numbers are in
`e2e/README.md`.

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
