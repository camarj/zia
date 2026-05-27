import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ENV_VAR_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

/**
 * Upsert a credential into `${agentDir}/.env` and set permissions to `0600`.
 *
 * - Preserves unrelated lines (other vars, comments, blank lines).
 * - If the key already exists, replaces ONLY that line (idempotent on
 *   identical inputs).
 * - If the file does not exist, creates it with the single key.
 * - Always chmods to `0600` after writing, even if the file pre-existed
 *   with looser perms.
 *
 * Validation:
 * - `name` must match `^[A-Z_][A-Z0-9_]*$` (standard env-var naming).
 * - `value` must be non-empty after trimming, so we never silently blank a
 *   key by passing an unbound prompt result.
 *
 * Quoting:
 * - If `value` contains whitespace, quotes, or `\n`, it is double-quoted
 *   and embedded quotes / backslashes are escaped. Plain values are
 *   written as `KEY=VALUE` to match the dotenv convention people see in
 *   the wild.
 */
export async function upsertCredential(
  agentDir: string,
  name: string,
  value: string,
): Promise<void> {
  if (!ENV_VAR_NAME_PATTERN.test(name)) {
    throw new Error(
      `zia: refused to write credential — "${name}" is not a valid env var name (expected /^[A-Z_][A-Z0-9_]*$/)`,
    );
  }
  if (value.trim() === "") {
    throw new Error(
      `zia: refused to write credential — value for ${name} is empty or whitespace-only`,
    );
  }

  const envPath = join(agentDir, ".env");
  const existing = await readExisting(envPath);
  const next = upsertLine(existing, name, value);

  await writeFile(envPath, next, { encoding: "utf8" });
  await chmod(envPath, 0o600);
}

async function readExisting(envPath: string): Promise<string> {
  try {
    return await readFile(envPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw err;
  }
}

function upsertLine(existing: string, name: string, value: string): string {
  const formatted = formatLine(name, value);
  const lines = existing.length === 0 ? [] : existing.split("\n");

  // dotenv files customarily end with a trailing newline. Drop the trailing
  // empty token from a trailing newline so we can re-add it predictably.
  let trailingNewline = existing.endsWith("\n");
  if (trailingNewline) {
    lines.pop();
  }

  const matcher = new RegExp(`^\\s*${name}\\s*=`);
  const idx = lines.findIndex((line) => matcher.test(line));

  if (idx >= 0) {
    lines[idx] = formatted;
  } else {
    lines.push(formatted);
    trailingNewline = true;
  }

  return lines.join("\n") + (trailingNewline ? "\n" : "");
}

function formatLine(name: string, value: string): string {
  const needsQuoting = /[\s"'`$\\\n]/.test(value);
  if (!needsQuoting) {
    return `${name}=${value}`;
  }
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
  return `${name}="${escaped}"`;
}
