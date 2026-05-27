---
name: pi-sdk
description: Reference for @earendil-works/pi-coding-agent (pi.dev SDK) — Node/TypeScript SDK with TUI, JSON, and RPC modes. Use when implementing the agent core, gateways, custom tools, or any code touching pi.dev. Triggers on imports of @earendil-works/pi-coding-agent, on createAgentSession, defineTool, runRpcMode, runPrintMode, InteractiveMode, and on mentions of pi.dev or "pi sdk".
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

## Run modes

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
// Listens on stdin/stdout for JSON-RPC commands.
```

### Print (cron, webhooks)

```typescript
await runPrintMode(runtime, {
  mode: "text",
  initialMessage: "Generate monthly report",
  initialImages: [],
  messages: [],
});
```

## RPC protocol

Newline-delimited JSON over stdin/stdout. **Do NOT use Node `readline`** — it splits on `U+2028`/`U+2029`, which are valid inside JSON strings. Split on `\n` only.

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
{"id": "req-10", "type": "cycle_model"}
{"id": "req-11", "type": "get_available_models"}
{"id": "req-12", "type": "set_thinking_level", "level": "high"}
{"id": "req-13", "type": "compact"}
{"id": "req-14", "type": "get_session_stats"}
```

### Events streamed to stdout

| Event | Meaning |
|---|---|
| `agent_start` / `agent_end` | Agent processing lifecycle |
| `turn_start` / `turn_end` | One LLM response + its tool calls |
| `message_start` / `message_update` / `message_end` | Message streaming |
| `tool_execution_start` / `tool_execution_update` / `tool_execution_end` | Tool lifecycle |
| `queue_update` | Steering/follow-up queue changed |
| `compaction_start` / `compaction_end` | Context compaction |
| `auto_retry_start` / `auto_retry_end` | Retry on transient errors |
| `extension_ui_request` | Extension wants user input |

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

## JSON event stream (for cron/webhook)

```bash
pi --mode json "Generate financial summary for last month" 2>/dev/null
```

Output is JSONL with the same event shapes as RPC mode. Use jq to filter:

```bash
pi --mode json "..." | jq -c 'select(.type == "agent_end") | .messages[-1]'
```

## Multi-model support

Each agent's ficha declares `llm.available`. Map it to pi.dev's `scopedModels`:

```typescript
const scopedModels = ficha.llm.available.map(m => ({
  model: getModel(m.provider, m.model),
  thinkingLevel: m.thinkingLevel ?? "off",
}));

const { session } = await createAgentSession({
  model: scopedModels[0].model,
  thinkingLevel: scopedModels[0].thinkingLevel,
  scopedModels,
  // ...
});

// Change model at runtime (from RPC, Web UI, TUI Ctrl+P):
await session.setModel(newModel);
await session.cycleModel();
session.setThinkingLevel("high");
```

## Session management

```typescript
SessionManager.inMemory()                       // No persistence (one-shots)
SessionManager.create(cwd)                      // Persistent (recommended)
SessionManager.continueRecent(cwd)              // Resume last
SessionManager.open("/path/to/session.jsonl")  // Specific
```

Sessions are JSONL files with tree structure (branching). Each agent in zia has its own session directory inside its container volume.

## Events to subscribe to (Web UI / audit log)

```typescript
session.subscribe((event) => {
  switch (event.type) {
    case "message_update":
      if (event.assistantMessageEvent.type === "text_delta") {
        // Stream to Web UI via WebSocket
      }
      break;
    case "tool_execution_start":
      auditLog.recordStart(event);
      break;
    case "tool_execution_end":
      auditLog.recordEnd(event);
      break;
    case "agent_end":
      sessionStore.save();
      break;
  }
});
```

## TUI customization

The TUI supports overlay components, custom editor, status indicators, widgets above/below the editor. Useful for surfacing pending approvals:

```typescript
ctx.ui.setWidget("pending-approvals", (_tui, theme) => ({
  render: () => approvalQueue.pending.map(a => `[pending] ${a.action}`),
  invalidate: () => {},
}));
```

## Settings

Stored in `~/.pi/agent/settings.json` or `<cwd>/.pi/settings.json`:

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
7. **Pass `scopedModels` from ficha** so model switching works in TUI/Web UI/RPC.
