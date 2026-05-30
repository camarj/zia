/**
 * builtins/index.ts — Barrel + createBuiltinTools factory (A.12, SPEC-F1-1, SPEC-F2-4).
 *
 * Side-effect imports below trigger import-time self-registration for all 7
 * file-tool builtins. After these imports resolve, getAll() returns 7 descriptors.
 *
 * createBuiltinTools(cwd, searchFn?) then:
 *  1. Calls each registered descriptor's build(cwd) to produce WrappableTools
 *     bound to the real per-container cwd.
 *  2. If searchFn is provided, appends the search_session tool (which needs
 *     searchFn, not cwd, so it cannot self-register).
 *  3. Returns the complete array ready to be spread into rawTools in tui.ts.
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

export type { SessionSearchFn, SessionMessageHit } from "./search-session.js";

/**
 * Build all builtin WrappableTools for the given agent cwd.
 *
 * @param cwd       Absolute path to the agent's working directory (fichaDir).
 *                  Passed to every file-tool factory so relative paths resolve correctly.
 * @param searchFn  Optional session-search function from SqliteMessageStore.search.
 *                  When provided, the search_session tool is appended to the result.
 *                  When omitted, only the 7 file-tools are returned.
 */
export function createBuiltinTools(
  cwd: string,
  searchFn?: SessionSearchFn,
): WrappableTool[] {
  const fileTools = getAll().map((descriptor) => descriptor.build(cwd));

  if (searchFn !== undefined) {
    return [...fileTools, buildSearchSessionTool(searchFn)];
  }

  return fileTools;
}
