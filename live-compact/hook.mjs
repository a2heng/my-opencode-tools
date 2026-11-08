// Live Compact for OpenCode — plugin wiring.
//
// Kept separate from index.js so the hook can be tested without importing
// `@opencode/plugin` (which only the host can resolve).

import { createHash } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { compactMessagesForward, DEFAULT_OPTIONS, resolveEngine } from "./core.mjs"

export const PLUGIN_ID = "live-compact"

const NUMERIC_OPTIONS = [
  "minContextTokens",
  "minCutTokens",
  "maxCutTokens",
  "pointerTokens",
  "keepRounds",
  "keepRoundTokens",
  "tailTokens",
  "urgentTokens",
  "bigGate",
  "keepChars",
  "maxPasses",
]

const ENV_OPTIONS = {
  minContextTokens: "OPENCODE_LIVE_COMPACT_MIN_CONTEXT",
  minCutTokens: "OPENCODE_LIVE_COMPACT_MIN_CUT",
  maxCutTokens: "OPENCODE_LIVE_COMPACT_MAX_CUT",
  pointerTokens: "OPENCODE_LIVE_COMPACT_POINTER_TOKENS",
  keepRounds: "OPENCODE_LIVE_COMPACT_KEEP_ROUNDS",
  keepRoundTokens: "OPENCODE_LIVE_COMPACT_KEEP_ROUND_TOKENS",
  tailTokens: "OPENCODE_LIVE_COMPACT_TAIL_TOKENS",
  urgentTokens: "OPENCODE_LIVE_COMPACT_URGENT_TOKENS",
  bigGate: "OPENCODE_LIVE_COMPACT_BIG_GATE",
  keepChars: "OPENCODE_LIVE_COMPACT_KEEP_CHARS",
  maxPasses: "OPENCODE_LIVE_COMPACT_MAX_PASSES",
}

