# zia — Architecture

> **Status:** skeleton. This document grows feature by feature as we go through the SDD process (see `docs/SDD/`). The detailed architectural reference lives in [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) until the code catches up.

## Vision

`zia` mirrors the separation of responsibilities of [Hermes Agent](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture) (Nous Research), in TypeScript, using [pi.dev SDK](https://pi.dev) as the agent runtime. The enterprise layer (identity, governance, approval flow, container isolation) is what we add on top.

## High-level topology

```
┌─────────────────────────────────────────────────────┐
│  Control Panel (Next.js + Postgres)                 │
│  Lists agents, audit agregado, ficha editor         │
└────────────┬────────────────────────────────────────┘
             │
   ┌─────────┴─────────┬──────────────┬────────────┐
   ▼                   ▼              ▼            ▼
┌──────────┐    ┌──────────┐    ┌──────────┐  ┌──────────┐
│ Agent:   │    │ Agent:   │    │ Agent:   │  │ ...      │
│ Finanzas │    │ Proyectos│    │ Comercial│  │          │
│ (Docker) │    │ (Docker) │    │ (Docker) │  │          │
└──────────┘    └──────────┘    └──────────┘  └──────────┘
```

Each agent is a Docker container that runs:

- the agent core (pi.dev SDK wrapper);
- its own gateways (IMAP/SMTP, Slack bot, HTTP for Web UI);
- its own Web UI (Next.js) accessible to its human boss;
- its own SQLite for sessions and audit log;
- its ficha mounted as a volume.

## Hermes → zia mapping

See [`IMPLEMENTATION_PLAN.md` § Mapping](IMPLEMENTATION_PLAN.md).

## Detailed designs

Each feature gets a design doc under `docs/SDD/<feature>/` as we implement it.

| Feature | Status | Design doc |
|---|---|---|
| Agent core (`packages/core`) | Pending Phase 0 | — |
| Tool registry & MCP adapter | Pending Phase 1-2 | — |
| Approval queue | Pending Phase 1 | — |
| Email IMAP/SMTP gateway | Pending Phase 2 | — |
| Slack gateway | Pending Phase 2 | — |
| Control panel | Pending Phase 3 | — |

## References

- [Hermes architecture](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture) — primary inspiration.
- [OpenClaw](https://docs.openclaw.ai/) — multi-channel gateway inspiration.
- [pi.dev SDK](https://pi.dev/docs/latest/sdk), [RPC](https://pi.dev/docs/latest/rpc), [JSON](https://pi.dev/docs/latest/json), [TUI](https://pi.dev/docs/latest/tui).
- [Hermes blog post](https://nousresearch.com/blog/) (if available).
