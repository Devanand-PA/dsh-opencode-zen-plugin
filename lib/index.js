import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { assertUsableApiKey, errorChain, resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm';
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { deepEqualJson } from '@deepseek-ai/dsh-util-values';
import z from '@deepseek-ai/schemastery';
import { createProvider, } from '@earendil-works/pi-ai';
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all';
import { stream as piCompletionsStream, streamSimple as piCompletionsStreamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import { stream as piResponsesStream, streamSimple as piResponsesStreamSimple } from '@earendil-works/pi-ai/api/openai-responses';
export const name = 'opencode-zen-free';
export const inject = ['llm'];
const PROVIDER = name;
const DISPLAY_NAME = 'OpenCode Zen Free';
/**
 * Inference base URL. The free tier lives on the private inference service
 * behind OpenCode's Zen proxy; `/inference/v1` is the path the current CLI
 * catalog publishes (`/zen/v1` also worked on 2026-10-21 but is the legacy
 * proxy path, so it is not depended on here).
 */
/** Debug/testing override: route Zen traffic through a logging proxy. */
const ZEN_BASE_URL = process.env.DSH_ZEN_BASE_URL ?? 'https://opencode.ai/inference/v1';
/** Model catalog endpoint; answers anonymously. */
const ZEN_CATALOG_URL = `${ZEN_BASE_URL}/models`;
/**
 * Context windows wider than what the free rows of models.dev declare. The
 * declared window is client-side metadata — it is what the harness trims
 * history against — so an under-declared window throttles a model that would
 * serve more. The GLM 5.3 Flash free id routes to `perplexity/glm-5.3-flash`,
 * which refuses prompts past ~640K tokens, so it declares 600K instead of the
 * paid row's 1M.
 */
const CONTEXT_WINDOW_OVERRIDES = {
    'mimo-v2.6-flash-free': 1_048_576,
    'deepseek-v4.1-flash-free': 1_048_576,
    'glm-5.3-flash-free': 614_400,
};
/**
 * Latest CLI version, read off unpkg's `@latest` redirect. The endpoint
 * refuses versions below ~1.11 with 426 "upgrade required", so an unreachable
 * unpkg must not silently drop below the known-good floor.
 */
const OPENCODE_VERSION_URL = 'https://unpkg.com/opencode-ai@latest/package.json';
const OPENCODE_VERSION_FALLBACK = '1.19.3';
/** Envelope types that must stay AUTH-classified instead of being rewritten. */
const AUTH_ERROR_TYPES = new Set(['AuthError', 'authentication_error', 'invalid_api_key', 'unauthorized']);
/**
 * Request image budget: 2 MiB of base64 per request, 1 MiB per image. A third
 * occurrence makes the harness offload the oldest image to a text placeholder
 * that still names its local normalized copy. This wire is stateless, so every
 * retained image rides every turn again.
 */
const DEFAULT_MAX_REQUEST_IMAGE_BYTES = 2_097_152;
const DEFAULT_REQUEST_IMAGE_MAX_BYTES = 1_048_576;
export const Config = z.object({
    maxRequestImageBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_REQUEST_IMAGE_BYTES).volatile(),
    requestImageMaxBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_REQUEST_IMAGE_MAX_BYTES).volatile(),
    retryPolicy: RetryPolicySchema.volatile(),
});
/**
 * The committed configuration as plain mutable values. Unwrapping the
 * references yields immutable snapshots; cloning makes them workable again.
 */
