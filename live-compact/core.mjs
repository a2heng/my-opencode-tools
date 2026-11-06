// Live Compact for OpenCode — core transform.
//
// Derived from dsh-live-compact 1.0.1 (MIT, https://github.com/MerkyorLynn/dsh-live-compact).
// The idea is the same: compact the bulky part of a *finished* turn in place,
// without touching anything before the cut, so the provider's prefix cache
// keeps hitting. The digest is built locally (regex extraction, no model call).
//
// This module is pure: it never mutates its input and has no I/O. The plugin
// wrapper supplies an optional shadow writer for the removed original text.

export const MARKER = "<live-compact>";

export const CHECKPOINT_PREAMBLE =
  "This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.";

export const DEFAULT_OPTIONS = {
  // Do not start cutting until the effective (already compacted) prefix is this big.
  minContextTokens: 20000,
  // Never bother cutting a span smaller than this.
  minCutTokens: 1000,
  // Upper bound per cut, mirroring dsh-live-compact's 32k rail.
  maxCutTokens: 32000,
  // Keep at least the final answer; stop keeping more trailing assistant
  // messages once the tail exceeds this.
  tailTokens: 2200,
  // Below this total, a long tail blocks the cut (DSH's URGENT_TOKENS).
  urgentTokens: 48000,
  // Character budget for the extracted digest.
  keepChars: 8000,
  // Write the removed original text to disk so it stays recoverable.
  shadow: true,
  shadowDir: "",
};

const LINE_TEST = 240;
const CODE =
  /^(?:diff --git|index [0-9a-f]{4,}|@@ |--- |\+\+\+ |def |class |function |fn |pub |impl |import |export |#include |package |const |let |var |async |return |Traceback\b|Error:|Exception:|panic!|FAILED\b|PASS\b)|^\s+at \S+|^(?:\$ |> )?(?:git|cargo|npm|bun|python3|pip|curl|make) /;
const PATH =
  /^[~./\w-]+\.(?:py|js|ts|tsx|go|rs|java|c|h|cc|cpp|md|json|yml|yaml)(?::\d+)?$/;
const RESEARCH =
  /(?:\barxiv:\d{4}\.\d{4,5}\b|\bdoi:\s*10\.\d{4,}\/|\b10\.\d{4,9}\/\S+|\b(?:lr|learning_rate|batch_size|temperature|top_p|max_tokens)\s*[=:]|^\$\$|\\(?:frac|sum|prod|alpha|beta|gamma|cdot)\b|^Figure \d|^Table \d|^Eq\.?\s*\d|\bsha256\b|\b[a-f0-9]{64}\b)/i;
const TABLE = /^\|.*\|$/;
const HARNESS =
  /web_search results are external|web_fetch returns external|Track every background job|Use the workflow tool ONLY|create_goal may infer|do not busy-poll/;
const OBLIGATION =
  /(?:\b(?:must|never|do not|don't|required|requires|preserve|preserving|shall not)\b|必须|不要|禁止|不能|不得|只能|保留)/i;
const TOKEN =
  /`([^`]{2,80})`|\b([A-Z][A-Za-z0-9]+(?:[A-Z][a-z0-9]+)+)\b|\b([a-z][a-z0-9]*(?:[A-Z][a-z0-9]+)+)\b|\b([a-z][a-z0-9]*(?:[_-][a-z0-9]+){1,})\b|\b([A-Za-z0-9_.-]+\.(?:py|js|ts|tsx|go|rs|java|c|h|cc|cpp|md|json|yml|yaml))\b|\b((?:~|\.{1,2})?\/[A-Za-z0-9_./+-]{3,})\b/g;
const IDENT_VERB =
  /`[^`]{2,80}`[\s\S]{0,80}\b(?:move|place|clear|preserve|require|requires|keep)\b|\b(?:move|place|clear|preserve|require|requires|keep)\b[\s\S]{0,80}`[^`]{2,80}`/i;
const ERROR_LINE = /^(?:Error:|Exception:|Traceback\b|FAILED\b|panic!)/;

// ---------------------------------------------------------------------------
// Token estimate
// ---------------------------------------------------------------------------

// No tokenizer dependency: ASCII is ~4 chars/token, CJK is ~1.5 chars/token.
export function estimateTokens(text) {
  const value = String(text ?? "");
  let ascii = 0;
  let wide = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) < 128) ascii += 1;
    else wide += 1;
  }
  return Math.ceil(ascii / 4 + wide / 1.6);
}

// ---------------------------------------------------------------------------
// Local extraction (ported from dsh-live-compact plan.js, MIT)
// ---------------------------------------------------------------------------

function isPadding(text) {
  if (!text) return false;
  const sample = text.length > 800 ? text.slice(0, 800) : text;
  const parts = sample.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 8) return false;
  const counts = new Map();
  let max = 0;
  for (const part of parts) {
    const next = (counts.get(part) || 0) + 1;
    counts.set(part, next);
    if (next > max) max = next;
  }
  return counts.size <= 3 || max / parts.length >= 0.6;
}

function probe(line) {
  const sample = line.length > LINE_TEST ? line.slice(0, LINE_TEST) : line;
  return CODE.test(sample) || PATH.test(sample) || RESEARCH.test(sample) || TABLE.test(sample);
}

export function repeatedNames(text) {
  const counts = new Map();
  for (const match of String(text || "").matchAll(TOKEN)) {
    const token = match.slice(1).find(Boolean);
    if (!token || token.length < 4) continue;
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count >= 2).map(([token]) => token));
}

export function planText(text) {
  const covered = [];
  const uncovered = [];
  let fence = null;
  let codeLines = 0;
  const flushFence = () => {
    if (!fence) return;
    codeLines += fence.length;
    const body = fence.join("\n");
    covered.push(body.length > 1200 ? `${fence[0]}\n… ${fence.length} code lines …\n${fence.at(-1)}` : body);
    fence = null;
  };
  for (const raw of String(text ?? "").split("\n")) {
    const trimmed = raw.trim();
    if (fence) {
      fence.push(raw);
      if (trimmed.startsWith("```")) flushFence();
      continue;
    }
    if (trimmed.startsWith("```")) {
      fence = [raw];
      continue;
    }
    if (!trimmed || isPadding(trimmed)) continue;
    if (probe(trimmed)) {
      codeLines += 1;
      covered.push(trimmed.length > 300 ? `${trimmed.slice(0, 180)} …` : trimmed);
    } else uncovered.push(trimmed);
  }
  flushFence();
  return { covered, uncovered: uncovered.join("\n"), codeLines };
}

