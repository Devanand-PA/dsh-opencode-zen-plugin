/**
 * OpenCode Zen free anonymous models provider for the DeepSeek Harness.
 *
 * OpenCode's free tier serves a rotating set of `-free` models (plus a few
 * unsuffixed zero-cost ones) from `https://opencode.ai/inference/v1`, but the
 * gate only unlocks for requests that carry the OpenCode CLI's own identity.
 * The requirements below were verified against the live endpoint on
 * 2026-10-21 (see README.md for the full matrix):
 *
 *   1. `Authorization: Bearer public` (or a real `OPENCODE_API_KEY`)
 *   2. `User-Agent: opencode/<semver>` with semver >= ~1.11; older versions
 *      get HTTP 426 UpgradeRequired, non-semver gets 403 FreeTierError
 *   3. `x-opencode-session: ses_` + exactly 26 alphanumeric characters, in
 *      OpenCode's own identifier format (12 hex time digits + 14 base62)
 *   4. a tool literally named `read` declared in the request body
 *   5. `"stream": true`
 *
 * The plugin therefore wraps pi-ai's OpenAI transports with the identity
 * headers, pads the tool list when the harness sends fewer tools than the
 * gate wants (compaction, titles, restricted turns), and keeps the model
 * catalog fresh without ever blocking the mount: apply() is synchronous, the
 * picker starts on pi-ai's builtin zero-cost OpenCode models (plus the
 * last-good list on disk), and the live catalog is refreshed lazily in the
 * background.
 *
 * Structure and several hard-won details follow the proven approach of
 * github.com/jiesou/dsh-opencode-zen-free-provider (MIT).
 */
import type { Context } from '@deepseek-ai/cordis'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { assertUsableApiKey, errorChain, resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter, type ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
// Augments Context with `fiber.entry` and the `loader/volatile-update` event.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import z from '@deepseek-ai/schemastery'
import {
  createProvider,
  type AuthContext,
  type CredentialStore,
  type Model,
  type SimpleStreamOptions,
  type ProviderStreams,
  type ThinkingLevelMap,
  type Tool,
  type TranscriptContext,
} from '@earendil-works/pi-ai'
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import { stream as piCompletionsStream, streamSimple as piCompletionsStreamSimple } from '@earendil-works/pi-ai/api/openai-completions'
import { stream as piResponsesStream, streamSimple as piResponsesStreamSimple } from '@earendil-works/pi-ai/api/openai-responses'

// The cordis service name: the plugin's identity inside the harness. It
// matches the package name, so one string names the plugin everywhere.
export const name = 'dsh-opencode-zen-plugin'
export const inject = ['llm']

// The LLM provider id: a separate namespace, the one the model picker shows
// as `opencode-zen-free/<model>` (like `nvidia-nim/z-ai/glm-5.3-flash`).
// Changing it would strand saved sessions and settings that name a model
// under this provider, so it stays descriptive of the models it serves.
const PROVIDER = 'opencode-zen-free'
const DISPLAY_NAME = 'OpenCode Zen Free'

/**
 * Inference base URL. The free tier lives on the private inference service
 * behind OpenCode's Zen proxy; `/inference/v1` is the path the current CLI
 * catalog publishes (`/zen/v1` also worked on 2026-10-21 but is the legacy
 * proxy path, so it is not depended on here).
 */
/** Debug/testing override: route Zen traffic through a logging proxy. */
const ZEN_BASE_URL = process.env.DSH_ZEN_BASE_URL ?? 'https://opencode.ai/inference/v1'

/** Model catalog endpoint; answers anonymously. */
const ZEN_CATALOG_URL = `${ZEN_BASE_URL}/models`

/**
 * Context windows wider than what the free rows of models.dev declare. The
 * declared window is client-side metadata — it is what the harness trims
 * history against — so an under-declared window throttles a model that would
 * serve more. The GLM 5.3 Flash free id routes to `perplexity/glm-5.3-flash`,
 * which refuses prompts past ~640K tokens, so it declares 600K instead of the
 * paid row's 1M.
 */
const CONTEXT_WINDOW_OVERRIDES: Record<string, number> = {
  'mimo-v2.6-flash-free': 1_048_576,
  'deepseek-v4.1-flash-free': 1_048_576,
  'glm-5.3-flash-free': 614_400,
}

/**
 * The wire identity, pinned. The gate demands `opencode/<semver>` with a
 * semver above ~1.11 and refuses older ones with 426; this constant is a
 * known-good version, so the wire identity needs no network at any point of
 * the plugin's life. When OpenCode raises the bar, bump this string.
 */
const ZEN_USER_AGENT = 'opencode/1.19.3'

/** Envelope types that must stay AUTH-classified instead of being rewritten. */
const AUTH_ERROR_TYPES = new Set(['AuthError', 'authentication_error', 'invalid_api_key', 'unauthorized'])

/**
 * Request image budget: 2 MiB of base64 per request, 1 MiB per image. A third
 * occurrence makes the harness offload the oldest image to a text placeholder
 * that still names its local normalized copy. This wire is stateless, so every
 * retained image rides every turn again.
 */
const DEFAULT_MAX_REQUEST_IMAGE_BYTES = 2_097_152
const DEFAULT_REQUEST_IMAGE_MAX_BYTES = 1_048_576

/**
 * Deadline for the response headers of one model request. The OpenAI SDK
 * clears this timer the moment the headers arrive, so it bounds the wait for
 * the first byte and never the length of the stream. Without it a dropped
 * route leaves the request open until the harness's own idle watchdog fires
 * (minutes later), which reads as a frozen UI.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000

/** Maximum silence between two streamed chunks. */
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 120_000

/**
 * The plugin's own retry policy. The harness default retries five times, and
 * a transport error on the free tier usually means a broken route rather than
 * a blip, so five attempts turn one dead request into a quarter of an hour
 * of frozen UI. Two retries keep a genuine blip recoverable while bounding
 * the worst case to roughly three attempts.
 */
const DEFAULT_RETRY_POLICY: RetryPolicyConfig = {
  mode: 'normal',
  maxRetries: 2,
  backoff: { initialDelayMs: 1_000, maxDelayMs: 5_000, jitterRatio: 0.1 },
}

export interface Config {
  /** Base64 image payload one request accepts before older images are offloaded (default 2 MiB). */
  maxRequestImageBytes?: number
  /** Per-image request budget after re-encoding (default 1 MiB). */
  requestImageMaxBytes?: number
  /** Provider-owned model-request retry policy; omission uses normal defaults. */
  retryPolicy?: RetryPolicyConfig
  /**
   * Deadline for the response headers of one model request, in milliseconds.
   * The free tier is shared capacity and a dropped route can leave a request
   * open forever; this bounds how long a turn may sit without an answer
   * before the request fails and the harness can move on (or the user can
   * stop the turn). It bounds the wait for the FIRST byte only — the stream
   * itself is bounded by `streamIdleTimeoutMs`.
   */
  requestTimeoutMs?: number
  /**
   * Maximum silence between two streamed chunks, in milliseconds.
   */
  streamIdleTimeoutMs?: number
}

export const Config = z.object({
  maxRequestImageBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_REQUEST_IMAGE_BYTES).volatile(),
  requestImageMaxBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_REQUEST_IMAGE_MAX_BYTES).volatile(),
  retryPolicy: RetryPolicySchema.volatile(),
  requestTimeoutMs: z.number().step(1).min(1_000).max(30 * 60_000).default(DEFAULT_REQUEST_TIMEOUT_MS).volatile(),
  streamIdleTimeoutMs: z.number().step(1).min(1_000).max(30 * 60_000).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS).volatile(),
})

