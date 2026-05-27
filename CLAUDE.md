# zia

zia is an opensource framework for deploying employee-style AI agents in companies. Each agent runs in its own Docker container, has its own corporate email, own credentials for company tools, and serves a human boss inside the team.

Architecture is inspired by [Hermes Agent](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture) (Nous Research). See `docs/ARCHITECTURE.md` and `docs/IMPLEMENTATION_PLAN.md`.

# Stack

- TypeScript/Node 22+, pnpm workspaces
- pi.dev SDK (`@earendil-works/pi-coding-agent`) as agent core
- Next.js for Web UI and Control Panel
- `better-sqlite3` with FTS5 for session/audit persistence
- Docker for per-agent isolation
- MCP for integrations (Linear, Notion, Drive, Slack)
- gentle-ai for Spec-Driven Development orchestration

# Repository layout

- `packages/core/` — agent core, prompt builder, memory manager
- `packages/tools/` — tool registry, MCP adapter, builtin tools
- `packages/gateways/` — channel platforms (email IMAP/SMTP, Slack, HTTP)
- `packages/providers/` — LLM provider resolver
- `packages/memory/` — memory providers (file-based, sqlite-fts)
- `packages/cron/` — scheduled jobs
- `packages/persistence/` — SQLite + FTS5
- `packages/callbacks/` — approval queue, observability
- `apps/agent-runtime/` — Docker image that runs one agent
- `apps/agent-web-ui/` — Next.js served inside each agent container
- `apps/control-panel/` — separate Next.js dashboard for the whole team
- `agents/` — employee fichas (versionable in git)
- `docs/` — PRD, plan, architecture, roadmap, SDD artifacts
- `.claude/` — skills, subagents, slash commands, settings

# Workflow

- Use **plan mode** before any non-trivial change.
- For any new package, gateway, or feature: follow **Spec-Driven Development** (`/sdd-design` → `/sdd-spec` → `/sdd-implement` → `/sdd-review`). See `docs/SDD/README.md`.
- Read `docs/ARCHITECTURE.md` and the relevant `SKILL.md` before touching pi.dev code.
- Skills available: `pi-sdk`, `zia-architecture`, `agent-ficha-schema` (in `.claude/skills/`).
- Subagents: `architect` for design decisions, `tool-builder` for custom tools.
- Slash commands: `/new-agent <name>` scaffolds a new agent ficha.

# Code style

- TypeScript strict mode. **No `any`**.
- ESM only. No CommonJS.
- Tests with vitest. Add a test for every behavior change.
- Conventional commits (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`).
- Run `pnpm typecheck && pnpm test && pnpm lint` before committing.

# Common commands

- `pnpm typecheck` — run tsc across all packages
- `pnpm test` — run vitest
- `pnpm lint` — eslint
- `pnpm dev` — start dev mode for current package
- `pnpm --filter @zia/agent-runtime docker:build` — build agent Docker image
- `gentle-ai sdd-init` — re-initialize SDD context for the project

# Workflow rules

- **IMPORTANT:** never call pi.dev SDK directly from gateways or apps. Always go through `packages/core/agent.ts`.
- **IMPORTANT:** tool execution that touches external systems (email send, Slack post, ticket creation, ANY action visible outside the agent's own container) MUST go through `packages/callbacks/approval.ts`. Trivial reads are exempt — see the `POLICIES.md` schema.
- **IMPORTANT:** never put credentials in `agents/*/profile.yaml`. Use env vars (`*_env: VAR_NAME`) and reference them at runtime.
- **IMPORTANT:** never commit anything under `agents/*/data/`, `agents/*/.env`, or `agents/*/secrets/`. The `.gitignore` covers these but double-check.

# Architecture references

- Hermes architecture (primary inspiration): https://hermes-agent.nousresearch.com/docs/developer-guide/architecture
- pi.dev SDK: https://pi.dev/docs/latest/sdk
- pi.dev RPC: https://pi.dev/docs/latest/rpc
- pi.dev JSON: https://pi.dev/docs/latest/json
- pi.dev TUI: https://pi.dev/docs/latest/tui
- Implementation plan: @docs/IMPLEMENTATION_PLAN.md
- PRD: @docs/PRD.md
- Architecture skeleton: @docs/ARCHITECTURE.md
