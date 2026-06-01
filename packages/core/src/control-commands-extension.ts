/**
 * control-commands-extension.ts — pi.dev ExtensionFactory that registers
 * the four zia control slash commands (F-CORE-10, SPEC-CMD-1..4).
 *
 * Commands registered:
 *  /model   — list or switch the active LLM (SPEC-CMD-1)
 *  /memory  — show MEMORY.md contents (SPEC-CMD-2)
 *  /status  — show agent status: model, spend, budget, etc. (SPEC-CMD-3)
 *  /help    — list all registered slash commands via pi.getCommands() (SPEC-CMD-4)
 *
 * Design invariants:
 *  - @zia/core MUST NOT import @zia/persistence (INV-1). MonthlySpendStore is
 *    imported as a type-only reference from budget-extension.ts where it is
 *    declared as a structural interface.
 *  - Always injected regardless of whether a budget is configured (SPEC-EXT-1-B).
 *  - store is optional — /status degrades gracefully if absent (SPEC-CMD-3-C).
 *  - pi.setModel() is async and may return false when the chosen model lacks
 *    API credentials after the auth realignment (lazy available[] auth, fix #36).
 *    Handled as a graceful error message (SPEC-CMD-1-D).
 *
 * Output pattern: command handlers call pi.sendMessage({ customType, content,
 * display: true }) to surface output in all modes (TUI / print / RPC).
 * The handler return type is Promise<void> per pi.dev RegisteredCommand contract.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionFactory,
  SlashCommandInfo,
} from "@earendil-works/pi-coding-agent";

import type { MonthlySpendStore } from "./budget-extension.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Model entry as it appears on handle.scopedModels (also mirrors ResolvedModelEntry
 * from @zia/providers — ControlCommandsExtension owns this locally to avoid
 * cross-package imports for the structural fields it needs).
 */
export interface AvailableModelEntry {
  model: { id: string; provider: string };
  thinkingLevel?: "off" | "low" | "medium" | "high";
  label?: string;
  modelId: string;
}

