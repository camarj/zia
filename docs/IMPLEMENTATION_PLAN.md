# Plan: Framework opensource de agentes-empleados — proyecto `zia`

## Contexto

Inteliside es un studio de tecnología de 5 personas en Guayaquil. La carga supera al equipo. El objetivo es construir un **framework opensource** (uso interno primero, comunidad después) que permita desplegar **agentes-empleados** con identidad propia, email corporativo, cuentas en herramientas internas, viviendo aislados en sus propios containers, trabajando para un jefe humano del equipo.

El proyecto se llama **`zia`** y vive en `~/Documents/Proyectos/zia/`.

Referencia arquitectónica: **Hermes Agent (Nous Research)** — replicamos su separación de responsabilidades (core / gateways / tools / providers / memory / cron / runtimes) en **TypeScript/Node** usando **pi.dev SDK** (`@earendil-works/pi-coding-agent`) como motor del agente.

## Decisiones tomadas

| Tema | Decisión |
|---|---|
| Nombre del proyecto | `zia` |
| Path | `~/Documents/Proyectos/zia/` |
| Lenguaje | TypeScript/Node en todo el stack |
| Monorepo | pnpm workspaces (más liviano que turborepo para el MVP) |
| SDK base del agente | `@earendil-works/pi-coding-agent` (pi.dev SDK) |
| Modelo LLM | Claude-first (cuenta Anthropic de Inteliside) |
| Autonomía | Copiloto — humano aprueba todo lo externo |
| Ficha de agente | Carpeta por agente con `.md` + `.yaml` versionable en git |
| Despliegue | Container Docker por agente, aislado, credenciales propias |
| MCP | Adaptador propio + `mcp-builder` skill como ayuda de desarrollo |
| Panel central | Existe pero los agentes funcionan independientemente |

## Diferencias fundamentales con Hermes

| Aspecto | Hermes | zia |
|---|---|---|
| Aislamiento | Multi-profile en un proceso | Un container Docker por agente |
| Identidad | "Perfil" genérico | "Empleado" con email, jefe, permisos, cuentas propias |
| Autonomía | Ejecuta tools libremente | Copiloto con aprobación de acciones externas |
| Memoria | SOUL.md + MEMORY.md + USER.md | SOUL.md + MEMORY.md + KNOWLEDGE.md + POLICIES.md + profile.yaml + tools.yaml + mcp.yaml |

---

# Fase -1: Bootstrap del proyecto zia

