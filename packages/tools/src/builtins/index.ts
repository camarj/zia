/**
 * builtins/index.ts — Barrel + createBuiltinTools factory (A.12, SPEC-F1-1, SPEC-F2-4,
 * SPEC-TOOL-6, SPEC-TOOL-7).
 *
 * Side-effect imports below trigger import-time self-registration for all 7
 * file-tool builtins. After these imports resolve, getAll() returns 7 descriptors.
 *
 * createBuiltinTools(cwd, opts?) then:
 *  1. Calls each registered descriptor's build(cwd) to produce WrappableTools
 *     bound to the real per-container cwd.
 *  2. If opts.searchFn is provided, appends the search_session tool.
 *  3. If opts.memoryWriteFn is provided, appends the write_memory tool.
 *  4. If opts.memorySearchFn is provided, appends the search_memory tool.
 *  5. Returns the complete array ready to be spread into rawTools in tui.ts.
 *
 * The old positional second argument (searchFn?) has been removed. All callers
 * must use the options-object form (SPEC-TOOL-6, SPEC-WIRE-2).
 */

// Trigger import-time self-registration for the 7 file-tool builtins.
import "./read.js";
import "./bash.js";
import "./edit.js";
import "./write.js";
import "./grep.js";
import "./find.js";
import "./ls.js";

import type { WrappableTool } from "@zia/callbacks";
import { getAll } from "../registry.js";
import { buildSearchSessionTool, type SessionSearchFn } from "./search-session.js";
import { buildWriteMemoryTool, type MemoryWriteFn } from "./write-memory.js";
import { buildSearchMemoryTool, type MemorySearchFn, type MemoryHit } from "./search-memory.js";

export type { SessionSearchFn, SessionMessageHit } from "./search-session.js";
export type { MemoryWriteFn } from "./write-memory.js";
export type { MemorySearchFn, MemoryHit } from "./search-memory.js";

// ---------------------------------------------------------------------------
// Options type (SPEC-TOOL-7)
// ---------------------------------------------------------------------------

/**
 * Options bag for createBuiltinTools. Each fn is optional — when absent the
 * corresponding tool is not appended to the returned array.
 */
export interface BuiltinToolsOptions {
  /** Session search function (was the second positional arg before migration). */
  searchFn?: SessionSearchFn;
  /** Memory write function — when provided, write_memory tool is appended. */
  memoryWriteFn?: MemoryWriteFn;
  /** Memory search function — when provided, search_memory tool is appended. */
  memorySearchFn?: MemorySearchFn;
}


// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build all builtin WrappableTools for the given agent cwd.
 *
 * @param cwd   Absolute path to the agent's working directory (fichaDir).
 *              Passed to every file-tool factory so relative paths resolve correctly.
 * @param opts  Optional bag of injected functions. Each fn unlocks one additional
 *              tool:
 *              - opts.searchFn      → search_session
 *              - opts.memoryWriteFn → write_memory
 *              - opts.memorySearchFn → search_memory
 */
export function createBuiltinTools(
  cwd: string,
  opts?: BuiltinToolsOptions,
): WrappableTool[] {
  const fileTools = getAll().map((descriptor) => descriptor.build(cwd));
  const extras: WrappableTool[] = [];

  if (opts?.searchFn !== undefined) {
    extras.push(buildSearchSessionTool(opts.searchFn));
  }

  if (opts?.memoryWriteFn !== undefined) {
    extras.push(buildWriteMemoryTool(opts.memoryWriteFn));
  }

  if (opts?.memorySearchFn !== undefined) {
    extras.push(buildSearchMemoryTool(opts.memorySearchFn));
  }

  return [...fileTools, ...extras];
}
