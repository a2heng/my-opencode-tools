#!/usr/bin/env node
// OpenCode 缓存命中率看板 —— 独立 Web UI，实时显示各会话的提示词缓存命中率
// 用法: node server.mjs [--port 8788] [--host 127.0.0.1]

import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

const HOME = os.homedir()
const SERVICE_CONFIG = path.join(HOME, ".config", "opencode", "service.json")
const SERVICE_STATE = path.join(HOME, ".local", "state", "opencode", "service.json")

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return {}
  }
}

const config = readJSON(SERVICE_CONFIG)
const state = readJSON(SERVICE_STATE)
const PASSWORD = process.env.OPENCODE_PASSWORD || config.password || state.password
const BASE = (process.env.OPENCODE_URL || state.url || (config.port ? `http://127.0.0.1:${config.port}` : "")).replace(/\/$/, "")
const PORT = Number(arg("port", process.env.PORT || 8788))
const HOST = arg("host", process.env.HOST || "127.0.0.1")

const AUTH = "Basic " + Buffer.from(`opencode:${PASSWORD}`).toString("base64")

async function api(pathname, timeout = 30000) {
  if (!BASE) throw new Error("找不到 OpenCode 地址：请设置 OPENCODE_URL 或在 service.json 里给 port")
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const response = await fetch(BASE + pathname, { headers: { authorization: AUTH }, signal: controller.signal })
    if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${pathname}`)
    const body = await response.json()
    return body.data ?? body
  } finally {
    clearTimeout(timer)
  }
}

// OpenCode 新版消息里 model 是 { id, providerID, variant }，旧版是 { providerID, modelID }；兼容两种
function modelName(model) {
  if (!model) return undefined
  if (typeof model === "string") return model
  const id = model.id ?? model.modelID
  return id ? `${model.providerID ?? "?"}/${id}` : (model.providerID ?? undefined)
}

function stepsOf(messages) {
  const steps = []
  for (const message of messages) {
    if (message?.type !== "assistant") continue
    const tokens = message.tokens
    if (!tokens) continue
    const input = Number(tokens.input ?? 0)
    const cacheRead = Number(tokens.cache?.read ?? 0)
    const cacheWrite = Number(tokens.cache?.write ?? 0)
    const denominator = input + cacheRead
    steps.push({
      id: message.id,
      time: message.time?.completed ?? message.time?.created ?? 0,
      rate: denominator > 0 ? (cacheRead / denominator) * 100 : 0,
      input,
      cacheRead,
      cacheWrite,
      output: Number(tokens.output ?? 0) + Number(tokens.reasoning ?? 0),
      cost: Number(message.cost ?? 0),
      model: modelName(message.model),
    })
  }
  // OpenCode 的 /api/session/<id>/message 按时间倒序返回（新的在前）。
  // 这里统一排成正序（旧 → 新）：totals.last 才是真正的「最近一步」，
  // 前端趋势图（新的在右）和明细（新的在上）也才正确。
  steps.sort((a, b) => (a.time || 0) - (b.time || 0))
  return steps
}

function totalsOf(steps) {
  const totals = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0, steps: steps.length, rate: 0, last: 0 }
  for (const step of steps) {
    totals.input += step.input
    totals.cacheRead += step.cacheRead
    totals.cacheWrite += step.cacheWrite
    totals.output += step.output
    totals.cost += step.cost
  }
  const denominator = totals.input + totals.cacheRead
  totals.rate = denominator > 0 ? (totals.cacheRead / denominator) * 100 : 0
  totals.last = steps.length > 0 ? steps[steps.length - 1].rate : 0
  return totals
}

const summaryCache = new Map()

async function sessionSummary(session) {
  const cached = summaryCache.get(session.id)
  const updated = session.time?.updated ?? 0
  if (cached && cached.updated === updated) return cached.value
  const messages = await api(`/api/session/${session.id}/message`, 60000)
  const steps = stepsOf(messages)
  const value = {
    id: session.id,
    title: session.title || session.id,
    updated,
    created: session.time?.created ?? 0,
    agent: session.agent,
    totals: totalsOf(steps),
    lastSteps: steps.slice(-40),
  }
  summaryCache.set(session.id, { updated, value })
  return value
}

async function overview() {
  const sessions = await api("/api/session")
  const list = [...sessions].sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0)).slice(0, 20)
  const out = []
  for (const session of list) {
    try {
      out.push(await sessionSummary(session))
    } catch (error) {
      out.push({ id: session.id, title: session.title || session.id, updated: session.time?.updated ?? 0, error: String(error.message || error) })
    }
  }
  return out
}

const HTML = fs.readFileSync(new URL("./index.html", import.meta.url), "utf8")

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`)

  if (url.pathname === "/" || url.pathname === "/index.html") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
    response.end(HTML)
    return
  }

  if (url.pathname === "/api/overview") {
    try {
      const data = await overview()
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
      response.end(JSON.stringify({ base: BASE, data }))
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json; charset=utf-8" })
      response.end(JSON.stringify({ error: String(error.message || error) }))
    }
    return
  }

  if (url.pathname === "/api/stream") {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    })
    const controller = new AbortController()
    request.on("close", () => controller.abort())
    ;(async () => {
      try {
        const upstream = await fetch(`${BASE}/api/event`, { headers: { authorization: AUTH }, signal: controller.signal })
        const reader = upstream.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ""
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let index
          while ((index = buffer.indexOf("\n\n")) >= 0) {
            const chunk = buffer.slice(0, index)
            buffer = buffer.slice(index + 2)
            const line = chunk.split("\n").find((item) => item.startsWith("data: "))
            if (!line) continue
            try {
              const event = JSON.parse(line.slice(6))
              if (/^(message\.|session\.|pty\.)/.test(event.type) || event.type === "server.connected") {
                response.write(`data: ${JSON.stringify({ type: event.type, sessionID: event.data?.sessionID ?? event.data?.info?.sessionID ?? event.data?.id })}\n\n`)
              }
            } catch {
              /* 忽略非 JSON 心跳 */
            }
          }
        }
      } catch {
        /* 上游断开 */
      }
      response.end()
    })()
    return
  }

  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
  response.end("not found")
})

server.listen(PORT, HOST, () => {
  console.log(`cache dashboard: http://${HOST}:${PORT}  ->  OpenCode ${BASE}`)
})
