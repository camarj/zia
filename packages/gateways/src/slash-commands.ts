/**
 * slash-commands.ts — Pure command parser (SC-09..SC-16, SPEC-R8 partial).
 *
 * resolveCommand() has zero side effects and zero external dependencies.
 * It is the only place that maps raw text to a typed SlashCommand.
 * The runner enforces SPEC-R8 (slash text never reaches the agent).
 */
import type { SlashCommand } from "./types.ts";

/**
 * Parse text for a recognized slash command.
 *
 * Returns a typed SlashCommand if text matches a known command, or null if
 * the text is a plain user message (or an unknown slash command).
 *
 * Does NOT mutate state. Pure function.
 */
export function resolveCommand(text: string): SlashCommand | null {
  const trimmed = text.trim();

  if (!trimmed.startsWith("/")) return null;

  // Split into command token and optional rest
  const spaceIdx = trimmed.indexOf(" ");
  const cmd = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

  switch (cmd) {
    case "/stop":
      return { kind: "stop" };

    case "/new":
      return { kind: "new" };

    case "/queue":
      return { kind: "queue" };

    case "/status":
      return { kind: "status" };

    case "/approve":
      if (!rest) return null;
      return { kind: "approve", id: rest };

    case "/deny":
      if (!rest) return null;
      return { kind: "deny", id: rest };

    case "/model":
      if (!rest) return null;
      return { kind: "model", name: rest };

    default:
      return null;
  }
}
