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

## 5. Environment variables

Create a `.env` at the repo root (gitignored). At minimum:

```bash
# Required for any agent using Anthropic
ANTHROPIC_API_KEY=sk-ant-...

# Optional fallback
OPENAI_API_KEY=sk-...

# Per-agent vars get set in each agent's docker-compose.yml
```

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

You're ready to start Phase 0 (core spike). The first command inside Claude Code should be:

```
/sdd-design phase-0-core-spike
```