Antes de escribir código, preparamos el proyecto para que Claude Code lo desarrolle siguiendo las [best practices oficiales](https://code.claude.com/docs/en/best-practices).

## Estructura inicial del directorio

```
~/Documents/Proyectos/zia/
├── README.md                       # Landing del repo opensource (Apéndice G)
├── LICENSE                         # MIT
├── CONTRIBUTING.md                 # Guía para contribuidores
├── CODE_OF_CONDUCT.md              # Estándar (Contributor Covenant 2.1)
├── CLAUDE.md                       # Contexto persistente para Claude Code (Apéndice B)
├── .claude/
│   ├── settings.json               # Permisos, hooks (Apéndice C)
│   ├── skills/
│   │   ├── pi-sdk/SKILL.md         # Skill propio de pi.dev (Apéndice A)
│   │   ├── zia-architecture/SKILL.md
│   │   └── agent-ficha-schema/SKILL.md
│   ├── agents/
│   │   ├── architect.md            # Subagent para diseño (Apéndice D)
│   │   └── tool-builder.md         # Subagent para tools custom (Apéndice D)
│   └── commands/
│       └── new-agent.md            # Slash command (Apéndice E)
├── .gitignore
├── .editorconfig
├── package.json                    # Workspace root
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── .github/
│   ├── ISSUE_TEMPLATE/
│   ├── PULL_REQUEST_TEMPLATE.md
│   └── workflows/
│       └── ci.yml                  # typecheck + tests en PRs
├── packages/                       # (vacío al inicio, se llena en Fase 0+)
├── apps/                           # (vacío al inicio)
├── agents/                         # Fichas de empleados (vacío al inicio)
│   └── _template/                  # Plantilla base para `/new-agent`
└── docs/
    ├── PRD.md                      # Product Requirements (Apéndice F)
    ├── IMPLEMENTATION_PLAN.md      # Este plan, movido al repo
    ├── ARCHITECTURE.md             # Diseño técnico (estilo Hermes)
    ├── ROADMAP.md                  # Fases públicas
    └── SDD/                        # Specs por fase (gentle-ai)
        └── README.md
```

**Nota importante**: este archivo de plan vive hoy en `~/.claude/plans/`, pero al hacer el bootstrap se copia a `docs/IMPLEMENTATION_PLAN.md` dentro del repo. La versión del repo es la fuente de verdad para contribuidores; la de `~/.claude/plans/` queda como artefacto histórico de planificación.

## Herramienta de desarrollo: gentle-ai (Spec-Driven Development)

[gentle-ai](https://github.com/Gentleman-Programming/gentle-ai) (MIT, Go) es la herramienta de orquestación de desarrollo para `zia`. **No es un DAG de tasks**, sino un configurador de agentes con SDD: asigna modelos diferentes a cada fase (diseño, implementación, review), trae memoria persistente vía Engram, y sincroniza configuraciones a Claude Code y otros agentes.

### Instalación

```bash
# macOS (Homebrew)
brew tap Gentleman-Programming/homebrew-tap
brew install gentle-ai

# Verificación
gentle-ai doctor
```

### Setup inicial dentro del proyecto

```bash
cd ~/Documents/Proyectos/zia

# Detecta stack, activa Strict TDD Mode, registra el proyecto
gentle-ai sdd-init

# Escanea y registra los skills custom de zia
gentle-ai skill-registry refresh

# Configura perfiles SDD para Claude Code:
#  - sdd-design: usa Opus (calidad de razonamiento)
#  - sdd-spec: usa Opus (especificaciones precisas)
#  - sdd-implement: usa Sonnet (más barato, suficiente para código)
#  - sdd-review: usa Sonnet (revisión rápida)
gentle-ai sync --profile-phase default:sdd-design:anthropic/claude-opus-4-7
gentle-ai sync --profile-phase default:sdd-spec:anthropic/claude-opus-4-7
gentle-ai sync --profile-phase default:sdd-implement:anthropic/claude-sonnet-4-6
gentle-ai sync --profile-phase default:sdd-review:anthropic/claude-sonnet-4-6
```

### Flujo de desarrollo con SDD

Cada feature de `zia` pasa por 4 fases con artefactos persistentes en `docs/SDD/`:

1. **`/sdd-design`** — boceto arquitectónico (Opus). Output: diagrama y trade-offs en `docs/SDD/<feature>/design.md`.
2. **`/sdd-spec`** — spec detallado con interfaces, schemas, criterios de aceptación (Opus). Output: `docs/SDD/<feature>/spec.md`.
3. **`/sdd-implement`** — implementación contra el spec (Sonnet). Crea tests primero (Strict TDD), luego código.
4. **`/sdd-review`** — review adversarial (Sonnet) contra el spec. Output: gaps en `docs/SDD/<feature>/review.md`.

Esto garantiza que cada componente del framework tiene su decisión arquitectónica documentada, lo cual es **crítico para opensource**: contribuidores externos pueden entender el porqué de cada parte sin tener que leer todo el código.

### Engram (memoria persistente)

Ya está activa en este entorno. Para `zia` la usamos para registrar:
- Decisiones arquitectónicas tomadas en cada fase
- Bugs y sus root causes
- Convenciones que se descubren durante el desarrollo

```bash
engram projects list             # ver zia entre los proyectos
engram search "approval queue"   # consultar decisiones pasadas
```

## Skills externos a instalar (desde skills.sh)

Comandos a correr en `~/Documents/Proyectos/zia/`:

```bash
# Creación de skills/agents (de Anthropic)
npx skillsadd anthropics/skills/skill-creator

# MCP server builder — para el adaptador MCP custom
npx skillsadd anthropics/skills/mcp-builder

# Next.js (para Web UI del agente y Control Panel)
npx skillsadd vercel-labs/next-skills/next-best-practices
npx skillsadd vercel-labs/agent-skills/vercel-react-best-practices

# Testing y debugging
npx skillsadd mattpocock/skills/tdd
npx skillsadd mattpocock/skills/systematic-debugging
npx skillsadd anthropics/skills/webapp-testing

# UI components (para Web UI con shadcn)
npx skillsadd shadcn/ui
```

## Skills propios a crear

Tres skills custom específicos para `zia`, en `.claude/skills/`:

### 1. `pi-sdk` — uso del pi.dev SDK
Skill completo con referencia del SDK, RPC, JSON y TUI mode. **Ver Apéndice A** para el contenido íntegro de `SKILL.md`. Se basa en:
- https://pi.dev/docs/latest/sdk
- https://pi.dev/docs/latest/rpc
- https://pi.dev/docs/latest/json
- https://pi.dev/docs/latest/tui

### 2. `zia-architecture` — convenciones del framework
Cómo separar core/gateways/tools/providers/memory/cron. Cómo nombrar paquetes. Cómo registrar tools custom. Mapeo Hermes → zia (la tabla del plan).

### 3. `agent-ficha-schema` — esquemas de la ficha de empleado
Los esquemas exactos de `SOUL.md`, `POLICIES.md`, `KNOWLEDGE.md`, `MEMORY.md`, `profile.yaml`, `tools.yaml`, `mcp.yaml`. Ejemplos por rol (asistente financiero, asistente de proyectos).

## Subagents propios

### `architect`
Para decisiones de diseño y trade-offs arquitectónicos. Modelo Opus. Tools: Read, Grep, Glob, WebFetch.

### `tool-builder`
Para construir tools custom (sea como adaptador MCP, sea como `defineTool()` directo). Modelo Sonnet. Tools: Read, Edit, Write, Bash.

## Hooks recomendados

En `.claude/settings.json`:
- **PostToolUse en Edit/Write a `*.ts`**: corre `pnpm typecheck` automáticamente.
- **PreToolUse en Bash con `git push`**: bloquea push directo a `main`.
- **PostToolUse en Edit a archivos de `agents/*/profile.yaml`**: valida schema con zod antes de aceptar.

## Plantilla de CLAUDE.md

Ver **Apéndice B** para el contenido íntegro recomendado.

## Plantilla de settings.json

Ver **Apéndice C** para el contenido íntegro recomendado.

---

# Layout del monorepo (Fase 0 en adelante)

```
zia/
├── packages/
│   ├── core/                     # Equivalente a run_agent.py de Hermes
│   │   ├── agent.ts              # AIAgent class (wrapper sobre pi.dev SDK)
│   │   ├── prompt-builder.ts     # Ensambla system prompt desde ficha
│   │   ├── context-engine.ts
│   │   ├── memory-manager.ts
│   │   ├── trajectory.ts
│   │   └── cache.ts              # Anthropic cache breakpoints
│   │
│   ├── tools/                    # Equivalente a tools/ de Hermes
│   │   ├── registry.ts           # Auto-registro al importar
│   │   ├── approval.ts           # Clasificación de riesgo
│   │   ├── builtins/
│   │   └── adapters/
│   │       └── mcp-adapter.ts    # Bridge MCP → pi.dev tools via defineTool()
│   │
│   ├── providers/
│   │   ├── resolver.ts
│   │   ├── anthropic.ts
│   │   └── ollama.ts
│   │
│   ├── memory/
│   │   ├── provider.ts
│   │   ├── file-based.ts
│   │   └── sqlite-fts.ts
│   │
│   ├── gateways/
│   │   ├── runner.ts
│   │   ├── session-store.ts
│   │   ├── pairing.ts
│   │   ├── hooks.ts
│   │   └── platforms/
│   │       ├── email-imap.ts
│   │       ├── slack.ts
│   │       ├── http-webui.ts
│   │       └── webhook.ts
│   │
│   ├── cron/
│   │   ├── scheduler.ts
│   │   └── jobs.ts
│   │
│   ├── runtimes/
│   │   ├── runtime.ts
│   │   └── local.ts
│   │
│   ├── persistence/
│   │   ├── db.ts                 # better-sqlite3 + FTS5
│   │   ├── schema.sql
│   │   └── migrations/
│   │
│   └── callbacks/
│       ├── approval.ts
│       ├── clarify.ts
│       └── observability.ts
│
├── apps/
│   ├── agent-runtime/
│   │   ├── index.ts              # Lee ficha, registra tools/MCP, arranca gateways
│   │   ├── tui.ts                # Entry para TUI nativa de pi.dev
│   │   ├── rpc.ts                # Entry para JSON-RPC subprocess mode
│   │   ├── Dockerfile
│   │   └── docker-compose.yml
│   │
│   ├── agent-web-ui/             # Next.js servido dentro del container
│   │   └── ...
│   │
│   └── control-panel/            # App separada
│       ├── api/
│       └── ui/
│
├── agents/                       # Fichas de empleados
│   ├── finanzas/
│   ├── proyectos/
│   └── comercial/
│
└── docs/
```

## Mapping Hermes → zia (componente a componente)

| Hermes (Python) | zia equivalente (TypeScript) |
|---|---|
| `AIAgent.run_conversation()` | `packages/core/agent.ts` envuelve `createAgentSession` de pi.dev |
| `cli.py` HermesCLI | TUI nativa de pi.dev (`InteractiveMode`) — no la construimos |
| `prompt_builder.build_system_prompt()` | `packages/core/prompt-builder.ts` |
| `tools/registry.py` (auto-register) | `packages/tools/registry.ts` |
| `runtime_provider.resolve_runtime_provider()` | `packages/providers/resolver.ts` |
| `gateway/run.py` GatewayRunner | `packages/gateways/runner.ts` |
| `gateway/session.py` SessionStore | `packages/gateways/session-store.ts` con `better-sqlite3` |
| `cron/scheduler.py` | `packages/cron/scheduler.ts` |
| `tools/mcp_tool.py` | `packages/tools/adapters/mcp-adapter.ts` |
| `tools/approval.py` | `packages/callbacks/approval.ts` |
| `agent/memory_manager.py` | `packages/memory/` |
| `agent/prompt_caching.py` | `packages/core/cache.ts` |
| `hermes_constants.py` (profile dirs) | NO se replica (cada agente es su container) |
| `acp_adapter/` | NO se replica (no es para IDEs) |

## Modos de interacción con el agente (pi.dev nativo)

| Modo pi.dev | Cuándo se usa | Quién lo usa |
|---|---|---|
| **TUI interactiva** (`InteractiveMode`) | Acceso técnico al agente dentro del container | Raul / devs / admin |
| **Print mode** (`runPrintMode`) | Cron jobs, webhooks one-shot | Sistema interno |
| **JSON-RPC subprocess** (`runRpcMode`) | La Web UI y los gateways (Slack/Email/HTTP) se comunican vía este modo | Jefes humanos vía interfaces amigables |

Los gateways traducen mensajes de canal a llamadas JSON-RPC contra el subprocess de pi.dev — no reimplementan el loop del agente.

## Esquemas concretos de la "ficha del empleado"

### `profile.yaml`
```yaml
agent:
  id: finanzas-001
  name: "Asistente Financiero"
  email: finanzas@inteliside.com
  email_server:
    imap: mail.inteliside.com:993
    smtp: mail.inteliside.com:465
    credentials_env: AGENT_EMAIL_PASS

bosses:
  - email: raulj.camacho@gmail.com
    permissions: [approve_all, edit_ficha, view_audit, switch_model]

accounts:
  slack: { workspace: inteliside, bot_token_env: AGENT_SLACK_TOKEN }
  linear: { team: finance, api_key_env: AGENT_LINEAR_KEY }
  github: { user: inteliside-finanzas-bot, token_env: AGENT_GITHUB_TOKEN }

# El agente puede cambiar entre estos modelos en tiempo de ejecución
# (vía Web UI, TUI con Ctrl+P, o RPC set_model/cycle_model).
# El primero es el default al arrancar.
llm:
  default: { provider: anthropic, model: claude-sonnet-4-6, thinkingLevel: medium }
  available:
    - provider: anthropic
      model: claude-opus-4-7
      thinkingLevel: high
      label: "Opus (razonamiento profundo)"
      credentials_env: ANTHROPIC_API_KEY
    - provider: anthropic
      model: claude-sonnet-4-6
      thinkingLevel: medium
      label: "Sonnet (default, balance)"
      credentials_env: ANTHROPIC_API_KEY
    - provider: anthropic
      model: claude-haiku-4-5-20251001
      thinkingLevel: off
      label: "Haiku (rápido y barato)"
      credentials_env: ANTHROPIC_API_KEY
    - provider: openai
      model: gpt-4o
      label: "GPT-4o (fallback no-Anthropic)"
      credentials_env: OPENAI_API_KEY
    - provider: ollama
      model: llama3.1:70b
      label: "Llama local (sin costo, datos no salen)"
      base_url: http://localhost:11434
  monthly_budget_usd: 50
  # Si un modelo falla (rate limit, API down), bajar al siguiente de la lista
  fallback_on_error: true
```

### Cambio de modelo en runtime

El agente NO está atado a un único modelo. Pi.dev SDK expone esto nativamente y zia lo aprovecha en todos los modos:

| Interfaz | Cómo cambiar de modelo |
|---|---|
| **TUI (pi.dev nativa)** | `Ctrl+P` cicla entre modelos en `llm.available` |
| **Web UI** | Selector de modelo en header; pinta el costo estimado por turno |
| **Slack** | Comando `/zia model <name>` (solo para jefes con permiso `switch_model`) |
| **RPC (gateways)** | `{"type": "set_model", "provider": "...", "modelId": "..."}` o `{"type": "cycle_model"}` |
| **`POLICIES.md`** | Puede declarar reglas como "para tareas de cálculo financiero, usa Opus; para chat casual, usa Haiku" — el agente las respeta vía un hook |

El changeover de modelo **no rompe la sesión**: pi.dev preserva el historial y el siguiente turno corre con el modelo nuevo.

### `SOUL.md`
```markdown
# Quién soy
Soy el Asistente Financiero de Inteliside.

# Cómo me comporto
- Hablo profesional pero cercano
- Si tengo duda, pregunto antes de asumir
- Nunca envío email sin aprobación
- Documento toda decisión financiera en MEMORY.md
```

### `POLICIES.md`
```markdown
# Clasificación de acciones

## Trivial (auto-ejecuta, solo notifica)
- Leer email, consultar Linear/Notion, generar reportes internos

## Medio (aprobación con un click)
- Crear borradores de factura, postear en Slack interno, crear tickets

## Alto (aprobación + comentario)
- Enviar email a clientes, emitir facturas finales, > $500
```

### `KNOWLEDGE.md`, `MEMORY.md`, `tools.yaml`, `mcp.yaml`
Ver detalle en versiones anteriores del plan o en el skill `agent-ficha-schema`.

## Loop del agente

```
Entrada de canal → gateway.runner.dispatch()
  → resolveSession(canal, user/thread)
  → AIAgent.runConversation()  // wrapper sobre createAgentSession de pi.dev
    → promptBuilder.build()     // lee ficha completa
    → providers.resolve()
    → pi.dev call con tools (builtins + MCP + custom)
    → cada tool call:
      → approval.classify(toolCall)
      → trivial: ejecuta; medio/alto: encola, notifica, espera, ejecuta
      → audit.log()
    → loop hasta no más tool calls
  → respuesta vía gateway de origen
  → sessionStore.save()
```

# Roadmap de construcción

## Fase -1 — Bootstrap (esta fase)

### Estructura base
- Crear `~/Documents/Proyectos/zia/` e inicializar git.
- Inicializar `pnpm`, `tsconfig.base.json`, `.gitignore`, `.editorconfig`.

### Documentación opensource
- `README.md` (Apéndice G) — landing del repo.
- `LICENSE` — MIT (alineado con Hermes, gentle-ai, OpenClaw).
- `CONTRIBUTING.md` (Apéndice G).
- `CODE_OF_CONDUCT.md` — Contributor Covenant 2.1 estándar.
- `docs/PRD.md` (Apéndice F).
- `docs/IMPLEMENTATION_PLAN.md` — copiar este plan al repo.
- `docs/ARCHITECTURE.md` — esqueleto (se llena en Fase 0).
- `docs/ROADMAP.md` — fases públicas para contribuidores.
- `docs/SDD/README.md` — explica el flujo SDD del proyecto.
- `.github/PULL_REQUEST_TEMPLATE.md`, `.github/ISSUE_TEMPLATE/` (bug, feature).
- `.github/workflows/ci.yml` — typecheck + tests en cada PR.

### Setup de Claude Code
- `CLAUDE.md` (Apéndice B).
- `.claude/settings.json` (Apéndice C).
- Instalar skills externos vía `npx skillsadd` (lista arriba).
- Crear skills propios: `pi-sdk` (Apéndice A), `zia-architecture`, `agent-ficha-schema`.
- Crear subagents: `architect`, `tool-builder` (Apéndice D).
- Crear slash command: `new-agent` (Apéndice E).

### Setup de gentle-ai (SDD)
- Instalar gentle-ai: `brew install Gentleman-Programming/homebrew-tap/gentle-ai`.
- Verificar: `gentle-ai doctor`.
- En el repo: `gentle-ai sdd-init` (registra el proyecto, activa Strict TDD).
- `gentle-ai skill-registry refresh` (descubre los skills custom de zia).
- Configurar perfiles SDD con los modelos por fase (ver sección "Setup inicial dentro del proyecto").

### Template del agente
- Crear `agents/_template/` con `SOUL.md`, `POLICIES.md`, `KNOWLEDGE.md`, `MEMORY.md`, `profile.yaml`, `tools.yaml`, `mcp.yaml` (placeholders para `/new-agent`).

### Cerrar Fase -1
- Commit inicial: `chore: bootstrap zia framework`.
- Crear repo en GitHub (Inteliside o personal de Raul), push inicial.
- Configurar branch protection en `main`.

**Hito**: el repo está vivo en GitHub, alguien clona, ejecuta `pnpm install && gentle-ai sdd-init`, abre Claude Code, ve CLAUDE.md, descubre skills, está listo para contribuir a Fase 0.

## Fase 0 — Spike del núcleo
- `packages/core/agent.ts` mínimo envolviendo `createAgentSession`.
- Carga de `SOUL.md` como systemPromptOverride.
- Usar TUI nativa de pi.dev (`InteractiveMode`) para hablar con el agente.
- **Hito**: arrancas un agente desde carpeta, abres TUI, te responde leyendo su SOUL.

## Fase 1 — Agente único en container con aprobación
- `packages/core/prompt-builder.ts` lee toda la ficha.
- `packages/tools/registry.ts` con auto-registro.
- `packages/callbacks/approval.ts` con clasificación trivial/medio/alto.
- `packages/persistence/db.ts` con better-sqlite3 + FTS5.
- `apps/agent-web-ui` mínima (chat + cola de aprobaciones) que se conecta vía JSON-RPC al agente.
- `apps/agent-runtime/Dockerfile`.
- **Hito**: agente en Docker, conversas por Web UI, te pide aprobaciones, todo en SQLite.

## Fase 2 — MCP adapter + conectividad real
- `packages/tools/adapters/mcp-adapter.ts`: arranca MCP servers como subprocesos y los expone como tools de pi.dev vía `defineTool()`.
- `packages/gateways/platforms/email-imap.ts`: IMAP listener + SMTP sender.
- `packages/gateways/platforms/slack.ts`: bot con cuenta propia del agente.
- Templates de fichas para 1 rol completo (asistente de proyectos).
- **Hito**: el agente recibe email, consulta Linear vía MCP, redacta respuesta, pide aprobación, envía firmado como él mismo.

## Fase 3 — Cron + multi-agente + panel central
- `packages/cron/scheduler.ts` + `jobs.json` por agente.
- 2-3 agentes en paralelo (containers separados).
- `apps/control-panel` (Next.js + Postgres): lista, audit agregado, editor de fichas.
- **Hito**: equipo de Inteliside ve panel con sus agentes.

## Fase 4 — Pulido + opensource
- Docs arquitectónicas (estilo Hermes docs).
- Templates de ficha para 3-4 roles.
- `npm create zia-agent` genera carpeta + docker-compose.
- Publicación pública.

# Verificación end-to-end (al terminar Fase 2)

1. Llega email a `proyectos@inteliside.com`.
2. Gateway IMAP detecta y dispara `AIAgent.runConversation()` vía RPC.
3. Agente consulta Linear vía MCP, genera borrador.
4. `approval.ts` clasifica como **alto** → encola.
5. Raul ve la cola en Web UI + notificación Slack.
6. Raul aprueba (o edita y aprueba).
7. SMTP envía firmado como `proyectos@inteliside.com`.
8. `audit.log()` registra.
9. `MEMORY.md` se actualiza.

# Riesgos

| Riesgo | Mitigación |
|---|---|
| Pi.dev SDK sin MCP nativo | Adaptador propio en Fase 2 (skill `mcp-builder` ayuda) |
| Tools built-in de pi.dev orientadas a coding | Usadas dentro del container; las empresariales son custom |
| Gobernanza vive en cabeza del jefe | `KNOWLEDGE.md` se llena iterativamente |
| Aprobaciones tediosas | Clasificación trivial/medio/alto en `POLICIES.md` |
| Costo LLM con N agentes always-on | Idle la mayoría del tiempo; budget por agente; cache breakpoints |
| Credenciales por agente trabajo manual | Documentado como onboarding de empleado |
| Container por agente pesa RAM | OK para 5-10 agentes; K8s después |

---

# Apéndice A — `.claude/skills/pi-sdk/SKILL.md`

Skill completo listo para copiar.

```markdown
---
name: pi-sdk
description: Reference for @earendil-works/pi-coding-agent (pi.dev SDK) — Node/TypeScript SDK with TUI, JSON, and RPC modes. Use when implementing the agent core, gateways, custom tools, or any code touching pi.dev. Triggers on imports of @earendil-works/pi-coding-agent, on `createAgentSession`, `defineTool`, `runRpcMode`, `runPrintMode`, `InteractiveMode`, and on mentions of pi.dev or "pi sdk".
---

# pi.dev SDK reference for zia

The pi.dev SDK is the runtime cerebrum of every zia agent. It exposes 3 modes:

| Mode | Function | Used by |
|---|---|---|
| TUI interactive | `InteractiveMode` | Admin/dev access to container |
| Print (one-shot) | `runPrintMode` | Cron jobs, webhooks |
| JSON-RPC subprocess | `runRpcMode` | Gateways (Slack/Email/HTTP), Web UI |

## Package

```bash
pnpm add @earendil-works/pi-coding-agent @earendil-works/pi-ai typebox
```

## Core imports

```typescript
import {
  createAgentSession,
  createAgentSessionRuntime,
  createAgentSessionFromServices,
  createAgentSessionServices,
  AuthStorage,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  DefaultResourceLoader,
  defineTool,
  InteractiveMode,
  runPrintMode,
  runRpcMode,
  createEventBus,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai";
import { Type } from "typebox";
```

## Minimal agent

```typescript
const { session } = await createAgentSession();
await session.prompt("What's in the current directory?");
```

## Full configured agent (zia pattern)

```typescript
const authStorage = AuthStorage.create();
authStorage.setRuntimeApiKey("anthropic", process.env.ANTHROPIC_API_KEY!);

const modelRegistry = ModelRegistry.create(authStorage);
const model = getModel("anthropic", "claude-sonnet-4-6");

const loader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir: process.env.ZIA_AGENT_DIR,
  systemPromptOverride: () => buildPromptFromFicha(fichaPath),
});
await loader.reload();

const { session } = await createAgentSession({
  cwd: process.cwd(),
  model,
  thinkingLevel: "medium",
  authStorage,
  modelRegistry,
  resourceLoader: loader,
  tools: ["read", "bash", "edit", "write"],
  customTools: [...mcpTools, ...customZiaTools],
  sessionManager: SessionManager.create(process.cwd()),
  settingsManager: SettingsManager.create(),
});
```

## Custom tools — pattern for zia

```typescript
const sendEmailTool = defineTool({
  name: "send_email",
  label: "Send Email",
  description: "Send an email from the agent's mailbox (REQUIRES APPROVAL).",
  parameters: Type.Object({
    to: Type.String(),
    subject: Type.String(),
    body: Type.String(),
  }),
  execute: async (toolCallId, params) => {
    // In zia: route to approval queue, wait for human OK, then send.
    const approved = await approvalQueue.requestApproval({
      toolCallId,
      action: "send_email",
      payload: params,
      riskLevel: "high",
    });
    if (!approved) {
      return {
        content: [{ type: "text", text: "Rejected by human approver." }],
        details: { rejected: true },
      };
    }
    const result = await smtpClient.send(params);
    return {
      content: [{ type: "text", text: `Email sent to ${params.to}` }],
      details: { messageId: result.id },
    };
  },
});
```

## Run modes for zia

### TUI (admin / dev)

```typescript
const runtime = await createAgentSessionRuntime(factory, {
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  sessionManager: SessionManager.create(process.cwd()),
});

const mode = new InteractiveMode(runtime, {
  migratedProviders: [],
  modelFallbackMessage: undefined,
  initialMessage: "",
  initialImages: [],
  initialMessages: [],
});

await mode.run();
```

### RPC (gateways, Web UI)

```typescript
const runtime = await createAgentSessionRuntime(factory, { ... });
await runRpcMode(runtime);
// Listens on stdin/stdout for JSON-RPC commands. See docs/latest/rpc.
```

### Print (cron, webhooks)

```typescript
await runPrintMode(runtime, {
  mode: "text", // or "json"
  initialMessage: "Generate monthly report",
  initialImages: [],
  messages: [],
});
```

## RPC protocol — what gateways send

The JSON-RPC protocol uses stdin/stdout with newline-delimited JSON. Critical: **do NOT use Node `readline`** — it splits on `U+2028`/`U+2029` which are valid inside JSON strings. Split on `\n` only.

### Commands gateways send

```json
{"id": "req-1", "type": "prompt", "message": "Hello"}
{"id": "req-2", "type": "steer", "message": "Stop, do this instead"}
{"id": "req-3", "type": "follow_up", "message": "Then also do this"}
{"id": "req-4", "type": "abort"}
{"id": "req-5", "type": "get_state"}
{"id": "req-6", "type": "get_messages"}
{"id": "req-7", "type": "new_session"}
{"id": "req-8", "type": "fork", "entryId": "abc123"}
{"id": "req-9", "type": "set_model", "provider": "anthropic", "modelId": "claude-sonnet-4-6"}
{"id": "req-10", "type": "compact"}
{"id": "req-11", "type": "get_session_stats"}
```

### Events streamed to stdout

| Event type | Meaning |
|---|---|
| `agent_start` / `agent_end` | Agent processing lifecycle |
| `turn_start` / `turn_end` | One LLM response + its tool calls |
| `message_start` / `message_update` / `message_end` | Message streaming |
| `tool_execution_start` / `tool_execution_update` / `tool_execution_end` | Tool lifecycle |
| `queue_update` | Steering/follow-up queue changed |
| `compaction_start` / `compaction_end` | Context compaction |
| `auto_retry_start` / `auto_retry_end` | Retry on transient errors |
| `extension_ui_request` | Extension wants user input (select/confirm/input/editor) |

### Reading events safely in Node

```typescript
function attachJsonlReader(stream: NodeJS.ReadableStream, onLine: (line: string) => void) {
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    while (true) {
      const nl = buffer.indexOf("\n");
      if (nl === -1) break;
      let line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      onLine(line);
    }
  });
}
```

## JSON event stream mode (for cron/webhook)

```bash
pi --mode json "Generate financial summary for last month" 2>/dev/null
```

Output is JSONL — same event shapes as RPC mode. Use jq to filter:

```bash
pi --mode json "..." | jq -c 'select(.type == "agent_end") | .messages[-1]'
```

## Session management

```typescript
// In-memory (no persistence, good for cron one-shots)
SessionManager.inMemory()