export function hardItems(text) {
  const names = repeatedNames(text);
  const items = [];
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.trim();
    if (!line || HARNESS.test(line)) continue;
    const named = [...names].filter((name) => line.includes(name));
    if (line.length > 400) {
      items.push(...named);
      continue;
    }
    if (named.length > 0 || OBLIGATION.test(line) || ERROR_LINE.test(line) || IDENT_VERB.test(line) || PATH.test(line)) {
      items.push(line);
    }
  }
  return [...new Set(items)];
}

export function buildCard(spanText, liveText = "", keepBudget = DEFAULT_OPTIONS.keepChars) {
  const span = String(spanText ?? "");
  const live = String(liveText ?? "");
  const hard = hardItems(span);
  const split = planText(span);
  const kept = [];
  let used = 0;
  let omittedHard = 0;
  for (const line of hard) {
    if (live.includes(line)) continue;
    if (used + line.length > keepBudget) {
      omittedHard += 1;
      continue;
    }
    kept.push(line);
    used += line.length;
  }
  let deferred = 0;
  for (const line of [...new Set(split.covered)]) {
    if (kept.includes(line) || live.includes(line)) continue;
    if (used + line.length > keepBudget) {
      deferred += 1;
      continue;
    }
    kept.push(line);
    used += line.length;
  }
  const missing = hard.filter((line) => !live.includes(line) && !kept.includes(line));
  const verdict = missing.length === 0 ? "TRUNK CONFIRMED" : "TRUNK UNCONFIRMED";
  return {
    verdict,
    hardLines: hard,
    hardCount: hard.length,
    omittedHard,
    deferred,
    missing,
    uncovered: split.uncovered,
    keptChars: used,
    spanChars: span.length,
    proseChars: split.uncovered.length,
    text: [
      "Live Compact extract.",
      `${verdict}.`,
      "Checked: names repeated in this span, obligation lines, and error headers. Unclassified prose is not claimed.",
      `Hard lines: ${hard.length}. Missing from the digest and the live prefix: ${missing.length}. Deferred recoverable: ${deferred}.`,
      "Kept lines:",
      ...(kept.length === 0 ? ["- (none)"] : kept.map((line) => `- ${line}`)),
      "Read a shadowed file before relying on deferred detail.",
    ].join("\n"),
  };
}

// ---------------------------------------------------------------------------
// Message helpers
// ---------------------------------------------------------------------------

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function resultText(result) {
  if (!result) return "";
  if (result.type === "text") return typeof result.value === "string" ? result.value : safeJson(result.value);
  if (result.type === "json") return safeJson(result.value);
  if (result.type === "error") return typeof result.value === "string" ? result.value : safeJson(result.value);
  if (result.type === "content") {
    return (result.value || [])
      .map((item) => (item.type === "text" ? item.text : `[file ${item.name || item.uri}]`))
      .join("\n");
  }
  return safeJson(result);
}

