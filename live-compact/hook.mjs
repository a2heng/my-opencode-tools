// Live Compact for OpenCode — plugin wiring.
//
// Kept separate from index.js so the hook can be tested without importing
// `@opencode/plugin` (which only the host can resolve).

import { createHash } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { compactMessages, DEFAULT_OPTIONS } from "./core.mjs"

export const PLUGIN_ID = "live-compact"

function shadowKey(sessionID, spanText) {
  const hash = createHash("sha256").update(spanText).digest("hex").slice(0, 16)
  const tag = String(sessionID ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(-24) || "session"
  return `${tag}-${hash}.txt`
}

export async function createLiveCompact(ctx) {
  const options = { ...DEFAULT_OPTIONS, ...(ctx.options ?? {}) }
  const shadowDir = options.shadow
    ? isAbsolute(options.shadowDir || "")
      ? options.shadowDir
      : resolve(homedir(), options.shadowDir || ".local/share/opencode/live-compact/shadow")
    : ""

  for (const key of ["minContextTokens", "minCutTokens", "maxCutTokens", "tailTokens", "urgentTokens", "keepChars"]) {
    const value = Number(options[key])
    options[key] = Number.isFinite(value) && value > 0 ? value : DEFAULT_OPTIONS[key]
  }

  const envOptions = {
    minContextTokens: "OPENCODE_LIVE_COMPACT_MIN_CONTEXT",
    minCutTokens: "OPENCODE_LIVE_COMPACT_MIN_CUT",
    maxCutTokens: "OPENCODE_LIVE_COMPACT_MAX_CUT",
    tailTokens: "OPENCODE_LIVE_COMPACT_TAIL_TOKENS",
    urgentTokens: "OPENCODE_LIVE_COMPACT_URGENT_TOKENS",
    keepChars: "OPENCODE_LIVE_COMPACT_KEEP_CHARS",
  }
  for (const [key, name] of Object.entries(envOptions)) {
    const raw = process.env[name]
    if (raw === undefined || raw === "") continue
    const value = Number(raw)
    if (Number.isFinite(value) && value > 0) options[key] = value
  }
  if (process.env.OPENCODE_LIVE_COMPACT_SHADOW === "0") options.shadow = false
  if (process.env.OPENCODE_LIVE_COMPACT_SHADOW_DIR) options.shadowDir = process.env.OPENCODE_LIVE_COMPACT_SHADOW_DIR

  const writeShadow = shadowDir
    ? (sessionID, spanText) => {
        const file = join(shadowDir, shadowKey(sessionID, spanText))
        try {
          mkdirSync(shadowDir, { recursive: true })
          if (!existsSync(file)) writeFileSync(file, spanText, { encoding: "utf8", flag: "wx" })
        } catch (error) {
          console.error(`[${PLUGIN_ID}] shadow write failed: ${error?.message ?? error}`)
        }
        // Return the path even if the write failed: the digest must stay
        // byte-identical across requests so the prefix cache keeps hitting.
        return file
      }
    : undefined

  const cache = new Map()
  const debug = process.env.OPENCODE_LIVE_COMPACT_DEBUG === "1"
  const debugFile = join(homedir(), ".local/share/opencode/live-compact/debug.log")
  let debugged = false

  const registration = await ctx.session.hook("context", (event) => {
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

      const result = compactMessages(event.messages, {
        sessionID: String(event.sessionID ?? ""),
        options,
        shadowWriter: writeShadow,
        cache,
      })
      if (result.cuts > 0) {
        event.messages = result.messages
        console.log(
          `[${PLUGIN_ID}] cut ${result.cuts} span(s) in ${Date.now() - started}ms ` +
            `${result.cutTokens} -> ${result.cardTokens} tokens session=${event.sessionID}`,
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
    `[${PLUGIN_ID}] loaded (minContext=${options.minContextTokens}, minCut=${options.minCutTokens}, ` +
      `maxCut=${options.maxCutTokens}, shadow=${shadowDir || "off"})`,
  )

  return () => registration.dispose()
}