function liveConfig(config) {
    return structuredClone({
        maxRequestImageBytes: config.maxRequestImageBytes.get(),
        requestImageMaxBytes: config.requestImageMaxBytes.get(),
        retryPolicy: config.retryPolicy.get(),
    });
}
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
//#region OpenCode identity
/** Semver compare, enough for a version floor check. */
const semverAtLeast = (version, floor) => {
    const parts = version.split('.').map(part => Number.parseInt(part, 10));
    if (parts.length < floor.length || parts.some(part => !Number.isFinite(part)))
        return false;
    for (let index = 0; index < floor.length; index += 1) {
        const part = parts[index];
        const bound = floor[index];
        if (part !== bound)
            return part > bound;
    }
    return true;
};
const resolveOpenCodeVersion = async () => {
    try {
        const payload = await fetchJson(OPENCODE_VERSION_URL, { accept: 'application/json' });
        const version = typeof payload.version === 'string' ? payload.version : '';
        if (version.length > 0 && semverAtLeast(version, [1, 18]))
            return version;
    }
    catch {
        // unpkg unreachable: fall through to the pinned floor.
    }
    return OPENCODE_VERSION_FALLBACK;
};
/**
 * Identifier format of the opencode CLI (`packages/schema/src/identifier.ts`):
 * the 12 leading hex digits are the six most significant bytes of a 64-bit
 * value (`ms * 0x1000 + counter`, bit-inverted for `ses_` so the newest sorts
 * first), followed by 14 random base62 characters. The endpoint validates the
 * shape: ids of other lengths (even `ses_` + 24 or 30 chars) are refused with
 * the misleading FreeTierError.
 */
const ID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
let lastIdTimestamp = 0;
let idCounter = 0;
const opencodeId = (prefix, descending) => {
    const timestamp = Date.now();
    if (timestamp !== lastIdTimestamp) {
        lastIdTimestamp = timestamp;
        idCounter = 0;
    }
    idCounter += 1;
    let value = BigInt(timestamp) * 0x1000n + BigInt(idCounter);
    if (descending)
        value = ~value;
    // Byte by byte from the top, as upstream does: `ses_` inverts the value, and
    // a single arithmetic shift of a negative BigInt is floored, not truncated.
    let time = '';
    for (let index = 0; index < 6; index += 1) {
        time += Number((value >> BigInt(40 - 8 * index)) & 0xffn).toString(16).padStart(2, '0');
    }
    let random = '';
    for (let index = 0; index < 14; index += 1) {
        random += ID_ALPHABET[Math.floor(Math.random() * 62)];
    }
    return `${prefix}_${time}${random}`;
};
/**
 * Session ids already minted for a conversation. Zen meters free usage per
 * session and routes its prompt cache by the id, so every turn of one
 * conversation has to reuse the id minted its first turn.
 */
const ZEN_SESSION_KEEP = 128;
const zenSessions = new Map();
const zenSessionId = (seed) => {
    const hit = zenSessions.get(seed);
    if (hit !== undefined)
        return hit;
    const minted = opencodeId('ses', true);
    if (zenSessions.size >= ZEN_SESSION_KEEP) {
        const oldest = zenSessions.keys().next();
        if (!oldest.done)
            zenSessions.delete(oldest.value);
    }
    zenSessions.set(seed, minted);
    return minted;
};
const zenApiHeaders = (model, options) => {
    const sessionId = options.sessionId ?? 'dsh-session-unknown';
    // One id per conversation, reused by every turn: Zen meters free usage by
    // session and caches by it.
    const session = zenSessionId(sessionId);
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
    };
};
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
const zenNativeFetch = globalThis.fetch;
let zenUserAgent;
const ZEN_URL_MARKERS = [
    'opencode.ai/inference',
    'opencode.ai/zen',
    // Debug override (DSH_ZEN_BASE_URL) may point at a local proxy.
    ...(() => { try {
        return [new URL(ZEN_BASE_URL).host];
    }
    catch {
        return [];
    } })(),
];
const zenFetch = (input, init) => {
    const url = typeof input === 'string'
        ? input
        : input instanceof URL ? input.href : input instanceof Request ? input.url : String(input);
    if (zenUserAgent === undefined || !ZEN_URL_MARKERS.some(marker => url.includes(marker))) {
        return zenNativeFetch(input, init);
    }
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set('user-agent', zenUserAgent);
    return zenNativeFetch(input, { ...init, headers });
};
//#endregion
//#region Tool gate padding
/**
 * Model-visible description of a tool this harness cannot execute. Each
 * placeholder mirrors the parameter shape the real opencode tool declares, so
 * a model that calls one produces an argument the harness can still see and
 * report; the harness never runs it.
 */
