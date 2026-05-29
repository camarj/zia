/**
 * types.ts — Core gateway types (spec §2.1, design §1).
 *
 * All types are channel-agnostic. No platform-specific imports allowed.
 * SPEC-R2: nothing here imports @zia/core or the pi.dev SDK. The RiskLevel
 * type below is a type-only import from @zia/callbacks (the canonical source),
 * which is permitted — SPEC-R2 only bans @zia/core and the pi.dev SDK.
 */
import type { RiskLevel } from "@zia/callbacks";

// ---------------------------------------------------------------------------
// Primitive type aliases
// ---------------------------------------------------------------------------

/** Platform identifier — e.g. "slack", "email", "null". Never contains ":". */
export type Platform = string;

/** Chat category used in session-key construction. */
export type ChatType = "dm" | "channel" | "thread" | "group";

// ---------------------------------------------------------------------------
// MessageEvent — unified inbound message from any channel (Hermes §4)
// ---------------------------------------------------------------------------

export interface MessageEvent {
  /** Platform identifier — matches the adapter's platform field. */
  readonly platform: Platform;
  /** Chat category for session-key construction. */
  readonly chatType: ChatType;
  /** Channel/thread/DM identifier within the platform. */
  readonly chatId: string;
  /** Globally unique sender identifier within the platform. */
  readonly senderId: string;
  /** Human-readable text body of the message. */
  readonly text: string;
  /**
   * Optional opaque parent thread reference for platforms that thread natively.
   * Runner uses this for thread-aware session key construction.
   */
  readonly threadContext?: string;
  /** Adapter-private passthrough — runner never reads this. */
  readonly raw?: unknown;
}

// ---------------------------------------------------------------------------
// AuthorizationResult — outcome of the layered auth check (spec §3 / ADR-2)
// ---------------------------------------------------------------------------

export type AuthorizationResult =
  | { readonly authorized: true }
  | { readonly authorized: false; readonly reason: string };

// ---------------------------------------------------------------------------
// SlashCommand — typed union of all intercepted control commands (spec §2.5)
// ---------------------------------------------------------------------------

export type SlashCommand =
  | { kind: "stop" }
  | { kind: "new" }
  | { kind: "queue" }
  | { kind: "status" }
  | { kind: "approve"; id: string }
  | { kind: "deny"; id: string }
  | { kind: "model"; name: string };

// ---------------------------------------------------------------------------
// RunState — observable state of an active run (L2 registry value)
// ---------------------------------------------------------------------------

export type RunState = "streaming" | "idle" | "compacting";

// ---------------------------------------------------------------------------
// ApprovalView — sanitized approval request surfaced to the channel (ADR-4)
//
// IMPORTANT: this is a SANITIZED view — it contains NO raw params object.
// ADR-4 mandates a pre-formatted summary string so channel code never sees
// the raw tool parameters. The spec §2.7 ApprovalRequest shape (from
// @zia/callbacks) is the internal shape; this is the channel-facing view.
// ---------------------------------------------------------------------------

export interface ApprovalView {
  /** toolCallId — opaque to the channel; used for /approve <id> routing. */
  readonly id: string;
  readonly toolName: string;
  /** Canonical risk classification — single source of truth in @zia/callbacks. */
  readonly riskLevel: RiskLevel;
  /** Pre-rendered human-readable summary. No raw params object exposed. */
  readonly summary: string;
}

// ---------------------------------------------------------------------------
// GatewayConfig — injected at GatewayRunner construction
// ---------------------------------------------------------------------------

export interface GatewayConfig {
  /** Global allow-all — bypasses all per-platform checks. */
  readonly allowAll?: boolean;
  /** Per-platform authorization overrides. */
  readonly platforms?: Record<Platform, PlatformConfig>;
}

export interface PlatformConfig {
  /** If true, every sender on this platform is authorized without further checks. */
  readonly allowAll?: boolean;
  /** Explicit allowlist of sender IDs — checked if allowAll is false. */
  readonly allowedUsers?: readonly string[];
}