type LiveConfig = Schemastery.TypeT<typeof Config>

/**
 * The committed configuration as plain mutable values. Unwrapping the
 * references yields immutable snapshots; cloning makes them workable again.
 */
function liveConfig(config: LiveConfig): Config {
  return structuredClone({
    maxRequestImageBytes: config.maxRequestImageBytes.get(),
    requestImageMaxBytes: config.requestImageMaxBytes.get(),
    retryPolicy: config.retryPolicy.get() ?? DEFAULT_RETRY_POLICY,
    requestTimeoutMs: config.requestTimeoutMs.get(),
    streamIdleTimeoutMs: config.streamIdleTimeoutMs.get(),
  }) as Config
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

//#region OpenCode identity

/**
 * Identifier format of the opencode CLI (`packages/schema/src/identifier.ts`):
 * the 12 leading hex digits are the six most significant bytes of a 64-bit
 * value (`ms * 0x1000 + counter`, bit-inverted for `ses_` so the newest sorts
 * first), followed by 14 random base62 characters. The endpoint validates the
 * shape: ids of other lengths (even `ses_` + 24 or 30 chars) are refused with
 * the misleading FreeTierError.
 */
const ID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
let lastIdTimestamp = 0
let idCounter = 0

const opencodeId = (prefix: 'ses' | 'msg', descending: boolean): string => {
  const timestamp = Date.now()
  if (timestamp !== lastIdTimestamp) {
    lastIdTimestamp = timestamp
    idCounter = 0
  }
  idCounter += 1
  let value = BigInt(timestamp) * 0x1000n + BigInt(idCounter)
  if (descending) value = ~value
  // Byte by byte from the top, as upstream does: `ses_` inverts the value, and
  // a single arithmetic shift of a negative BigInt is floored, not truncated.
  let time = ''
  for (let index = 0; index < 6; index += 1) {
    time += Number((value >> BigInt(40 - 8 * index)) & 0xffn).toString(16).padStart(2, '0')
  }
  let random = ''
  for (let index = 0; index < 14; index += 1) {
    random += ID_ALPHABET[Math.floor(Math.random() * 62)]
  }
  return `${prefix}_${time}${random}`
}

/**
 * Session ids already minted for a conversation. Zen meters free usage per
 * session and routes its prompt cache by the id, so every turn of one
 * conversation has to reuse the id minted its first turn.
 */
const ZEN_SESSION_KEEP = 128
const zenSessions = new Map<string, string>()

const zenSessionId = (seed: string): string => {
  const hit = zenSessions.get(seed)
  if (hit !== undefined) return hit
  const minted = opencodeId('ses', true)
  if (zenSessions.size >= ZEN_SESSION_KEEP) {
    const oldest = zenSessions.keys().next()
    if (!oldest.done) zenSessions.delete(oldest.value)
  }
  zenSessions.set(seed, minted)
  return minted
}

const zenApiHeaders = (model: Pick<Model<ZenApi>, 'headers'>, options: SimpleStreamOptions) => {
  const sessionId = options.sessionId ?? 'dsh-session-unknown'
  // One id per conversation, reused by every turn: Zen meters free usage by
  // session and caches by it.
  const session = zenSessionId(sessionId)
  return {
    ...model.headers,
    // Deliberately absent: `HTTP-Referer`. The real CLI sends no referer, and
    // the gate refuses any request that carries one (same request flips
    // 200 -> 403 the moment it is added).
    // Inference routes reject a 40-hex project id; only the literal `global`
    // passes. On this path `x-opencode-project` is pure provenance.
    'x-opencode-project': 'global',
    // All four session headers carry the same value; the CLI dual-sends the
    // legacy and three newer names. Only `x-opencode-session` is strictly
    // required today, but sending the full set keeps the shape honest.
    'x-opencode-session': session,
    'x-opencode-session-id': session,
    'x-session-affinity': session,
    'X-Session-Id': session,
    // Deliberately absent: `x-opencode-request`. Its mere presence trips the
    // gate on the inference path (it is only valid on the `/zen/go/v1` route).
    'x-opencode-client': 'cli',
  }
}
//#endregion

//#region User-Agent transport patch

/**
 * The gate requires the OpenCode CLI user-agent, but the harness merges its
 * own mandatory attribution `user-agent` over model headers (dsh-llm's
 * `attributionHeaders`, merged after model.headers by pi-ai's client), so the
 * fetch layer is the only place that still wins. Scoped to opencode's own
 * routes — `/inference/v1` today, `/zen` for legacy paths — so every other
 * URL keeps the harness attribution untouched.
 */
const zenNativeFetch = globalThis.fetch
/** The wire identity the transport stamps onto every opencode.ai request. */
const zenUserAgent = ZEN_USER_AGENT

/** Minimum spacing between fire-and-forget catalog refreshes. */
const REFRESH_DEBOUNCE_MS = 60_000

const ZEN_URL_MARKERS = [
  'opencode.ai/inference',
  'opencode.ai/zen',
  // Debug override (DSH_ZEN_BASE_URL) may point at a local proxy.
  ...(() => { try { return [new URL(ZEN_BASE_URL).host] } catch { return [] } })(),
]

const zenFetch: typeof globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string'
    ? input
    : input instanceof URL ? input.href : input instanceof Request ? input.url : String(input)
  if (zenUserAgent === undefined || !ZEN_URL_MARKERS.some(marker => url.includes(marker))) {
    return zenNativeFetch(input, init)
  }
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
  headers.set('user-agent', zenUserAgent)
  // A request that is still open when the plugin is disposed must not hold
  // the shutdown open: the harness force-exits after its own grace period, and
  // a socket that lingers makes even that slower. The controller is composed
  // with the caller's signal, so a cancelled turn still aborts the request.
  const controller = new AbortController()
  const signal = init?.signal == null
    ? controller.signal
    : AbortSignal.any([init.signal, controller.signal])
  trackInFlight(controller)
  try {
    const response = await zenNativeFetch(input, { ...init, headers, signal })
    return response
  } catch (error) {
    releaseInFlight(controller)
    throw error
  }
}

