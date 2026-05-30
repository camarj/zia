/**
 * grep.ts — Builtin grep tool (SPEC-F1-1..5).
 *
 * Risk level: trivial (read-only search — auto-executes, only notifies).
 * Declared in agents/_template/POLICIES.md under ## Trivial.
 */

import { createGrepToolDefinition } from "@earendil-works/pi-coding-agent";
import type { WrappableTool } from "@zia/callbacks";
import { register } from "../registry.js";
import { wrapDefinition, type SdkToolDefinition } from "./wrap-definition.js";

export function buildGrepTool(cwd: string): WrappableTool {
  return wrapDefinition(
    createGrepToolDefinition(cwd) as unknown as SdkToolDefinition,
  );
}

register({ name: "grep", build: buildGrepTool });
