import { describe, expect, it } from "vitest";
import { z } from "zod";

import { findProvider, providerCatalog } from "../src/catalog.ts";

const providerSchema = z
  .object({
    key: z.string().min(1),
    label: z.string().min(1),
    type: z.enum(["api-key", "oauth", "custom"]),
    credentialEnv: z.string().optional(),
    oauthHelper: z.enum(["github-copilot", "openai-codex"]).optional(),
    defaultModels: z.array(z.string()).readonly(),
  })
  .superRefine((p, ctx) => {
    if (p.type === "api-key" && !p.credentialEnv) {
      ctx.addIssue({
        code: "custom",
        message: `${p.key}: api-key providers require credentialEnv`,
      });
    }
    if (p.type === "oauth" && !p.oauthHelper) {
      ctx.addIssue({
        code: "custom",
        message: `${p.key}: oauth providers require oauthHelper`,
      });
    }
    if (p.type === "custom" && p.credentialEnv) {
      ctx.addIssue({
        code: "custom",
        message: `${p.key}: custom providers must NOT declare credentialEnv (per-endpoint config in ficha)`,
      });
    }
  });

describe("providerCatalog", () => {
  it("every entry matches the Provider schema", () => {
    for (const entry of providerCatalog) {
      const result = providerSchema.safeParse(entry);
      expect(result.success, JSON.stringify(result.error?.issues ?? entry)).toBe(true);
    }
  });

  it("keys are unique across the catalog", () => {
    const keys = providerCatalog.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("credentialEnv values are unique among api-key providers", () => {
    const envs = providerCatalog
      .filter((p) => p.type === "api-key" && p.credentialEnv)
      .map((p) => p.credentialEnv!);
    expect(new Set(envs).size).toBe(envs.length);
  });

  it("includes the curated set the proposal called out", () => {
    const keys = providerCatalog.map((p) => p.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        "anthropic",
        "openai",
        "google",
        "deepseek",
        "groq",
        "xai",
        "together",
        "openrouter",
        "opencode-go",
        "github-copilot",
        "openai-codex",
        "custom",
      ]),
    );
  });
});

describe("findProvider", () => {
  it("returns the entry for a known key", () => {
    const result = findProvider("openai");
    expect(result?.key).toBe("openai");
    expect(result?.credentialEnv).toBe("OPENAI_API_KEY");
  });

  it("returns undefined for an unknown key", () => {
    expect(findProvider("made-up-provider")).toBeUndefined();
  });
});