// Persistent (recommended for zia: each agent has its own session DB)
SessionManager.create(cwd)

// Continue most recent
SessionManager.continueRecent(cwd)

// Open specific
SessionManager.open("/path/to/session.jsonl")
```

Sessions are JSONL files with tree structure (branching support). Each agent in zia has its own session directory inside its container volume.

## Events to subscribe to (for Web UI / audit log)

```typescript
session.subscribe((event) => {
  switch (event.type) {
    case "message_update":
      if (event.assistantMessageEvent.type === "text_delta") {
        // Stream to Web UI via WebSocket
      }
      break;
    case "tool_execution_start":
      // Log to audit
      break;
    case "tool_execution_end":
      // Log result; if isError, surface to human
      break;
    case "agent_end":
      // Save session state
      break;
  }
});
```

## TUI customization (for admin UX)

The TUI supports overlay components, custom editor (vim modal possible), status indicators, widgets above/below the editor. Useful for showing pending approvals as a persistent widget.

```typescript
ctx.ui.setWidget("pending-approvals", (_tui, theme) => ({
  render: () => approvalQueue.pending.map(a => `⏳ ${a.action}`),
  invalidate: () => {},
}));
```

## Settings

Stored in `~/.pi/agent/settings.json` or `<cwd>/.pi/settings.json`. Override per agent:

```typescript
SettingsManager.inMemory({
  compaction: { enabled: true },
  retry: { enabled: true, maxRetries: 3 },
});
```

## Conventions for zia agents

1. **One pi.dev session per agent container** (one process, not multi-profile).
2. **Wrap `createAgentSession` in `packages/core/agent.ts`** — never call pi.dev SDK directly from gateways/web-ui.
3. **All tool execution goes through `packages/callbacks/approval.ts`** for risk classification.
4. **MCP servers register as custom tools** via the adapter in `packages/tools/adapters/mcp-adapter.ts`.
5. **Use thinking levels per role**: financial/legal = `high`; routine = `medium`; chat = `low`.
6. **Per-agent budget**: read `profile.yaml.llm.monthly_budget_usd` and abort if exceeded.
```

