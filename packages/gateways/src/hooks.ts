/**
 * hooks.ts — GatewayHooks interface + defaultHooks no-ops (spec §2.6, design §1).
 *
 * Hooks let callers observe or intercept message flow without modifying runner logic.
 * The default no-op implementation is safe to use when no hooks are needed.
 */
import type { MessageEvent } from "./types.ts";

export interface GatewayHooks {
  /**
   * Called before a MessageEvent is processed by the runner.
   * Return false (or a Promise resolving to false) to drop the message.
   * Return true (or void) to allow it through.
   */
  preMessage?(event: MessageEvent): boolean | Promise<boolean> | void | Promise<void>;

  /**
   * Called after the runner sends a response back to the originating adapter.
   */
  postMessage?(event: MessageEvent, reply: string): void | Promise<void>;
}

/**
 * Default no-op hooks — pass-through for all events.
 * Used when GatewayRunner is constructed without an explicit hooks option.
 */
export const defaultHooks: GatewayHooks = {};
