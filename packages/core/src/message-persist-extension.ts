/**
 * message-persist-extension.ts — pi.dev ExtensionFactory that persists every
 * completed message to an injected MessageSink (ADR-D5, SPEC-F4-5).
 *
 * Design invariants:
 *  - @zia/core MUST NOT import @zia/persistence (INV-1). MessageSink is a
 *    structural interface satisfied by SqliteMessageStore without importing it.
 *  - Delivered as an ExtensionFactory so it rides the EXISTING extensionFactories
 *    seam already present in agent.ts:219 — no new options required in @zia/core.
 *  - Registered in the same seam as ziaHeaderExtension (see tui-runner.ts).
 *  - Returns void from the message_end handler (never replaces the message).
 *  - Skips empty content (e.g. pure-tool-call assistant turns with no text block).
 *
 * Message shapes verified from @earendil-works/pi-ai@0.76.0 types.d.ts:
 *  UserMessage:      { role:"user";       content: string | (TextContent|ImageContent)[] }
 *  AssistantMessage: { role:"assistant";   content: (TextContent|ThinkingContent|ToolCall)[] }
 *  ToolResultMessage:{ role:"toolResult";  toolCallId; toolName; content: (TextContent|ImageContent)[] }
 */

import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/**
 * Minimal write-side interface for message persistence.
 *
 * SqliteMessageStore satisfies this structurally so @zia/core needs no import
 * of @zia/persistence. Any object that implements record() qualifies.
 */
export interface MessageSink {
  record(m: {
    sessionKey: string;
    role: string;
    content: string;
    toolName: string | null;
    timestamp: string;
  }): void;
}

// ---------------------------------------------------------------------------
// Internal helpers — AgentMessage structural types (no import from pi-ai needed;
// we use unknown discrimination to stay free of additional SDK imports)
// ---------------------------------------------------------------------------

/**
 * Minimal text-content shape we look for inside message.content arrays.
 * Both UserMessage and ToolResultMessage expose TextContent; AssistantMessage
 * exposes TextContent among other content variants.
 */
interface TextLike {
  type: "text";
  text: string;
}

/**
 * Extract displayable text and metadata from an AgentMessage.
 *
 * Handles all three pi.dev message roles:
 *  - user:       content = string | content-array (TextContent | ImageContent)
 *  - assistant:  content = (TextContent | ThinkingContent | ToolCall)[]
 *  - toolResult: content = (TextContent | ImageContent)[]; has toolName
 *
 * Returns { role, text, toolName }. text is empty string when there is nothing
 * worth persisting (e.g. a pure-thinking or pure-tool-call assistant turn).
 */
function extractText(message: unknown): {
  role: string;
  text: string;
  toolName: string | null;
} {
  if (typeof message !== "object" || message === null) {
    return { role: "unknown", text: "", toolName: null };
  }

  const msg = message as Record<string, unknown>;
  const role = typeof msg["role"] === "string" ? msg["role"] : "unknown";
  const content = msg["content"];
  let text = "";
  let toolName: string | null = null;

  if (role === "user") {
    // content: string | (TextContent | ImageContent)[]
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter((c): c is TextLike => typeof c === "object" && c !== null && (c as Record<string, unknown>)["type"] === "text")
        .map((c) => c.text)
        .join("");
    }
  } else if (role === "assistant") {
    // content: (TextContent | ThinkingContent | ToolCall)[]
    if (Array.isArray(content)) {
      text = content
        .filter((c): c is TextLike => typeof c === "object" && c !== null && (c as Record<string, unknown>)["type"] === "text")
        .map((c) => c.text)
        .join("");
    }
  } else if (role === "toolResult") {
    // content: (TextContent | ImageContent)[]; has toolName
    if (Array.isArray(content)) {
      text = content
        .filter((c): c is TextLike => typeof c === "object" && c !== null && (c as Record<string, unknown>)["type"] === "text")
        .map((c) => c.text)
        .join("");
    }
    if (typeof msg["toolName"] === "string") {
      toolName = msg["toolName"];
    }
  }

  return { role, text, toolName };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a pi.dev ExtensionFactory that persists every completed message via sink.
 *
 * Usage (composition root — tui.ts):
 *   extensionFactories: [messagePersistExtension(messageStore, sessionKey)]
 *
 * The factory subscribes to "message_end" events. For each event:
 *  - Extracts text + metadata from the AgentMessage.
 *  - Skips empty content (returns early without calling sink.record).
 *  - Calls sink.record() with sessionKey, role, content, toolName, ISO timestamp.
 *
 * The handler returns void — it never replaces or modifies the message.
 *
 * @param sink       Object with a record() method (SqliteMessageStore satisfies this).
 * @param sessionKey Stable key identifying this agent session (e.g. "tui:_template").
 */
export function messagePersistExtension(
  sink: MessageSink,
  sessionKey: string,
): ExtensionFactory {
  return (pi: ExtensionAPI): void => {
    pi.on("message_end", (ev) => {
      const { role, text, toolName } = extractText(ev.message);

      // Skip empty content — pure tool-call assistant turns or messages with
      // no text produce an empty string. Persisting them adds noise without value.
      if (!text) {
        return;
      }

      const rawTimestamp = (ev.message as { timestamp?: unknown }).timestamp;
      const timestamp = new Date(
        typeof rawTimestamp === "number" ? rawTimestamp : Date.now(),
      ).toISOString();

      sink.record({ sessionKey, role, content: text, toolName, timestamp });
    });
  };
}
