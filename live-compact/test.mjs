import assert from "node:assert/strict"
import { compactMessages, estimateTokens, messageText } from "./core.mjs"

const user = (text) => ({ role: "user", content: [{ type: "text", text }] })
const assistant = (text) => ({ role: "assistant", content: [{ type: "text", text }] })
const call = (id, name, input, text) => ({
  role: "assistant",
  content: [...(text ? [{ type: "text", text }] : []), { type: "tool-call", id, name, input }],
})
const result = (id, name, text) => ({
  role: "tool",
  content: [{ type: "tool-result", id, name, result: { type: "text", value: text } }],
})

const OPTS = { minContextTokens: 100, minCutTokens: 50, maxCutTokens: 5000, keepChars: 2000, shadow: false }

const prose = Array.from({ length: 120 }, (_, i) => `noise line ${i} ${"lorem ipsum dolor sit amet ".repeat(4)}`).join("\n")
const FILE = "must preserve the value ALPHA_LIMIT = 42 in src/config/alpha.ts"

function history() {
  return [
    user("first: build the feature"),
    assistant("starting"),
    result("t1", "read", `src/config/alpha.ts:1\n${FILE}\n${prose}`),
    call("t2", "edit", { filePath: "src/config/alpha.ts" }, "applying edit"),
    result("t2", "edit", "ok"),
    assistant("Done. ALPHA_LIMIT is preserved and the feature is in place."),
    user("second: now do another thing"),
    assistant("working on it"),
    result("t3", "read", "some current output"),
    assistant("partial answer for second turn"),
  ]
}

// 1. Small history is left alone.
{
  const small = [user("hi"), assistant("hello"), user("again"), assistant("done")]
  const out = compactMessages(small, { options: OPTS })
  assert.equal(out.cuts, 0)
  assert.deepEqual(out.messages, small)
}

// 2. Completed bulky turn is cut, final answer survives.
{
  const input = history()
  const out = compactMessages(input, { options: OPTS })
  assert.equal(out.cuts, 1, "one finished turn should be cut")
  assert.ok(out.cutTokens > out.cardTokens, "cut should reduce tokens")
  assert.equal(out.messages.at(-1).role, "assistant")
  assert.equal(out.messages.at(-1).content.map((p) => p.text ?? "").join("\n"), "partial answer for second turn")
  const cutMessage = out.messages.find((m) => messageText(m).includes("<live-compact>"))
  assert.ok(cutMessage, "digest should be attached")
  assert.ok(messageText(cutMessage).includes("TRUNK CONFIRMED"))
  assert.ok(messageText(cutMessage).includes("ALPHA_LIMIT = 42"), "hard line must survive")
  // Everything before the cut is byte-identical to the input.
  const firstCutIndex = input.findIndex((m) => messageText(m).startsWith("first:"))
  assert.deepEqual(out.messages.slice(0, firstCutIndex + 1), input.slice(0, firstCutIndex + 1))
}

// 3. Growing the active turn must not change earlier transformed messages.
{
  const base = history()
  const longer = [...base, assistant("more active-turn output"), result("t4", "read", prose)]
  const a = compactMessages(base, { options: OPTS })
  const b = compactMessages(longer, { options: OPTS })
  assert.equal(a.cuts, b.cuts)
  assert.deepEqual(b.messages.slice(0, a.messages.length), a.messages, "completed prefix must stay stable")
}

// 4. When the active turn becomes completed, earlier cuts must not move.
{
  const base = history()
  const next = [...base, user("third"), assistant("third answer")]
  const a = compactMessages(base, { options: OPTS })
  const b = compactMessages(next, { options: OPTS })
  // The second turn is now finished and cut, so compare up to end of first turn.
  const firstFinal = a.messages.findIndex((m) => messageText(m).includes("Done. ALPHA_LIMIT"))
  assert.ok(firstFinal > 0)
  assert.deepEqual(b.messages.slice(0, firstFinal + 1), a.messages.slice(0, firstFinal + 1))
}

