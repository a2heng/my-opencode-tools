import assert from "node:assert/strict"
import test from "node:test"
import { compactMessages, messageText } from "../core.mjs"
import { assistant, call, countCuts, danglingPairs, resetIds, result, user } from "./helpers.mjs"

const BASE = {
  minContextTokens: 100,
  minCutTokens: 20,
  maxCutTokens: 40000,
  pointerTokens: 30000,
  keepRounds: 3,
  keepRoundTokens: 32000,
  tailTokens: 2200,
  urgentTokens: 48000,
  bigGate: 650000,
  keepChars: 2000,
  maxPasses: 24,
  shadow: false,
}

const code = (lines, prefix = "line") =>
  Array.from(
    { length: lines },
    (_, i) => `const value_${i} = readConfig("src/config/module_${i}.ts") // ${prefix} ${i}`,
  ).join("\n")

const prose = (lines) =>
  Array.from(
    { length: lines },
    (_, i) => `paragraph ${i} unique${i} lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor`,
  ).join("\n")

function round(n, name = "bash", output = code(120)) {
  return [
    call(`c${n}`, name, { filePath: `src/file_${n}.ts`, command: `cmd_${n}` }, `round ${n}`),
    result(`c${n}`, name, output),
  ]
}

function run(messages, engine, overrides = {}) {
  return compactMessages(messages, { options: { ...BASE, ...overrides }, engine })
}

function twoRounds({ read = false, size = 400, marker = "ROUND" } = {}) {
  return [
    user("build the feature"),
    assistant("reading"),
    call("c1", read ? "read" : "bash", read ? { file_path: "a.ts" } : { command: "cat a" }, "round one"),
    result("c1", read ? "read" : "bash", `${marker}1\n${code(size)}`),
    assistant("checking"),
    call("c2", "bash", { command: "true" }, "round two"),
    result("c2", "bash", `${marker}2\nok`),
    assistant("Done."),
    user("next task"),
    assistant("working"),
  ]
}

test("small history is left byte-identical", () => {
  const input = [user("hi"), assistant("hello"), user("again"), assistant("done")]
  const out = run(input, "local")
  assert.equal(out.cuts, 0)
  assert.deepEqual(out.messages, input)
})

test("local cuts a finished bulky round and keeps the final answer", () => {
  const input = twoRounds({ size: 600, marker: "ROUND" })
  // A protected tool fact must survive in the card.
  input[3].content[0].result.value = `必须保留 ALPHA_LIMIT = 42\n${input[3].content[0].result.value}`
  const out = run(input, "local", { keepRounds: 1 })
  assert.equal(out.cuts, 1)
  assert.ok(out.totalAfter < out.totalBefore)
  assert.match(messageText(out.messages.at(-1)), /working/)
  const card = out.messages.find((message) => messageText(message).includes("<live-compact>"))
  assert.ok(card)
  assert.match(messageText(card), /ALPHA_LIMIT = 42/)
  assert.match(messageText(card), /TRUNK CONFIRMED/)
  // The kept round two and the final answer are still live.
  assert.ok(out.messages.some((message) => messageText(message).includes("ROUND2")))
  assert.ok(out.messages.some((message) => messageText(message).includes("Done.")))
  assert.deepEqual(danglingPairs(out.messages), { callsWithoutResult: [], resultsWithoutCall: [] })
})

test("deterministic output and stable prefix when the active turn grows", () => {
  const base = twoRounds({ size: 400 })
  const a = run(base, "local", { keepRounds: 1 })
  const b = run(base, "local", { keepRounds: 1 })
  assert.deepEqual(a.messages, b.messages)

  const longer = [...base, assistant("more active output")]
  const c = run(longer, "local", { keepRounds: 1 })
  const cardA = a.messages.find((message) => messageText(message).includes("<live-compact>"))
  const cardC = c.messages.find((message) => messageText(message).includes("<live-compact>"))
  assert.equal(messageText(cardC), messageText(cardA), "the finished turn's card must not move")
  const doneA = a.messages.findIndex((message) => messageText(message).includes("Done."))
  assert.deepEqual(c.messages.slice(0, doneA + 1), a.messages.slice(0, doneA + 1))
})