function partText(part) {
  if (!part) return "";
  if (part.type === "text" || part.type === "reasoning") return part.text ?? "";
  if (part.type === "tool-call") return `[tool-call ${part.name}] ${safeJson(part.input)}`;
  if (part.type === "tool-result") return `[tool-result ${part.name}]\n${resultText(part.result)}`;
  if (part.type === "compaction") return "[compaction]";
  if (part.type === "effort") return "[effort]";
  if (part.type === "media") return `[media ${part.media?.source?.mediaType ?? ""}]`;
  return "";
}

export function messageText(message) {
  return (message?.content ?? []).map(partText).filter(Boolean).join("\n");
}

function hasUnsafe(message) {
  for (const part of message?.content ?? []) {
    if (part.type !== "text" && part.type !== "reasoning" && part.type !== "tool-call" && part.type !== "tool-result") {
      return true;
    }
    if (
      part.type === "tool-result" &&
      part.result?.type === "content" &&
      Array.isArray(part.result.value) &&
      part.result.value.some((item) => item.type === "file")
    ) {
      return true;
    }
  }
  return false;
}

function indexToolIds(seg) {
  const calls = new Map();
  const results = new Map();
  seg.forEach((message, index) => {
    for (const part of message?.content ?? []) {
      if (part.type === "tool-call" && !calls.has(part.id)) calls.set(part.id, index);
      if (part.type === "tool-result" && !results.has(part.id)) results.set(part.id, index);
    }
  });
  return { calls, results };
}

// Returns "start" / "end" when moving that boundary would heal a split pair.
function pairingIssue(seg, start, end, calls, results) {
  for (const [id, callIndex] of calls) {
    const resultIndex = results.get(id);
    if (resultIndex === undefined) continue;
    const callInside = callIndex >= start && callIndex <= end;
    const resultInside = resultIndex >= start && resultIndex <= end;
    if (callInside && !resultInside) {
      if (resultIndex > end) return "end";
      if (resultIndex < start) return "start";
    }
    if (resultInside && !callInside) {
      if (callIndex < start) return "start";
      if (callIndex > end) return "end";
    }
  }
  return null;
}

function finalAnswerOf(seg) {
  const last = seg[seg.length - 1];
  if (!last || last.role !== "assistant") return null;
  if (last.native) return null;
  const parts = last.content ?? [];
  if (parts.some((part) => part.type === "tool-call" || part.type === "compaction")) return null;
  if (!parts.some((part) => part.type === "text" && typeof part.text === "string" && part.text.trim().length > 0)) {
    return null;
  }
  return last;
}

// Insert the digest where the span used to be, but keep the role sequence
// intact by attaching it to the turn's final assistant message. This avoids
// creating consecutive assistant/user turns that some providers reject.
function withCheckpoint(message, text) {
  const content = (message.content ?? []).slice();
  let index = content.findIndex((part) => part.type === "text");
  if (index < 0) index = content.length;
  content.splice(index, 0, { type: "text", text });
  return { ...message, content };
}

// ---------------------------------------------------------------------------
// Cut selection
// ---------------------------------------------------------------------------

