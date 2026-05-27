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
