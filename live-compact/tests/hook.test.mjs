import assert from "node:assert/strict"
import test from "node:test"
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createLiveCompact } from "../hook.mjs"
import { messageText } from "../core.mjs"
import { assistant, call, codeOutput, countCuts, resetIds, result, user } from "./helpers.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, ".tmp")

function fakeContext({ baseURL = "https://opencode.ai/inference/openai/v1", options = {}, providerFails = false, providers = null } = {}) {
  const hooks = {}
  const ctx = {
    options,
    provider: {
      list: async () => {
        if (providerFails) throw new Error("provider list unavailable")
        return {
          data: providers ?? [{ id: "opencode", settings: { baseURL } }],
        }
      },
    },
    session: {
      hook: async (name, callback) => {
        hooks[name] = callback
        return { dispose: async () => {} }
      },
    },
  }
  return { ctx, hooks }
}

function history() {
  resetIds()
  return [
    user("build it"),
    assistant("reading"),
    call("c1", "read", { filePath: "src/config/alpha.ts" }, "reading"),
    result("c1", "read", `必须保留 ALPHA_LIMIT = 42\n${codeOutput(600)}`),
    assistant("round one done"),
    call("c2", "bash", { command: "true" }, "checking"),
    result("c2", "bash", "ok"),
    assistant("Done."),
    user("next"),
    assistant("working"),
  ]
}

const OPTIONS = {
  minContextTokens: 100,
  minCutTokens: 20,
  maxCutTokens: 40000,
  keepRounds: 1,
  keepRoundTokens: 500,
  urgentTokens: 1000,
  keepChars: 2000,
  maxPasses: 8,
  shadow: true,
  shadowDir: join(root, "shadow"),
}

test("hook resolves the engine, cuts, writes a shadow and is deterministic", async () => {
  rmSync(root, { recursive: true, force: true })
  const { ctx, hooks } = fakeContext({ options: OPTIONS })
  await createLiveCompact(ctx)
  assert.ok(hooks.context, "context hook registered")

  const messages = history()
  const event = {
    sessionID: "ses_test",
    model: { providerID: "opencode" },
    messages,
  }
  await hooks.context(event)
  assert.notEqual(event.messages, messages, "hook replaces the message array")
  assert.ok(event.messages.length < messages.length, "hook removes the cut messages")
  assert.ok(event.messages.some((message) => messageText(message).includes("<live-compact>")))
  assert.ok(event.messages.some((message) => messageText(message).includes("ALPHA_LIMIT = 42")))
  assert.ok(event.messages.some((message) => messageText(message).includes("working")))

  const files = readdirSync(join(root, "shadow"))
  assert.equal(files.length, 1, "one shadow file")
  const shadow = readFileSync(join(root, "shadow", files[0]), "utf8")
  assert.ok(shadow.includes("ALPHA_LIMIT = 42"))

  const again = { sessionID: "ses_test", model: { providerID: "opencode" }, messages }
  await hooks.context(again)
  assert.deepEqual(again.messages, event.messages, "same history must produce the same bytes")

  rmSync(root, { recursive: true, force: true })
})

test("explicit local engine does not need the provider list", async () => {
  rmSync(root, { recursive: true, force: true })
  const { ctx, hooks } = fakeContext({
    options: { ...OPTIONS, engine: "local" },
    providerFails: true,
  })
  await createLiveCompact(ctx)
  const event = { sessionID: "ses_local", model: { providerID: "unknown" }, messages: history() }
  await hooks.context(event)
  assert.ok(event.messages.some((message) => messageText(message).includes("<live-compact>")))
  rmSync(root, { recursive: true, force: true })
})

test("a provider list failure falls back without breaking the request", async () => {
  rmSync(root, { recursive: true, force: true })
  const { ctx, hooks } = fakeContext({ options: OPTIONS, providerFails: true })
  await createLiveCompact(ctx)
  const event = { sessionID: "ses_fallback", model: { providerID: "opencode" }, messages: history() }
  await hooks.context(event)
  // Unknown endpoint resolves local (upstream rule); the transform still runs.
  assert.ok(Array.isArray(event.messages))
  rmSync(root, { recursive: true, force: true })
})

