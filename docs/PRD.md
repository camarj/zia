# zia — Product Requirements Document

## 1. Problema

Las empresas pequeñas y medianas (5-50 personas) necesitan apalancarse con IA sin entregar control sobre datos sensibles ni adoptar SaaS propietarios. Hoy las opciones son:

- **Asistentes personales tipo ChatGPT/Claude.ai**: no tienen identidad propia, no se integran a las herramientas internas, no actúan como empleados.
- **Plataformas comerciales (Lindy, Decagon, Sierra)**: SaaS, datos en la nube del proveedor, cero control, costoso.
- **Frameworks de agentes (LangGraph, CrewAI)**: requieren ingeniería seria, no vienen con identidad de empleado, integraciones, ni gobernanza empresarial.

## 2. Solución

`zia` es un framework opensource que permite desplegar **agentes-empleados**: cada agente vive aislado en su propio container Docker, con su propio email corporativo, sus propias credenciales para Slack/Linear/GitHub, y trabaja para un jefe humano del equipo bajo un modelo de copiloto (humano aprueba acciones externas).

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
- **F1.** Un agente arranca desde una carpeta de ficha (`agents/<nombre>/`).
- **F2.** El agente carga su SOUL, POLICIES, KNOWLEDGE, MEMORY al system prompt.
- **F3.** El jefe humano conversa con el agente vía Web UI dentro del container.
- **F4.** Las tools "externas" (definidas en POLICIES) requieren aprobación humana.
- **F5.** El agente lee y envía email vía IMAP/SMTP del servidor corporativo.
- **F6.** El agente accede a Linear/Notion/Drive vía MCP servers.
- **F7.** El agente postea en Slack con su propia identidad de bot.
- **F8.** Todas las acciones quedan en un audit log local (SQLite).

### Multi-modelo y multi-proveedor (transversal — desde Fase 1)
- **F-LLM-1.** La ficha del agente declara una lista de modelos disponibles (`llm.available`).
- **F-LLM-2.** El jefe humano puede cambiar de modelo en runtime sin reiniciar el agente, vía Web UI, TUI (Ctrl+P) o RPC.
- **F-LLM-3.** Soporte multi-proveedor: Anthropic, OpenAI, Ollama (local), y cualquier provider que pi.dev soporte.
- **F-LLM-4.** Si el modelo activo falla, fallback automático al siguiente de `llm.available` si `fallback_on_error: true`.
- **F-LLM-5.** El thinking level es configurable por modelo y cambiable en runtime.
- **F-LLM-6.** Reglas en `POLICIES.md` pueden forzar el modelo según el tipo de tarea.

### Multi-agente (Fase 3)
- **F9.** Múltiples agentes corren en containers separados sin colisión.
- **F10.** Panel central lista agentes, estado, audit agregado.
- **F11.** Cron jobs por agente (revisar inbox, recordatorios, reportes).

### Polish (Fase 4)
- **F12.** `npm create zia-agent` scaffolds una ficha + docker-compose.
- **F13.** Templates de ficha para 3-4 roles comunes (proyectos, comercial, soporte, financiero).

## 4.bis Paridad funcional de núcleo con Hermes

> Esta sección surge de una auditoría del **harness central de Hermes** (sus features y arquitectura reales) contra el código actual de zia. Captura las capacidades del **cerebro del agente** que aún faltan. Son capacidades **in-process**, validables por CLI/TUI, **independientes de las capas de comunicación** (gateways). Por decisión de proyecto, el núcleo funcional se completa **antes** que los gateways y Docker.
>
> Estado: ✅ ya cubierto · ❌ falta · ⚠️ parcial. "pi.dev" indica si el SDK ya lo provee (no se reimplementa, solo se expone/configura).

### Ya cubierto (referencia)
- Loop del agente (wrapper sobre pi.dev), prompt builder (SOUL/POLICIES/KNOWLEDGE/MEMORY), adaptador MCP, aprobación + clasificación de riesgo + audit, persistencia SQLite+FTS5, y cambio de modelo estático por CLI.

### Requisitos funcionales del núcleo (faltantes)

