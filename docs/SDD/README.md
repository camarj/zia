# SDD — Spec-Driven Development for zia

zia is developed using **Spec-Driven Development** orchestrated by [gentle-ai](https://github.com/Gentleman-Programming/gentle-ai). Each non-trivial feature gets its own folder here with 4 artifacts:

```
docs/SDD/<feature>/
├── design.md      # Architectural sketch + trade-offs (model: Opus)
├── spec.md        # Detailed spec: interfaces, schemas, acceptance criteria (Opus)
├── implementation-notes.md  # What changed during /sdd-implement (Sonnet)
└── review.md      # Adversarial review against the spec (Sonnet)
```

## When to use SDD

| Change type | SDD? |
|---|---|
| New package | Yes |
| New gateway (channel) | Yes |
| New role template | Optional — only if non-obvious |
| New tool inside an existing adapter | Optional |
| Typo / doc fix | No |
| Dependency bump | No |
| Bug fix | Only if the root cause needs architectural change |

## How to start a feature

```bash
# 1. Activate gentle-ai for this project
gentle-ai sdd-init

# 2. Inside Claude Code, start a design session
/sdd-design <feature-name>

# 3. Once the design is approved, write the spec
/sdd-spec <feature-name>

# 4. Implement against the spec (TDD)
/sdd-implement <feature-name>

# 5. Adversarial review
/sdd-review <feature-name>
```

Each phase uses a different model (configured in `gentle-ai sync --profile-phase`):

| Phase | Default model | Why |
|---|---|---|
| design | Claude Opus | Reasoning depth |
| spec | Claude Opus | Precision of interfaces |
| implement | Claude Sonnet | Faster, cheaper for coding |
| review | Claude Sonnet | Fast adversarial pass |

## Current SDD docs

Artifacts live in Engram (project `zia`). Look them up via `mem_search` or `engram search` using the `topic_key` column.

### `phase-0-core-spike` ✅ archived (PR #1 merged 2026-05-27)

| Phase | Topic key | Status |
|---|---|---|
| Explore | `sdd/phase-0-core-spike/explore` | done |
| Proposal | `sdd/phase-0-core-spike/proposal` | done |
| Design | `sdd/phase-0-core-spike/design` | done |
| Spec | `sdd/phase-0-core-spike/spec` | done |
| Tasks | `sdd/phase-0-core-spike/tasks` | done |
| Apply progress | `sdd/phase-0-core-spike/apply-progress` | done |
| Verify report | `sdd/phase-0-core-spike/verify-report` | PASS WITH WARNINGS |
| Archive report | `sdd/phase-0-core-spike/archive-report` | done |

### `llm-provider-cli` ✅ archived (PRs 1–4 merged 2026-05-28)

| Phase | Topic key | Engram ID | Status |
|---|---|---|---|
| Explore | `sdd/llm-provider-cli/explore` | — | done |
| Proposal | `sdd/llm-provider-cli/proposal` | #539 | done |
| Design | `sdd/llm-provider-cli/design` | #540 | done |
| Spec | `sdd/llm-provider-cli/spec` | #541 | done |
| Tasks | `sdd/llm-provider-cli/tasks` | #542 | done (4-PR split) |
| Apply progress | `sdd/llm-provider-cli/apply-progress` | #558 | done (all PRs merged) |
| Verify report | `sdd/llm-provider-cli/verify-report` | #563 | PASS WITH WARNINGS → RESOLVED |
| Archive report | `sdd/llm-provider-cli/archive-report` | #564 | done |

**Key design override (engram #556):** OAuth credential storage was changed from `.env` JSON blobs (original spec) to pi.dev's native `AuthStorage` (auth.json). See `decision/oauth-credential-storage` in engram for the full rationale.

**Bug fixes post-verify:** Commit 5f3ee82 fixed openai-codex OAuth hanging on orphaned prompt (engram #561). Commit 8da92a7 fixed WARNING-1 by replacing duplicated credentialEnv switch with catalog lookup.
