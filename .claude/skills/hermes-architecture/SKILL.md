---
name: hermes-architecture
description: Authoritative reference for Hermes Agent's architecture (Nous Research), the system zia mirrors in TypeScript. Use whenever confirming or making an architectural decision about zia — the agent core, the agent loop, prompt assembly, gateways, context compression/caching, session storage, or provider runtime. Triggers on "how does Hermes do X", "confirm the architecture", designing any package/gateway/loop change, or any mention of Hermes architecture.
---

# Hermes Agent architecture — reference for zia

zia mirrors [Hermes Agent](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture) (Nous Research, Python) in TypeScript on top of the pi.dev SDK. This skill is the distilled, authoritative reference. When confirming an architectural decision, consult the matching section here FIRST; only WebFetch the live docs if this skill is silent or you suspect it's stale.

> **Golden rule (from Hermes):** *"One AIAgent class serves CLI, gateway, ACP, batch, and API server. Platform differences live in the entry point, not the agent."* Everything below follows from this. In zia: every channel (TUI, Web UI, Telegram, WhatsApp, Slack, email) funnels through `packages/core/agent.ts` → the same conversation loop.

Source docs (fetch only to verify/extend):
- `/docs/developer-guide/architecture`
- `/docs/developer-guide/agent-loop`
- `/docs/developer-guide/prompt-assembly`
- `/docs/developer-guide/gateway-internals`
- `/docs/developer-guide/context-compression-and-caching`
- `/docs/developer-guide/session-storage`
- `/docs/developer-guide/provider-runtime`
- `/docs/developer-guide/programmatic-integration`

---

## 1. Architecture overview

Three+ entry points converge on a **single `AIAgent` core**:

| Entry point | Hermes file | zia equivalent |
|---|---|---|
| CLI / TUI (local, ssh) | `cli.py` (HermesCLI) | pi.dev native TUI via `apps/agent-runtime/src/tui.ts` |
| Gateway (20 chat platforms) | `gateway/run.py` | `packages/gateways/` (planned) |
| ACP (IDE) | `acp_adapter/` | **not replicated** (not an IDE agent) |
| Batch / trajectories | `batch_runner.py` | not replicated for MVP |
| API server | HTTP gateway | `apps/agent-web-ui` is an adapter, not special |

**Core (`run_agent.py` → zia `packages/core/agent.ts`)** owns: provider selection + runtime resolution, system-prompt assembly, tool dispatch + retries, compression, session persistence. Hermes runs 3 API modes (chat_completions, codex_responses, anthropic); zia delegates that to pi.dev.

Major subsystems and their zia homes:

| Hermes subsystem | File | zia package |
|---|---|---|
| Prompt builder | `agent/prompt_builder.py` | `packages/core/prompt-builder.ts` |
| Prompt caching | `agent/prompt_caching.py` | `packages/core/cache.ts` (pi.dev does most) |
| Context compressor | `agent/context_compressor.py` | pi.dev `compaction` settings + thin wrapper |
| Provider resolver | `hermes_cli/runtime_provider.py` | `packages/providers/resolver.ts` (DONE) |
| Tool registry | `tools/registry.py` | `packages/tools/registry.ts` (planned) |
| Approval / danger check | `tools/approval.py` | `packages/callbacks/approval.ts` (planned) |
| Session storage | `hermes_state.py` (SQLite+FTS5) | `packages/persistence/` (planned) |
| Gateway runner | `gateway/run.py` | `packages/gateways/runner.ts` (planned) |
| Memory manager | `agent/memory_manager.py` | `packages/memory/` |
| Cron | `cron/` | `packages/cron/` |

**Design principles** (carry these into zia):
- **Prompt stability** — system prompt is NOT mutated mid-conversation except on explicit command.
- **Observable execution** — every tool call surfaces via callbacks.
- **Interruptible** — API calls and tool execution are cancelable mid-flight.
- **Platform-agnostic core** — adapters are thin; the loop is shared.
- **Loose coupling** — registry patterns + gating functions for optional subsystems.
- **Profile isolation** — Hermes uses `-p <name>`; **zia uses one container per agent** instead.

Tools **self-register at import time** (`registry.register()`) — no manual import list.

