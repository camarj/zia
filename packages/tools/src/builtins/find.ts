/**
 * find.ts — Builtin find tool (SPEC-F1-1..5).
 *
 * Risk level: trivial (read-only filesystem traversal — auto-executes).
 * Declared in agents/_template/POLICIES.md under ## Trivial.
 */

import { createFindToolDefinition } from "@earendil-works/pi-coding-agent";
import type { WrappableTool } from "@zia/callbacks";
import { register } from "../registry.js";
import { wrapDefinition, type SdkToolDefinition } from "./wrap-definition.js";

export function buildFindTool(cwd: string): WrappableTool {
  return wrapDefinition(
    createFindToolDefinition(cwd) as unknown as SdkToolDefinition,
  );
}

register({ name: "find", build: buildFindTool });