/**
 * Controllers of the Zen requests currently open, with the time they started.
 * A request stays registered until it fails; a request that succeeded keeps
 * its controller until the stream ends, so the entry is pruned by age.
 */
const inFlightRequests = new Map<AbortController, number>()

/** Entries older than this are streams that ended without an error. */
const IN_FLIGHT_MAX_AGE_MS = 10 * 60_000

const trackInFlight = (controller: AbortController): void => {
  const now = Date.now()
  for (const [tracked, started] of inFlightRequests) {
    if (now - started > IN_FLIGHT_MAX_AGE_MS) inFlightRequests.delete(tracked)
  }
  inFlightRequests.set(controller, now)
}

const releaseInFlight = (controller: AbortController): void => {
  inFlightRequests.delete(controller)
}

/**
 * Abort every open Zen request. Called when the plugin is disposed, so a
 * request the upstream never answers cannot keep the harness waiting past
 * its shutdown grace period.
 */
const abortInFlightRequests = (): void => {
  for (const controller of inFlightRequests.keys()) {
    try {
      controller.abort(new Error(`${name}: disposed while a request was in flight`))
    } catch {
      // Best effort: an already-aborted controller throws nothing.
    }
  }
  inFlightRequests.clear()
}
//#endregion

//#region Tool gate padding

