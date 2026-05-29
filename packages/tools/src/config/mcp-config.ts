/**
 * mcp-config.ts — Parse and validate mcp.yaml for a zia agent ficha.
 *
 * Reads <fichaDir>/mcp.yaml, validates with zod, and resolves spawn parameters
 * (command split, env-var expansion) for each declared MCP server.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface McpServerConfig {
  readonly name: string;
  /** Raw command string, e.g. "npx -y @modelcontextprotocol/server-linear" */
  readonly command: string;
  /** Env values; $-prefixed strings are expanded from process.env at resolve time */
  readonly env?: Record<string, string>;
}

export interface ResolvedServerSpawn {
  readonly name: string;
  /** The executable (first token of the original command string) */
  readonly command: string;
  /** Remaining tokens after the executable */
  readonly args: string[];
  /** Fully expanded env vars (missing $VAR causes resolveSpawn to return null) */
  readonly env: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Zod schema
// ---------------------------------------------------------------------------

const mcpServerEntrySchema = z.object({
  // `name` is intentionally optional here so that entries without it parse
  // successfully (zod doesn't throw). The readMcpConfig loop explicitly guards
  // for !entry.name and skips the entry with a warn (SPEC-YAML-5, SC-11).
  // McpServerConfig.name is non-optional; it is only assigned after that guard.
  name: z.string().min(1).optional(),
  command: z.string().min(1),
  env: z.record(z.string()).optional(),
});

const mcpYamlSchema = z.object({
  servers: z.array(mcpServerEntrySchema).optional(),
});

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function warn(msg: string): void {
  process.stderr.write(`[mcp-adapter] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read and parse `<fichaDir>/mcp.yaml`. Returns validated server configs.
 *
 * - Missing file (ENOENT) → returns [].
 * - Server entry without a `name` field → skipped with a warn log (SC-11, SPEC-YAML-5).
 * - Any other read error is re-thrown.
 *
 * @param logger Optional logger for warn messages (injectable for testing).
 */
export async function readMcpConfig(
  fichaDir: string,
  logger: (msg: string) => void = warn,
): Promise<McpServerConfig[]> {
  const filePath = join(fichaDir, "mcp.yaml");
  let raw: string;

  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw err;
  }

  let doc: unknown;
  try {
    doc = parse(raw);
  } catch (cause) {
    throw new Error(`zia: ${filePath} is not valid YAML`, { cause });
  }

  // Treat null / empty document as empty servers list
  if (doc === null || doc === undefined) return [];

  const parsed = mcpYamlSchema.safeParse(doc);
  if (!parsed.success) {
    // Structural violation (e.g. servers: "linear" instead of a list).
    // Warn so operators can diagnose malformed config, then degrade gracefully.
    logger(`${filePath} has an invalid structure: ${parsed.error.message}`);
    return [];
  }

  const entries = parsed.data.servers ?? [];
  const configs: McpServerConfig[] = [];

  for (const entry of entries) {
    if (!entry.name) {
      logger(`server entry missing required "name" field; skipping`);
      continue;
    }
    configs.push({
      name: entry.name,
      command: entry.command,
      env: entry.env,
    });
  }

  return configs;
}

/**
 * Resolve a validated `McpServerConfig` into a `ResolvedServerSpawn` ready for
 * `StdioClientTransport`. Performs command splitting and env-var expansion.
 *
 * Returns `null` when a required `$VAR` is absent from `env` (SPEC-YAML-3, SC-04).
 * The caller should warn+skip the server when this returns null.
 *
 * @param logger Optional logger for warn messages (injectable for testing).
 */
export function resolveSpawn(
  cfg: McpServerConfig,
  env: NodeJS.ProcessEnv,
  logger: (msg: string) => void = warn,
): ResolvedServerSpawn | null {
  // Split command string on spaces (SPEC-YAML-2, SC-09)
  const tokens = cfg.command.split(" ").filter((t) => t.length > 0);
  const command = tokens[0] ?? cfg.command;
  const args = tokens.slice(1);

  // Expand env vars (SPEC-YAML-3).
  // Supports both bare ($VARNAME) and brace (${VARNAME}) forms — W-1.
  const resolvedEnv: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(cfg.env ?? {})) {
    if (rawValue.startsWith("$")) {
      // Strip leading $ and optional surrounding braces to get the var name.
      const inner = rawValue.slice(1);
      const varName =
        inner.startsWith("{") && inner.endsWith("}")
          ? inner.slice(1, -1)
          : inner;
      const expanded = env[varName];
      if (expanded === undefined) {
        logger(
          `env var $${varName} not set for server "${cfg.name}"; server will be skipped`,
        );
        return null;
      }
      resolvedEnv[key] = expanded;
    } else {
      resolvedEnv[key] = rawValue;
    }
  }

  return {
    name: cfg.name,
    command,
    args,
    env: resolvedEnv,
  };
}