- **F-CORE-1.** El agente dispone de **builtin tools** (read, write, edit, bash, search-files) expuestas a través del registry, y todas pasan por el gate de aprobación según `POLICIES.md`. *(pi.dev las provee; hoy zia las desactiva con `tools: []`.)*
- **F-CORE-2.** Existe un **tool registry** con auto-registro al importar, más scaffolding para definir tools custom vía `defineTool()`.
- **F-CORE-3.** El agente puede **leer y escribir su `MEMORY.md` en runtime** mediante una memory tool (no solo leerla al arrancar).
- **F-CORE-4.** El agente puede **buscar en el historial de la sesión** vía FTS5 (reusa `packages/persistence`).
- **F-CORE-5.** Existe `packages/memory` con providers **file-based** y **sqlite-fts**, con write-back, semántica de *frozen snapshot* (la memoria carga como snapshot al inicio de sesión; las escrituras van a disco pero no mutan el system prompt hasta una nueva sesión) y límites de tamaño.
- **F-CORE-6.** **Compactación de contexto** con disparo por umbral y linaje de sesión (`parent_session_id`). *(pi.dev expone `compact` por RPC pero sin auto-trigger; zia configura el umbral y el wrapper.)*
- **F-CORE-7.** **Prompt caching** con breakpoints de Anthropic sobre el bloque estable del prompt. *(pi.dev cubre la mayor parte; zia valida y configura.)*
- **F-CORE-8.** **Enforcement de presupuesto** por agente (`monthly_budget_usd`): el agente avisa y se detiene al superar el límite. *(Hoy el campo está declarado en `profile.yaml` pero no se aplica.)*
- **F-CORE-9.** **Cambio de modelo en runtime** dentro de la sesión: Ctrl+P en la TUI y `set_model` por RPC, sin reiniciar. *(pi.dev lo soporta; falta el wiring.)* Complementa F-LLM-2.
- **F-CORE-10.** **Slash commands de control** disponibles para el jefe en la sesión: `/model`, `/memory`, `/status`, `/help`.

### No-goals del núcleo (Hermes los tiene; zia NO en este bloque)

Se documentan explícitamente con su razón, para revisitar después. No forman parte de la visión "empleado corporativo con aprobación":

- **Code execution** (Python aislada vía RPC) — orientado a coding, no al rol de empleado.
- **Creación/gestión autónoma de skills** por el agente — zia usa fichas estáticas versionadas en git y revisadas por PR, no auto-generación.
- **Memory providers externos (Honcho, Mem0, etc.) y user-modeling** — zia es local-first (file + sqlite); los 9 providers externos de Hermes quedan fuera.
- **Subagent delegation / mixture-of-agents** — se evalúa en Fase 3+.
- **Voz/audio, generación de imagen/video, automatización de browser, computer-use, kanban, generación de training-data/batch** — fuera de la visión del producto.
- **Credential pools/rotation y context references (`@file`/`@url`/`@diff`)** — *nice-to-have* post-MVP.

## 5. Requisitos no-funcionales

- **NF1. Self-hosted obligatorio**: cero dependencia de servicios cloud propietarios. Pi.dev SDK + Anthropic API es la única dependencia externa runtime.
- **NF2. Versionable en git**: la ficha de cada agente (sin secretos) es texto plano.
- **NF3. Aislamiento real**: un container comprometido no afecta a otros agentes ni al host.
- **NF4. Audit completo**: cada acción del agente queda registrada con timestamp, aprobador (si aplica), input, output.
- **NF5. Open source con licencia MIT.**
- **NF6. Idiomas**: documentación en español e inglés (Inteliside es LATAM-first).

## 6. Out of scope (al menos en MVP)

- Modelos LLM locales como default — Claude-first; soporte de otros LLMs vía pi.dev pero sin garantía.
- Voz / audio.
- Mobile native — la Web UI debe ser responsive y suficiente.
- Federación entre agentes en empresas distintas.
- Marketplace de tools comercial.

## 7. Métricas de éxito

### Para Inteliside (uso interno)
- **M1.** 3 agentes desplegados, usados diariamente, por al menos 2 personas del equipo.
- **M2.** >50% de las acciones rutinarias del rol cubiertas por el agente (medible por jefe humano).
- **M3.** <10% de aprobaciones rechazadas tras 2 semanas de uso.

### Para opensource
- **M4.** >100 stars en GitHub en los primeros 3 meses post-publicación.
- **M5.** Al menos 1 fork con un rol nuevo aportado a la comunidad.

## 8. Riesgos del producto

Ver sección "Riesgos" en [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md).

## 9. Roadmap público

Ver [`ROADMAP.md`](ROADMAP.md).