function selectCut(seg, prefixText, prefixTokens, options, sessionID, shadowWriter) {
  const segTokens = seg.reduce((sum, message) => sum + estimateTokens(messageText(message)), 0);
  const totalTokens = prefixTokens + segTokens;
  if (totalTokens < options.minContextTokens) return null;

  if (!finalAnswerOf(seg)) return null;
  if (seg.some((message) => message.role === "system" || hasUnsafe(message))) return null;
  if (seg.some((message) => messageText(message).includes(MARKER))) return null;

  // Keep the final answer (plus any extra trailing assistant messages that fit)
  // as the live tail; the cut goes immediately before it.
  let end = seg.length - 1;
  let tailTokens = 0;
  while (end >= 0 && seg[end].role === "assistant") {
    const tokens = estimateTokens(messageText(seg[end]));
    if (tailTokens > 0 && tailTokens + tokens > options.tailTokens) break;
    tailTokens += tokens;
    end -= 1;
  }
  if (end < 0) return null;

  const { calls, results } = indexToolIds(seg);

  // Never leave a tool call inside the span whose result is in the tail.
  let guard = 0;
  while (end >= 0) {
    const issue = pairingIssue(seg, 0, end, calls, results);
    if (issue !== "end") break;
    end -= 1;
    guard += 1;
    if (guard > seg.length * 4) return null;
  }
  if (end < 0) return null;

  // Recompute the tail after the pairing adjustment.
  tailTokens = 0;
  for (let index = end + 1; index < seg.length; index += 1) {
    tailTokens += estimateTokens(messageText(seg[index]));
  }
  if (tailTokens > options.tailTokens && totalTokens < options.urgentTokens) return null;

  if (estimateTokens(messageText(seg[end])) > options.maxCutTokens) return null;

  const tailText = seg
    .slice(end + 1)
    .map(messageText)
    .join("\n");
  const liveAt = (start) =>
    `${prefixText}\n${seg
      .slice(0, start)
      .map(messageText)
      .join("\n")}\n${tailText}`;

  // Grow backwards while the local card still proves no hard line is lost.
  let start = end;
  let spanText = messageText(seg[end]);
  let spanTokens = estimateTokens(spanText);
  let card = buildCard(spanText, liveAt(start), options.keepChars);
  if (card.verdict !== "TRUNK CONFIRMED") return null;

  while (start > 0) {
    const prev = start - 1;
    if (seg[prev].role === "user") break;
    const prevText = messageText(seg[prev]);
    const nextTokens = spanTokens + estimateTokens(prevText);
    if (nextTokens > options.maxCutTokens) break;
    const trialText = `${prevText}\n${spanText}`;
    const trial = buildCard(trialText, liveAt(prev), options.keepChars);
    if (trial.verdict !== "TRUNK CONFIRMED") break;
    start = prev;
    spanText = trialText;
    spanTokens = nextTokens;
    card = trial;
  }

  // Drop a left orphan tool result (its call lives before the span).
  guard = 0;
  while (start <= end) {
    const issue = pairingIssue(seg, start, end, calls, results);
    if (!issue) break;
    if (issue !== "start") return null;
    start += 1;
    guard += 1;
    if (guard > seg.length * 4) return null;
  }
  if (start > end) return null;

  spanText = seg
    .slice(start, end + 1)
    .map(messageText)
    .join("\n");
  spanTokens = estimateTokens(spanText);
  if (spanTokens < options.minCutTokens) return null;

  card = buildCard(spanText, liveAt(start), options.keepChars);
  if (card.verdict !== "TRUNK CONFIRMED") return null;
  // DSH's wait-80 route: mostly-unclassified prose is left to native compaction.
  if (card.proseChars >= 20000 && card.proseChars / Math.max(1, card.spanChars) >= 0.5) return null;

  let text = `${CHECKPOINT_PREAMBLE}\n\n${MARKER}\n${card.text}\n</live-compact>`;
  if (options.shadow && shadowWriter) {
    const file = shadowWriter(sessionID, spanText);
    if (file) text += `\nFull shadowed text: ${file}`;
  }

  const cardTokens = estimateTokens(text);
  if (cardTokens >= spanTokens * 0.95) return null;

  return { start, end, spanTokens, cardTokens, text };
}

// ---------------------------------------------------------------------------
// Public transform
// ---------------------------------------------------------------------------

export function compactMessages(messages, { sessionID = "", options = {}, shadowWriter, cache } = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const out = [];
  let prefixText = "";
  let prefixTokens = 0;
  let cuts = 0;
  let cutTokens = 0;
  let cardTokens = 0;

  const push = (message) => {
    out.push(message);
    const text = messageText(message);
    prefixText += `\n${text}`;
    prefixTokens += estimateTokens(text);
  };

  let index = 0;
  while (index < messages.length) {
    const message = messages[index];
    if (message?.role !== "user") {
      push(message);
      index += 1;
      continue;
    }

    push(message);
    index += 1;
    const start = index;
    let end = index;
    while (end < messages.length && messages[end]?.role !== "user") end += 1;
    const seg = messages.slice(start, end);

    if (end === messages.length) {
      for (const item of seg) push(item);
      index = end;
      continue;
    }

    const cut = (() => {
      const firstId = seg[0]?.id;
      const lastId = seg[seg.length - 1]?.id;
      const key = cache && firstId && lastId ? `${sessionID}|${firstId}|${lastId}|${seg.length}` : "";
      if (key && cache.has(key)) return cache.get(key);
      const result = selectCut(seg, prefixText, prefixTokens, opts, sessionID, shadowWriter);
      if (key) {
        cache.set(key, result);
        if (cache.size > 512) cache.delete(cache.keys().next().value);
      }
      return result;
    })();
    if (!cut) {
      for (const item of seg) push(item);
      index = end;
      continue;
    }

    for (let cursor = 0; cursor < cut.start; cursor += 1) push(seg[cursor]);
    push(withCheckpoint(seg[seg.length - 1], cut.text));
    cuts += 1;
    cutTokens += cut.spanTokens;
    cardTokens += cut.cardTokens;
    index = end;
  }

  return { messages: out, cuts, cutTokens, cardTokens };
}
