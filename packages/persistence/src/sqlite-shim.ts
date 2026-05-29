/**
 * sqlite-shim.ts — ESM→CJS bridge for better-sqlite3 (ADR-7, SPEC-R13).
 *
 * better-sqlite3 is CJS-only (synchronous native bindings cannot be loaded
 * via async ESM dynamic import). This file is the ONLY place in
 * packages/persistence that calls require() or createRequire().
 *
 * All other src files import the Database constructor via this shim:
 *   import Database from "./sqlite-shim.ts";
 *   import type { Database } from "./sqlite-shim.ts";
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Cast to the typed surface so the rest of the codebase gets full type safety
// without pulling in the CJS module resolution path directly.
const Database = require("better-sqlite3") as typeof import("better-sqlite3");

export default Database;
export type { Database } from "better-sqlite3";
