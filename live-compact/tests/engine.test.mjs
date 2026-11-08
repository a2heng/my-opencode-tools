import assert from "node:assert/strict"
import test from "node:test"
import { hostOf, isLocalHost, resolveEngine } from "../core.mjs"

test("isLocalHost classifies loopback, RFC1918, CGNAT and local names", () => {
  for (const host of [
    "localhost",
    "127.0.0.1",
    "10.1.2.3",
    "192.168.0.105",
    "172.16.0.1",
    "172.31.255.255",
    "100.64.0.1",
    "100.127.255.255",
    "::1",
    "fd00::1",
    "fe80::1",
    "printer.local",
  ]) {
    assert.equal(isLocalHost(host), true, host)
  }
})

test("isLocalHost rejects public endpoints", () => {
  for (const host of ["api.deepseek.com", "opencode.ai", "8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1"]) {
    assert.equal(isLocalHost(host), false, host)
  }
})

test("hostOf accepts a bare host:port and a full URL", () => {
  assert.equal(hostOf("http://192.168.0.5:8080/v1"), "192.168.0.5")
  assert.equal(hostOf("api.example.com:443"), "api.example.com")
  assert.equal(hostOf(""), "")
})

test("resolveEngine follows address, provider, env and unknown rules", () => {
  assert.deepEqual(resolveEngine({ provider: "opencode", baseURL: "https://opencode.ai/inference" }), {
    engine: "cloud",
    source: "address",
  })
  assert.deepEqual(resolveEngine({ provider: "opencode", baseURL: "http://127.0.0.1:8000/v1" }), {
    engine: "local",
    source: "address",
  })
  assert.deepEqual(resolveEngine({ provider: "strata-local", baseURL: "https://example.com" }), {
    engine: "local",
    source: "provider",
  })
  assert.deepEqual(resolveEngine({ provider: "x" }), { engine: "local", source: "unknown" })
  assert.deepEqual(resolveEngine({ provider: "x", engine: "cloud" }), { engine: "cloud", source: "config" })
  assert.deepEqual(
    resolveEngine({ provider: "x", baseURL: "https://api.example.com", env: { OPENCODE_LIVE_COMPACT_ENGINE: "local" } }),
    { engine: "local", source: "config" },
  )
  assert.deepEqual(
    resolveEngine({ provider: "x", baseURL: "https://api.example.com", engine: "auto", env: {} }),
    { engine: "cloud", source: "address" },
  )
})