export interface ControlCommandsExtensionOpts {
  /** Path to the agent's ficha directory (MEMORY.md is read from here). */
  fichaDir: string;
  /**
   * List of all models in the switch menu. Populated from handle.scopedModels
   * at the composition root. Used by /model to list and switch.
   */
  availableModels: AvailableModelEntry[];
  /** Agent identifier (from profile.yaml agent.id, or slug fallback). */
  agentId: string;
  /**
   * Monthly budget in USD (from ficha llm.monthly_budget_usd).
   * Optional — /status shows "(not set)" when absent.
   */
  budgetUsd?: number;
  /**
   * Monthly spend store for /status live spend read.
   * Optional — /status degrades gracefully (shows $0.00 with no-store note).
   */
  store?: MonthlySpendStore;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Fuzzy-match a user arg against model entries.
 * Matches if entry.modelId or entry.label contains the arg (case-insensitive).
 * Returns the first match, or undefined if none.
 */
function fuzzyMatch(
  arg: string,
  models: AvailableModelEntry[],
): AvailableModelEntry | undefined {
  const lower = arg.trim().toLowerCase();
  if (!lower) return undefined;
  return models.find(
    (m) =>
      m.modelId.toLowerCase().includes(lower) ||
      (m.label ?? "").toLowerCase().includes(lower),
  );
}

/**
 * Format a single model entry for display in /model output.
 */
function formatModelEntry(entry: AvailableModelEntry, isActive: boolean): string {
  const active = isActive ? " [active]" : "";
  const label = entry.label ? ` — ${entry.label}` : "";
  const thinking = entry.thinkingLevel ? ` (thinking: ${entry.thinkingLevel})` : "";
  return `  ${entry.modelId}${label}${thinking}${active}`;
}

/**
 * Produce the full model-list string. Used for /model with no args and
 * for /model <no-match> fallback.
 */
function buildModelList(
  models: AvailableModelEntry[],
  activeModelId: string,
  prefix = "",
): string {
  const lines = models.map((m) => formatModelEntry(m, m.modelId === activeModelId));
  return `${prefix}Available models:\n${lines.join("\n")}`;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a pi.dev ExtensionFactory that registers the four zia control commands.
 *
 * Always injected at the composition root (createZiaAgent), regardless of whether
 * a budget is configured (SPEC-EXT-1-B).
 *
 * Usage (composition root — agent.ts):
 *   const factory = createControlCommandsExtension({ fichaDir, availableModels,
 *     agentId, budgetUsd, store });
 *   allExtensionFactories.push(factory);
 */
export function createControlCommandsExtension(
  opts: ControlCommandsExtensionOpts,
): ExtensionFactory {
  const { fichaDir, availableModels, agentId, budgetUsd, store } = opts;

  return (pi: ExtensionAPI): void => {
    // -----------------------------------------------------------------------
    // /model — list available models or switch to a named one (SPEC-CMD-1)
    // -----------------------------------------------------------------------
    pi.registerCommand("model", {
      description: "Switch or list available models. Usage: /model [name]",
      handler: async (args: string, _ctx: ExtensionCommandContext): Promise<void> => {
        const thinkingLevel = pi.getThinkingLevel();
        void thinkingLevel; // read for /status; not used here directly

        // Determine active model ID from the current session.
        // pi.getThinkingLevel() is always available; for the model id we try
        // getCurrentModel() if the SDK exposes it (not typed on ExtensionAPI but
        // present at runtime), then fall back to availableModels[0].
        const piAny = pi as unknown as Record<string, unknown>;
        const currentModel =
          typeof piAny["getCurrentModel"] === "function"
            ? (piAny["getCurrentModel"] as () => { id: string })()
            : undefined;
        const activeModelId = currentModel?.id ?? availableModels[0]?.modelId ?? "";

        const trimmed = args.trim();

        // No args → list all models, mark active
        if (!trimmed) {
          const text = buildModelList(availableModels, activeModelId);
          pi.sendMessage({
            customType: "zia:model-list",
            content: text,
            display: true,
            details: { activeModelId, availableModels: availableModels.length },
          });
          return;
        }

        // Try to match the arg
        const match = fuzzyMatch(trimmed, availableModels);
        if (!match) {
          const text = `No match for "${trimmed}".\n${buildModelList(availableModels, activeModelId)}`;
          pi.sendMessage({
            customType: "zia:model-no-match",
            content: text,
            display: true,
            details: { query: trimmed },
          });
          return;
        }

        // Attempt the switch — setModel is async and returns false on missing creds
        const success = await pi.setModel(match.model as never);
        if (success === false) {
          const text =
            `Error: cannot switch to "${match.modelId}" — missing API key or credentials. ` +
            `Ensure the provider's credential env var is set and the agent is restarted.`;
          pi.sendMessage({
            customType: "zia:model-switch-error",
            content: text,
            display: true,
            details: { modelId: match.modelId, reason: "missing-api-key" },
          });
          return;
        }

        const labelPart = match.label ? ` (${match.label})` : "";
        const text = `Switched to ${match.modelId}${labelPart}.`;
        pi.sendMessage({
          customType: "zia:model-switched",
          content: text,
          display: true,
          details: { modelId: match.modelId },
        });
      },
    });

    // -----------------------------------------------------------------------
    // /memory — show MEMORY.md contents (SPEC-CMD-2)
    // -----------------------------------------------------------------------
    pi.registerCommand("memory", {
      description: "Show the agent's MEMORY.md file contents.",
      handler: async (_args: string, _ctx: ExtensionCommandContext): Promise<void> => {
        const memoryPath = join(fichaDir, "MEMORY.md");
        let content: string;
        try {
          content = await readFile(memoryPath, "utf8");
        } catch {
          pi.sendMessage({
            customType: "zia:memory",
            content: "(MEMORY.md not found)",
            display: true,
            details: { path: memoryPath, found: false },
          });
          return;
        }

        const trimmed = content.trim();
        if (!trimmed) {
          pi.sendMessage({
            customType: "zia:memory",
            content: "(MEMORY.md is empty)",
            display: true,
            details: { path: memoryPath, found: true, empty: true },
          });
          return;
        }

        pi.sendMessage({
          customType: "zia:memory",
          content,
          display: true,
          details: { path: memoryPath, found: true, empty: false },
        });
      },
    });

    // -----------------------------------------------------------------------
    // /status — agent status: model, thinking level, spend, budget (SPEC-CMD-3)
    // -----------------------------------------------------------------------
    pi.registerCommand("status", {
      description: "Show agent status: model, thinking level, spend, and budget.",
      handler: async (_args: string, _ctx: ExtensionCommandContext): Promise<void> => {
        const piAny = pi as unknown as Record<string, unknown>;
        const currentModel =
          typeof piAny["getCurrentModel"] === "function"
            ? (piAny["getCurrentModel"] as () => { id: string })()
            : undefined;
        const activeModelId = currentModel?.id ?? availableModels[0]?.modelId ?? "(unknown)";
        const activeEntry = availableModels.find((m) => m.modelId === activeModelId);
        const activeLabel = activeEntry?.label ?? activeModelId;

        const thinkingLevel = pi.getThinkingLevel();

        const currentYm = new Date().toISOString().slice(0, 7);
        const monthlySpend = store ? store.getSpend(agentId, currentYm) : 0;

        const spendStr = `$${monthlySpend.toFixed(2)}`;

        // Free-model indicator: spend is $0 and either no store or no budget
        const isFreeModel = monthlySpend === 0 && (!store || !budgetUsd);
        const freeModelNote = isFreeModel ? " (free model — $0.00/turn)" : "";

        const budgetStr =
          budgetUsd !== undefined && budgetUsd > 0
            ? `$${budgetUsd.toFixed(2)}`
            : "(not set)";

        const percentStr =
          budgetUsd !== undefined && budgetUsd > 0
            ? `${((monthlySpend / budgetUsd) * 100).toFixed(1)}%`
            : "(N/A)";

        const lines = [
          `Agent ID:       ${agentId}`,
          `Model:          ${activeModelId}${activeLabel !== activeModelId ? ` (${activeLabel})` : ""}`,
          `Thinking level: ${thinkingLevel}`,
          `Monthly spend:  ${spendStr}${freeModelNote}`,
          `Monthly budget: ${budgetStr}`,
          `Spend %:        ${percentStr}`,
          `Period:         ${currentYm}`,
        ];

        const text = lines.join("\n");
        pi.sendMessage({
          customType: "zia:status",
          content: text,
          display: true,
          details: {
            agentId,
            activeModelId,
            thinkingLevel,
            monthlySpend,
            budgetUsd,
            percentStr,
            period: currentYm,
          },
        });
      },
    });

    // -----------------------------------------------------------------------
    // /help — list all registered commands via pi.getCommands() (SPEC-CMD-4)
    // -----------------------------------------------------------------------
    pi.registerCommand("help", {
      description: "List all available slash commands.",
      handler: async (_args: string, _ctx: ExtensionCommandContext): Promise<void> => {
        const commands: SlashCommandInfo[] = pi.getCommands();
        let text: string;
        if (!commands || commands.length === 0) {
          text = "No slash commands are registered.";
        } else {
          const lines = commands.map(
            (cmd) => `  /${cmd.name}${cmd.description ? ` — ${cmd.description}` : ""}`,
          );
          text = `Available commands:\n${lines.join("\n")}`;
        }

        pi.sendMessage({
          customType: "zia:help",
          content: text,
          display: true,
          details: { commandCount: commands?.length ?? 0 },
        });
      },
    });
  };
}