# Apéndice B — `CLAUDE.md` raíz del proyecto

```markdown
# zia

zia is an opensource framework for deploying employee-style AI agents in companies.
Each agent runs in its own Docker container, has its own corporate email, own
credentials for company tools, and serves a human boss inside the team.

Architecture is inspired by Hermes (Nous Research). See `docs/architecture.md`.

# Stack
- TypeScript/Node, pnpm workspaces
- pi.dev SDK (`@earendil-works/pi-coding-agent`) as agent core
- Next.js for Web UI and Control Panel
- better-sqlite3 with FTS5 for session/audit persistence
- Docker for per-agent isolation
- MCP for integrations (Linear, Notion, Drive, Slack)

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

# Workflow
- Use plan mode before any non-trivial change.
- Read `docs/architecture.md` and the relevant SKILL.md before touching pi.dev code.
- Skills: `pi-sdk`, `zia-architecture`, `agent-ficha-schema` are in `.claude/skills/`.
- Subagents: `architect` for design, `tool-builder` for custom tools.
- Slash commands: `/new-agent <name>` scaffolds a new agent ficha.

# Code style
- TypeScript strict mode. No `any`.
- ESM only. No CommonJS.
- Tests with vitest. Coverage not enforced but encouraged for `packages/core/`.
- Conventional commits (feat:, fix:, refactor:, docs:, test:, chore:).

# Common commands
- `pnpm typecheck` — run tsc across all packages
- `pnpm test` — run vitest
- `pnpm lint` — eslint
- `pnpm dev` — start dev mode for current package
- `pnpm --filter @zia/agent-runtime docker:build` — build agent Docker image

# Workflow rules
- IMPORTANT: never call pi.dev SDK directly from gateways or apps. Always go
  through `packages/core/agent.ts`.
- IMPORTANT: tool execution that touches external systems (email send, Slack post,
  ticket creation) MUST go through `packages/callbacks/approval.ts`. Trivial reads
  are exempt — see `POLICIES.md` schema.
- IMPORTANT: never put credentials in `agents/*/profile.yaml`. Use env vars
  (`*_env: VAR_NAME`) and reference them at runtime.
- Verify changes by running `pnpm typecheck && pnpm test` before committing.

# Architecture references
- Hermes architecture (inspiration): https://hermes-agent.nousresearch.com/docs/developer-guide/architecture
- pi.dev SDK docs: https://pi.dev/docs/latest/sdk
- pi.dev RPC: https://pi.dev/docs/latest/rpc
- pi.dev JSON: https://pi.dev/docs/latest/json
- pi.dev TUI: https://pi.dev/docs/latest/tui
- Plan: @../../.claude/plans/hola-quiero-que-me-replicated-quail.md
```

# Apéndice C — `.claude/settings.json`

```json
{
  "permissions": {
    "allow": [
      "Bash(pnpm:*)",
      "Bash(npx skillsadd:*)",
      "Bash(git status)",
      "Bash(git diff:*)",
      "Bash(git log:*)",
      "Bash(git add:*)",
      "Bash(git commit:*)",
      "Bash(docker compose:*)",
      "Bash(docker build:*)",
      "Edit",
      "Write",
      "Read",
      "Grep",
      "Glob"
    ],
    "deny": [
      "Bash(git push --force:*)",
      "Bash(rm -rf:*)"
    ]
  },
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "pathMatcher": ".*\\.(ts|tsx)$",
        "command": "pnpm typecheck"
      },
      {
        "matcher": "Edit|Write",
        "pathMatcher": "agents/.*/profile\\.yaml$",
        "command": "pnpm --filter @zia/core validate-ficha"
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Bash",
        "patternMatcher": "git push.*main",
        "command": "echo 'Direct push to main blocked. Open a PR.' && exit 1"
      }
    ]
  }
}
```

# Apéndice D — Subagents

## `.claude/agents/architect.md`

```markdown
---
name: architect
description: Senior software architect for zia. Use when making non-trivial design
  decisions, evaluating trade-offs, or designing new packages. Reads docs/architecture.md
  and the plan before answering.
