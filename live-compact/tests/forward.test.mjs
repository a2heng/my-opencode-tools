import assert from "node:assert/strict"
import test from "node:test"
import { compactMessagesForward, estimateTokens, messageText } from "../core.mjs"
import { assistant, call, countCuts, resetIds, result, user } from "./helpers.mjs"

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
  maxPasses: 16,
  shadow: false,
}

const code = (lines, prefix = "line") =>
  Array.from(
    { length: lines },
    (_, i) => `const value_${i} = readConfig("src/config/module_${i}.ts") // ${prefix} ${i}`,
  ).join("\n")

function round(n, name = "bash", output = code(300)) {
  return [
    call(`c${n}`, name, { filePath: `src/file_${n}.ts`, command: `cmd_${n}` }, `round ${n}`),
    result(`c${n}`, name, output),
  ]
}

function turn(n, rounds = 2) {
  const items = [user(`task ${n}`), assistant(`starting ${n}`)]
  for (let r = 1; r <= rounds; r += 1) items.push(...round(`${n}-${r}`, "bash", code(300, `task${n}-r${r}`)))
  items.push(assistant(`done ${n}`))
  return items
}

const options = (overrides = {}) => ({ ...BASE, ...overrides })

test("forward transform is deterministic", () => {
  resetIds()
  const input = [...turn(1), ...turn(2), user("active"), assistant("working")]
  const a = compactMessagesForward(input, { options: options(), engine: "local" })
  const b = compactMessagesForward(input, { options: options(), engine: "local" })
  assert.deepEqual(a.messages, b.messages)
  assert.equal(a.cuts, b.cuts)
})

test("finishing turn 3 never rewrites the already-cut turn 1/2 prefix", () => {
  resetIds()
  const base = [...turn(1), ...turn(2), ...turn(3), user("active"), assistant("working")]
  const a = compactMessagesForward(base, { options: options({ keepRounds: 1 }), engine: "local" })
  assert.ok(a.cuts > 0, "the finished turns should be cut")
  const done2 = a.messages.findIndex((message) => messageText(message).includes("done 2"))
  assert.ok(done2 > 0)
  const prefixA = a.messages.slice(0, done2 + 1)

  const longer = [...base, user("task 4"), assistant("done 4")]
  const b = compactMessagesForward(longer, { options: options({ keepRounds: 1 }), engine: "local" })
  assert.deepEqual(
    b.messages.slice(0, prefixA.length),
    prefixA,
    "the prefix of turns 1/2 must be byte-identical after turn 3 finishes",
  )
})

test("an older card is never un-cut by a new user turn", () => {
  resetIds()
  const base = [...turn(1), ...turn(2), user("active"), assistant("working")]
  const a = compactMessagesForward(base, { options: options({ keepRounds: 1 }), engine: "local" })
  const cardsA = a.messages.filter((message) => messageText(message).includes("<live-compact>")).map(messageText)
  assert.ok(cardsA.length > 0)

  const next = [...base, user("task 3"), assistant("done 3")]
  const b = compactMessagesForward(next, { options: options({ keepRounds: 1 }), engine: "local" })
  const cardsB = b.messages.filter((message) => messageText(message).includes("<live-compact>")).map(messageText)
  for (const card of cardsA) assert.ok(cardsB.includes(card), "old card must remain byte-identical")
})

test("restart (same raw history) reproduces the same output", () => {
  resetIds()
  const input = [...turn(1), ...turn(2), user("active"), assistant("working")]
  const a = compactMessagesForward(input, { options: options({ keepRounds: 1 }), engine: "local" })
  const b = compactMessagesForward(input, { options: options({ keepRounds: 1 }), engine: "local" })
  assert.deepEqual(a.messages, b.messages)
})

test("kept rounds are per turn, so a later turn cannot change an earlier turn's kept set", () => {
  resetIds()
  const base = [...turn(1, 4), ...turn(2, 2), user("active"), assistant("working")]
  const a = compactMessagesForward(base, { options: options({ keepRounds: 1 }), engine: "local" })
  const text = a.messages.map(messageText).join("\n")
  assert.equal(text.includes("task1-r1 0"), false, "oldest round of turn 1 is cut")
  assert.ok(text.includes("task1-r4 0"), "newest round of turn 1 is kept")
  assert.ok(text.includes("done 1"))

  const next = [...base, user("task 3"), assistant("done 3")]
  const b = compactMessagesForward(next, { options: options({ keepRounds: 1 }), engine: "local" })
  const done1 = a.messages.findIndex((message) => messageText(message).includes("done 1"))
  assert.deepEqual(b.messages.slice(0, done1 + 1), a.messages.slice(0, done1 + 1))
})

test("a single-round turn is left alone when keepRounds is 1", () => {
  resetIds()
  const input = [...turn(1, 1), user("active"), assistant("working")]
  const out = compactMessagesForward(input, { options: options({ keepRounds: 1 }), engine: "local" })
  assert.equal(out.cuts, 0)
})
