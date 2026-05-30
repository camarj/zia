/**
 * read.ts — Builtin read tool (SPEC-F1-1..5).
 *
 * Wraps pi.dev's createReadToolDefinition factory so the tool flows through
 * zia's governance gate (wrapToolsWithApproval) just like every other builtin.
 * Import-time side-effect: register({ name, build }) (ADR-D2-bis).
 */

import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import type { WrappableTool } from "@zia/callbacks";
import { register } from "../registry.js";
import { wrapDefinition, type SdkToolDefinition } from "./wrap-definition.js";

export function buildReadTool(cwd: string): WrappableTool {
  return wrapDefinition(
    createReadToolDefinition(cwd) as unknown as SdkToolDefinition,
  );
}

// Import-time self-registration (Hermes pattern §9.7 / ADR-D2-bis).
// Registry stores the descriptor; createBuiltinTools(cwd) calls build(cwd).
register({ name: "read", build: buildReadTool });
