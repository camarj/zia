/**
 * bash.ts — Builtin bash tool (SPEC-F1-1..5).
 *
 * Risk level: alto (runs arbitrary shell commands — always needs human approval).
 * Declared in agents/_template/POLICIES.md under ## Alto.
 */

import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import type { WrappableTool } from "@zia/callbacks";
import { register } from "../registry.js";
import { wrapDefinition, type SdkToolDefinition } from "./wrap-definition.js";

export function buildBashTool(cwd: string): WrappableTool {
  return wrapDefinition(
    createBashToolDefinition(cwd) as unknown as SdkToolDefinition,
  );
}

register({ name: "bash", build: buildBashTool });