---

## 2. Agent loop (`run_conversation()`)

Entry takes `user_message`, optional `system_message` (auto-built if omitted), optional `conversation_history` (auto-loaded from session if omitted).

Per-iteration sequence:
1. **Init** — generate `task_id` if absent.
2. **History** — append user message.
3. **Prompt** — build OR reuse cached system prompt (prompt_builder).
4. **Preflight compression** — check if needed (>50% context).
5. **Message assembly** — build API messages from history (mode-specific transforms).
6. **Ephemeral injection** — budget warnings, context-pressure notes (NOT cached).
7. **Caching markers** — apply if on Anthropic.
8. **API call** — interruptible (`_interruptible_api_call`).
9. **Branch**: if `tool_calls` → execute, append results, **loop back to step 5**. If text → persist session, flush memory, return.

**Tool execution flow per call:**
- Resolve handler from registry.
- Fire `pre_tool_call` hook.
- **Safety check (`tools/approval.py`)** ← zia's governance gate goes here.
- Execute handler with args + task_id.
- Fire `post_tool_call` hook.
- Append `{role: "tool", content: result}` to history.

Cardinality: single call runs directly; **multiple calls run concurrently** (ThreadPoolExecutor) EXCEPT interactive tools like `clarify`.

**Message role discipline:** strict alternation User→Assistant→User→Assistant; only `tool` role may have consecutive entries (parallel tool results).

**Interruptibility:** HTTP call runs on a background thread monitoring an interrupt event; on trigger the response is abandoned and the agent processes the new input or shuts down cleanly.

**Budget/termination:** default 90 iterations (`agent.max_turns`); subagents capped at 50. At 100% the agent stops and returns a work summary.

**Error fallback:** on provider failure, walk `fallback_providers` in order; on success continue the same conversation with the new provider.

---

## 3. Prompt assembly

Hermes deliberately splits **cached system-prompt state** from **ephemeral API-call-time additions** — to protect provider-side prefix caching, session continuity, and memory correctness.

**Cached system prompt — assembly order:**
1. Agent identity — `SOUL.md` (or `DEFAULT_AGENT_IDENTITY` fallback).
2. Tool-aware behavior guidance.
3. Honcho static block (optional personality/context).
4. Optional system message (config/API override).
5. **Frozen memory snapshot** (`MEMORY.md`) — injected at session start.
6. **Frozen user-profile snapshot** (`USER.md`).
7. Skills index (compact, with descriptions).
8. Context files (priority, first-match-only — see below).
9. Timestamp / session ID.
10. Platform hint (output-formatting guidance).

**`SOUL.md` loading** (`load_soul_md()`): reads file, **security-scans for injection patterns**, truncates to 20,000 chars, returns `None` → fallback identity. When loaded, it replaces the default identity and context-files builder runs with `skip_soul=True` to avoid duplication.

**Context-file priority (only ONE project context loads):**
| Priority | Files | Scope |
|---|---|---|
| 1 | `.hermes.md`, `HERMES.md` | CWD → git root |
| 2 | `AGENTS.md` | CWD |
| 3 | `CLAUDE.md` | CWD |
| 4 | `.cursorrules`, `.cursor/rules/*.mdc` | CWD |

All context files: security-scanned, truncated (20k cap, 70/20 head/tail), YAML frontmatter stripped.

**Frozen-snapshot semantics:** memory/profile load as frozen snapshots at session start. Mid-session writes update DISK but do NOT mutate the already-built system prompt until a new session or forced rebuild. This is what keeps the cache prefix stable.

**Explicitly NOT cached (API-call-time only):** `ephemeral_system_prompt`, prefill messages, gateway-derived session overlays, later-turn recall injected into the current user message.

> **zia gotcha already learned:** pi.dev's `DefaultResourceLoader` auto-scans cwd and folds `CLAUDE.md` / `AGENTS.md` / skill registry into the prompt — leaking host context into the agent. zia's `prompt-builder.ts` must build the ficha prompt explicitly and not let the loader pull host files. (See engram: "DefaultResourceLoader leaks host context".)

