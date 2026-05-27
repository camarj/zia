<p align="center">
  <strong>zia</strong> · opensource framework for employee-style AI agents
</p>

<p align="center">
  <a href="#whats-zia">What</a> ·
  <a href="#install">Install</a> ·
  <a href="#quickstart">Quickstart</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#roadmap">Roadmap</a> ·
  <a href="#contributing">Contributing</a>
</p>

---

## What's zia

zia lets companies deploy AI agents that act like **employees**, not assistants:

- each agent has its own corporate email, Slack identity, Linear/GitHub accounts;
- each agent lives isolated in its own Docker container;
- each agent reports to a **human boss** in the team who approves external actions;
- the agent's "ficha" (role definition, policies, knowledge) is plain markdown, versionable in git, reviewable in PRs.

Inspired by [Hermes Agent](https://hermes-agent.nousresearch.com/) (Nous Research) and [OpenClaw](https://docs.openclaw.ai/), but built specifically for the **enterprise employee** use case rather than personal or coding-focused agents.

Built on top of [pi.dev SDK](https://pi.dev) as the agent runtime, with TypeScript everywhere.

## Status

Pre-alpha. Active development at [Inteliside](https://inteliside.com). See [`docs/ROADMAP.md`](docs/ROADMAP.md).

## Install

```bash
# Prerequisites
brew install Gentleman-Programming/homebrew-tap/gentle-ai  # SDD orchestration
node --version  # >= 22

# Clone and bootstrap
git clone https://github.com/<org>/zia
cd zia
pnpm install
gentle-ai sdd-init
```

See [`docs/SETUP.md`](docs/SETUP.md) for the full setup walkthrough including Claude Code skills.

## Quickstart

```bash
# Create a new agent ficha
pnpm zia new-agent finance-assistant

# Edit agents/finance-assistant/ — fill in SOUL.md, POLICIES.md, profile.yaml

# Run the agent locally (TUI mode — admin)
pnpm --filter @zia/agent-runtime tui agents/finance-assistant

# Deploy in Docker
docker compose -f agents/finance-assistant/docker-compose.yml up -d

# Connect via Web UI: http://localhost:<port>
```

## Architecture

zia is a monorepo of independent packages. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full picture.

| Package | Responsibility |
|---|---|
| `packages/core` | Agent core (pi.dev SDK wrapper, prompt builder, memory) |
| `packages/tools` | Tool registry, MCP adapter, approval flow |
| `packages/gateways` | Channels: email IMAP/SMTP, Slack, HTTP (Web UI) |
| `packages/providers` | LLM provider resolver |
| `packages/cron` | Scheduled jobs per agent |
| `packages/persistence` | SQLite + FTS5 for sessions and audit |
| `apps/agent-runtime` | The Docker image each agent runs in |
| `apps/agent-web-ui` | Next.js UI served inside each agent's container |
| `apps/control-panel` | Separate dashboard for the whole team |

## Multi-model support

Each agent's ficha declares a list of available models (`llm.available` in `profile.yaml`). The human boss can switch the active model at runtime via Web UI, TUI (Ctrl+P), or RPC — no restart needed. Anthropic, OpenAI, and Ollama (local) are supported.

## Roadmap

See [`docs/ROADMAP.md`](docs/ROADMAP.md).

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). PRs welcome — start by reading [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) and [`docs/SDD/README.md`](docs/SDD/README.md) for the development workflow.

## License

MIT — see [`LICENSE`](LICENSE).