/**
 * Model-visible description of a tool this harness cannot execute. Each
 * placeholder mirrors the parameter shape the real opencode tool declares, so
 * a model that calls one produces an argument the harness can still see and
 * report; the harness never runs it.
 */
const ZEN_TOOL_TEXT = 'Requirement placeholder from OpenCode Zen: this harness cannot execute it.'

const zenTool = (name: string, property: string): Tool => ({
  name,
  description: ZEN_TOOL_TEXT,
  parameters: {
    type: 'object',
    properties: { [property]: { type: 'string', description: ZEN_TOOL_TEXT } },
    required: [property],
  },
})

/**
 * The free tier gates on the request's tool list: a tool named `read` must be
 * present, carrying a real parameter schema (verified 2026-10-21: `read` alone
 * passes; `bash` alone or no tools at all are refused). Requests that declare
 * fewer tools — compaction, session titles, summaries, or any turn whose
 * permissions cut the list down — are refused with the misleading "free tier
 * can only be used from within OpenCode". `bash` is padded alongside `read`
 * because the gate has required both in the past; a request that already
 * qualifies is untouched, so the provider's prompt cache is not invalidated.
 */
const ZEN_REQUIRED_TOOLS: readonly (readonly [string, string])[] = [
  ['bash', 'command'],
  ['read', 'file_path'],
]

export const requiredZenTools = (tools: readonly Tool[] = []): Tool[] => {
  const filled = [...tools]
  const present = new Set(filled.map(tool => tool.name))
  for (const [name, property] of ZEN_REQUIRED_TOOLS) {
    if (!present.has(name)) filled.push(zenTool(name, property))
  }
  return filled
}
//#endregion

//#region Request context normalization

// Replayed thinking blocks carry no wire signature; marking them
// `reasoning_content` keeps the transport from mangling history. Never gated
// on `model.reasoning`: a model with no effort control still streams thinking.
//
// On pi-ai 1.x the tool declarations sit in the transcript's leading system
// message (`toolsAdded`), so padding the list means rewriting that message
// (falling back to `context.tools`, which a context built before
// normalization still carries).
const normalizeReasoningContext = (context: TranscriptContext & { tools?: readonly Tool[] }): TranscriptContext => {
  const hasLeadingSystem = context.messages[0]?.role === 'system'
  const baseMessages = hasLeadingSystem
    ? context.messages.map((message, index) => {
        if (index === 0 && message.role === 'system') {
          return { ...message, toolsAdded: requiredZenTools(message.toolsAdded ?? context.tools ?? []) }
        }
        return message
      })
    : [
        {
          role: 'system' as const,
          content: '',
          toolsAdded: requiredZenTools(context.tools ?? []),
          timestamp: Date.now(),
        },
        ...context.messages,
      ]

  return {
    ...context,
    messages: baseMessages.map((message) => {
      if (message.role !== 'assistant') return message
      return {
        ...message,
        content: message.content.map(block =>
          block.type === 'thinking' && block.thinking.trim().length > 0 && block.thinkingSignature === undefined
            ? { ...block, thinkingSignature: 'reasoning_content' }
            : block),
      }
    }),
  }
}
//#endregion

//#region Refusal rewriting

// Non-credential refusals (ended free promotions, region blocks, exhausted
// anonymous quota) arrive as HTTP 401/403, which the harness classifies as
// AUTH and masks as "API key is invalid". Rewriting the envelope to
// `[opencode-zen <type>] <message>` gets the real reason past that
// classification; genuine auth envelopes and unparseable text pass through.
const rewriteRefusalMessage = (errorMessage: string): string => {
  const start = errorMessage.indexOf('{')
  const end = errorMessage.lastIndexOf('}')
  if (start < 0 || end <= start) return errorMessage
  let parsed: unknown
  try { parsed = JSON.parse(errorMessage.slice(start, end + 1)) } catch { return errorMessage }
  if (!isRecord(parsed)) return errorMessage
  // Accept both the raw envelope (`{"type":"error","error":{…}}`) and the
  // SDK-unwrapped inner object (`{"type":"ModelError","message":"…"}`).
  const detail = parsed.type === 'error' && isRecord(parsed.error) ? parsed.error : parsed
  const message = [detail.message, isRecord(detail.error) ? detail.error.message : undefined, detail.detail]
    .find((value): value is string => typeof value === 'string')
  if (message === undefined) return errorMessage
  const type = typeof detail.type === 'string' ? detail.type : 'Error'
  const code = typeof detail.code === 'string' ? detail.code : ''
  if (AUTH_ERROR_TYPES.has(type) || AUTH_ERROR_TYPES.has(code)) return errorMessage
  // Dropping the status prefix is what defeats the AUTH classifier.
  return `[opencode-zen ${type}] ${message}`
}