tools: Read, Grep, Glob, WebFetch
model: opus
---

You are a senior software architect for the zia project. Before answering:

1. Read `docs/architecture.md` and `.claude/plans/*` if relevant.
2. Read the Hermes architecture doc when the question touches the core loop.
3. Check the existing package boundaries — never propose collapsing them without
   strong reason.
4. When suggesting changes, name the exact files and packages affected.
5. Flag any deviation from the original plan and explain why.

Output format: decision + reasoning + files affected + trade-offs.
```

## `.claude/agents/tool-builder.md`

```markdown
---
name: tool-builder
description: Builds custom tools for zia agents — either as native pi.dev tools via
  defineTool() or as MCP adapters. Use when adding a new integration or new capability.
tools: Read, Edit, Write, Bash, Grep, Glob
model: sonnet
---

You build custom tools for zia agents. Workflow:

1. Read `.claude/skills/pi-sdk/SKILL.md` for the defineTool() pattern.
2. Read `packages/tools/registry.ts` for the auto-registration pattern.
3. Read `packages/callbacks/approval.ts` for risk classification — every new tool
   MUST declare its risk level.
4. Implement the tool in `packages/tools/builtins/` or as an MCP adapter in
   `packages/tools/adapters/`.
5. Add a vitest test in the same package.
6. Document the tool in the agent ficha template if it's a default capability.