> **zia ficha mapping:** Hermes has SOUL+MEMORY+USER. zia's ficha is richer: SOUL + POLICIES + KNOWLEDGE + MEMORY + profile.yaml. The Slice-1 prompt-builder assembles SOUL→POLICIES→KNOWLEDGE→MEMORY (governance lives in POLICIES, which feeds the approval classifier — see §8).

---

## 4. Gateway internals

**`GatewayRunner` (`gateway/run.py`)** owns the event loop and dispatch; tracks `_running_agents` and `_active_sessions`. Core method `_handle_message()`.

**Adapter interface (`BaseAdapter`, `gateway/platforms/base.py`):**
- `connect()` / `disconnect()` — lifecycle.
- `send_message()` — outbound.
- `on_message()` — inbound normalization → `MessageEvent`.

Adapters own platform protocol (polling / webhooks / WebSockets) and emit a **unified `MessageEvent`**: sender ID, chat ID, platform identifier, message text, thread context.

**Authorization (layered, in order):** per-platform allow-all → platform allowlist (user IDs) → DM pairing (existing users authorize new ones via code, persisted in `pairing.py`) → global allow-all → default reject.

**Session key:** `"agent:main:{platform}:{chat_type}:{chat_id}"`, built ONLY via `build_session_key()` — never hand-assembled. Thread-aware platforms embed thread ID in `chat_id`.

**Pipeline:**
1. Adapter `on_message()` → `MessageEvent`.
2. Base-adapter guard: if `_active_sessions` busy → queue message + set interrupt.
3. Runner resolves session key (`_session_key_for_source()`).
4. Authorization check.
5. Slash-command detection (`resolve_command()`).
6. Running-agent check: intercepts `/stop`, `/new`, `/queue`, `/status`, `/approve`, `/deny` inline; `/model` is blocking; otherwise `running_agent.interrupt()`.
7. Else create `AIAgent` for the conversation.
8. `gateway/delivery.py` sends the response back through the originating adapter.

**Two guard levels:** L1 base-adapter (`_active_sessions`, queues if busy); L2 runner (`_running_agents`, intercepts control commands or interrupts).

> **zia mapping:** Slice 3 builds `packages/gateways/runner.ts` with this exact shape — `MessageEvent` → authorize → resolve session → core. The Web UI (Slice 4) is just the first `BaseAdapter`, not a privileged path. `/approve` `/deny` inline interception is how a boss approves a queued action from any chat channel.

---

## 5. Context compression & caching

**Dual compression:**
1. **Gateway session hygiene — 85% threshold** (`gateway/run.py`): safety net BEFORE agent processing; uses API-reported tokens or char estimate; only with 4+ messages.
2. **Agent ContextCompressor — 50% threshold** (`agent/context_compressor.py`): primary, inside the tool loop, accurate counts, user-configurable.

**Config (`compression` key):** `threshold: 0.50`, `target_ratio: 0.20` (tail budget), `protect_last_n: 20`, `protect_first_n: 3`. (200K model → 100k trigger, 20k tail, ≤10k summary.)

**Four-phase algorithm:**
1. **Prune tool results** — old tool outputs >200 chars outside protected regions → placeholder (no LLM).
2. **Determine boundaries** — split head (system + first exchange) / middle (summarized) / tail (token-budget protected); align with `_align_boundary_backward()` so tool_call/tool_result pairs never split.
3. **Generate summary** — aux LLM gets the middle in a structured template (goal, constraints, progress done/in-progress/blocked, decisions, files, next steps, critical context); summary 20% of compressed content, 2k–12k tokens.
4. **Assemble** — head + summary (role chosen to avoid consecutive same-role) + untouched tail; `_sanitize_tool_pairs()` removes orphaned tool results, stubs removed calls.

**Iterative re-compression:** updates `_previous_summary` rather than regenerating (items flow In-Progress→Done, obsolete pruned).

**Prompt caching (Anthropic), "system_and_3" strategy (≤4 breakpoints):**
- BP1: system prompt (stable all turns).
- BP2–4: rolling window of 3rd-/2nd-/last non-system messages.
- `apply_anthropic_cache_control()` injects ephemeral markers, TTL default 5m (optional 1h).
- Cache survives turns and compression; exact prefix match required; after compression invalidates the region, the rolling window re-establishes caching within 1–2 turns. Compression appends notes only on FIRST compaction (preserves system-prompt stability).

