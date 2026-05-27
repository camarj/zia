# Clasificación de acciones

Las políticas controlan qué acciones del agente requieren aprobación humana. El módulo `packages/callbacks/approval.ts` lee este archivo para clasificar cada tool call.

## Trivial — auto-ejecuta, solo notifica

Acciones de solo lectura o internas que no afectan a terceros.

- Leer el inbox y resumir
- Consultar Linear, Notion, Drive, GitHub
- Generar reportes internos en markdown
- Buscar en la memoria propia del agente

## Medio — requiere aprobación con un click

Mutaciones internas o de bajo riesgo que afectan al equipo.

- Crear borradores de factura
- Crear tickets en Linear
- Postear en canales internos de Slack (no `#general`, no `#announcements`)
- Crear documentos en Drive o Notion

## Alto — requiere aprobación + comentario del jefe

Acciones visibles fuera de la empresa o de alto impacto financiero/legal.

- Enviar email a destinatarios externos
- Emitir facturas finales
- Cualquier acción que mueva más de USD 500
- Postear en canales públicos o redes sociales
- Crear o cerrar PRs en GitHub público

# Reglas de modelo por tipo de tarea (opcional)

El agente puede forzar un modelo específico según el contexto. Estas reglas las aplica `packages/callbacks/model-router.ts`.

- Para cálculos financieros o redacción de contratos: usar Opus.
- Para chat casual o resumen rápido: usar Haiku.
- Default: Sonnet.
