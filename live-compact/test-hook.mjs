import assert from "node:assert/strict"
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createLiveCompact } from "./hook.mjs"
import { messageText } from "./core.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const testDir = join(here, ".test")
const shadowDir = join(testDir, "shadow")
rmSync(testDir, { recursive: true, force: true })

let nextId = 0
const id = () => `msg_${(nextId += 1)}`
const user = (text) => ({ id: id(), role: "user", content: [{ type: "text", text }] })
const assistant = (text) => ({ id: id(), role: "assistant", content: [{ type: "text", text }] })
const result = (toolId, name, text) => ({
  id: id(),
  role: "tool",
  content: [{ type: "tool-result", id: toolId, name, result: { type: "text", value: text } }],
})

const prose = Array.from({ length: 120 }, (_, i) => `noise ${i} ${"lorem ipsum dolor sit amet ".repeat(4)}`).join("\n")
const hard = "must preserve the value ALPHA_LIMIT = 42 in src/config/alpha.ts"

const messages = [
  user("build it"),
  assistant("reading"),
  result("t1", "read", `src/config/alpha.ts:1\n${hard}\n${prose}`),
  assistant("Done. ALPHA_LIMIT is preserved."),
  user("next task"),
  assistant("working"),
]

const hooks = {}
let disposed = false
const ctx = {
  options: {
    minContextTokens: 100,
    minCutTokens: 50,
    maxCutTokens: 5000,
    keepChars: 2000,
    shadow: true,
    shadowDir,
  },
  session: {
    hook: async (name, callback) => {
      hooks[name] = callback
      return { dispose: async () => { disposed = true } }
    },
  },
}

const cleanup = await createLiveCompact(ctx)
assert.ok(hooks.context, "context hook registered")

const event = { sessionID: "ses_test", messages }
hooks.context(event)

assert.notEqual(event.messages, messages, "hook must replace the message array")
assert.ok(event.messages.length < messages.length, "hook must remove messages")
const digest = event.messages.find((message) => messageText(message).includes("<live-compact>"))
assert.ok(digest, "digest must be present")
assert.ok(messageText(digest).includes("TRUNK CONFIRMED"))
assert.ok(messageText(digest).includes("ALPHA_LIMIT = 42"), "hard line must survive")
assert.equal(event.messages.at(-1).role, "assistant")
assert.ok(messageText(event.messages.at(-1)).includes("working"), "active turn stays intact")

const files = readdirSync(shadowDir)
assert.equal(files.length, 1, "shadow file written")
const shadow = readFileSync(join(shadowDir, files[0]), "utf8")
assert.ok(shadow.includes("ALPHA_LIMIT = 42"), "shadow keeps the original text")

// Re-running with the same history must produce identical bytes (cache stability).
const again = { sessionID: "ses_test", messages }
hooks.context(again)
assert.deepEqual(again.messages, event.messages, "same input must produce same output")

await cleanup()
assert.equal(disposed, true)
rmSync(testDir, { recursive: true, force: true })
console.log("hook test passed")