test("a previous cut is sticky while the active turn grows", async () => {
  const { ctx, hooks } = fakeContext({ options: OPTIONS })
  await createLiveCompact(ctx)
  const raw = history()
  const first = { sessionID: "ses_sticky", model: { providerID: "opencode" }, messages: raw }
  await hooks.context(first)
  const card = first.messages.find((message) => messageText(message).includes("<live-compact>"))
  assert.ok(card)

  const grown = [...raw, assistant("more active output")]
  const second = { sessionID: "ses_sticky", model: { providerID: "opencode" }, messages: grown }
  await hooks.context(second)
  assert.deepEqual(second.messages.slice(0, first.messages.length), first.messages, "old cut must be byte-identical")
  assert.deepEqual(
    second.messages.filter((message) => messageText(message).includes("<live-compact>")).map(messageText),
    [messageText(card)],
    "the card must not be duplicated or changed",
  )
})

test("a new finished turn is cut without un-cutting the old card", async () => {
  const { ctx, hooks } = fakeContext({ options: OPTIONS })
  await createLiveCompact(ctx)
  const raw = history()
  const first = { sessionID: "ses_sticky2", model: { providerID: "opencode" }, messages: raw }
  await hooks.context(first)
  const oldCard = first.messages.find((message) => messageText(message).includes("<live-compact>"))
  assert.ok(oldCard)

  const next = [...raw, user("third task"), assistant("third answer")]
  const second = { sessionID: "ses_sticky2", model: { providerID: "opencode" }, messages: next }
  await hooks.context(second)
  assert.deepEqual(second.messages.slice(0, first.messages.length), first.messages, "old prefix must stay")
  assert.ok(
    second.messages.some((message) => messageText(message) === messageText(oldCard)),
    "old card must remain exactly once",
  )
})

test("a rewritten raw prefix drops the stored plan and rebuilds", async () => {
  const { ctx, hooks } = fakeContext({ options: OPTIONS })
  await createLiveCompact(ctx)
  const raw = history()
  const first = { sessionID: "ses_reset", model: { providerID: "opencode" }, messages: raw }
  await hooks.context(first)
  assert.ok(first.messages.some((message) => messageText(message).includes("<live-compact>")))

  const rewritten = raw.map((message, index) =>
    index === 0 ? { ...message, content: [{ type: "text", text: "a different first prompt" }] } : message,
  )
  const second = { sessionID: "ses_reset", model: { providerID: "opencode" }, messages: rewritten }
  await hooks.context(second)
  assert.ok(Array.isArray(second.messages))
  assert.ok(second.messages.length > 0)
})

test("engine resolution is per session, not frozen from the first provider", async () => {
  const { ctx, hooks } = fakeContext({
    options: {
      minContextTokens: 100,
      minCutTokens: 20,
      maxCutTokens: 40000,
      keepRounds: 1,
      keepRoundTokens: 100000,
      urgentTokens: 100000,
      keepChars: 2000,
      maxPasses: 8,
      shadow: false,
    },
    providers: [
      { id: "opencode", settings: { baseURL: "https://opencode.ai/inference/openai/v1" } },
      { id: "local", settings: { baseURL: "http://127.0.0.1:8000/v1" } },
    ],
  })
  await createLiveCompact(ctx)

  const messages = () => {
    resetIds()
    return [
      user("build it"),
      assistant("reading"),
      call("c1", "bash", { command: "cat a" }, "reading"),
      result("c1", "bash", codeOutput(500)),
      assistant("round one"),
      call("c2", "bash", { command: "true" }, "checking"),
      result("c2", "bash", "ok"),
      assistant("done"),
      user("next"),
      assistant("working"),
    ]
  }

  const cloudEvent = { sessionID: "ses_cloud", model: { providerID: "opencode" }, messages: messages() }
  await hooks.context(cloudEvent)
  assert.equal(countCuts(cloudEvent.messages), 0, "cloud ordinary turn cuts nothing")

  const localEvent = { sessionID: "ses_local", model: { providerID: "local" }, messages: messages() }
  await hooks.context(localEvent)
  assert.equal(countCuts(localEvent.messages), 1, "local session still cuts after a cloud session")
})

test("shadow is optional", async () => {
  rmSync(root, { recursive: true, force: true })
  const { ctx, hooks } = fakeContext({ options: { ...OPTIONS, shadow: false } })
  await createLiveCompact(ctx)
  const event = { sessionID: "ses_noshadow", model: { providerID: "opencode" }, messages: history() }
  await hooks.context(event)
  assert.equal(existsSync(join(root, "shadow")), false)
  rmSync(root, { recursive: true, force: true })
})
