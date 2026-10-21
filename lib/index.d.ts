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
import type { Context } from '@deepseek-ai/cordis';
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm';
import z from '@deepseek-ai/schemastery';
import { type Tool } from '@earendil-works/pi-ai';
export declare const name = "dsh-opencode-zen-plugin";
export declare const inject: string[];
export interface Config {
    /** Base64 image payload one request accepts before older images are offloaded (default 2 MiB). */
    maxRequestImageBytes?: number;
    /** Per-image request budget after re-encoding (default 1 MiB). */
    requestImageMaxBytes?: number;
    /** Provider-owned model-request retry policy; omission uses normal defaults. */
    retryPolicy?: RetryPolicyConfig;
    /**
     * Deadline for the response headers of one model request, in milliseconds.
     * The free tier is shared capacity and a dropped route can leave a request
     * open forever; this bounds how long a turn may sit without an answer
     * before the request fails and the harness can move on (or the user can
     * stop the turn). It bounds the wait for the FIRST byte only — the stream
     * itself is bounded by `streamIdleTimeoutMs`.
     */
    requestTimeoutMs?: number;
    /**
     * Maximum silence between two streamed chunks, in milliseconds.
     */
    streamIdleTimeoutMs?: number;
}
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    maxRequestImageBytes: z<number, number, "volatile-defined">;
    requestImageMaxBytes: z<number, number, "volatile-defined">;
    retryPolicy: z<NoInfer<RetryPolicyConfig>, NoInfer<RetryPolicyConfig>, "volatile">;
    requestTimeoutMs: z<number, number, "volatile-defined">;
    streamIdleTimeoutMs: z<number, number, "volatile-defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    maxRequestImageBytes: z<number, number, "volatile-defined">;
    requestImageMaxBytes: z<number, number, "volatile-defined">;
    retryPolicy: z<NoInfer<RetryPolicyConfig>, NoInfer<RetryPolicyConfig>, "volatile">;
    requestTimeoutMs: z<number, number, "volatile-defined">;
    streamIdleTimeoutMs: z<number, number, "volatile-defined">;
}>>, "plain">;
type LiveConfig = Schemastery.TypeT<typeof Config>;
export declare const requiredZenTools: (tools?: readonly Tool[]) => Tool[];
export declare function apply(ctx: Context, config: LiveConfig): void;
export {};
