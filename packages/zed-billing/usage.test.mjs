import { afterEach, expect, test } from "bun:test"
import { ZedBillingPlugin, _internal as i } from "./index.mjs"

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch; i.cache.clear() })
const auth = (key = "zed.session=test-session") => ({ type: "api", key })
const data = (spent = 275, limit = 1000) => ({
  plan: "zed_student",
  current_usage: { token_spend: { spend_in_cents: spent, limit_in_cents: limit } },
})
const hooks = () => ZedBillingPlugin()
const read = async (a = auth()) => (await hooks()).auth.usage(async () => a)

test("returns exact spent, spending limit, remaining USD and a progress window", async () => {
  const seen = []
  globalThis.fetch = async (url, init) => {
    seen.push({ url, init })
    return Response.json(data())
  }
  const out = await read()
  expect(out).toEqual({
    plan: "Student", balance: "$7.25 USD", signIn: "kept",
    windows: [{ name: "Token spend (web account)", amount: 2.75, unit: "USD", aside: true,
      used: expect.closeTo(27.5, 8), limit: 10, display: "$2.75 / $10.00 used; $7.25 remaining" }],
  })
  expect(seen).toHaveLength(1)
  expect(seen[0].url).toBe(i.BILLING_URL)
  expect(seen[0].init.headers).toEqual({ Accept: "application/json", Cookie: auth().key })
  expect(seen[0].init.redirect).toBe("error")
  expect(seen[0].init.signal).toBeInstanceOf(AbortSignal)
})

test("an unknown limit is not fabricated from the Student plan or turned into unlimited", () => {
  for (const limit of [null, undefined]) {
    const payload = data()
    payload.current_usage.token_spend.limit_in_cents = limit
    const out = i.parseUsage(payload)
    expect(out.balance).toBeUndefined()
    expect(out.windows[0]).toEqual({ name: "Token spend (web account)", amount: 2.75, unit: "USD", aside: true,
      display: "$2.75 used; limit not reported" })
  }
})

test("zero budgets, exact exhaustion and overspending keep amounts and clamp only progress and remaining", () => {
  expect(i.parseUsage(data(0, 0)).windows[0].used).toBe(0)
  expect(i.parseUsage(data(1, 0)).windows[0].used).toBe(100)
  expect(i.parseUsage(data(1000, 1000)).balance).toBe("$0.00 USD")
  const over = i.parseUsage(data(1250, 1000))
  expect(over.balance).toBe("$0.00 USD")
  expect(over.windows[0]).toMatchObject({ amount: 12.5, limit: 10, used: 100 })
})

test("missing usage, malformed data and invalid amounts stay unknown", () => {
  for (const value of [null, [], {}, { plan: "zed_student", current_usage: {} }, data(undefined, "1000")])
    expect(() => i.parseUsage(value)).toThrow()
  for (const value of [-1, NaN, Infinity, "275", null, undefined, Number.MAX_SAFE_INTEGER + 1]) {
    const bad = data(); bad.current_usage.token_spend.spend_in_cents = value
    expect(() => i.parseUsage(bad)).toThrow()
  }
})

test("retains only the session cookie, accepts a full Cookie header and rejects header injection", () => {
  expect(i.sessionCookie(" Cookie: other=private; zed.session=test%2Fvalue; tracking=not-sent ")).toBe("zed.session=test%2Fvalue")
  for (const bad of ["", "other=x", "zed.session=", "zed.session=a; zed.session=b", "zed.session=a\r\nX-Test: b", "zed.session=a\nb", 'zed.session="a"', "zed.session=a".repeat(2000)])
    expect(() => i.sessionCookie(bad)).toThrow()
})

test("missing or invalid credentials make no request and expose no input", async () => {
  globalThis.fetch = async () => { throw new Error("must not fetch") }
  expect((await read(null)).error).toContain("Add a Zed web billing session")
  const out = await read(auth("private-invalid-secret"))
  expect(out.signIn).toBe("expired")
  expect(JSON.stringify(out)).not.toContain("private-invalid-secret")
  expect(out.windows).toEqual([])
})

test("browser authentication failure marks only the billing account expired and never returns stale totals", async () => {
  for (const status of [401, 403]) {
    i.cache.clear()
    globalThis.fetch = async () => new Response("zed.session=should-not-leak", { status })
    const out = await read()
    expect(out.signIn).toBe("expired")
    expect(out.windows).toEqual([])
    expect(out.balance).toBeUndefined()
    expect(out.error).toContain("browser session expired")
    expect(JSON.stringify(out)).not.toContain("should-not-leak")
  }
})

