---
name: zia-architecture
description: zia framework architecture conventions — package boundaries, naming, the loop, what goes where. Use when adding a new package, gateway, tool, or making any architectural decision. Triggers on mentions of "where should this go", "new package", "architecture", or when editing files across more than one package.
---

# zia architecture conventions

zia mirrors Hermes Agent's separation of responsibilities in TypeScript on top of pi.dev SDK. The architecture is intentionally similar so anyone who knows Hermes can navigate zia quickly.

## Package boundaries

| Package | Responsibility | What NEVER goes here |
|---|---|---|
| `packages/core` | Agent loop, prompt builder, memory manager, cache | Channel-specific code, tool implementations |
| `packages/tools` | Registry, MCP adapter, approval flow, builtin tools | Anything that depends on a specific gateway |
| `packages/gateways` | Channel platforms (IMAP/SMTP, Slack, HTTP) | Tool implementations, LLM provider logic |
| `packages/providers` | LLM provider resolver, credentials | Tool execution, gateway logic |
| `packages/memory` | Memory providers (file-based, sqlite-fts) | Prompt assembly (that's `core`) |
| `packages/cron` | Scheduler, jobs.json parsing | Tool execution (delegate to `core`) |
| `packages/persistence` | SQLite + FTS5 layer | Business logic |
| `packages/callbacks` | Approval queue, clarify, observability | Anything specific to a tool or gateway |

## The golden rules

1. **Never call pi.dev SDK directly from gateways or apps.** Always go through `packages/core/agent.ts`. The wrapper hides version drift and lets us inject approval/audit hooks.
2. **External side-effects go through `packages/callbacks/approval.ts`.** If a tool sends an email, posts to Slack, creates a ticket, or writes to anything outside the agent's own container — it MUST request approval first.
3. **MCP servers are wrapped as pi.dev tools**, not used directly. The adapter lives at `packages/tools/adapters/mcp-adapter.ts`.
4. **Channel gateways translate to JSON-RPC** against the agent subprocess (pi.dev `runRpcMode`). They do not reimplement the loop.
5. **One agent per Docker container.** Multi-profile is Hermes's job; zia's job is per-employee isolation.

## Hermes → zia mapping

| Hermes (Python) | zia (TypeScript) |
|---|---|
| `AIAgent.run_conversation()` | `packages/core/agent.ts` wraps `createAgentSession` |
| `cli.py` HermesCLI | Native `InteractiveMode` from pi.dev — we don't build it |
| `prompt_builder.build_system_prompt()` | `packages/core/prompt-builder.ts` |
| `tools/registry.py` (auto-register) | `packages/tools/registry.ts` |
| `runtime_provider.resolve_runtime_provider()` | `packages/providers/resolver.ts` |
| `gateway/run.py` GatewayRunner | `packages/gateways/runner.ts` |
| `gateway/session.py` SessionStore | `packages/gateways/session-store.ts` + `better-sqlite3` |
| `cron/scheduler.py` | `packages/cron/scheduler.ts` |
| `tools/mcp_tool.py` | `packages/tools/adapters/mcp-adapter.ts` |
| `tools/approval.py` | `packages/callbacks/approval.ts` |
| `agent/memory_manager.py` | `packages/memory/` |
| `agent/prompt_caching.py` | `packages/core/cache.ts` |
| `hermes_constants.py` (profile dirs) | NOT replicated (each agent is its own container) |
| `acp_adapter/` | NOT replicated (not for IDEs) |

## The agent loop

```
Channel event → gateway.runner.dispatch()
  → resolveSession(channel, user/thread)
  → AIAgent.runConversation()           // wrapper over createAgentSession
    → promptBuilder.build()              // reads full ficha
    → providers.resolve()
    → pi.dev call with tools (builtins + MCP + custom)
    → for each tool call:
      → approval.classify(toolCall)
      → trivial: execute; medium/high: queue, notify boss, await, execute
      → audit.log()
    → loop until no more tool calls
  → response via origin gateway
  → sessionStore.save()
```

## Naming conventions

- Packages: `@zia/<name>` (e.g. `@zia/core`, `@zia/tools`).
- Files: kebab-case (`prompt-builder.ts`, not `promptBuilder.ts`).
- Classes: PascalCase. Functions: camelCase. Constants: UPPER_SNAKE_CASE.
- Tool names (the string registered with `defineTool`): snake_case (`send_email`, `query_linear`).
- MCP-derived tools: prefixed with `mcp_<server>_<tool>` (e.g. `mcp_linear_create_issue`).

## When to create a new package

- New responsibility that's reusable across apps/gateways → new `packages/<name>`.
- Variant of an existing concern (new gateway platform, new memory provider) → subfolder inside existing package.
- One-off helper used by exactly one consumer → keep it in that consumer.

## When to launch SDD

Any change that:
- adds a package or top-level folder;
- adds a new gateway, provider, or memory backend;
- changes the ficha schema (`profile.yaml`, `tools.yaml`, `mcp.yaml`);
- changes the agent loop;
- affects the approval flow.

Trivial fixes, dependency bumps, typo corrections, and bug fixes that don't touch the architecture do NOT need SDD.

## When in doubt

Read `docs/IMPLEMENTATION_PLAN.md`. It's the long-form reference for everything not covered here. If the plan and reality diverge, the plan wins for new code; flag the divergence in a PR.
