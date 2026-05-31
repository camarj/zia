/**
 * cache.test.ts — F-CORE-7 prompt-caching validator + configurator.
 *
 * cache.ts is pure (except applyCacheRetention's env mutation), so it is fully
 * covered without a live pi.dev session. The `cacheRetention` VALUE validation
 * (short|long, throw on bad) lives in @zia/providers (ficha schema) and is
 * covered there — here we cover eligibility + the TTL lever behavior.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";

import {
  assessCacheEligibility,
  estimateTokens,
  applyCacheRetention,
  CACHE_MIN_TOKENS,
  DEFAULT_CACHE_RETENTION,
} from "../src/cache.ts";

describe("estimateTokens", () => {
  it("estimates ~4 chars per token, rounding up", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("a")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });
});

describe("DEFAULT_CACHE_RETENTION", () => {
  it("matches pi.dev's own default (short)", () => {
    expect(DEFAULT_CACHE_RETENTION).toBe("short");
  });
});

describe("assessCacheEligibility", () => {
  // A string whose estimated tokens clear the minimum.
  const bigPrompt = "x".repeat(CACHE_MIN_TOKENS * 4 + 4);
  const smallPrompt = "tiny ficha";

  it("eligible: Anthropic provider with a large-enough stable prompt", () => {
    const result = assessCacheEligibility("anthropic", bigPrompt);
    expect(result.eligible).toBe(true);
    expect(result.provider).toBe("anthropic");
    expect(result.estimatedTokens).toBeGreaterThanOrEqual(CACHE_MIN_TOKENS);
    expect(result.reason).toMatch(/cache-eligible/);
  });

  it("ineligible: Anthropic prompt below the token minimum", () => {
    const result = assessCacheEligibility("anthropic", smallPrompt);
    expect(result.eligible).toBe(false);
    expect(result.estimatedTokens).toBeLessThan(CACHE_MIN_TOKENS);
    expect(result.reason).toMatch(/minimum/);
  });

  it("ineligible no-op: non-Anthropic providers never cache", () => {
    const openai = assessCacheEligibility("openai", bigPrompt);
    expect(openai.eligible).toBe(false);
    expect(openai.reason).toMatch(/only applies to Anthropic/);

    const ollama = assessCacheEligibility("ollama", bigPrompt);
    expect(ollama.eligible).toBe(false);
  });
});

describe("applyCacheRetention", () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env.PI_CACHE_RETENTION;
    delete process.env.PI_CACHE_RETENTION;
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env.PI_CACHE_RETENTION;
    } else {
      process.env.PI_CACHE_RETENTION = original;
    }
  });

  it('sets PI_CACHE_RETENTION=long for "long"', () => {
    applyCacheRetention("long");
    expect(process.env.PI_CACHE_RETENTION).toBe("long");
  });

  it('leaves the env untouched for "short" (pi.dev default)', () => {
    applyCacheRetention("short");
    expect(process.env.PI_CACHE_RETENTION).toBeUndefined();
  });
});
