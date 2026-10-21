# dsh-opencode-zen-plugin

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that
registers [OpenCode Zen](https://opencode.ai/zen)'s **free anonymous models** as an
LLM provider — no API key required.

One name covers the whole plugin: the repository, the npm package, the profile
bundle, and the harness service are all `dsh-opencode-zen-plugin`.

The one deliberate exception is the **LLM provider id**, `opencode-zen-free` —
the namespace the model picker shows as `opencode-zen-free/<model>` (alongside
`nvidia-nim/z-ai/glm-5.3-flash` and `deepseek-official/<model>`). It names the
*models being served*, not the plugin doing the serving, and keeping it stable
means saved sessions and settings that reference a model under this provider
keep working.

- Provider id: `opencode-zen-free` (display name **OpenCode Zen Free**)
- Package / bundle / service: `dsh-opencode-zen-plugin`
- Works on DSH `0.2.1-rc.2` (web + headless profiles)
- Zero-cost models are discovered live from the Zen catalog + [models.dev](https://models.dev)
  metadata (free = zero cost or a `-free` model id), with a disk cache
- Streams text and reasoning, supports tool calling, images (on capable models),
  and per-model reasoning-effort selectors
- Anonymous access is gated server-side; the plugin satisfies the gate for you
  (see [The anonymous free-tier gate](#the-anonymous-free-tier-gate))

Verified end-to-end on 2026-10-21 with DSH 0.2.1-rc.2: `dsh --profile <p> "…"`
headless runs (plain Q&A and tool use — a model reading a file through the
`read` tool) against `deepseek-v4.1-flash-free` and
`nemotron-3.5-lightning-free`, plus direct wire tests against
`glm-5.3-flash-free`, `big-pickle`, `longcat-2.5-preview-free`,
`beam-free`, `muse-spark-*` (responses API) and friends.

## Requirements

- DeepSeek Harness `0.2.1-rc.2` (the plugin declares
  `dsh.compatibility.dsh: ">=0.2.1-rc.2 <0.3"`, which deliberately **excludes
  alpha builds** — on any other DSH version the loader prints a one-line
  "skipping profile bundle" notice and boots without the plugin; the harness
  is never touched)
- Node.js 20+ and a profile you can edit (`$DSH_HOME/profiles/<profile>`)
- **No API key.** Anonymous free-tier access works out of the box.
- **The mount never blocks and never waits on the network.** `apply()` is
  synchronous: the picker immediately serves the 11 zero-cost models built
  into pi-ai (plus the last-good catalog from disk), and the live catalog is
  refreshed lazily in the background (right after mount, on model reads, and
  a slow daily round). A slow or blocked route to `opencode.ai`/`models.dev`
  slows only the refresh, never the harness boot or a session.

## Install

### Option A — plugin manager (Web GUI)

Open the DSH Web GUI → **Plugins** → **Install from source**, and enter the
GitHub URL:

```
github:Devanand-PA/dsh-opencode-zen-plugin
```

(or `https://github.com/Devanand-PA/dsh-opencode-zen-plugin.git`). Installation
adds the bundle and enables it by default.

### Option B — profile package.json (from GitHub or a local checkout)

Add the package as a profile dependency and bundle, then install. In
`$DSH_HOME/profiles/<your-profile>/package.json`:

```jsonc
{
  // …
  "dependencies": {
    // from GitHub:
    "dsh-opencode-zen-plugin": "github:Devanand-PA/dsh-opencode-zen-plugin",
    // …or from a local checkout (edit-in-place friendly):
    // "dsh-opencode-zen-plugin": "link:/path/to/dsh-opencode-zen-plugin"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // …existing bundles…,
        "dsh-opencode-zen-plugin"
      ]
    }
  }
}
```

Then run `pnpm install` in the profile directory (the plugin manager does this
for you), and restart the harness. To try it without touching your default
model, pick **OpenCode Zen Free → <model>** in the model picker.

> The repository ships the compiled `lib/` output, so a GitHub install works
> without a build step. Cloning and hacking on it? `pnpm install && pnpm build`
> inside the checkout, then point the profile at it with
> `"dsh-opencode-zen-plugin": "link:/path/to/checkout"`.

To make it the default for new agents, add to the profile's `cordis.patch.yml`:

```yaml
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: opencode-zen-free
    model: deepseek-v4.1-flash-free
```

### Option C — one-off patch overlay

```
dsh --profile <your-profile> --patch ./opencode-zen.yml "your task"
```

with `opencode-zen.yml` containing just the `agent-default-model` patch above
(the bundle itself must already be installed).

### From source (development)

```bash
git clone https://github.com/Devanand-PA/dsh-opencode-zen-plugin.git
cd dsh-opencode-zen-plugin
pnpm install
pnpm build        # tsc → lib/
pnpm typecheck
```

Point a profile at the checkout with
`"dsh-opencode-zen-plugin": "link:/path/to/dsh-opencode-zen-plugin"` and re-run
`pnpm install` in the profile directory.

## Optional: a real OpenCode API key

Anonymous access works with the literal token `public`. If you have an OpenCode
API key (higher limits), store it as the credential
`OPENCODE_ZEN_FREE_API_KEY` (harness credential store / Models page); the
plugin resolves it per request and falls back to anonymous access when absent.

## Configuration

The `dsh-opencode-zen-plugin:` settings section (the bundle's entry id is the
namespace; all fields are volatile, so the plugin re-reads them on change):

| Setting | Default | Meaning |
| --- | --- | --- |
| `maxRequestImageBytes` | 2097152 | Largest image attachment offered to Zen (bytes) |
| `requestImageMaxBytes` | 1048576 | Images above this are offloaded to text instead |
| `retryPolicy` | adapter defaults | Retry behaviour for transient Zen failures |

## The anonymous free-tier gate

OpenCode's free tier is gated server-side to look like the OpenCode CLI. These
requirements were root-caused by wire-capturing the OpenCode CLI against a
logging proxy and bisecting (details in
[notes/opencode-zen-anonymous-gate.md](notes/opencode-zen-anonymous-gate.md)).
All are satisfied by this plugin automatically:

1. `Authorization: Bearer public` (a real key also works)
2. `User-Agent: opencode/<semver>` with semver ≳ 1.11 (the plugin pins a
   known-good version — no version probe, no network at boot)
3. `x-opencode-session` / `x-opencode-session-id` / `x-session-affinity` /
   `x-session-id`: one `ses_…` id (26 base62/hex chars) per DSH session,
   minted in OpenCode's id format and reused for cache friendliness
4. The request body must declare a tool named **`read`** (and `bash`) — the
   plugin pads the tool list with harmless placeholders when the harness
   didn't send them, and leaves real requests untouched
5. `"stream": true`

The harness stamps its own attribution `user-agent` over model headers, so the
plugin wraps `globalThis.fetch` (scoped to `opencode.ai` inference/zen URLs —
or `DSH_ZEN_BASE_URL`'s host when overridden) to restore the required
`opencode/<semver>` UA on the wire.

Model availability:

- `GET https://opencode.ai/zen/v1/models` (no auth) lists models; zero-cost
  entries in models.dev (or a `-free` id) are exposed. Paid models require a
  real key and are hidden for anonymous use.
- `muse-spark-*` models speak the OpenAI **responses** API; everything else
  here uses **chat completions**.

## Troubleshooting

- **429 / "Upstream request failed"** — the free tier is shared capacity;
  transient upstream outages and rate limits are normal. The harness's retry
  policy handles most of it; try again or pick another free model.
- **`FreeTierError` / 403 on every call** — the request didn't look like the
  OpenCode CLI. If you're routing Zen through a custom proxy, set
  `DSH_ZEN_BASE_URL` (e.g. `http://127.0.0.1:8899/v1`); the plugin patches the
  UA for that host too.
- **426 Upgrade Required** — OpenCode raised its version floor past the
  plugin's pinned `opencode/1.19.3`; update the plugin (or file an issue).
- **Model missing from the picker** — the picker serves pi-ai's builtin
  zero-cost OpenCode models offline; the live catalog (a few more models,
  including the `muse-spark-*` responses ones) arrives with the background
  refresh. To force it, delete
  `$DSH_HOME/cache/dsh-opencode-zen-plugin-catalog.json` (the older
  `opencode-zen-free-catalog.json` is read and upgraded automatically).
- **DSH 0.2.1-alpha.* prints "skipping profile bundle"** — intentional. The
  plugin is compatible with `0.2.1-rc.2` only; alpha builds are excluded so
  they can never be affected by it.

## Credits

Reverse-engineering and design reference — thank you:

- [jiesou/dsh-opencode-zen-free-provider](https://github.com/jiesou/dsh-opencode-zen-free-provider)
  (the primary reference for the DSH-side shape; this plugin targets the
  0.2.1-rc.2 seam and adds the wire-level gate, session ids, tool padding,
  refusal rewriting, and the models.dev-based free-model filter)
- [edynasty/dsh-opencode-go-provider](https://github.com/edynasty/dsh-opencode-go-provider)
- [wyouwd1/dsh-opencode-models](https://github.com/wyouwd1/dsh-opencode-models)
- [opencode](https://github.com/anomalyco/opencode) — id format and client
  behaviour came from its source (`packages/schema/src/identifier.ts`)

## License

MIT