function shadowKey(sessionID, spanText) {
  const hash = createHash("sha256").update(spanText).digest("hex").slice(0, 16)
  const tag = String(sessionID ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(-24) || "session"
  return `${tag}-${hash}.txt`
}

// Provider base URLs come from the host's provider inventory (the same data
// the HTTP API exposes as `settings.baseURL`). Resolution is best-effort and
// never breaks a request: an unknown provider stays local, like upstream DSH.
async function loadProviderURLs(ctx) {
  const urls = new Map()
  try {
    const result = await ctx?.provider?.list?.()
    const list = Array.isArray(result) ? result : (result?.data ?? [])
    for (const item of list) {
      const id = item?.id
      const url = item?.settings?.baseURL || item?.baseURL || item?.defaultBaseURL
      if (id && url) urls.set(id, url)
    }
  } catch {
    // fall through with an empty map
  }
  return urls
}

export async function createLiveCompact(ctx) {
  const options = { ...DEFAULT_OPTIONS, ...(ctx.options ?? {}) }

  for (const key of NUMERIC_OPTIONS) {
    const value = Number(options[key])
    options[key] = Number.isFinite(value) && value > 0 ? value : DEFAULT_OPTIONS[key]
  }
  for (const [key, name] of Object.entries(ENV_OPTIONS)) {
    const raw = process.env[name]
    if (raw === undefined || raw === "") continue
    const value = Number(raw)
    if (Number.isFinite(value) && value > 0) options[key] = value
  }
  const engineOption = String(options.engine ?? "auto").toLowerCase()
  options.engine = ["auto", "local", "cloud"].includes(engineOption) ? engineOption : "auto"
  const envEngine = String(process.env.OPENCODE_LIVE_COMPACT_ENGINE ?? "").toLowerCase()
  if (options.engine === "auto" && (envEngine === "local" || envEngine === "cloud")) options.engine = envEngine

  const shadowDir = options.shadow
    ? isAbsolute(options.shadowDir || "")
      ? options.shadowDir
      : resolve(homedir(), options.shadowDir || ".local/share/opencode/live-compact/shadow")
    : ""

  if (process.env.OPENCODE_LIVE_COMPACT_SHADOW === "0") options.shadow = false
  if (process.env.OPENCODE_LIVE_COMPACT_SHADOW_DIR) options.shadowDir = process.env.OPENCODE_LIVE_COMPACT_SHADOW_DIR
  const effectiveShadowDir = options.shadow
    ? isAbsolute(options.shadowDir || "")
      ? options.shadowDir
      : resolve(homedir(), options.shadowDir || shadowDir)
    : ""

  const writeShadow = effectiveShadowDir
    ? (sessionID, spanText) => {
        const file = join(effectiveShadowDir, shadowKey(sessionID, spanText))
        try {
          mkdirSync(effectiveShadowDir, { recursive: true })
          if (!existsSync(file)) writeFileSync(file, spanText, { encoding: "utf8", flag: "wx" })
        } catch (error) {
          console.error(`[${PLUGIN_ID}] shadow write failed: ${error?.message ?? error}`)
        }
        // Return the path even if the write failed: the digest must stay
        // byte-identical across requests so the prefix cache keeps hitting.
        return file
      }
    : undefined

  const debug = process.env.OPENCODE_LIVE_COMPACT_DEBUG === "1"
  const debugFile = join(homedir(), ".local/share/opencode/live-compact/debug.log")
  let debugged = false
  let providerURLs = null
  const engineLogged = new Set()

  const registration = await ctx.session.hook("context", async (event) => {
    const started = Date.now()
    try {
      if (debug && !debugged) {
        debugged = true
        const shape = event.messages.map((message) => ({
          id: message.id,
          role: message.role,
          parts: (message.content ?? []).map((part) => part.type),
        }))
        try {
          mkdirSync(join(homedir(), ".local/share/opencode/live-compact"), { recursive: true })
          appendFileSync(debugFile, `${JSON.stringify({ sessionID: event.sessionID, shape })}\n`)
        } catch {}
      }

      // Resolve per request, never freeze the first session's engine into the
      // shared options: this plugin is global, so cloud and local providers can
      // be used side by side on the same server.
      let resolvedEngine = options.engine
      if (options.engine === "auto") {
        if (!providerURLs) providerURLs = await loadProviderURLs(ctx)
        const provider = event.model?.providerID ?? ""
        const resolved = resolveEngine({
          provider,
          baseURL: providerURLs.get(provider),
          engine: "auto",
          env: process.env,
        })
        resolvedEngine = resolved.engine
        if (!engineLogged.has(provider)) {
          engineLogged.add(provider)
          console.log(
            `[${PLUGIN_ID}] engine=${resolved.engine} source=${resolved.source} provider=${provider || "?"}`,
          )
        }
      }

      const result = compactMessagesForward(event.messages, {
        sessionID: String(event.sessionID ?? ""),
        options,
        engine: resolvedEngine,
        shadowWriter: writeShadow,
      })
      event.messages = result.messages
      if (result.cuts > 0) {
        console.log(
          `[${PLUGIN_ID}] cut ${result.cuts} span(s) in ${Date.now() - started}ms ` +
            `${result.cutTokens} -> ${result.cardTokens} tokens ` +
            `effective ${result.totalBefore} -> ${result.totalAfter} engine=${result.engine} ` +
            `mode=monotonic session=${event.sessionID}`,
        )
        if (debug) {
          try {
            appendFileSync(
              debugFile,
              `${JSON.stringify({
                sessionID: event.sessionID,
                cut: result.cuts,
                cutTokens: result.cutTokens,
                cardTokens: result.cardTokens,
                totalBefore: result.totalBefore,
                totalAfter: result.totalAfter,
                engine: result.engine,
                mode: "monotonic",
                ms: Date.now() - started,
              })}\n`,
            )
          } catch {}
        }
      }
    } catch (error) {
      // Never break a model request because compaction failed.
      console.error(`[${PLUGIN_ID}] skipped: ${error?.message ?? error}`)
    }
  })

  console.log(
    `[${PLUGIN_ID}] loaded (engine=${options.engine}, minContext=${options.minContextTokens}, ` +
      `minCut=${options.minCutTokens}, maxCut=${options.maxCutTokens}, keepRounds=${options.keepRounds}, ` +
      `shadow=${effectiveShadowDir || "off"})`,
  )

  return () => registration.dispose()
}
