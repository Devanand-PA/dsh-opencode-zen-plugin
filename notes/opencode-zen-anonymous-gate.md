# OpenCode Zen anonymous (free) tier — verified request requirements

Endpoint: `POST https://opencode.ai/inference/openai/v1/chat/completions`
(OpenAI Chat Completions wire format, SSE streaming)

## Required
1. `Authorization: Bearer public` (the literal token `public`; real keys also work: `Bearer <OPENCODE_API_KEY>`)
2. `User-Agent: opencode/<semver>` with semver >= ~1.11 (1.10.0 -> 426 UpgradeRequired; invalid semver -> 403 FreeTierError; `opencode` alone -> 403)
3. `x-opencode-session: ses_` + exactly 26 alphanumeric chars (opencode's ID format: 12 hex time + 14 base62)
4. Request body must declare a tool named `read` (schema/content irrelevant; only the name is checked)
5. `"stream": true` (non-streaming requests -> 403 FreeTierError)

## Free (anonymous-allowed) models verified working
nemotron-3.5-lightning-free, nemotron-3.5-super-vl-free, deepseek-v4.1-flash-free,
big-pickle, beam-free (also listed anonymously at GET https://opencode.ai/zen/v1/models)

## Model list (anonymous)
GET https://opencode.ai/zen/v1/models — no auth needed.

## Behavior notes
- `Bearer public` on paid models -> 401 AuthError "Missing API key"
- Full opencode client also sends x-opencode-client/project/request/session-id — all OPTIONAL for the gate
- x-opencode-session-id is NOT required (only x-opencode-session)
- The released client (v1.19.3) sends UA `opencode/1.19.3 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14`
- Header order, accept-encoding, TLS fingerprint: irrelevant (verified via node fetch proxy)
- Session ids longer/shorter than 26 chars -> 403