const sanitizeStream = <S extends { push(event: unknown): void }>(stream: S): S => {
  const originalPush = stream.push.bind(stream)
  stream.push = (event: unknown) => {
    if (isRecord(event) && event.type === 'error' && isRecord(event.error) && typeof event.error.errorMessage === 'string') {
      event.error.errorMessage = rewriteRefusalMessage(event.error.errorMessage)
    }
    originalPush(event)
  }
  return stream
}
//#endregion

//#region Transports

type ZenApi = 'openai-completions' | 'openai-responses'

const zenStreamFor = (api: ZenApi): ProviderStreams => api === 'openai-responses'
  ? {
      stream: (model: Model<'openai-responses'>, context: TranscriptContext, options: SimpleStreamOptions) =>
        sanitizeStream(piResponsesStream({ ...model, headers: zenApiHeaders(model, options) }, normalizeReasoningContext(context), { ...options, fetch: zenFetch })),
      streamSimple: (model: Model<'openai-responses'>, context: TranscriptContext, options: SimpleStreamOptions) =>
        sanitizeStream(piResponsesStreamSimple({ ...model, headers: zenApiHeaders(model, options) }, normalizeReasoningContext(context), { ...options, fetch: zenFetch })),
    } as unknown as ProviderStreams
  : {
      stream: (model: Model<'openai-completions'>, context: TranscriptContext, options: SimpleStreamOptions) =>
        sanitizeStream(piCompletionsStream({ ...model, headers: zenApiHeaders(model, options) }, normalizeReasoningContext(context), { ...options, fetch: zenFetch })),
      streamSimple: (model: Model<'openai-completions'>, context: TranscriptContext, options: SimpleStreamOptions) =>
        sanitizeStream(piCompletionsStreamSimple({ ...model, headers: zenApiHeaders(model, options) }, normalizeReasoningContext(context), { ...options, fetch: zenFetch })),
    }

const zenApi: Partial<Record<ZenApi, ProviderStreams>> = {
  'openai-completions': zenStreamFor('openai-completions'),
  'openai-responses': zenStreamFor('openai-responses'),
}
//#endregion

//#region Catalog

const CATALOG_ATTEMPTS = 3
const CATALOG_TIMEOUT_MS = 20_000
const CATALOG_TOTAL_BUDGET_MS = 45_000

const sleep = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms) })

async function fetchJson(url: string, headers: Record<string, string>): Promise<Record<string, unknown>> {
  const deadline = Date.now() + CATALOG_TOTAL_BUDGET_MS
  let lastError: unknown
  for (let attempt = 1; attempt <= CATALOG_ATTEMPTS; attempt += 1) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    try {
      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(Math.min(CATALOG_TIMEOUT_MS, remaining)),
      })
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
      const payload: unknown = await response.json()
      if (!isRecord(payload)) throw new Error(`${url}: unexpected response shape`)
      return payload
    } catch (error) {
      lastError = error
      if (attempt < CATALOG_ATTEMPTS) await sleep(250 * attempt)
    }
  }
  throw lastError
}

/** pi-ai's standard ladder keys (off = explicit close; the rest are depths). */
const PI_LEVEL_KEYS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

// Only an `effort`-type option's values shape the selector. A `toggle`, an
// empty list or a missing entry declares no level — an honest "takes no
// effort".
function reasoningLevelsFor(metadata: Record<string, unknown>): string[] {
  const option = (Array.isArray(metadata.reasoning_options) ? metadata.reasoning_options : [])
    .find(value => isRecord(value) && value.type === 'effort')
  return isRecord(option) && Array.isArray(option.values)
    ? option.values.filter((value): value is string => typeof value === 'string')
    : []
}

// `Default` (the harness's "no selection" path) is the *absent key* — leaving
// `reasoning_effort` off the wire and letting the upstream choose. Each ladder
// level the endpoint accepts lands at its own key with its own wire value; the
// `off` key carries the upstream's literal close value only when the feed
// names one (e.g. `none`), so the selector's "Off" entry is a real switch
// rather than a no-op. A feed that names no close value gets `null`: nothing
// goes on the wire and the "Off" entry drops out of the selector.
//
// Never fabricate a close value: chat-completions backends reject invented
// effort variants and fail the whole turn.
function reasoningMapFor(levels: readonly string[], api: ZenApi): ThinkingLevelMap {
  const map: ThinkingLevelMap = {}
  for (const key of PI_LEVEL_KEYS) {
    if (levels.includes(key)) map[key] = key
  }
  map.off = api === 'openai-completions' && levels.includes('none') ? 'none' : null
  return map
}

