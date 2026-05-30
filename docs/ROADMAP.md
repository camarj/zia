# zia — Roadmap

> No timeline. Quality over speed. Each phase is a real, usable deliverable.

> **Ordering note (2026-05):** the central agent harness is completed **before** the communication layers. We close the functional core — the **F-CORE-1…10** requirements in [`PRD.md` §4.bis](PRD.md) (builtin tools, tool registry, runtime memory, context compaction, prompt caching, budget enforcement, runtime model switch) — validated entirely through the CLI/TUI, and only then build gateways, the Web UI, and Docker. This re-sequences items inside Phases 1–2 (Web UI and Docker shift later) without changing the milestones.

## Phase -1 — Bootstrap ✅ (current)

Project skeleton, docs, Claude Code skills, gentle-ai setup, agent template.

## Phase 0 — Core spike

- `packages/core/agent.ts` wraps `createAgentSession` from pi.dev.
- Load `SOUL.md` as system prompt override.
- Talk to the agent via pi.dev's native TUI.

**Milestone:** spawn an agent from a ficha folder, open the TUI, get a response that reflects its SOUL.

## Phase 1 — Single agent in Docker with approval

- `packages/core/prompt-builder.ts` reads the full ficha.
- `packages/tools/registry.ts` with auto-registration.
- `packages/callbacks/approval.ts` with trivial/medium/high classification.
- `packages/persistence/db.ts` with `better-sqlite3` + FTS5.
- `apps/agent-web-ui` minimal (chat + approval queue) talking JSON-RPC to the agent.
- `apps/agent-runtime/Dockerfile`.

**Milestone:** agent runs in Docker, human boss chats via Web UI, gets approval requests, everything logged to SQLite.

## Phase 2 — MCP adapter + real connectivity

- `packages/tools/adapters/mcp-adapter.ts` bridges MCP servers as pi.dev tools.
- `packages/gateways/platforms/email-imap.ts` IMAP listener + SMTP sender.
- `packages/gateways/platforms/slack.ts` bot with the agent's own credentials.
- Ficha templates for one full role (project assistant).

**Milestone:** agent receives an email, queries Linear via MCP, drafts a reply, asks for approval, sends signed as itself.

## Phase 3 — Cron + multi-agent + control panel

- `packages/cron/scheduler.ts` + per-agent `jobs.json`.
- 2-3 agents running in parallel (separate containers).
- `apps/control-panel` (Next.js + Postgres) with agent list and aggregate audit.

**Milestone:** the Inteliside team sees a panel with their agents and uses them daily.

## Phase 4 — Polish + opensource launch

- Architectural docs (Hermes-style detail).
- Ficha templates for 3-4 common roles.
- `npm create zia-agent` scaffolds a ficha + docker-compose.
- Public release announcement.

## Future (post 1.0)

- Web-based ficha editor with schema validation.
- Multi-tenant control panel (one panel, many companies).
- Federated agents (agent in company A can talk to agent in company B via signed messages).
- Voice / WhatsApp gateways.
- Plugin marketplace for tools and role templates.