> **zia mapping:** pi.dev SDK exposes `compaction` and caching natively (`SettingsManager`). zia configures thresholds per agent rather than reimplementing the 4-phase algorithm. The principle that matters: **never mutate the system prompt mid-conversation** (it kills the cache).

---

## 6. Session storage

**Backend:** SQLite + **WAL** mode at `~/.hermes/state.db` (`HERMES_HOME`). zia: one SQLite DB per agent container volume.

**Schema:**
- **Sessions table:** id, source platform, model config, system prompt, token counts (input/output/cache read+write/reasoning), billing (provider, est/actual cost), lifecycle (started/ended/end_reason), optional unique title, `parent_session_id` (lineage).
- **Messages table:** session ref, role (user/assistant), content, timestamp, tool-call info (JSON strings), token counts, finish reason, reasoning fields; indexes on session_id + timestamp.

**`SessionDB` API:** `create_session()`, `append_message()`, `get_messages()`, `get_messages_as_conversation()` (OpenAI format), `end_session()` / `reopen_session()`, `set_session_title()`, `resolve_session_by_title()`, `get_next_title_in_lineage()`.

**FTS5:** `messages_fts` (standard) + `messages_fts_trigram` (CJK/substring); `search_messages()` supports boolean/phrase/prefix with query sanitization.

**Lineage:** `parent_session_id` chains form when compression splits a session; recursive CTEs find ancestors/descendants.

**Write contention (multi-process on one DB):** 1s timeout (not 30s), app-level retry with jitter (20–150ms, ≤15 retries), `BEGIN IMMEDIATE`, WAL checkpoint every 50 writes.

**Schema versioning:** v11; declarative `_reconcile_columns()` + version-gated migrations.

> **zia mapping:** `packages/persistence/` uses `better-sqlite3` + FTS5 (Slice 2 backs the audit log; also session store). Reuse the lineage + WAL + retry patterns. The **audit log** is a zia addition (NF4): every tool action with timestamp, approver, input, output.

---

## 7. Provider runtime