const isFreeCost = (metadata: Record<string, unknown>): boolean => {
  if (!isRecord(metadata.cost)) return false
  const input = metadata.cost.input
  const output = metadata.cost.output
  return input === 0 && output === 0
}

// Turn the live-scanned feeds into pi-ai model descriptors.
function buildModels(
  zenData: readonly unknown[],
  modelsById: Record<string, unknown>,
  userAgent: string,
): Model<ZenApi>[] {
  const baseModels = getBuiltinModels('opencode')
  return zenData
    .filter((entry): entry is Record<string, unknown> =>
      isRecord(entry) && typeof entry.id === 'string')
    .flatMap((entry): Model<ZenApi>[] => {
      const id = entry.id as string
      const metadata = modelsById[id]
      if (!isRecord(metadata)) return []
      // Anonymous requests authenticate as `public`; paid models would 401,
      // so only zero-cost rows are offered. The `-free` suffix alone is not
      // the full set (`big-pickle`, `grok-code`, …).
      if (!id.endsWith('-free') && !isFreeCost(metadata)) return []
      if (typeof metadata.status === 'string' && metadata.status === 'deprecated') return []
      // Zen serves muse-spark contributor-free models on the Responses
      // endpoint; chat/completions 500s for them.
      const api: ZenApi = id.includes('muse-spark') ? 'openai-responses' : 'openai-completions'
      const baseCompat = baseModels.find(base => base.id === id)?.compat
      // Models not yet in the pi-ai built-in catalogue still need the Zen
      // `maxTokensField` ("max_tokens") or the proxy rejects the request with
      // a 500 when "max_completion_tokens" arrives. `supportsStrictMode` is
      // what makes pi-ai send `strict: false` on a Responses tool; without it
      // the Responses API normalizes the schema into strict mode, where every
      // declared property counts as required. Chat-completions models need
      // nothing: pi-ai omits `strict` there by default.
      const strictCompat = api === 'openai-responses' ? { supportsStrictMode: true as const } : {}
      const compat = baseCompat === undefined
        ? { maxTokensField: 'max_tokens' as const, supportsReasoningEffort: false as const, ...strictCompat }
        : { ...baseCompat, requiresReasoningContentOnAssistantMessages: false, ...strictCompat }

      // No ladder upstream ⇒ no selector: `reasoning: false` means "no effort
      // control", never "no thinking".
      const levels = reasoningLevelsFor(metadata)
      const controllable = levels.length > 0

      const limit = isRecord(metadata.limit) ? metadata.limit : undefined
      const input = isRecord(metadata.modalities) && Array.isArray(metadata.modalities.input)
        ? metadata.modalities.input.filter((value): value is 'text' | 'image' => value === 'text' || value === 'image')
        : []
      return [{
        id,
        name: typeof metadata.name === 'string' ? metadata.name : id,
        api,
        provider: PROVIDER,
        baseUrl: ZEN_BASE_URL,
        headers: { 'User-Agent': userAgent },
        reasoning: controllable,
        ...(controllable ? { thinkingLevelMap: reasoningMapFor(levels, api) } : {}),
        input: input.length > 0 ? input : ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        // The feed declares the 200K tier for several free ids while the
        // backend serves more, and the cap is client-side metadata: the
        // declared value is what the harness trims against.
        contextWindow: CONTEXT_WINDOW_OVERRIDES[id] ?? (typeof limit?.context === 'number' ? limit.context : 1_048_576),
        maxTokens: typeof limit?.output === 'number' ? limit.output : 32_768,
        ...(compat ? { compat } : {}),
      }]
    })
}
//#endregion

//#region Catalog cache

/**
 * Last-good catalog on disk, so a stalled feed degrades to a slightly stale
 * model list instead of an empty one (which would fail the first turn with
 * UNKNOWN_MODEL). Best-effort in both directions.
 */
const CACHE_DIR = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'cache')
const CACHE_PATH = join(CACHE_DIR, `${name}-catalog.json`)

/** Last-good live catalog on disk, so a cold cache never blanks the picker. */
interface CatalogCache {
  models: Model<ZenApi>[]
  checkedAt: number
}