// 5. A tool pair is never split across the cut boundary.
{
  const input = [
    user("use tools"),
    call("pair1", "read", { filePath: "a.ts" }, "reading a"),
    result("pair1", "read", prose),
    assistant("done with a"),
    user("next"),
    assistant("next answer"),
  ]
  const out = compactMessages(input, { options: OPTIONS() })
  const callIds = new Set()
  const resultIds = new Set()
  for (const message of out.messages) {
    for (const part of message.content) {
      if (part.type === "tool-call") callIds.add(part.id)
      if (part.type === "tool-result") resultIds.add(part.id)
    }
  }
  assert.deepEqual([...resultIds].filter((id) => !callIds.has(id)), [], "no dangling tool result")
  assert.deepEqual([...callIds].filter((id) => !resultIds.has(id)), [], "no dangling tool call")
}

// 6. Applying the transform to already-compacted output is a no-op.
{
  const once = compactMessages(history(), { options: OPTS })
  const twice = compactMessages(once.messages, { options: OPTS })
  assert.equal(twice.cuts, 0)
  assert.deepEqual(twice.messages, once.messages)
}

// 7. Determinism.
{
  const a = compactMessages(history(), { options: OPTS })
  const b = compactMessages(history(), { options: OPTS })
  assert.deepEqual(a.messages, b.messages)
}

// 8. If the full candidate cannot be confirmed, shrink to a confirmable span
// instead of skipping the turn.
{
  const hardBlock = Array.from({ length: 40 }, (_, i) => `must preserve config key HARD_KEY_${i} = ${i}`).join("\n")
  const bigTool = Array.from({ length: 200 }, (_, i) => `noise ${i} lorem ipsum dolor sit amet consectetur`).join("\n")
  const input = [user("go"), assistant(hardBlock), result("t1", "read", bigTool), assistant("final answer"), user("next"), assistant("next answer")]
  const out = compactMessages(input, { options: { ...OPTS, keepChars: 200 } })
  assert.equal(out.cuts, 1, "a smaller confirmable span should still be cut")
  assert.ok(out.messages.some((m) => messageText(m).includes("HARD_KEY_0")), "the unconfirmed block stays live")
  assert.ok(out.messages.some((m) => messageText(m).includes("<live-compact>")))
}

// 9. Mostly-unclassified prose is left to native compaction (DSH wait-80).
{
  const prose = Array.from(
    { length: 300 },
    (_, i) => `paragraph ${i} unique${i} lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor`,
  ).join("\n")
  const input = [user("go"), result("t1", "read", prose), assistant("final"), user("next"), assistant("next answer")]
  const out = compactMessages(input, { options: { ...OPTS, minContextTokens: 100, minCutTokens: 50 } })
  assert.equal(out.cuts, 0, "prose-heavy span must wait for native compaction")
}

// 10. A long final answer blocks the cut until the session is urgent.
{
  const answer = Array.from({ length: 500 }, (_, i) => `answer line ${i} with enough detail to exceed the tail budget`).join("\n")
  const tool = Array.from({ length: 120 }, (_, i) => `tool line ${i} with some output text`).join("\n")
  const input = [user("go"), result("t1", "read", tool), assistant(answer), user("next"), assistant("next answer")]
  const calm = compactMessages(input, { options: { ...OPTS, minContextTokens: 100, minCutTokens: 50 } })
  assert.equal(calm.cuts, 0, "long tail must block a non-urgent cut")
  const urgent = compactMessages(input, {
    options: { ...OPTS, minContextTokens: 100, minCutTokens: 50, urgentTokens: 100 },
  })
  assert.equal(urgent.cuts, 1, "an urgent session may cut despite the long tail")
}

function OPTIONS() {
  return { ...OPTS, minCutTokens: 10 }
}

console.log("all core tests passed")
