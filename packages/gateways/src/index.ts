/**
 * Public barrel for @zia/gateways.
 *
 * NullAdapter is @internal and intentionally NOT exported here (SPEC-R7).
 * Import it directly from the adapter path in tests:
 *   import { NullAdapter } from "@zia/gateways/src/adapters/null-adapter.ts"
 *
 * GatewayRunner and GatewayRunnerDeps are exported from PR B onward.
 */

// Types
export type {
  Platform,
  ChatType,
  MessageEvent,
  AuthorizationResult,
  SlashCommand,
  RunState,
  ApprovalView,
  GatewayConfig,
  PlatformConfig,
} from "./types.ts";

// Base adapter
export { BaseAdapter } from "./base-adapter.ts";

// Slash command parser
export { resolveCommand } from "./slash-commands.ts";

// Hooks
export type { GatewayHooks } from "./hooks.ts";
export { defaultHooks } from "./hooks.ts";