function readCatalogCache(): CatalogCache | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(CACHE_PATH, 'utf8'))
    if (!isRecord(parsed)) return undefined
    // Current format: the built model list, straight from the last publish.
    if (Array.isArray(parsed.models)) {
      const models = parsed.models.filter((model): model is Model<ZenApi> =>
        isRecord(model) && (model as Record<string, unknown>).provider === PROVIDER &&
        typeof (model as Record<string, unknown>).id === 'string')
      if (models.length > 0) {
        return { models, checkedAt: typeof parsed.checkedAt === 'number' ? parsed.checkedAt : 0 }
      }
    }
    // First format: the raw zen + models.dev feeds. Rebuild the list from
    // them (pure, no network) so an install that upgrades mid-flight keeps
    // serving exactly the models it had before.
    if (Array.isArray(parsed.zen) && isRecord(parsed.models)) {
      const rebuilt = buildModels(parsed.zen, parsed.models, ZEN_USER_AGENT)
      if (rebuilt.length > 0) return { models: rebuilt, checkedAt: 0 }
    }
    return undefined
  } catch {
    return undefined
  }
}

async function writeCatalogCache(cache: CatalogCache): Promise<void> {
  try {
    await mkdir(CACHE_DIR, { recursive: true })
    // Write-then-rename so a torn write cannot leave a half-parsed cache behind.
    const temporary = `${CACHE_PATH}.${process.pid}.tmp`
    await writeFile(temporary, JSON.stringify(cache))
    await rename(temporary, CACHE_PATH)
  } catch {
    // A cache miss is always recoverable; never fail the scan over it.
  }
}

// Required by the adapter, unused by this route: the credential comes from
// `resolveApiKey`, so pi-ai never stores one nor asks an ambient question.
const PI_AUTH: { credentials: CredentialStore, authContext: AuthContext } = {
  credentials: {
    read: async () => undefined,
    list: async () => [],
    modify: async (_providerId, mutate) => mutate(undefined),
    delete: async () => {},
  },
  authContext: { env: async () => undefined, fileExists: async () => false },
}