Never bypass the approval flow for external-side-effect tools.
```

# Apéndice E — Slash command

## `.claude/commands/new-agent.md`

```markdown
---
name: new-agent
description: Scaffold a new agent ficha in agents/$ARGUMENTS with all required files.
---

Create a new agent directory at `agents/$ARGUMENTS/` with these files:

1. `SOUL.md` — copy from `agents/_template/SOUL.md`, replace placeholders.
2. `POLICIES.md` — copy from template.
3. `KNOWLEDGE.md` — empty starter with section headers.
4. `MEMORY.md` — empty file.
5. `profile.yaml` — copy template, fill in: id=$ARGUMENTS-001, name (ask user),
   email (ask user), bosses (ask user).
6. `tools.yaml` — copy template with minimal enabled tools.
7. `mcp.yaml` — empty servers list.

After creating, run `pnpm --filter @zia/core validate-ficha agents/$ARGUMENTS`.

Print a summary of what was created and which env vars the user must set
before running this agent in Docker.
```

# Apéndice F — `docs/PRD.md`

Product Requirements Document inicial. Crece con el proyecto.

```markdown
# zia — Product Requirements Document

## 1. Problema

Las empresas pequeñas y medianas (5-50 personas) necesitan apalancarse con IA
sin entregar control sobre datos sensibles ni adoptar SaaS propietarios. Hoy
las opciones son:

