/**
 * Public API for @zia/tools.
 *
 * PR-1: config types.
 * PR-2: createMcpAdapter + McpAdapterHandle.
 * PR-3: toSchema (adapter-internal, unstable).
 * PR-A (core-tools): createBuiltinTools, registry namespace, search types.
 *
 * @internal note on SDK dependency (ADR-D4):
 * SPEC-PKG-3 ("tools must be SDK-free") is superseded for the builtins layer.
 * @earendil-works/pi-coding-agent is imported ONLY in src/builtins/*.ts files.
 * src/adapters/* (MCP adapter) remains SDK-free and independently testable.
 */

export type { McpServerConfig, ResolvedServerSpawn } from "./config/mcp-config.js";
export { createMcpAdapter } from "./adapters/mcp-adapter.js";
export type { McpAdapterHandle, CreateMcpAdapterOptions, ServerBootReport } from "./adapters/mcp-adapter.js";

// Builtin tools — createBuiltinTools + search injection types (ADR-D2-bis, ADR-D3)
export { createBuiltinTools } from "./builtins/index.js";
export type { SessionSearchFn, SessionMessageHit } from "./builtins/search-session.js";

// Registry namespace — discover/clear registered builtin descriptors
export { register, getAll, get, clear } from "./registry.js";
export type { BuiltinDescriptor } from "./registry.js";

/**
 * @internal
 * Unstable adapter-internal API exposed for spike/verification in apps/agent-runtime.
 * Not a public contract — may be removed or changed without a semver bump.
 */
export { toSchema } from "./adapters/schema-bridge.js";