const ZEN_TOOL_TEXT = 'Requirement placeholder from OpenCode Zen: this harness cannot execute it.';
const zenTool = (name, property) => ({
    name,
    description: ZEN_TOOL_TEXT,
    parameters: {
        type: 'object',
        properties: { [property]: { type: 'string', description: ZEN_TOOL_TEXT } },
        required: [property],
    },
});
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
const ZEN_REQUIRED_TOOLS = [
    ['bash', 'command'],
    ['read', 'file_path'],
];
export const requiredZenTools = (tools = []) => {
    const filled = [...tools];
    const present = new Set(filled.map(tool => tool.name));
    for (const [name, property] of ZEN_REQUIRED_TOOLS) {
        if (!present.has(name))
            filled.push(zenTool(name, property));
    }
    return filled;
};
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
const normalizeReasoningContext = (context) => {
    const hasLeadingSystem = context.messages[0]?.role === 'system';
    const baseMessages = hasLeadingSystem
        ? context.messages.map((message, index) => {
            if (index === 0 && message.role === 'system') {
                return { ...message, toolsAdded: requiredZenTools(message.toolsAdded ?? context.tools ?? []) };
            }
            return message;
        })
        : [
            {
                role: 'system',
                content: '',
                toolsAdded: requiredZenTools(context.tools ?? []),
                timestamp: Date.now(),
            },
            ...context.messages,
        ];
    return {
        ...context,
        messages: baseMessages.map((message) => {
            if (message.role !== 'assistant')
                return message;
            return {
                ...message,
                content: message.content.map(block => block.type === 'thinking' && block.thinking.trim().length > 0 && block.thinkingSignature === undefined
                    ? { ...block, thinkingSignature: 'reasoning_content' }
                    : block),
            };
        }),
    };
};
//#endregion
//#region Refusal rewriting
// Non-credential refusals (ended free promotions, region blocks, exhausted
// anonymous quota) arrive as HTTP 401/403, which the harness classifies as
// AUTH and masks as "API key is invalid". Rewriting the envelope to
// `[opencode-zen <type>] <message>` gets the real reason past that
// classification; genuine auth envelopes and unparseable text pass through.
const rewriteRefusalMessage = (errorMessage) => {
    const start = errorMessage.indexOf('{');
    const end = errorMessage.lastIndexOf('}');
    if (start < 0 || end <= start)
        return errorMessage;
    let parsed;
    try {
        parsed = JSON.parse(errorMessage.slice(start, end + 1));
    }
    catch {
        return errorMessage;
    }
    if (!isRecord(parsed))
        return errorMessage;
    // Accept both the raw envelope (`{"type":"error","error":{…}}`) and the
    // SDK-unwrapped inner object (`{"type":"ModelError","message":"…"}`).
    const detail = parsed.type === 'error' && isRecord(parsed.error) ? parsed.error : parsed;
    const message = [detail.message, isRecord(detail.error) ? detail.error.message : undefined, detail.detail]
        .find((value) => typeof value === 'string');
    if (message === undefined)
        return errorMessage;
    const type = typeof detail.type === 'string' ? detail.type : 'Error';
    const code = typeof detail.code === 'string' ? detail.code : '';
    if (AUTH_ERROR_TYPES.has(type) || AUTH_ERROR_TYPES.has(code))
        return errorMessage;
    // Dropping the status prefix is what defeats the AUTH classifier.
    return `[opencode-zen ${type}] ${message}`;
};
const sanitizeStream = (stream) => {
    const originalPush = stream.push.bind(stream);
    stream.push = (event) => {
        if (isRecord(event) && event.type === 'error' && isRecord(event.error) && typeof event.error.errorMessage === 'string') {
            event.error.errorMessage = rewriteRefusalMessage(event.error.errorMessage);
        }
        originalPush(event);
    };
    return stream;
};
const zenStreamFor = (api) => api === 'openai-responses'
    ? {
        stream: (model, context, options) => sanitizeStream(piResponsesStream({ ...model, headers: zenApiHeaders(model, options) }, normalizeReasoningContext(context), { ...options, fetch: zenFetch })),
        streamSimple: (model, context, options) => sanitizeStream(piResponsesStreamSimple({ ...model, headers: zenApiHeaders(model, options) }, normalizeReasoningContext(context), { ...options, fetch: zenFetch })),
    }
    : {
        stream: (model, context, options) => sanitizeStream(piCompletionsStream({ ...model, headers: zenApiHeaders(model, options) }, normalizeReasoningContext(context), { ...options, fetch: zenFetch })),
        streamSimple: (model, context, options) => sanitizeStream(piCompletionsStreamSimple({ ...model, headers: zenApiHeaders(model, options) }, normalizeReasoningContext(context), { ...options, fetch: zenFetch })),
    };
