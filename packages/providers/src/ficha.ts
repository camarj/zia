import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

import type { FichaLlmDeclaration } from "./types.ts";

const thinkingLevelSchema = z.enum(["off", "low", "medium", "high"]);
const cacheRetentionSchema = z.enum(["short", "long"]);

const llmDefaultSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    // YAML uses snake_case to match the existing convention from
    // IMPLEMENTATION_PLAN.md; we expose it as camelCase to consumers.
    credentials_env: z.string().min(1).optional(),
    baseUrl: z
      .string()
      .min(1)
      .refine(
        (value) => {
          try {
            // eslint-disable-next-line no-new
            new URL(value);
            return true;
          } catch {
            return false;
          }
        },
        { message: "baseUrl must be a parseable URL" },
      )
      .optional(),
    thinkingLevel: thinkingLevelSchema.optional(),
  })
  .strict();

const profileSchema = z
  .object({
    llm: z
      .object({
        default: llmDefaultSchema,
        // F-CORE-7: session-wide Anthropic prompt-cache TTL. Lives at the `llm`
        // level (not per-model) because it configures the provider transport,
        // not a model entry. Accepts snake_case too, matching the YAML idiom.
        cacheRetention: cacheRetentionSchema.optional(),
        cache_retention: cacheRetentionSchema.optional(),
      })
      .passthrough(),
  })
  .passthrough();

/**
 * Read and validate `${fichaDir}/profile.yaml`. Returns the declared `llm.default`
 * block as a normalized {@link FichaLlmDeclaration}. Does NOT resolve credential
 * env-vars from the catalog (that happens in the resolver).
 *
 * @throws Error if the file is missing, the YAML is malformed, or the schema
 *   does not match. Error messages always name the offending path or field so
 *   the operator can fix the ficha without spelunking.
 */
export async function readFichaLlm(fichaDir: string): Promise<FichaLlmDeclaration> {
  const profilePath = join(fichaDir, "profile.yaml");
  let raw: string;
  try {
    raw = await readFile(profilePath, "utf8");
  } catch (cause) {
    throw new Error(`zia: cannot read ${profilePath}`, { cause });
  }

  let doc: unknown;
  try {
    doc = parse(raw);
  } catch (cause) {
    throw new Error(`zia: ${profilePath} is not valid YAML`, { cause });
  }

  // Surface the canonical "missing llm.default" error before zod, which would
  // otherwise emit a less actionable "expected object" message.
  const root = doc as { llm?: { default?: unknown } } | null | undefined;
  if (!root?.llm || typeof root.llm.default === "undefined") {
    throw new Error(
      `zia: ${profilePath} is missing llm.default. Declare provider and model under llm.default.`,
    );
  }

  const parsed = profileSchema.safeParse(doc);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    throw new Error(`zia: invalid ${profilePath} — ${detail}`);
  }

  const def = parsed.data.llm.default;
  return {
    provider: def.provider,
    modelId: def.model,
    baseUrl: def.baseUrl,
    credentialEnv: def.credentials_env,
    thinkingLevel: def.thinkingLevel,
    cacheRetention: parsed.data.llm.cacheRetention ?? parsed.data.llm.cache_retention,
  };
}
