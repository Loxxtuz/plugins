import { createHash } from "node:crypto"

const PROVIDER = "zed-billing"
const BILLING_URL = "https://cloud.zed.dev/frontend/billing/usage"
const MAX_BODY = 256 * 1024
const CACHE_MS = 60_000
const MAX_ACCOUNTS = 32
const cache = new Map()
const money = (n) => "$" + n.toFixed(2)
class BillingResponseError extends Error {}

// Keep only the billing session. Other cookies and pasted HTTP headers
// never leave this module. Error messages must not repeat input values.
function sessionCookie(input) {
  if (typeof input !== "string" || input.length > 16_384 || /[\x00-\x1f\x7f]/.test(input))
    throw new Error("Paste the Cookie request header from a signed-in zed.dev page.")
  const header = input.trim().replace(/^Cookie:\s*/i, "")
  const values = header.split(";").map((v) => v.trim()).filter((v) => v.startsWith("zed.session="))
  // Zed's signed session includes a JSON suffix. Preserve its quotes and
  // punctuation; control characters and cookie delimiters stay forbidden.
  if (values.length !== 1 || !/^zed\.session=[\x21-\x3a\x3c-\x7e]+$/.test(values[0]))
    throw new Error("The Cookie header must contain exactly one non-empty zed.session cookie.")
  return values[0]
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function cents(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER)
    throw new BillingResponseError("Zed billing returned an invalid amount; its response format may have changed.")
  return value / 100
}

function parseUsage(body) {
  if (!record(body) || typeof body.plan !== "string" || !body.plan.trim() ||
      !record(body.current_usage) || !record(body.current_usage.token_spend))
    throw new BillingResponseError("Zed billing did not return token spend; its response format may have changed.")
  const spend = body.current_usage.token_spend
  const used = cents(spend.spend_in_cents)
  const limit = spend.limit_in_cents == null ? null : cents(spend.limit_in_cents)
  const plan = body.plan.replace(/^zed_/, "").split(/[_\s]+/).filter(Boolean)
    .map((s) => s[0].toUpperCase() + s.slice(1)).join(" ")
  const window = { name: "Token spend (web account)", amount: used, unit: "USD", aside: true }
  if (limit === null) {
    // An unreported limit is unknown, not unlimited or zero spent.
    window.display = `${money(used)} used; limit not reported`
    return { plan, windows: [window], signIn: "kept" }
  }
  const left = Math.max(0, limit - used)
  Object.assign(window, {
    used: limit > 0 ? Math.max(0, Math.min(100, used / limit * 100)) : used > 0 ? 100 : 0,
    limit,
    display: `${money(used)} / ${money(limit)} used; ${money(left)} remaining`,
  })
  return { plan, balance: `${money(left)} USD`, windows: [window], signIn: "kept" }
}

async function readBody(response) {
  if (Number(response.headers.get("content-length")) > MAX_BODY) {
    await response.body?.cancel().catch(() => {})
    throw new BillingResponseError("Zed billing returned an unexpectedly large response.")
  }
  const reader = response.body?.getReader()
  if (!reader) throw new BillingResponseError("Zed billing returned an empty response.")
  const chunks = []
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BODY) {
        await reader.cancel()
        throw new BillingResponseError("Zed billing returned an unexpectedly large response.")
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  let data
  try { data = JSON.parse(new TextDecoder().decode(bytes)) }
  catch { throw new BillingResponseError("Zed billing returned an unreadable response; refresh the Zed browser session.") }
  return data
}

function billingError(message, expired = false) {
  return { error: message, windows: [], signIn: expired ? "expired" : "kept" }
}

async function fetchUsage(cookie) {
  let response
  try {
    response = await fetch(BILLING_URL, {
      headers: { Accept: "application/json", Cookie: cookie },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    // A fetch exception may include request details. Never echo it.
    return billingError("Could not reach Zed billing; check the connection and browser session.")
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {})
    if (response.status === 401 || response.status === 403)
      return billingError("The Zed billing browser session expired; sign in to zed.dev and update this billing account's Cookie.", true)
    if (response.status === 429) return billingError("Zed billing is rate limited; try again later.")
    return billingError(`Zed billing returned HTTP ${response.status}; try again later.`)
  }
  try { return parseUsage(await readBody(response)) }
  catch (e) {
    // Only errors created by our response parser have displayable text.
    return billingError(e instanceof BillingResponseError ? e.message : "Zed billing could not be read; refresh the browser session.")
  }
}

async function usage(auth) {
  if (auth?.type !== "api") return billingError("Add a Zed web billing session to read token spend.")
  let cookie
  try { cookie = sessionCookie(auth.key) }
  catch { return billingError("This Zed billing credential has no valid zed.session cookie; update it.", true) }
  // This source belongs exclusively to the browser account. It never
  // reads or writes an editor credential and is not used for model routing.
  const key = createHash("sha256").update(cookie).digest("hex")
  const now = Date.now()
  let entry = cache.get(key)
  if (!entry || now - entry.at >= CACHE_MS) {
    if (cache.size >= MAX_ACCOUNTS) cache.delete(cache.keys().next().value)
    entry = { at: now, promise: fetchUsage(cookie) }
    cache.set(key, entry)
  }
  return structuredClone(await entry.promise)
}

export async function ZedBillingPlugin() {
  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] = { name: "Zed Billing (web account)", models: {} }
    },
    auth: {
      provider: PROVIDER,
      methods: [{
        type: "api",
        label: "Add Zed web billing session",
        prompts: [{ type: "text", key: "cookie", label: "Cookie request header from zed.dev (contains zed.session)", placeholder: "zed.session=..." }],
        async authorize(inputs) {
          let cookie
          try { cookie = sessionCookie(inputs?.cookie) }
          catch (e) { return { type: "failed", error: e.message } }
          const result = await usage({ type: "api", key: cookie })
          if (result.error) return { type: "failed", error: result.error }
          return { type: "success", key: cookie }
        },
      }],
      async loader() { return {} },
      async usage(getAuth) { return usage(await getAuth()) },
    },
  }
}

// Helpers are deliberately absent from the package's public entry point.
export const _internal = { sessionCookie, parseUsage, usage, cache, CACHE_MS, MAX_BODY, BILLING_URL }