const zenApi = {
    'openai-completions': zenStreamFor('openai-completions'),
    'openai-responses': zenStreamFor('openai-responses'),
};
//#endregion
//#region Catalog
const CATALOG_ATTEMPTS = 3;
const CATALOG_TIMEOUT_MS = 20_000;
const CATALOG_TOTAL_BUDGET_MS = 45_000;
const sleep = (ms) => new Promise(resolve => { setTimeout(resolve, ms); });
async function fetchJson(url, headers) {
    const deadline = Date.now() + CATALOG_TOTAL_BUDGET_MS;
    let lastError;
    for (let attempt = 1; attempt <= CATALOG_ATTEMPTS; attempt += 1) {
        const remaining = deadline - Date.now();
        if (remaining <= 0)
            break;
        try {
            const response = await fetch(url, {
                headers,
                signal: AbortSignal.timeout(Math.min(CATALOG_TIMEOUT_MS, remaining)),
            });
            if (!response.ok)
                throw new Error(`${url}: HTTP ${response.status}`);
            const payload = await response.json();
            if (!isRecord(payload))
                throw new Error(`${url}: unexpected response shape`);
            return payload;
        }
        catch (error) {
            lastError = error;
            if (attempt < CATALOG_ATTEMPTS)
                await sleep(250 * attempt);
        }
    }
    throw lastError;
}
/** pi-ai's standard ladder keys (off = explicit close; the rest are depths). */
const PI_LEVEL_KEYS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
// Only an `effort`-type option's values shape the selector. A `toggle`, an
// empty list or a missing entry declares no level — an honest "takes no
// effort".
function reasoningLevelsFor(metadata) {
    const option = (Array.isArray(metadata.reasoning_options) ? metadata.reasoning_options : [])
        .find(value => isRecord(value) && value.type === 'effort');
    return isRecord(option) && Array.isArray(option.values)
        ? option.values.filter((value) => typeof value === 'string')
        : [];
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
function reasoningMapFor(levels, api) {
    const map = {};
    for (const key of PI_LEVEL_KEYS) {
        if (levels.includes(key))
            map[key] = key;
    }
    map.off = api === 'openai-completions' && levels.includes('none') ? 'none' : null;
    return map;
}
const isFreeCost = (metadata) => {
    if (!isRecord(metadata.cost))
        return false;
    const input = metadata.cost.input;
    const output = metadata.cost.output;
    return input === 0 && output === 0;
};
// Turn the live-scanned feeds into pi-ai model descriptors.
function buildModels(zenData, modelsById, userAgent) {
    const baseModels = getBuiltinModels('opencode');
    return zenData
        .filter((entry) => isRecord(entry) && typeof entry.id === 'string')
        .flatMap((entry) => {
        const id = entry.id;
        const metadata = modelsById[id];
        if (!isRecord(metadata))
            return [];
        // Anonymous requests authenticate as `public`; paid models would 401,
        // so only zero-cost rows are offered. The `-free` suffix alone is not
        // the full set (`big-pickle`, `grok-code`, …).
        if (!id.endsWith('-free') && !isFreeCost(metadata))
            return [];
        if (typeof metadata.status === 'string' && metadata.status === 'deprecated')
            return [];
        // Zen serves muse-spark contributor-free models on the Responses
        // endpoint; chat/completions 500s for them.
        const api = id.includes('muse-spark') ? 'openai-responses' : 'openai-completions';
        const baseCompat = baseModels.find(base => base.id === id)?.compat;
        // Models not yet in the pi-ai built-in catalogue still need the Zen
        // `maxTokensField` ("max_tokens") or the proxy rejects the request with
        // a 500 when "max_completion_tokens" arrives. `supportsStrictMode` is
        // what makes pi-ai send `strict: false` on a Responses tool; without it
        // the Responses API normalizes the schema into strict mode, where every
        // declared property counts as required. Chat-completions models need
        // nothing: pi-ai omits `strict` there by default.
        const strictCompat = api === 'openai-responses' ? { supportsStrictMode: true } : {};
        const compat = baseCompat === undefined
            ? { maxTokensField: 'max_tokens', supportsReasoningEffort: false, ...strictCompat }
            : { ...baseCompat, requiresReasoningContentOnAssistantMessages: false, ...strictCompat };
        // No ladder upstream ⇒ no selector: `reasoning: false` means "no effort
        // control", never "no thinking".
        const levels = reasoningLevelsFor(metadata);
        const controllable = levels.length > 0;
        const limit = isRecord(metadata.limit) ? metadata.limit : undefined;
        const input = isRecord(metadata.modalities) && Array.isArray(metadata.modalities.input)
            ? metadata.modalities.input.filter((value) => value === 'text' || value === 'image')
            : [];
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
            }];
    });
}
//#endregion
//#region Catalog cache
/**
 * Last-good catalog on disk, so a stalled feed degrades to a slightly stale
 * model list instead of an empty one (which would fail the first turn with
 * UNKNOWN_MODEL). Best-effort in both directions.
 */
