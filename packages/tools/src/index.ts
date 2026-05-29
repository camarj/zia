// Public API for @zia/tools.
// PR-1: config types.
// PR-2: createMcpAdapter + McpAdapterHandle (WU-8).
// PR-3: toSchema exposed for spike verification and downstream consumers.
export type { McpServerConfig, ResolvedServerSpawn } from "./config/mcp-config.js";
export { createMcpAdapter } from "./adapters/mcp-adapter.js";
export type { McpAdapterHandle, CreateMcpAdapterOptions, ServerBootReport } from "./adapters/mcp-adapter.js";
export { toSchema } from "./adapters/schema-bridge.js";