test("rate limits and upstream failures keep the billing login and sanitize response bodies", async () => {
  for (const status of [429, 500, 502]) {
    i.cache.clear()
    globalThis.fetch = async () => new Response("secret-in-response", { status })
    const out = await read()
    expect(out.signIn).toBe("kept")
    expect(out.balance).toBeUndefined()
    expect(out.windows).toEqual([])
    expect(JSON.stringify(out)).not.toContain("secret-in-response")
  }
})

test("transport and stream errors do not leak request credentials", async () => {
  globalThis.fetch = async () => { throw new Error("secret-cookie-from-fetch") }
  expect(JSON.stringify(await read())).not.toContain("secret-cookie-from-fetch")
  i.cache.clear()
  globalThis.fetch = async () => new Response(new ReadableStream({ start(c) { c.error(new Error("Zed billing returned secret-cookie-from-stream")) } }))
  expect(JSON.stringify(await read())).not.toContain("secret-cookie-from-stream")
})

test("HTML or changed response formats return a clear error without inventing a zero balance", async () => {
  for (const body of ["<html>login secret</html>", "null", "{}", '{"plan":"zed_student"}']) {
    i.cache.clear()
    globalThis.fetch = async () => new Response(body)
    const out = await read()
    expect(out.error).toContain("Zed billing")
    expect(out.windows).toEqual([])
    expect(out.balance).toBeUndefined()
    expect(JSON.stringify(out)).not.toContain("login secret")
  }
})

test("response size is bounded even without Content-Length", async () => {
  globalThis.fetch = async () => new Response("a".repeat(i.MAX_BODY + 1))
  expect((await read()).error).toContain("large response")
  i.cache.clear()
  globalThis.fetch = async () => new Response("{}", { headers: { "content-length": String(i.MAX_BODY + 1) } })
  expect((await read()).error).toContain("large response")
})

test("concurrent and repeated reads share one request, with credential-scoped cache and cloned results", async () => {
  let calls = 0
  globalThis.fetch = async () => { calls++; return Response.json(data(calls * 100)) }
  const [a, b] = await Promise.all([read(), read()])
  expect(calls).toBe(1)
  a.windows[0].amount = 999
  expect(b.windows[0].amount).toBe(1)
  expect((await read()).windows[0].amount).toBe(1)
  expect((await read(auth("zed.session=another-account"))).windows[0].amount).toBe(2)
  expect(calls).toBe(2)
  expect([...i.cache.keys()].join()).not.toContain("zed.session")
  for (const entry of i.cache.values()) entry.at -= i.CACHE_MS + 1
  expect((await read()).windows[0].amount).toBe(3)
})

test("the usage source is a separate account with no model catalog or editor credentials", async () => {
  const h = await hooks()
  const cfg = {}
  await h.config(cfg)
  expect(h.auth.provider).toBe("zed-billing")
  expect(cfg.provider["zed-billing"]).toEqual({ name: "Zed Billing (web account)", models: {} })
  expect(await h.auth.loader()).toEqual({})
  expect(cfg.provider.zed).toBeUndefined()
  globalThis.fetch = async () => { throw new Error("must not fetch editor account") }
  const out = await read({ type: "oauth", access: "editor-secret", refresh: "editor-metadata" })
  expect(out.balance).toBeUndefined()
  expect(JSON.stringify(out)).not.toContain("editor-secret")
})

test("sign-in verifies billing before storing only its cookie", async () => {
  const h = await hooks()
  globalThis.fetch = async () => Response.json(data())
  expect(await h.auth.methods[0].authorize({ cookie: "other=private; zed.session=test-session" }))
    .toEqual({ type: "success", key: "zed.session=test-session" })
  expect((await h.auth.methods[0].authorize({ cookie: "secret-invalid" })).type).toBe("failed")
  i.cache.clear()
  globalThis.fetch = async () => new Response("secret-unauthorized", { status: 401 })
  const bad = await h.auth.methods[0].authorize({ cookie: "zed.session=expired" })
  expect(bad.type).toBe("failed")
  expect(JSON.stringify(bad)).not.toContain("secret-unauthorized")
})