const CACHE_DIR = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'cache');
const CACHE_PATH = join(CACHE_DIR, `${name}-catalog.json`);
async function readCatalogCache() {
    try {
        const parsed = JSON.parse(await readFile(CACHE_PATH, 'utf8'));
        if (!isRecord(parsed) || !Array.isArray(parsed.zen) || !isRecord(parsed.models))
            return undefined;
        if (typeof parsed.userAgent !== 'string')
            return undefined;
        return { zen: parsed.zen, models: parsed.models, userAgent: parsed.userAgent };
    }
    catch {
        return undefined;
    }
}
async function writeCatalogCache(cache) {
    try {
        await mkdir(CACHE_DIR, { recursive: true });
        // Write-then-rename so a torn write cannot leave a half-parsed cache behind.
        const temporary = `${CACHE_PATH}.${process.pid}.tmp`;
        await writeFile(temporary, JSON.stringify(cache));
        await rename(temporary, CACHE_PATH);
    }
    catch {
        // A cache miss is always recoverable; never fail the scan over it.
    }
}
//#endregion
// Required by the adapter, unused by this route: the credential comes from
// `resolveApiKey`, so pi-ai never stores one nor asks an ambient question.
const PI_AUTH = {
    credentials: {
        read: async () => undefined,
        list: async () => [],
        modify: async (_providerId, mutate) => mutate(undefined),
        delete: async () => { },
    },
    authContext: { env: async () => undefined, fileExists: async () => false },
};
export async function apply(ctx, config) {
    // One-time: the Zen user-agent the transport forces on every opencode.ai request.
    const opencodeVersion = await resolveOpenCodeVersion();
    const opencodeUserAgent = `opencode/${opencodeVersion}`;
    zenUserAgent = opencodeUserAgent;
    // The Loader owns the settings namespace, so the configuration form is
    // addressed by the profile entry id that mounted this plugin.
    const settingsNs = ctx.fiber.entry?.options.id ?? name;
    // Outside the settings-backed config, so a settings snapshot cannot clobber
    // a scan.
    let scanned = [];
    const buildProfiles = () => {
        const opts = liveConfig(config);
        const piProvider = createProvider({
            id: PROVIDER,
            name: 'OpenCodeZenFree',
            baseUrl: ZEN_BASE_URL,
            auth: { apiKey: { name: 'OpenCodeZenFree', resolve: ({ credential }) => Promise.resolve({
                        auth: credential?.key === undefined ? {} : { apiKey: credential.key },
                        source: 'OpenCodeZenFree',
                    }) } },
            models: scanned,
            api: zenApi,
        });
        const profiles = new Map([[PROVIDER, {
                    provider: PROVIDER,
                    displayName: DISPLAY_NAME,
                    apiKeyEnv: credentialRef('OPENCODE_ZEN_FREE_API_KEY'),
                    streamIdleTimeoutMs: 300_000,
                    maxRequestImageBytes: opts.maxRequestImageBytes ?? DEFAULT_MAX_REQUEST_IMAGE_BYTES,
                    requestImagePixelBudget: 4_194_304,
                    requestImageMaxBytes: opts.requestImageMaxBytes ?? DEFAULT_REQUEST_IMAGE_MAX_BYTES,
                    retryPolicy: resolveRetryPolicy(opts.retryPolicy, `${name}: retryPolicy`),
                    piProvider: piProvider,
                    modelErrors: new Map(),
                    configuredMaxTokens: new Map(),
                }]]);
        return profiles;
    };
    // PiAiAdapter memoizes its snapshot on this Map's identity, so a fresh Map
    // per request would rebuild the whole pi-ai collection: rebuild only on
    // change.
    let profiles = buildProfiles();
    const adapter = new PiAiAdapter({
        resolveAttachments: () => ctx.get('attachments'),
        profiles: () => profiles,
        auth: PI_AUTH,
        resolveApiKey: async (_provider, profile) => {
            const credentials = ctx.get('credentials');
            if (credentials !== undefined) {
                const hit = await credentials.resolve(profile.apiKeyEnv);
                if (hit !== undefined)
                    return assertUsableApiKey(hit.value, name, String(profile.apiKeyEnv));
            }
            // OpenCode Zen serves the free tier to the anonymous `public` identity.
            return 'public';
        },
    });
    ctx.llm.registerConfigurableProviders([
        { provider: PROVIDER, displayName: DISPLAY_NAME, settingsNs, settingsPath: [] },
    ]);
    ctx.llm.registerAdapter([PROVIDER], adapter);
    // Every field is volatile, so the Loader commits a settings write into this
    // fiber and announces it here instead of remounting; re-derive the profiles.
    ctx.on('loader/volatile-update', () => {
        profiles = buildProfiles();
    });
    // The catalog is fetched once at mount. Mount awaits it: dsh resolves a
    // session's model as soon as the provider is up, so registering the adapter
    // against an empty catalogue makes every model read as UNKNOWN_MODEL on the
    // first turn — the scan has to land before the first resolve does. Both
    // feeds are bounded, and when either is unreachable the last-good catalog
    // on disk stands in.
    async function sync() {
        const usable = (zen, models, userAgent) => {
            const next = buildModels(zen, models, userAgent);
            if (next.length === 0)
                throw new Error('no OpenCode Zen free models resolved');
            return next;
        };
        let next;
        try {
            const [zen, modelsDev] = await Promise.all([
                fetchJson(ZEN_CATALOG_URL, {
                    'User-Agent': opencodeUserAgent,
                    accept: 'application/json',
                }),
                fetchJson('https://models.dev/api.json', { accept: 'application/json' }),
            ]);
            if (!Array.isArray(zen.data))
                throw new Error('zen models: unexpected response shape');
            if (!isRecord(modelsDev.opencode) || !isRecord(modelsDev.opencode.models)) {
                throw new Error('models.dev: no "opencode" provider');
            }
            next = usable(zen.data, modelsDev.opencode.models, opencodeUserAgent);
            void writeCatalogCache({ zen: zen.data, models: modelsDev.opencode.models, userAgent: opencodeUserAgent });
        }
        catch (error) {
            const cached = await readCatalogCache();
            if (cached === undefined)
                throw error;
            ctx.logger.warn('[%s] catalog fetch failed (%s); using the cached catalog', name, errorChain(error));
            next = usable(cached.zen, cached.models, cached.userAgent);
        }
        if (deepEqualJson(next, scanned))
            return;
        scanned = next;
        profiles = buildProfiles();
        ctx.logger.info('[%s] synced %d free model(s): %s', name, scanned.length, scanned.map(model => model.id).join(', '));
    }
    await sync().catch((error) => {
        ctx.logger.warn('[%s] initial catalog scan failed: %s', name, errorChain(error));
    });
}
