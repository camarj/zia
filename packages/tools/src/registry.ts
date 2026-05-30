/**
 * registry.ts — Module-level builtin tool registry (ADR-D2-bis, SPEC-F2-1..3).
 *
 * Stores BuiltinDescriptor entries — cwd-bound FACTORY descriptors, not
 * pre-built instances. Import-time side-effects in each builtin file call
 * register({ name, build }) so that createBuiltinTools(cwd) can later
 * call every builder with the REAL per-container cwd.
 *
 * WHY descriptors not instances: cwd is per-container and only known at the
 * composition root (tui.ts). Pre-instantiating at import time would bind
 * the wrong process.cwd() (ADR-D2-bis).
 *
 * clear() is exposed for test teardown only — not for production use.
 */

import type { WrappableTool } from "@zia/callbacks";

// ---------------------------------------------------------------------------
// BuiltinDescriptor — the unit stored in the registry
// ---------------------------------------------------------------------------

export interface BuiltinDescriptor {
  /** Snake-case tool name — must match the WrappableTool.name returned by build(). */
  readonly name: string;
  /** Factory: receives the agent's absolute cwd, returns a WrappableTool. */
  build(cwd: string): WrappableTool;
}

// ---------------------------------------------------------------------------
// Module-level singleton Map (private)
// ---------------------------------------------------------------------------

const _registry = new Map<string, BuiltinDescriptor>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register a builtin descriptor.
 *
 * - Idempotent when called with the SAME object reference (re-import safety).
 * - Throws when a DIFFERENT descriptor with the same name is already registered
 *   (protects against silent shadowing of builtin names).
 */
export function register(descriptor: BuiltinDescriptor): void {
  const existing = _registry.get(descriptor.name);
  if (existing !== undefined && existing !== descriptor) {
    throw new Error(
      `[zia/tools] registry: duplicate builtin name "${descriptor.name}". ` +
        "Each builtin name must be unique.",
    );
  }
  _registry.set(descriptor.name, descriptor);
}

/**
 * Return all registered descriptors as an array snapshot.
 * Mutations to the returned array do NOT affect the registry.
 */
export function getAll(): BuiltinDescriptor[] {
  return [..._registry.values()];
}

/**
 * Return the descriptor for a given name, or undefined if not registered.
 */
export function get(name: string): BuiltinDescriptor | undefined {
  return _registry.get(name);
}

/**
 * Remove all registrations.
 * FOR TEST TEARDOWN ONLY — never call in production code.
 */
export function clear(): void {
  _registry.clear();
}
