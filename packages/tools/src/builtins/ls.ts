/**
 * ls.ts — Builtin ls tool (SPEC-F1-1..5).
 *
 * Risk level: trivial (read-only directory listing — auto-executes).
 * Declared in agents/_template/POLICIES.md under ## Trivial.
 */

import { createLsToolDefinition } from "@earendil-works/pi-coding-agent";
import type { WrappableTool } from "@zia/callbacks";
import { register } from "../registry.js";
import { wrapDefinition, type SdkToolDefinition } from "./wrap-definition.js";

export function buildLsTool(cwd: string): WrappableTool {
  return wrapDefinition(
    createLsToolDefinition(cwd) as unknown as SdkToolDefinition,
  );
}

register({ name: "ls", build: buildLsTool });
