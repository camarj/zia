/**
 * mcp-adapter.ts — Boot orchestration: read mcp.yaml → spawn servers → list tools → build WrappableTools.
 *
 * Entry point for the zia runtime. Call `createMcpAdapter(fichaDir)` before `createZiaAgent`
 * and pass `handle.tools` into `rawTools`.
 *
 * SPEC-API-1: McpAdapterHandle — tools, servers boot report, dispose().
 * SPEC-API-2: createMcpAdapter(fichaDir) convenience overload.
 * SPEC-ERR-1: Boot failure → warn + skip; other servers continue.
 * SPEC-LIFE-1..3: spawn → listTools → dispose lifecycle.
 * SPEC-L2-1: Layer 2 (dynamic toolset routing) is out of scope — see comment below.
 *
 * Drive and Slack are declared-but-not-validated in MVP. The adapter code path
 * for those servers is identical to Linear/Notion (config-driven, no server-specific code).
 *
 * Layer 2 (dynamic toolset routing via setActiveTools) is not implemented here.
 * setActiveTools is only available on ExtensionAPI, not on AgentSession/AgentSessionRuntime
 * or any surface reachable from createZiaAgent. Deferred to a future phase that either
 * (a) registers tools as a pi.dev extension, or (b) re-creates the session with a filtered
 * tool set. See sdd/mcp-adapter proposal for full rationale.
 */

import type { WrappableTool } from "@zia/callbacks";
import { readMcpConfig, resolveSpawn } from "../config/mcp-config.ts";
import type { ResolvedServerSpawn } from "../config/mcp-config.ts";
import { connectServer } from "./mcp-server.ts";
import type { McpServerClient } from "./mcp-server.ts";
import { buildWrappableTool } from "./tool-factory.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Per-server boot outcome recorded in McpAdapterHandle.servers. */
export interface ServerBootReport {
  readonly name: string;
  readonly ok: boolean;
  readonly toolCount: number;
  readonly error?: string;
}

/**
 * Handle returned by createMcpAdapter.
 * Pass `tools` into `createZiaAgent` rawTools; call `dispose()` at teardown.
 */
export interface McpAdapterHandle {
  /** WrappableTool[] ready to pass to createZiaAgent rawTools. */
  readonly tools: WrappableTool[];
  /** Per-server boot outcomes for diagnostics. Extension beyond SPEC-API-1 — added per design §2. */
  readonly servers: ReadonlyArray<ServerBootReport>;
  /** Close all MCP client connections and subprocesses. Idempotent. */
  dispose(): Promise<void>;
}

/**
 * Options for createMcpAdapter (full form).
 */
export interface CreateMcpAdapterOptions {
  /** Absolute path to the agent's ficha directory (contains mcp.yaml). */
  readonly fichaDir: string;
  /** Environment to use for $VAR expansion. Defaults to process.env. */
  readonly env?: NodeJS.ProcessEnv;
  /** Logger for warn messages. Defaults to process.stderr. */
  readonly logger?: (msg: string) => void;
}

/**
 * Internal seam for testing: override the connectServer function.
 * Production callers never need this.
 */
export interface CreateMcpAdapterInternals {
  connectServerFn?: (spawn: ResolvedServerSpawn) => Promise<McpServerClient>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convenience overload: pass just the ficha directory path.
 * Uses process.env for expansion and process.stderr for warnings.
 */
export async function createMcpAdapter(fichaDir: string): Promise<McpAdapterHandle>;

/**
 * Full-options overload: injectable env and logger (used in tests).
 */
export async function createMcpAdapter(
  opts: CreateMcpAdapterOptions,
  internals?: CreateMcpAdapterInternals,
): Promise<McpAdapterHandle>;

export async function createMcpAdapter(
  fichaOrOpts: string | CreateMcpAdapterOptions,
  internals: CreateMcpAdapterInternals = {},
): Promise<McpAdapterHandle> {
  const opts: CreateMcpAdapterOptions =
    typeof fichaOrOpts === "string" ? { fichaDir: fichaOrOpts } : fichaOrOpts;

  const env = opts.env ?? process.env;
  const logger = opts.logger ?? ((msg: string) => process.stderr.write(`[mcp-adapter] ${msg}\n`));
  const connectFn = internals.connectServerFn ?? connectServer;

  // ---------------------------------------------------------------------------
  // 1. Read and validate mcp.yaml
  // ---------------------------------------------------------------------------
  const configs = await readMcpConfig(opts.fichaDir, logger);

  if (configs.length === 0) {
    return emptyHandle();
  }

  // ---------------------------------------------------------------------------
  // 2. Spawn servers in parallel (Promise.allSettled — one slow server must not block others)
  // ---------------------------------------------------------------------------
  const allTools: WrappableTool[] = [];
  const bootReports: ServerBootReport[] = [];
  const openClients: McpServerClient[] = [];

  const bootResults = await Promise.allSettled(
    configs.map(async (cfg) => {
      // Resolve spawn parameters (command split + env expansion).
      // resolveSpawn returns null when a required $VAR is missing.
      const spawn = resolveSpawn(cfg, env, logger);
      if (spawn === null) {
        // resolveSpawn already logged the warn; just skip.
        return { name: cfg.name, client: null as McpServerClient | null, tools: [] as WrappableTool[], skipped: true };
      }

      const client = await connectFn(spawn); // throws on connect failure
      const descriptors = await client.listTools();
      const tools = descriptors.map((desc) => buildWrappableTool(cfg.name, desc, client));

      return { name: cfg.name, client, tools, skipped: false };
    }),
  );

  for (let i = 0; i < bootResults.length; i++) {
    const result = bootResults[i]!;
    const cfg = configs[i]!;

    if (result.status === "fulfilled") {
      const { name, client, tools, skipped } = result.value;
      if (skipped) {
        // Missing env var — already warned by resolveSpawn; record as skip
        bootReports.push({ name, ok: false, toolCount: 0, error: "env var not set; skipped" });
      } else {
        allTools.push(...tools);
        if (client !== null) openClients.push(client);
        bootReports.push({ name, ok: true, toolCount: tools.length });
      }
    } else {
      // connect rejected — SPEC-ERR-1: warn + skip
      const errorMsg = result.reason instanceof Error ? result.reason.message : String(result.reason);
      logger(`server "${cfg.name}" failed to start; skipping. Reason: ${errorMsg}`);
      bootReports.push({ name: cfg.name, ok: false, toolCount: 0, error: errorMsg });
    }
  }

  // ---------------------------------------------------------------------------
  // 3. Build and return the handle
  // ---------------------------------------------------------------------------
  let disposed = false;

  return {
    tools: allTools,
    servers: bootReports,

    async dispose(): Promise<void> {
      if (disposed) return; // idempotent guard (SPEC-LIFE-3)
      disposed = true;

      await Promise.allSettled(
        openClients.map(async (client) => {
          try {
            await client.close();
          } catch (err) {
            // SPEC-LIFE-3: individual close errors are caught and swallowed
            const msg = err instanceof Error ? err.message : String(err);
            logger(`dispose: client "${client.name}" close error (ignored): ${msg}`);
          }
        }),
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function emptyHandle(): McpAdapterHandle {
  return {
    tools: [],
    servers: [],
    dispose: async () => {},
  };
}
