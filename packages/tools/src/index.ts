// Public API for @zia/tools.
// PR-1: config types.
// PR-2: createMcpAdapter + McpAdapterHandle (WU-8).
// PR-3: toSchema exposed for spike verification and downstream consumers.
export type { McpServerConfig, ResolvedServerSpawn } from "./config/mcp-config.js";
export { createMcpAdapter } from "./adapters/mcp-adapter.js";
export type { McpAdapterHandle, CreateMcpAdapterOptions, ServerBootReport } from "./adapters/mcp-adapter.js";

/**
 * @internal
 * Unstable adapter-internal API exposed for spike/verification in apps/agent-runtime
 * (which cannot import it from inside @zia/tools directly because those tests depend
 * on @earendil-works/pi-coding-agent, which @zia/tools MUST NOT depend on per SPEC-PKG-3).
 * Not a public contract — may be removed or changed without a semver bump.
 */
export { toSchema } from "./adapters/schema-bridge.js";