**Resolution precedence:** explicit CLI/runtime request → `config.yaml` model/provider → env vars → provider defaults. (Saved choice is source of truth — env exports don't override user selection.)

**Providers:** 30+ families (OpenRouter, OpenAI, Anthropic, Gemini, Bedrock, Azure, custom OpenAI-compatible). Custom via `provider: custom` or `custom_providers` config.

**`get_provider_profile()` → `ProviderProfile`:** canonical `base_url`, `env_vars` priority list, `api_mode`, `fallback_models`. Plugins register via `register_provider()` under `plugins/model-providers/<name>/` — no core changes.

**Resolution output:** provider identity, api_mode, base_url, api_key, credential source, metadata (e.g. expiration).

**Credential scoping:** keys scoped to base_urls to prevent cross-provider leakage (`OPENROUTER_API_KEY` only hits OpenRouter).

**Native Anthropic:** `api_mode = anthropic_messages`, native Messages API, `anthropic_adapter.py`. Prefers refreshable Claude Code credentials over env tokens.

**Runtime `/model` switch** (`model_switch.py`): shared pipeline across CLI + gateway; doesn't break the session.

**Auxiliary routing** (`auxiliary_client.py`): vision/summarization/compression/MCP can use an independent provider/model; `provider: main` inherits the shared runtime.

**Fallback** (`_try_activate_fallback()` in `run_agent.py`), triggered by: invalid responses after max retries; non-retryable 401/403/404; transient 429/500/502/503 after retries. Swaps provider/model/base_url/api_mode/client in-place, re-evaluates caching, resets retry counter, continues. One-shot (`_fallback_activated` guard). **Limit:** subagents/aux do NOT inherit fallback (only provider choice); cron jobs DO.

> **zia status:** `packages/providers/` already implements this (resolver, catalog, ficha-driven config, OAuth via pi.dev AuthStorage, `zia model` switch, fallback). Matches Hermes precedence + scoping. See engram `sdd/llm-provider-cli/*`.

---

## 8. Programmatic integration

Hermes exposes **three protocols** for external programs to drive the agent. zia's gateways and Web UI sit on the equivalent pi.dev surfaces.

| Protocol | Hermes location | Transport | Use case | zia equivalent |
|---|---|---|---|---|
| **ACP** (Agent Client Protocol) | `hermes acp` | JSON-RPC over stdio | IDE plugins (VS Code, Zed, JetBrains) | **not replicated** (zia isn't an IDE agent) |
| **TUI Gateway JSON-RPC** | `tui_gateway/server.py` (+ `ws.py`) | JSON-RPC over stdio **or WebSocket** | Custom hosts needing full control (approvals, branching, clarify, steering) | pi.dev `runRpcMode` → `packages/gateways/runner.ts` + Web UI |
| **OpenAI-compatible API Server** | `gateway/platforms/api_server.py` | HTTP + SSE | OpenAI-compatible frontends (Open WebUI, LobeChat) | optional future adapter |

**TUI Gateway JSON-RPC — method surface** (this is the richest control plane; closest to what zia's Web UI needs):
- Sessions: `session.create`, `session.list`, `session.activate`, `session.close`, `session.branch`, `session.history`
- Prompts: `prompt.submit`, `prompt.background`
- Commands: `command.dispatch`, `command.resolve`, `commands.catalog`
- **Responses to agent requests:** `clarify.respond`, **`approval.respond`**, `sudo.respond`, `secret.respond`
- Control: `session.interrupt`, `session.compress`, `session.steer`
- **Events streamed:** `message.delta`, `message.complete`, `tool.start`, `tool.progress`, `tool.complete`, **`approval.request`**, `clarify.request`, + lifecycle.

**OpenAI-compatible API Server — endpoints:** `POST /v1/chat/completions`, `POST /v1/responses`, `POST /v1/runs` (→202 + run_id), `GET /v1/runs/{id}`, `GET /v1/runs/{id}/events` (SSE), **`POST /v1/runs/{id}/approval`**, `POST /v1/runs/{id}/stop`, `GET /v1/capabilities`, `GET /v1/models`, `GET /health`. Session headers: `X-Hermes-Session-Id`, `X-Hermes-Session-Key`.

**In-process embedding:** import `AIAgent` directly (Python). zia equivalent: import the wrapper from `packages/core/agent.ts` — never the pi.dev SDK directly (CLAUDE.md rule).

**Model switching** is universal across all surfaces via `/model` (CLI/TUI), `command.dispatch {"command": "/model ..."}` (RPC), or `model` field / `X-Hermes-Model` header (HTTP).

> **zia mapping:** the pi.dev RPC mode (`runRpcMode`, see `pi-sdk` skill) IS zia's "TUI Gateway JSON-RPC" equivalent — the Web UI (Slice 4) and chat gateways talk to the agent subprocess over newline-delimited JSON-RPC. Critically, the **`approval.request` event + `approval.respond` method** are the exact wire primitives zia's approval queue (Slice 2) rides on: the core emits an approval request, any channel surfaces it, the boss answers, the core resumes. Design the approval queue to map cleanly onto this event/response pair.

## 9. How this constrains zia (decision crib)

When in doubt, these are the load-bearing invariants:

1. **Governance lives in the core, not in gateways.** Every channel hits `run_conversation()`; the approval/danger check sits at the tool-execution step (§2). Implement once in `packages/callbacks/approval.ts`; all channels inherit it. (This is WHY Slice 1 = governance core comes first.)
2. **The system prompt is immutable mid-conversation.** Per-turn context goes in ephemeral layers / the user message, never by rebuilding the system prompt. Protects caching.
3. **Adapters are thin.** A new channel = a new `BaseAdapter` (`on_message` → `MessageEvent`, `send_message`). It must NOT contain agent logic.
4. **Session keys are structured and built by a helper**, never hand-concatenated.
5. **Everything persists to SQLite+FTS5** with WAL + retry-on-contention; the audit log is a zia-specific table.
6. **Provider resolution already matches Hermes** — don't reinvent it; extend `packages/providers/`.
7. **Tools self-register at import.** Don't build a manual import list.
