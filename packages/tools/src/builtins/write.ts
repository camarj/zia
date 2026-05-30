/**
 * write.ts — Builtin write tool (SPEC-F1-1..5).
 *
 * Risk level: alto (creates/overwrites files — always needs human approval).
 * Declared in agents/_template/POLICIES.md under ## Alto.
 */

import { createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import type { WrappableTool } from "@zia/callbacks";
import { register } from "../registry.js";
import { wrapDefinition, type SdkToolDefinition } from "./wrap-definition.js";

export function buildWriteTool(cwd: string): WrappableTool {
  return wrapDefinition(
    createWriteToolDefinition(cwd) as unknown as SdkToolDefinition,
  );
}

register({ name: "write", build: buildWriteTool });
