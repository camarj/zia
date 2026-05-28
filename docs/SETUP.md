# zia — Setup walkthrough

This document covers the **manual steps** the project lead (Raul) must run once, before the framework can be developed or used. These are things Claude Code cannot do automatically because they require external credentials (Homebrew, GitHub auth, Anthropic API key).

## 1. Prerequisites

- Node.js 22 or higher (`node --version`).
- pnpm 9 or higher (`pnpm --version`, install with `npm i -g pnpm` if missing).
- Docker Desktop (for the per-agent containers — needed in Phase 1+).
- Git.
- Homebrew (macOS) or equivalent.

## 2. Install gentle-ai (SDD orchestration)

gentle-ai assigns different LLM models to each Spec-Driven Development phase (design / spec / implement / review).

```bash
brew tap Gentleman-Programming/homebrew-tap
brew install gentle-ai
gentle-ai doctor
```

Then, inside this repo:

```bash
gentle-ai sdd-init
gentle-ai skill-registry refresh

# Configure per-phase models (adjust to your subscription/budget)
gentle-ai sync --profile-phase default:sdd-design:anthropic/claude-opus-4-7
gentle-ai sync --profile-phase default:sdd-spec:anthropic/claude-opus-4-7
gentle-ai sync --profile-phase default:sdd-implement:anthropic/claude-sonnet-4-6
gentle-ai sync --profile-phase default:sdd-review:anthropic/claude-sonnet-4-6
```

## 3. Install Claude Code skills

These skills are NOT vendored into the repo — they're installed via the `skillsadd` registry into your local Claude Code config.

```bash
# Skill creation / MCP building (Anthropic)
npx skillsadd anthropics/skills/skill-creator
npx skillsadd anthropics/skills/mcp-builder
npx skillsadd anthropics/skills/webapp-testing

# Next.js + React (Vercel Labs)
npx skillsadd vercel-labs/next-skills/next-best-practices
npx skillsadd vercel-labs/agent-skills/vercel-react-best-practices

# Testing / debugging (mattpocock)
npx skillsadd mattpocock/skills/tdd
npx skillsadd mattpocock/skills/systematic-debugging

# UI components
npx skillsadd shadcn/ui
```

The zia-specific skills (`pi-sdk`, `zia-architecture`, `agent-ficha-schema`) are already in `.claude/skills/` — no install needed.

## 4. Bootstrap the project

```bash
pnpm install
pnpm typecheck   # should pass with no packages yet
```

## 5. Configure an agent's LLM provider

Use the interactive `zia model` picker to configure the LLM provider and credentials for an agent. This replaces manual `.env` editing.

```bash
pnpm --filter @zia/agent-runtime model agents/_template
```

The picker supports three credential paths depending on the provider:

### Path A — API-key providers (Anthropic, OpenAI, Groq, …)

The picker prompts for the API key (input is masked) and writes it to `agents/<name>/.env` with `chmod 600`. It also updates `llm.default` in `profile.yaml`.

```
Provider: Anthropic Claude
Model:    claude-sonnet-4-6
ANTHROPIC_API_KEY: **********************

Saved anthropic / claude-sonnet-4-6 to agents/_template/profile.yaml.
Credential ANTHROPIC_API_KEY written to agents/_template/.env (chmod 600).
```

To use the credential in a TUI session:

```bash
# Load the agent's .env into the current shell, then run the TUI
set -a; source agents/_template/.env; set +a
pnpm --filter @zia/agent-runtime tui agents/_template
```

### Path B — Custom OpenAI-compatible endpoint (Ollama, vLLM, LiteLLM, …)

Select "Custom OpenAI-compatible endpoint" in the picker, then enter the base URL and model id. The picker validates the endpoint with a `GET /v1/models` request (5-second timeout) **before** touching any file. On failure, nothing is written.

```
Provider:  Custom OpenAI-compatible endpoint
Base URL:  http://localhost:11434
Model id:  llama3.1:8b

Saved custom / llama3.1:8b (http://localhost:11434) to agents/_template/profile.yaml.
No credential written — custom endpoints typically handle auth at the endpoint level.
```

No `.env` entry is written. If your endpoint requires a key, add it manually to `agents/<name>/.env` and reference it with `credentials_env` in `profile.yaml`.

### Path C — OAuth providers (GitHub Copilot, OpenAI Codex)

Select the OAuth provider in the picker. A browser-based or device-code flow opens automatically (handled by pi.dev's AuthStorage). When the flow completes, the token is persisted to `~/.pi/agent/auth.json` — **not** to `.env`.

```
Provider: GitHub Copilot (OAuth)
Model:    claude-sonnet-4.5

Starting OAuth flow for GitHub Copilot (OAuth)…

Device code: ABCD-1234
Open this URL and enter the code:
  https://github.com/login/device

Waiting for authorisation…

OAuth credentials for "github-copilot" saved to auth.json.
Saved github-copilot / claude-sonnet-4.5 to agents/_template/profile.yaml.
```

The agent runtime reads OAuth tokens from the same `auth.json` automatically — no additional env-var setup needed.

**auth.json location note:** By default, both `zia model` and the agent runtime use `~/.pi/agent/auth.json` (one file per machine, shared across agents on the same host). Inside a Docker container this is fine — each container has its own filesystem. On a shared dev host all zia agents share the same OAuth token per provider. To scope tokens per ficha, set `PI_CODING_AGENT_DIR=<ficha-dir>/.pi` before running `zia model` and when starting the agent.

## 6. Push to GitHub

```bash
gh repo create <org>/zia --public --source=. --remote=origin --push
```

After pushing, enable branch protection on `main` (require PR + CI passing).

## 7. Verify

- `gentle-ai doctor` returns OK.
- `pnpm typecheck` passes.
- `ls .claude/skills/` shows `pi-sdk`, `zia-architecture`, `agent-ficha-schema`.
- `ls agents/_template/` shows all 7 ficha files.
- `pnpm --filter @zia/agent-runtime model agents/_template` launches the provider picker without errors.

You're ready to start Phase 0 (core spike). The first command inside Claude Code should be:

```
/sdd-design phase-0-core-spike
```