test("a growing tool round in the active turn never changes the prefix", () => {
  resetIds()
  const base = [
    user("build it"),
    assistant("reading"),
    call("c1", "read", { file_path: "a.ts" }, "reading a"),
    result("c1", "read", code(500)),
    assistant("round one done"),
    call("c2", "bash", { command: "true" }, "checking"),
    result("c2", "bash", "ok"),
    assistant("final answer"),
    user("next task"),
    assistant("working"),
  ]
  const options = { ...BASE, keepRounds: 1, keepRoundTokens: 500 }
  const a = compactMessages(base, { options, engine: "local" })
  const cardA = a.messages.find((message) => messageText(message).includes("<live-compact>"))
  assert.ok(cardA)

  // The active turn now grows with its own completed tool round. It is not
  // finished yet (no later user message), so it must not be cut.
  const grown = [...base, assistant("still working"), call("c9", "bash", { command: "cat log" }, "checking"), result("c9", "bash", code(500))]
  const b = compactMessages(grown, { options, engine: "local" })
  const cardB = b.messages.find((message) => messageText(message).includes("<live-compact>"))
  assert.equal(messageText(cardB), messageText(cardA), "finished turn's card must not move")
  assert.equal(countCuts(b.messages), countCuts(a.messages), "no new cut in the active turn")
  assert.ok(b.messages.length > a.messages.length, "active-turn messages stay live")
})

test("applying the transform to its own output is a no-op", () => {
  const once = run(twoRounds({ size: 400 }), "local", { keepRounds: 1 })
  assert.ok(once.cuts > 0)
  const twice = run(once.messages, "local", { keepRounds: 1 })
  assert.equal(twice.cuts, 0)
  assert.deepEqual(twice.messages, once.messages)
})

test("tool pairs are never split across a cut", () => {
  const input = [
    user("go"),
    call("p1", "read", { file_path: "a.ts" }, "reading a"),
    result("p1", "read", code(500)),
    assistant("done with a"),
    user("next"),
    assistant("next answer"),
  ]
  const out = run(input, "local", { keepRounds: 1 })
  assert.deepEqual(danglingPairs(out.messages), { callsWithoutResult: [], resultsWithoutCall: [] })
})

test("cloud ordinary turns cut nothing, even for a big non-read result", () => {
  const input = [
    user("go"),
    call("c1", "bash", { command: "cat log" }, "reading"),
    result("c1", "bash", code(400)),
    assistant("done"),
    user("next"),
    assistant("working"),
  ]
  const out = run(input, "cloud", { keepRoundTokens: 100000, urgentTokens: 200000 })
  assert.equal(out.cuts, 0)
})

test("cloud pointerises an oversized long-read result on an ordinary turn", () => {
  const input = [
    user("go"),
    call("c1", "read", { file_path: "big.ts" }, "reading"),
    result("c1", "read", `SECRET_BODY\n${code(4000)}`),
    assistant("done"),
    user("next"),
    assistant("working"),
  ]
  const out = run(input, "cloud", {
    keepRoundTokens: 100000,
    urgentTokens: 200000,
    pointerTokens: 30000,
    maxCutTokens: 50000,
  })
  assert.equal(out.cuts, 1)
  const card = out.messages.find((message) => messageText(message).includes("<live-compact>"))
  assert.match(messageText(card), /-> result/)
  assert.doesNotMatch(messageText(card), /SECRET_BODY/)
  assert.doesNotMatch(messageText(out.messages.at(-1)), /SECRET_BODY/)
})

test("cloud keeps an oversized non-read result on an ordinary turn", () => {
  const input = [
    user("go"),
    call("c1", "bash", { command: "cat big" }, "reading"),
    result("c1", "bash", `SECRET_BODY\n${code(4000)}`),
    assistant("done"),
    user("next"),
    assistant("working"),
  ]
  const out = run(input, "cloud", {
    keepRoundTokens: 100000,
    urgentTokens: 200000,
    pointerTokens: 30000,
    maxCutTokens: 50000,
  })
  assert.equal(out.cuts, 0)
  assert.ok(out.messages.some((message) => messageText(message).includes("SECRET_BODY")))
})

