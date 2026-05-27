import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Document, isMap, parseDocument } from "yaml";

import type { ResolvedThinkingLevel } from "@zia/providers";

export interface ProfileLlmUpdate {
  provider: string;
  modelId: string;
  thinkingLevel?: ResolvedThinkingLevel;
  /** When `undefined`, any existing `credentials_env` line is REMOVED so the
   * resolver falls back to the catalog default. When set, written as
   * `credentials_env: <value>` (snake_case to match the YAML convention). */
  credentialEnv?: string;
}

/**
 * Update `${fichaDir}/profile.yaml`'s `llm.default` block in place. Uses the
 * `yaml` library's Document API to preserve comments, key order, and
 * formatting. The YAML field name is `credentials_env` (snake_case) per the
 * IMPLEMENTATION_PLAN's ficha schema; the TS side calls it `credentialEnv`.
 *
 * @throws Error when the file is missing or unreadable. Malformed YAML
 * surfaces as the underlying parser error.
 */
export async function updateProfileLlmDefault(
  fichaDir: string,
  update: ProfileLlmUpdate,
): Promise<void> {
  const profilePath = join(fichaDir, "profile.yaml");
  let raw: string;
  try {
    raw = await readFile(profilePath, "utf8");
  } catch (cause) {
    throw new Error(`zia: cannot read ${profilePath}`, { cause });
  }

  const doc = parseDocument(raw);

  // Ensure llm is a map. If the doc is empty or has no `llm`, create it.
  if (doc.get("llm") === undefined) {
    doc.set("llm", new Document().createNode({}));
  }
  const llm = doc.get("llm");
  if (!isMap(llm)) {
    throw new Error(`zia: ${profilePath} has a non-map "llm" entry — refusing to overwrite`);
  }

  // Ensure llm.default is a map. Create it when missing.
  if (llm.get("default") === undefined) {
    llm.set("default", new Document().createNode({}));
  }
  const def = llm.get("default");
  if (!isMap(def)) {
    throw new Error(
      `zia: ${profilePath} has a non-map "llm.default" entry — refusing to overwrite`,
    );
  }

  def.set("provider", update.provider);
  def.set("model", update.modelId);

  // Partial-update semantics: only set fields that were explicitly passed.
  // `undefined` means "preserve existing"; callers that want to CLEAR a
  // field should use {@link clearProfileLlmField} below. This matches the
  // user expectation that `zia model` (which only asks for provider + model)
  // does not silently drop unrelated config like thinkingLevel.
  if (update.thinkingLevel !== undefined) {
    def.set("thinkingLevel", update.thinkingLevel);
  }
  if (update.credentialEnv !== undefined) {
    def.set("credentials_env", update.credentialEnv);
  }

  await writeFile(profilePath, doc.toString(), "utf8");
}

/**
 * Explicitly remove an optional field from `llm.default`. Use this when the
 * caller wants to clear `thinkingLevel` or `credentials_env`, since the main
 * updater preserves those when the update object omits them.
 */
export async function clearProfileLlmField(
  fichaDir: string,
  field: "thinkingLevel" | "credentials_env",
): Promise<void> {
  const profilePath = join(fichaDir, "profile.yaml");
  let raw: string;
  try {
    raw = await readFile(profilePath, "utf8");
  } catch (cause) {
    throw new Error(`zia: cannot read ${profilePath}`, { cause });
  }

  const doc = parseDocument(raw);
  const llm = doc.get("llm");
  if (!isMap(llm)) {
    return;
  }
  const def = llm.get("default");
  if (!isMap(def)) {
    return;
  }
  if (def.has(field)) {
    def.delete(field);
    await writeFile(profilePath, doc.toString(), "utf8");
  }
}
