# Clasificación de acciones

Las políticas controlan qué acciones del agente requieren aprobación humana. El módulo `packages/callbacks/approval.ts` lee este archivo para clasificar cada tool call.

## Trivial — auto-ejecuta, solo notifica

Acciones de solo lectura o internas que no afectan a terceros.

- Leer el inbox y resumir (tools: read_email)
- Consultar Linear, Notion, Drive, GitHub (tools: search_linear)
- Generar reportes internos en markdown (tools: generate_report)
- Buscar en la memoria propia del agente (tools: search_memory)

## Medio — requiere aprobación con un click

Mutaciones internas o de bajo riesgo que afectan al equipo.

- Crear borradores de factura (tools: create_invoice_draft)
- Crear tickets en Linear (tools: create_ticket)
- Postear en canales internos de Slack (tools: post_slack_internal)
- Crear documentos en Drive o Notion (tools: create_doc)

## Alto — requiere aprobación + comentario del jefe

Acciones visibles fuera de la empresa o de alto impacto financiero/legal.

- Enviar email a destinatarios externos (tools: send_email)
- Emitir facturas finales (tools: issue_invoice)
- Cualquier acción que mueva más de USD 500
- Postear en canales públicos o redes sociales (tools: post_slack_public)
- Crear o cerrar PRs en GitHub público (tools: manage_github_pr)

# Reglas de modelo por tipo de tarea (opcional)

El agente puede forzar un modelo específico según el contexto. Estas reglas las aplica `packages/callbacks/model-router.ts`.

- Para cálculos financieros o redacción de contratos: usar Opus.
- Para chat casual o resumen rápido: usar Haiku.
- Default: Sonnet.