export function apply(ctx: Context, config: LiveConfig): void {
  // The mount path is strictly synchronous and touches no network. The
  // harness starts listening (and accepts sessions, model resolutions, and
  // shutdown) without waiting on any fetch this plugin could make; the live
  // catalog arrives in the background. Before that first refresh lands, the
  // picker serves pi-ai's builtin zero-cost OpenCode models, or the last-good
  // list on disk when one exists.

  // The Loader owns the settings namespace, so the configuration form is
  // addressed by the profile entry id that mounted this plugin.
  const settingsNs = ctx.fiber.entry?.options.id ?? name

  // Offline floor: pi-ai ships the OpenCode catalog; its zero-cost entries
  // are what the picker offers before any refresh, always.
  const floor = builtinFloor()

  // Last-good live list from a previous run, if one was written.
  const cached = readCatalogCache()

  const provider = createProvider<ZenApi>({
    id: PROVIDER,
    name: 'OpenCodeZenFree',
    baseUrl: ZEN_BASE_URL,
    auth: { apiKey: { name: 'OpenCodeZenFree', resolve: ({ credential }) => Promise.resolve({
      auth: credential?.key === undefined ? {} : { apiKey: credential.key },
      source: 'OpenCodeZenFree',
    }) } },
    models: floor,
    api: zenApi,
    // The live overlay: the Zen feed (which model ids exist) crossed with
    // models.dev (which of those are free). Bounded; on failure the previous
    // list stands and the floor keeps the picker alive.
    fetchModels: async () => {
      const [zen, modelsDev] = await Promise.all([
        fetchJson(ZEN_CATALOG_URL, { 'User-Agent': ZEN_USER_AGENT, accept: 'application/json' }),
        fetchJson('https://models.dev/api.json', { accept: 'application/json' }),
      ])
      if (!Array.isArray(zen.data)) throw new Error('zen models: unexpected response shape')
      if (!isRecord(modelsDev.opencode) || !isRecord(modelsDev.opencode.models)) {
        throw new Error('models.dev: no "opencode" provider')
      }
      const next = buildModels(zen.data, modelsDev.opencode.models, ZEN_USER_AGENT)
      if (next.length === 0) throw new Error('no OpenCode Zen free models resolved')
      return next
    },
  })

  // Fire-and-forget refreshes, debounced: the first one runs right after the
  // mount returns, every read of the model list is another opportunity, and a
  // long-lived instance gets a slow daily round. `refreshModels` restores the
  // disk cache before the network attempt, so a warm start serves the last
  // good list within a tick of mount.
  let lastRefresh = 0
  let refreshing = false
  let loggedSync = false
  const refresh = (force = false): void => {
    if (refreshing) return
    if (!force && Date.now() - lastRefresh < REFRESH_DEBOUNCE_MS) return
    refreshing = true
    type RefreshCall = Parameters<NonNullable<typeof provider.refreshModels>>[0]
    const call: RefreshCall = {
      stored: cached === undefined ? undefined : { models: cached.models, checkedAt: cached.checkedAt },
      publish: async ({ update, persist }) => {
        update?.()
        lastRefresh = Date.now()
        if (persist) {
          const models = persist.models.filter((model): model is Model<ZenApi> =>
            isRecord(model) && (model as Record<string, unknown>).provider === PROVIDER &&
            typeof (model as Record<string, unknown>).id === 'string')
          if (models.length > 0) void writeCatalogCache({ models, checkedAt: persist.checkedAt ?? Date.now() })
        }
        return true
      },
      allowNetwork: true,
      signal: new AbortController().signal,
    }
    provider.refreshModels?.(call)
      .then(() => {
        refreshing = false
        if (!loggedSync) {
          loggedSync = true
          ctx.logger.info('[%s] catalog: %d free model(s) live', name, provider.getModels().length)
        }
      })
      .catch((error: unknown) => {
        refreshing = false
        ctx.logger.warn('[%s] catalog refresh failed: %s', name, errorChain(error))
      })
  }

  // Every read of the model list is also a refresh opportunity: the picker, a
  // session's model resolution, and the settings page all read here.
  const liveProvider = {
    ...provider,
    getModels: () => {
      refresh()
      return provider.getModels()
    },
  }

  const buildProfiles = (): ReadonlyMap<string, ResolvedPiAiProviderProfile> => {
    const opts = liveConfig(config)
    return new Map<string, ResolvedPiAiProviderProfile>([[PROVIDER, {
      provider: PROVIDER,
      displayName: DISPLAY_NAME,
      apiKeyEnv: credentialRef('OPENCODE_ZEN_FREE_API_KEY'),
      // Bounds the wait for the response headers. The SDK clears this timer
      // as soon as the headers arrive, so a long stream is never cut short,
      // while a route that silently drops the request fails in bounded time
      // instead of freezing the turn.
      timeoutMs: opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      streamIdleTimeoutMs: opts.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      maxRequestImageBytes: opts.maxRequestImageBytes ?? DEFAULT_MAX_REQUEST_IMAGE_BYTES,
      requestImagePixelBudget: 4_194_304,
      requestImageMaxBytes: opts.requestImageMaxBytes ?? DEFAULT_REQUEST_IMAGE_MAX_BYTES,
      retryPolicy: resolveRetryPolicy(opts.retryPolicy, `${name}: retryPolicy`),
      piProvider: liveProvider as unknown as ResolvedPiAiProviderProfile['piProvider'],
      modelErrors: new Map(),
      configuredMaxTokens: new Map(),
    }]])
  }

  // PiAiAdapter memoizes its snapshot on this Map's identity: the map is
  // rebuilt only when the settings change, never per read, so the live model
  // list flows through the provider's own getModels instead.
  let profiles = buildProfiles()

  const adapter = new PiAiAdapter({
    resolveAttachments: () => ctx.get('attachments'),
    profiles: () => profiles,
    auth: PI_AUTH,
    resolveApiKey: async (_provider, profile) => {
      const credentials = ctx.get('credentials')
      if (credentials !== undefined) {
        const hit = await credentials.resolve(profile.apiKeyEnv!)
        if (hit !== undefined) return assertUsableApiKey(hit.value, name, String(profile.apiKeyEnv))
      }
      // OpenCode Zen serves the free tier to the anonymous `public` identity.
      return 'public'
    },
  })

  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: DISPLAY_NAME, settingsNs, settingsPath: [] },
  ])
  ctx.llm.registerAdapter([PROVIDER], adapter)

  // Every field is volatile, so the Loader commits a settings write into this
  // fiber and announces it here instead of remounting; re-derive the profile
  // wrapper only (the provider, and its live list, are untouched).
  ctx.on('loader/volatile-update', () => {
    profiles = buildProfiles()
  })

  // A request the upstream never answers must not hold the shutdown open:
  // on dispose, every Zen request still in flight is aborted so the harness
  // can exit inside its own grace period instead of being force-killed.
  ctx.effect(
    () => () => {
      abortInFlightRequests()
    },
    `${name}: abort in-flight requests`,
  )

  setImmediate(() => refresh(true))
  const dailyRefresh = setInterval(() => refresh(true), 6 * 60 * 60_000)
  dailyRefresh.unref?.()
}

//#region Offline floor

/**
 * The plugin's offline floor: the zero-cost entries of pi-ai's builtin
 * OpenCode catalog. Available the instant apply() returns, with no network
 * and no disk, so the picker and the first model resolution work even while
 * the live catalog is unreachable. The live refresh overlays (and shadows)
 * these by id once it lands.
 */
function builtinFloor(): Model<ZenApi>[] {
  return getBuiltinModels('opencode')
    .filter(model =>
      (model.api === 'openai-completions' || model.api === 'openai-responses') &&
      Object.values(model.cost ?? {}).every(cost => cost === 0))
    .map(model => ({
      ...model,
      provider: PROVIDER,
      baseUrl: ZEN_BASE_URL,
    })) as Model<ZenApi>[]
}
//#endregion
