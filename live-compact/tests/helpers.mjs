// Shared builders for Live Compact tests.
//
// Messages follow OpenCode's @opencode/ai LLM.Message shape: roles
// user/assistant/tool, parts text/reasoning/tool-call/tool-result/compaction.

let seq = 0;

export function resetIds() {
  seq = 0;
}

export function nextId() {
  seq += 1;
  return `msg_${seq}`;
}

export function user(text, id = nextId()) {
  return { id, role: "user", content: [{ type: "text", text }] };
}

export function assistant(text, id = nextId()) {
  return { id, role: "assistant", content: [{ type: "text", text }] };
}

export function reasoning(text, id = nextId()) {
  return { id, role: "assistant", content: [{ type: "reasoning", text }] };
}

export function call(id, name, input, text = "") {
  return {
    id: nextId(),
    role: "assistant",
    content: [...(text ? [{ type: "text", text }] : []), { type: "tool-call", id, name, input }],
  };
}

export function result(id, name, text, options = {}) {
  return {
    id: nextId(),
    role: "tool",
    content: [
      {
        type: "tool-result",
        id,
        name,
        result: options.isError
          ? { type: "error", value: { error: text, content: [] } }
          : { type: "text", value: text },
      },
    ],
  };
}

export function compaction(summary = "[compact summary]", id = nextId()) {
  return {
    id,
    role: "assistant",
    content: [{ type: "compaction", provider: "opencode", id: `cmp_${id}`, text: summary }],
  };
}

// Deterministic, structured tool output: 4 chars/token and code-like lines so
// the wait-80 prose route does not swallow the test.
export function codeOutput(lines, prefix = "line") {
  return Array.from(
    { length: lines },
    (_, index) => `const value_${index} = readConfig("src/config/module_${index}.ts") // ${prefix} ${index}`,
  ).join("\n");
}

export function proseOutput(lines, prefix = "paragraph") {
  return Array.from(
    { length: lines },
    (_, index) =>
      `${prefix} ${index} unique${index} lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor`,
  ).join("\n");
}

export function countCuts(messages) {
  return messages.filter((message) =>
    (message.content ?? []).some((part) => part.type === "text" && part.text.includes("<live-compact>")),
  ).length;
}

// Assert every tool call still has its result and every result its call.
export function danglingPairs(messages) {
  const calls = new Set();
  const results = new Set();
  for (const message of messages) {
    for (const part of message.content ?? []) {
      if (part.type === "tool-call") calls.add(part.id);
      if (part.type === "tool-result") results.add(part.id);
    }
  }
  return {
    callsWithoutResult: [...calls].filter((id) => !results.has(id)),
    resultsWithoutCall: [...results].filter((id) => !calls.has(id)),
  };
}
