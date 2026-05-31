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

// ---------------------------------------------------------------------------
// FichaModelEntry — one entry in llm.available[] (SPEC-FICHA-1, PR1)
// ---------------------------------------------------------------------------

/** One entry in the `llm.available[]` list in profile.yaml. */
export interface FichaModelEntry {
  /** pi.dev provider key (e.g. "anthropic", "openai", "custom"). Required. */
  provider: string;
  /** Model identifier as used by the provider. Required.
   * The YAML field is named `model`; it is parsed and re-exported as `modelId`. */
  modelId: string;
  thinkingLevel?: "off" | "low" | "medium" | "high";
  /** Human-friendly label shown in the /model picker. */
  label?: string;
  /** Env-var name holding the API key. Absent for OAuth and custom providers. */
  credentialEnv?: string;
  /** Base URL for custom/self-hosted endpoints (Ollama, vLLM, LiteLLM). */
  baseUrl?: string;
}

/** Shape of the `llm:` block in profile.yaml, extended for PR1 fields. */
export interface FichaLlmConfig {
  /** The default model to use at session start. */
  default?: { provider: string; model: string; thinkingLevel?: string };
  /** All models available for runtime switching (Ctrl+P / RPC set_model). */
  available?: FichaModelEntry[];
  /** Monthly USD budget cap. When absent, budget enforcement is disabled. */
  monthly_budget_usd?: number;
  /** Auto-fallback to next model on provider error. */
  fallback_on_error?: boolean;
}

/** Top-level shape of profile.yaml after parsing.
 *
 * All new fields are additive — old fichas without `agent.id` or `llm.available`
 * remain valid and parse cleanly. The `llm` block still uses `.passthrough()` so
 * unknown keys (e.g. future fields) never cause rejection. */
export interface FichaProfile {
  agent?: {
    /** Primary accounting and identity key. When absent, callers MUST log a
     * WARNING and derive a slug from `path.basename(fichaDir)` as fallback. */
    id?: string;
    name?: string;
    email?: string;
  };
  llm?: FichaLlmConfig;
  bosses?: unknown[];
  accounts?: unknown;
}

// ---------------------------------------------------------------------------
// Zod schemas — additive extensions; passthrough preserved
// ---------------------------------------------------------------------------

/** Schema for one entry in llm.available[]. The YAML field is `model`; we
 * rename it to `modelId` in the output to avoid shadowing the block name. */
const fichaModelEntrySchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    thinkingLevel: thinkingLevelSchema.optional(),
    label: z.string().optional(),
    credentials_env: z.string().min(1).optional(),
    baseUrl: z.string().min(1).optional(),
  })
  .passthrough();

const profileSchema = z
  .object({
    agent: z
      .object({
        id: z.string().min(1).optional(),
        name: z.string().optional(),
        email: z.string().optional(),
      })
      .passthrough()
      .optional(),
    llm: z
      .object({
        default: llmDefaultSchema,
        // F-CORE-7: session-wide Anthropic prompt-cache TTL.
        cacheRetention: cacheRetentionSchema.optional(),
        cache_retention: cacheRetentionSchema.optional(),
        // PR1 additions (additive):
        available: z.array(fichaModelEntrySchema).optional(),
        monthly_budget_usd: z.number().nonnegative().optional(),
        fallback_on_error: z.boolean().optional(),
      })
      .passthrough(),
  })
  .passthrough();

/** Loose schema for readFichaProfile — llm.default is optional to support
 * fichas that only declare llm.available or purely store agent metadata. */
const profileLooseSchema = z
  .object({
    agent: z
      .object({
        id: z.string().min(1).optional(),
        name: z.string().optional(),
        email: z.string().optional(),
      })
      .passthrough()
      .optional(),
    llm: z
      .object({
        default: llmDefaultSchema.optional(),
        cacheRetention: cacheRetentionSchema.optional(),
        cache_retention: cacheRetentionSchema.optional(),
        available: z.array(fichaModelEntrySchema).optional(),
        monthly_budget_usd: z.number().nonnegative().optional(),
        fallback_on_error: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// readFichaLlm — existing function, UNCHANGED
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// readFichaProfile — NEW (PR1 / SPEC-FICHA-1)
// ---------------------------------------------------------------------------

/**
 * Read and parse `${fichaDir}/profile.yaml` as a full {@link FichaProfile}.
 *
 * Unlike {@link readFichaLlm} (which requires `llm.default`), this function
 * parses the whole profile with loose validation so callers can access
 * `agent.id`, `llm.available[]`, and `llm.monthly_budget_usd` independently
 * of whether `llm.default` is present.
 *
 * - `agent.id` absent: logs a `console.warn` with a remediation hint. The
 *   caller should derive a slug from `path.basename(fichaDir)` as fallback.
 * - Unknown keys in the `llm` block are preserved (zod `.passthrough()`).
 * - Does NOT resolve any credential env-vars — that is the resolver's job.
 *
 * @throws Error if the file is missing or the YAML is malformed.
 */
export async function readFichaProfile(fichaDir: string): Promise<FichaProfile> {
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

  const parsed = profileLooseSchema.safeParse(doc);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    throw new Error(`zia: invalid ${profilePath} — ${detail}`);
  }

  const data = parsed.data;

  // SPEC-FICHA-1-C: warn when agent.id is absent so operators know the fallback
  // slug (path.basename(fichaDir)) is being used for accounting/audit purposes.
  if (!data.agent?.id) {
    console.warn(
      `zia: ${profilePath} is missing agent.id. ` +
        `Budget and audit records will use the directory name as the agent identifier. ` +
        `Add 'agent:\\n  id: <slug>' to silence this warning.`,
    );
  }

  // Map available[] entries: YAML uses `model`, FichaModelEntry exports `modelId`.
  const available: FichaModelEntry[] | undefined = data.llm?.available?.map((entry) => ({
    provider: entry.provider as string,
    modelId: entry.model as string,
    thinkingLevel: (entry.thinkingLevel as FichaModelEntry["thinkingLevel"]) ?? undefined,
    label: (entry.label as string | undefined) ?? undefined,
    credentialEnv: (entry.credentials_env as string | undefined) ?? undefined,
    baseUrl: (entry.baseUrl as string | undefined) ?? undefined,
  }));

  return {
    agent: data.agent
      ? {
          id: data.agent.id,
          name: data.agent.name,
          email: data.agent.email,
        }
      : undefined,
    llm: data.llm
      ? {
          default: data.llm.default
            ? {
                provider: data.llm.default.provider,
                model: data.llm.default.model,
                thinkingLevel: data.llm.default.thinkingLevel,
              }
            : undefined,
          available,
          monthly_budget_usd: data.llm.monthly_budget_usd,
          fallback_on_error: data.llm.fallback_on_error,
        }
      : undefined,
    bosses: (data as { bosses?: unknown[] }).bosses,
    accounts: (data as { accounts?: unknown }).accounts,
  };
}