- **Asistentes personales tipo ChatGPT/Claude.ai**: no tienen identidad propia,
  no se integran a las herramientas internas, no actúan como empleados.
- **Plataformas comerciales (Lindy, Decagon, Sierra)**: SaaS, datos en la nube
  del proveedor, cero control, costoso.
- **Frameworks de agentes (LangGraph, CrewAI)**: requieren ingeniería seria, no
  vienen con identidad de empleado, integraciones, ni gobernanza empresarial.

## 2. Solución

`zia` es un framework opensource que permite desplegar **agentes-empleados**:
cada agente vive aislado en su propio container Docker, con su propio email
corporativo, sus propias credenciales para Slack/Linear/GitHub, y trabaja para
un jefe humano del equipo bajo un modelo de copiloto (humano aprueba acciones
externas).

## 3. Usuarios

### Usuario primario: el jefe humano del agente
- Profesional no-necesariamente-técnico en un equipo de 5-50 personas.
- Trabaja con su agente vía Web UI, Slack, o email.
- Aprueba acciones externas, revisa el audit log, edita la ficha del agente.

### Usuario secundario: el operador técnico
- Devops/founder técnico que despliega los containers.
- Configura credenciales por agente, monitorea el panel central.
- Edita fichas vía git PRs.

### Usuario terciario: el contribuidor opensource
- Developer que extiende `zia` con nuevos gateways, tools, o templates de rol.

## 4. Requisitos funcionales

### Core (MVP — Fase 0-2)
- F1. Un agente arranca desde una carpeta de ficha (`agents/<nombre>/`).
- F2. El agente carga su SOUL, POLICIES, KNOWLEDGE, MEMORY al system prompt.
- F3. El jefe humano conversa con el agente vía Web UI dentro del container.
- F4. Las tools "externas" (definidas en POLICIES) requieren aprobación humana.
- F5. El agente lee y envía email vía IMAP/SMTP del servidor corporativo.
- F6. El agente accede a Linear/Notion/Drive vía MCP servers.
- F7. El agente postea en Slack con su propia identidad de bot.
- F8. Todas las acciones quedan en un audit log local (SQLite).

