/**
 * cache.ts — prompt-caching validation + configuration (F-CORE-7).
 *
 * pi.dev does the actual work: its Anthropic provider auto-places
 * `cache_control: { type: "ephemeral" }` breakpoints on every call (over the
 * system prompt, the last tool, and the last message) whenever cache retention
 * is not "none". zia has NO public API to inject breakpoints — and reimplementing
 * that would duplicate the SDK. So zia's job, per the PRD ("pi.dev covers most;
 * zia validates and configures"), is exactly two things:
 *
 *  1. CONFIGURE the cache TTL via the one lever pi.dev exposes: the
 *     PI_CACHE_RETENTION env var ("long" upgrades the 5-minute default to 1h).
 *     The value itself is validated upstream by @zia/providers (ficha schema).
 *  2. VALIDATE that the stable system prompt is actually cache-eligible
 *     (Anthropic provider + at least the minimum token count), so an agent
 *     whose ficha is too small to cache surfaces a clear diagnostic instead of
 *     silently paying full price every turn.
 *
 * The cache only ever pays off because the stable block is frozen for the
 * session (the system prompt is built once and captured in a closure — see
 * agent.ts and the Block 2 frozen-snapshot semantics for MEMORY.md). If the
 * prompt changed mid-session the breakpoint would miss on every turn.
 *
 * Disabling caching ("none") is a documented no-goal: pi.dev's env lever cannot
 * express it (it only toggles short↔long), turning it off has negative ROI for
 * a stable ficha prefix, and forcing it would require a payload-mutating
 * extension that is out of scope for F-CORE-7.
 */

import type { CacheRetention } from "@zia/providers";

export type { CacheRetention };

/**
 * Anthropic requires a minimum prompt size before it will create a cache entry.
 * Below this, the cache_control breakpoint is a no-op and caching saves nothing.
 */
export const CACHE_MIN_TOKENS = 1024;

/** Rough chars→tokens heuristic (Anthropic averages ~4 chars/token). */
const CHARS_PER_TOKEN = 4;

/** pi.dev's own default retention when nothing is configured. */
export const DEFAULT_CACHE_RETENTION: CacheRetention = "short";

/** Estimate the token count of a string without a real tokenizer. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** The result of assessing whether a system prompt benefits from caching. */
export interface CacheEligibility {
  /** Provider key the assessment ran against. */
  provider: string;
  /** True only when caching will actually save tokens for this prompt. */
  eligible: boolean;
  /** Estimated token count of the stable system prompt. */
  estimatedTokens: number;
  /** Human-readable explanation (logged as a startup diagnostic). */
  reason: string;
}

/**
 * Assess whether prompt caching will help for this provider + system prompt.
 *
 * Non-Anthropic providers are reported as ineligible (a graceful no-op, not an
 * error — caching is Anthropic-specific). An Anthropic prompt below
 * CACHE_MIN_TOKENS is ineligible because the breakpoint won't create an entry.
 */
export function assessCacheEligibility(
  provider: string,
  systemPrompt: string,
): CacheEligibility {
  const estimatedTokens = estimateTokens(systemPrompt);

  if (provider !== "anthropic") {
    return {
      provider,
      eligible: false,
      estimatedTokens,
      reason: `prompt caching only applies to Anthropic; provider is "${provider}" — no-op`,
    };
  }

  if (estimatedTokens < CACHE_MIN_TOKENS) {
    return {
      provider,
      eligible: false,
      estimatedTokens,
      reason: `stable prompt ≈${estimatedTokens} tokens is below Anthropic's ${CACHE_MIN_TOKENS}-token minimum for caching`,
    };
  }

  return {
    provider,
    eligible: true,
    estimatedTokens,
    reason: `stable prompt ≈${estimatedTokens} tokens is cache-eligible`,
  };
}

/**
 * Apply the resolved retention to pi.dev's documented lever.
 *
 * pi.dev's Anthropic provider reads PI_CACHE_RETENTION === "long" to extend the
 * cache TTL from the 5-minute default to 1 hour. "short" is already pi.dev's
 * default, so it requires no action. zia runs one agent per container, so
 * mutating the process env here is per-agent in practice.
 */
export function applyCacheRetention(retention: CacheRetention): void {
  if (retention === "long") {
    process.env.PI_CACHE_RETENTION = "long";
  }
}
