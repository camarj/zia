---
name: agent-ficha-schema
description: Schemas and conventions for the agent ficha (SOUL.md, POLICIES.md, KNOWLEDGE.md, MEMORY.md, profile.yaml, tools.yaml, mcp.yaml). Use when editing or validating any file under agents/, when adding fields to the schema, or when scaffolding a new role template. Triggers on edits inside agents/*/, on "ficha", "SOUL.md", "profile.yaml", or scaffolding a new agent.
---

# Agent ficha schema for zia

Every zia agent lives in a directory under `agents/<name>/` with 7 files. Together they form the "ficha del empleado" — the complete identity, governance, knowledge, and capabilities of one agent.

## File-by-file

### `SOUL.md` — personality and role

Markdown. Free form but typically:

```markdown
# Quién soy
Soy el [rol] de [empresa].

# Cómo me comporto
- [Tono y estilo]
- [Cuándo preguntar vs cuándo asumir]
- [Reglas inviolables]
```

Injected at the **top of the system prompt**. Keep it short — the model reads this every turn.

### `POLICIES.md` — governance and risk classification

The agent reads this to decide which actions need approval.

```markdown
# Clasificación de acciones

## Trivial (auto-execute, only notify)
- [List of action patterns]

## Medium (approval with one click)
- [List]

## High (approval + comment required)
- [List]

# Forced model rules (optional)
- "For [type of task], use [model]."
```

Schema enforced by `packages/callbacks/approval.ts` at runtime — actions are classified by matching the tool call against the lists.

### `KNOWLEDGE.md` — company context

Long-lived facts the agent should know but that aren't in any external system:

```markdown
# Empresa
- [Legal name, RUC/EIN, address]

# Procesos
- [How invoicing works, etc.]

# Tracking systems
- [Where customer data lives, etc.]
```

Updated manually by the boss or via PRs.

### `MEMORY.md` — self-written by the agent

The agent appends here when it learns something new from feedback:

```markdown
# 2026-05-27
- Customer Acme paid invoice #1043. Confirmed with Raul.
- New learned rule: when a customer asks for extension, offer max 15 days.
```

Read at every session start. Subject to compaction when it grows large (handled by `packages/core/memory-manager.ts`).

### `profile.yaml` — identity, authority, accounts, LLM config

```yaml
agent:
  id: <slug>-001              # globally unique
  name: "Display name"
  email: <slug>@<domain>
  email_server:
    imap: mail.example.com:993
    smtp: mail.example.com:465
    credentials_env: AGENT_EMAIL_PASS  # env var name, NEVER the secret itself

bosses:
  - email: <boss>@<domain>
    permissions: [approve_all, edit_ficha, view_audit, switch_model]

accounts:
  slack: { workspace: <name>, bot_token_env: AGENT_SLACK_TOKEN }
  linear: { team: <team>, api_key_env: AGENT_LINEAR_KEY }
  github: { user: <bot-username>, token_env: AGENT_GITHUB_TOKEN }

llm:
  default:
    provider: anthropic
    model: claude-sonnet-4-6
    thinkingLevel: medium
  available:
    - provider: anthropic
      model: claude-opus-4-7
      thinkingLevel: high
      label: "Opus (deep reasoning)"
      credentials_env: ANTHROPIC_API_KEY
    - provider: anthropic
      model: claude-sonnet-4-6
      thinkingLevel: medium
      label: "Sonnet (default)"
      credentials_env: ANTHROPIC_API_KEY
    - provider: anthropic
      model: claude-haiku-4-5-20251001
      thinkingLevel: off
      label: "Haiku (fast)"
      credentials_env: ANTHROPIC_API_KEY
    - provider: openai
      model: gpt-4o
      label: "GPT-4o (fallback)"
      credentials_env: OPENAI_API_KEY
    - provider: ollama
      model: llama3.1:70b
      label: "Llama local"
      base_url: http://localhost:11434
  monthly_budget_usd: 50
  fallback_on_error: true
```

**CRITICAL:** never put the actual secrets in this file. Always use `*_env: VAR_NAME` and inject the secret at container runtime via `docker-compose.yml` or `.env`.

### `tools.yaml` — enabled capabilities

```yaml
enabled:
  - email_read
  - email_send                  # high-risk → goes through approval queue
  - sqlite_query
  - http_get
  - http_post                   # high-risk
disabled:
  - bash                        # not needed for this role
```

### `mcp.yaml` — MCP servers to mount

```yaml
servers:
  - name: linear
    command: npx -y @modelcontextprotocol/server-linear
    env: { LINEAR_API_KEY: $AGENT_LINEAR_KEY }
  - name: notion
    command: npx -y @modelcontextprotocol/server-notion
    env: { NOTION_TOKEN: $AGENT_NOTION_KEY }
```

Each server's tools become available to the agent prefixed with `mcp_<name>_*`.

## Validation

`packages/core/validate-ficha.ts` (Phase 1+) validates with zod. The hook in `.claude/settings.json` runs it on every edit to `agents/*/profile.yaml`. Manual:

```bash
pnpm --filter @zia/core validate-ficha agents/<name>
```

## Scaffolding a new agent

Use the `/new-agent <name>` slash command (defined at `.claude/commands/new-agent.md`). It copies from `agents/_template/` and asks for the fields that must be unique (id, email, bosses).

## Templates

`agents/_template/` is the empty starter. As we go, we'll add `agents/_templates/<role>/` for each common role (project-assistant, sales-assistant, etc.). Use them as starting points.

## Things that DO NOT belong in the ficha

- API keys, passwords, tokens (use `*_env` references).
- Per-environment URLs that change between dev/prod (use env vars).
- Implementation code (that goes in `packages/`).
- One-off tasks the agent currently has (those go in the session, not the ficha).

## Ficha lifecycle

1. Created via `/new-agent`.
2. Edited by the boss as the agent's role evolves.
3. Committed to the `zia` repo (Inteliside) OR kept in the consuming company's private repo.
4. Mounted as a Docker volume at `/agent` inside the container.
5. Reloaded by the agent on file change (via fs watch).