### Multi-modelo y multi-proveedor (transversal — desde Fase 1)
- F-LLM-1. La ficha del agente declara una lista de modelos disponibles (`llm.available`).
- F-LLM-2. El jefe humano puede cambiar de modelo en runtime sin reiniciar el agente, vía Web UI, TUI (Ctrl+P) o RPC.
- F-LLM-3. Soporte multi-proveedor: Anthropic, OpenAI, Ollama (local), y cualquier provider que pi.dev soporte.
- F-LLM-4. Si el modelo activo falla (rate limit, error 5xx), fallback automático al siguiente de `llm.available` si `fallback_on_error: true`.
- F-LLM-5. El thinking level es configurable por modelo y cambiable en runtime.
- F-LLM-6. Reglas en `POLICIES.md` pueden forzar el modelo según el tipo de tarea (ej. cálculos financieros → Opus).

### Multi-agente (Fase 3)
- F9. Múltiples agentes corren en containers separados sin colisión.
- F10. Panel central lista agentes, estado, audit agregado.
- F11. Cron jobs por agente (revisar inbox, recordatorios, reportes).

### Polish (Fase 4)
- F12. `npm create zia-agent` scaffolds una ficha + docker-compose.
- F13. Templates de ficha para 3-4 roles comunes (proyectos, comercial, soporte, financiero).

## 5. Requisitos no-funcionales

- **NF1. Self-hosted obligatorio**: cero dependencia de servicios cloud propietarios. Pi.dev SDK + Anthropic API es la única dependencia externa runtime.
- **NF2. Versionable en git**: la ficha de cada agente (sin secretos) es texto plano.
- **NF3. Aislamiento real**: un container comprometido no afecta a otros agentes ni al host.
- **NF4. Audit completo**: cada acción del agente queda registrada con timestamp, aprobador (si aplica), input, output.
- **NF5. Open source con licencia MIT.**
- **NF6. Idiomas**: documentación en español e inglés (Inteliside es LATAM-first).

## 6. Out of scope (al menos en MVP)

- Modelos LLM locales — Claude-first; soporte de otros LLMs vía pi.dev pero sin garantía.
- Voz / audio.
- Mobile native — la Web UI debe ser responsive y suficiente.
- Federación entre agentes en empresas distintas.
- Marketplace de tools comercial.

## 7. Métricas de éxito

### Para Inteliside (uso interno)
- M1. 3 agentes desplegados, usados diariamente, por al menos 2 personas del equipo.
- M2. >50% de las acciones rutinarias del rol cubiertas por el agente (medible por jefe humano).
- M3. <10% de aprobaciones rechazadas tras 2 semanas de uso (señal de que el agente "entiende" su rol).

### Para opensource
- M4. >100 stars en GitHub en los primeros 3 meses post-publicación.
- M5. Al menos 1 fork con un rol nuevo aportado a la comunidad.

## 8. Riesgos del producto

Ver sección "Riesgos" en `IMPLEMENTATION_PLAN.md`.

## 9. Roadmap público

Ver `docs/ROADMAP.md`.
```

# Apéndice G — `README.md` raíz y `CONTRIBUTING.md`

## `README.md`

```markdown
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
- the agent's "ficha" (role definition, policies, knowledge) is plain markdown,
  versionable in git, reviewable in PRs.

Inspired by [Hermes Agent](https://hermes-agent.nousresearch.com/) (Nous Research)
and [OpenClaw](https://docs.openclaw.ai/), but built specifically for the
**enterprise employee** use case rather than personal or coding-focused agents.

Built on top of [pi.dev SDK](https://pi.dev) as the agent runtime, with
TypeScript everywhere.

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

## Roadmap

See [`docs/ROADMAP.md`](docs/ROADMAP.md).

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). PRs welcome — start by reading
[`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) and
[`docs/SDD/README.md`](docs/SDD/README.md) for the development workflow.

## License

MIT
```

## `CONTRIBUTING.md`

```markdown
# Contributing to zia

Thanks for considering a contribution. zia is built and used by the Inteliside
team in Guayaquil, Ecuador, and opened to the community as a byproduct.

## Development workflow

We use **Spec-Driven Development** via [gentle-ai](https://github.com/Gentleman-Programming/gentle-ai).
Every non-trivial feature follows 4 phases with artifacts in `docs/SDD/`:

1. `/sdd-design` — architectural sketch (model: Opus).
2. `/sdd-spec` — detailed spec with interfaces and acceptance criteria (Opus).
3. `/sdd-implement` — TDD implementation against the spec (Sonnet).
4. `/sdd-review` — adversarial review against the spec (Sonnet).

For trivial changes (typo fixes, doc updates), skip SDD and open a PR directly.

## Setup

```bash
pnpm install
gentle-ai sdd-init
pnpm typecheck && pnpm test
```

## Code standards

- TypeScript strict mode, no `any`.
- ESM only.
- Tests with vitest. Add a test for every behavior change.
- Conventional commits (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`).
- Run `pnpm typecheck && pnpm test && pnpm lint` before submitting.

## Where things live

- New tool? → `packages/tools/builtins/` or `packages/tools/adapters/`.
- New gateway? → `packages/gateways/platforms/`.
- New role template? → `agents/_templates/<role>/`.
- Architecture decisions? → `docs/SDD/<feature>/design.md`.

## Reporting bugs

Use the GitHub issue template. Include:
- zia version (`pnpm zia --version`).
- pi.dev SDK version.
- Minimal repro (a ficha that triggers it).
- Audit log excerpt if relevant.

## Code of Conduct

We follow the [Contributor Covenant 2.1](CODE_OF_CONDUCT.md).
```

# Notas finales

- No hay timeline. Calidad sobre velocidad.
- La meta primaria es uso interno en Inteliside. Opensource es subproducto cultural.
- El plan vive en `docs/IMPLEMENTATION_PLAN.md` del repo (no en `~/.claude/plans/`). La de `~/.claude/plans/` es artefacto histórico.
- Cada decisión arquitectónica importante queda en `docs/SDD/<feature>/design.md` gracias a gentle-ai.
- Cada agente que entre en producción en Inteliside, su ficha (sin secretos) se commitea al repo `zia` como template para la comunidad.
- Documentar la arquitectura con el mismo nivel de detalle que Hermes hace al proyecto más atractivo si se libera.
