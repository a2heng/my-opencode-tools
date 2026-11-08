import assert from "node:assert/strict"
import test from "node:test"
import {
  buildCard,
  compactionRoute,
  messageText,
  planText,
  pointerOnlyText,
  toolExcerpt,
} from "../core.mjs"

const codeText = (lines) =>
  Array.from({ length: lines }, (_, i) => `const value_${i} = readConfig("src/config/module_${i}.ts") // line ${i}`).join("\n")

const proseText = (lines) =>
  Array.from(
    { length: lines },
    (_, i) => `paragraph ${i} unique${i} lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor`,
  ).join("\n")

test("messageText keeps visible text and tool results, but not reasoning or tool-call input", () => {
  const message = {
    id: "m",
    role: "assistant",
    content: [
      { type: "reasoning", text: "private chain" },
      { type: "text", text: "visible answer" },
      { type: "tool-call", id: "c1", name: "read", input: { file_path: "secret.ts" } },
      { type: "tool-result", id: "c1", name: "read", result: { type: "text", value: "file body" } },
    ],
  }
  assert.equal(messageText(message), "visible answer\nfile body")
})

test("planText classifies code and prose, and compactionRoute is strict", () => {
  const code = planText(codeText(400))
  assert.ok(code.covered.length > 0)
  assert.equal(compactionRoute({ chars: 30000, uncovered: proseText(200) }), "wait-80")
  assert.equal(compactionRoute({ chars: 30000, uncovered: "const a = 1\nconst b = 2" }), "local")
  assert.equal(compactionRoute({ chars: 30000, uncovered: "x".repeat(1000) }), "local")
})

test("buildCard keeps a required user line and confirms coverage", () => {
  const span = [
    "must preserve ALPHA_LIMIT = 42 in src/config/alpha.ts",
    codeText(50),
  ].join("\n")
  const cap = buildCard(span, "", [
    { id: 0, role: "user", text: span, seq: "m1" },
  ])
  assert.equal(cap.ok, true)
  assert.match(cap.text, /TRUNK CONFIRMED/)
  assert.match(cap.text, /ALPHA_LIMIT = 42/)
})

test("buildCard refuses when an assistant decision line would be lost", () => {
  const span = "Plan bug-123-456 is the chosen path.\n" + codeText(40)
  const cap = buildCard(span, "", [
    { id: 0, role: "assistant", text: span, seq: "m1" },
    { id: 1, role: "tool", text: codeText(40), seq: "m2" },
  ])
  assert.equal(cap.ok, false)
  assert.match(cap.text, /TRUNK UNCONFIRMED/)
})

test("buildCard does not re-require a source whose full text is still live", () => {
  const line = "must preserve ALPHA_LIMIT = 42"
  const cap = buildCard(line, line, [{ id: 0, role: "user", text: line, seq: "m1" }])
  assert.equal(cap.ok, true)
  assert.equal(cap.hardCount, 0)
})

test("toolExcerpt keeps small results verbatim and prioritises failures", () => {
  const small = toolExcerpt([
    { id: 0, role: "tool", text: "ok\none line", name: "bash", command: "true", toolCallId: "c1", seq: "m1" },
  ])
  assert.match(small.text, /one line/)

  const failed = toolExcerpt([
    {
      id: 0,
      role: "tool",
      text: "first line\nError: boom\nlast line\n[exit code: 1]",
      name: "bash",
      command: "false",
      toolCallId: "c1",
      isError: true,
      seq: "m1",
    },
  ])
  assert.match(failed.text, /Error: boom/)
})

test("pointerOnlyText never includes the original result text", () => {
  const text = pointerOnlyText([
    {
      role: "tool",
      text: "huge original output",
      name: "read",
      command: "big.ts",
      toolCallId: "c1",
      seq: "m2",
      callSeq: "m1",
    },
  ])
  assert.match(text, /read "big.ts" \(seq m1 -> result m2\)/)
  assert.doesNotMatch(text, /huge original output/)
})
