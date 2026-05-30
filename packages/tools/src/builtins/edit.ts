/**
 * edit.ts — Builtin edit tool (SPEC-F1-1..5).
 *
 * Risk level: alto (mutates files — always needs human approval).
 * Declared in agents/_template/POLICIES.md under ## Alto.
 */

import { createEditToolDefinition } from "@earendil-works/pi-coding-agent";
import type { WrappableTool } from "@zia/callbacks";
import { register } from "../registry.js";
import { wrapDefinition, type SdkToolDefinition } from "./wrap-definition.js";

export function buildEditTool(cwd: string): WrappableTool {
  return wrapDefinition(
    createEditToolDefinition(cwd) as unknown as SdkToolDefinition,
  );
}

register({ name: "edit", build: buildEditTool });