test("cloud drain cuts older rounds and keeps the newest ones", () => {
  const rounds = []
  for (let index = 0; index < 5; index += 1) {
    rounds.push(call(`c${index}`, "bash", { command: "cat log" }, `round ${index}`))
    rounds.push(result(`c${index}`, "bash", `ROUND${index}\n${code(1200)}`))
  }
  const input = [user("go"), ...rounds, assistant("done"), user("next"), assistant("working")]
  const out = run(input, "cloud", {
    keepRounds: 3,
    keepRoundTokens: 60000,
    maxCutTokens: 40000,
    pointerTokens: 50000,
  })
  assert.ok(out.cuts >= 1)
  assert.ok(!out.messages.some((message) => messageText(message).includes("ROUND0")), "oldest round is cut")
  assert.ok(out.messages.some((message) => messageText(message).includes("ROUND4")), "newest round is kept")
  assert.deepEqual(danglingPairs(out.messages), { callsWithoutResult: [], resultsWithoutCall: [] })
})

test("long-read rounds are cut confined to their own round", () => {
  const input = [
    user("go"),
    call("cr", "read", { file_path: "big.ts" }, "reading big"),
    result("cr", "read", `LONGREAD\n${code(800)}`),
    call("c1", "bash", { command: "true" }, "checking"),
    result("c1", "bash", "BASH1\nok"),
    call("c2", "bash", { command: "true" }, "checking"),
    result("c2", "bash", "BASH2\nok"),
    call("c3", "bash", { command: "true" }, "checking"),
    result("c3", "bash", "BASH3\nok"),
    assistant("done"),
    user("next"),
    assistant("working"),
  ]
  const out = run(input, "cloud", { keepRoundTokens: 100000, urgentTokens: 200000 })
  assert.equal(out.cuts, 1)
  assert.ok(!out.messages.some((message) => messageText(message).includes("LONGREAD")))
  for (const marker of ["BASH1", "BASH2", "BASH3"]) {
    assert.ok(out.messages.some((message) => messageText(message).includes(marker)), marker)
  }
})

test("the 650k stopline disables cuts", () => {
  const input = twoRounds({ size: 2000 })
  const out = run(input, "local", { bigGate: 100 })
  assert.equal(out.cuts, 0)
})

test("native compaction checkpoints are never removed", () => {
  const input = [
    user("go"),
    { id: "cmp1", role: "assistant", content: [{ type: "compaction", provider: "opencode", id: "c", text: "summary" }] },
    call("c1", "bash", { command: "cat log" }, "reading"),
    result("c1", "bash", `ROUND1\n${code(800)}`),
    assistant("done"),
    user("next"),
    assistant("working"),
  ]
  const out = run(input, "local", { keepRounds: 1 })
  assert.ok(out.messages.some((message) => message.content.some((part) => part.type === "compaction")))
})

test("prose-heavy spans wait for native compaction (wait-80)", () => {
  const input = [
    user("go"),
    assistant(prose(500)),
    call("c1", "bash", { command: "cat log" }, "reading"),
    result("c1", "bash", code(100)),
    assistant("done"),
    user("next"),
    assistant("working"),
  ]
  const out = run(input, "local", { keepRounds: 1, maxCutTokens: 40000 })
  assert.equal(out.cuts, 0)
})

test("an assistant decision line that would be lost vetoes the card", () => {
  const input = [
    user("go"),
    assistant("Plan bug-123-456 is the chosen path."),
    call("c1", "bash", { command: "cat log" }, "reading"),
    result("c1", "bash", code(300)),
    assistant("done"),
    user("next"),
    assistant("working"),
  ]
  const out = run(input, "local", { keepRounds: 1 })
  assert.equal(out.cuts, 0)
})
