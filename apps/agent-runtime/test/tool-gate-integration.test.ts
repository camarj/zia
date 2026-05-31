/**
 * tool-gate-integration.test.ts — SPEC-F1-6, SPEC-F1-7, SPEC-P-2, SPEC-P-3
 *
 * Integration tests that wire wrapToolsWithApproval directly with the TEMPLATE
 * POLICIES.md risk declarations (agents/_template/POLICIES.md content from PR A).
 *
 * These tests exercise the COMPLETE classification + gate path with named tools
 * matching the builtins declared in POLICIES.md:
 *  - read  → trivial → auto-execute (SPEC-P-2 trivial path)
 *  - bash  → alto → approval required (SPEC-P-2 alto path)
 *  - unknown_tool → alto (default-deny, SPEC-P-3)
 *
 * SPEC-F1-7 "pi.dev native builtins stay suppressed in agent.ts" is verified via
 * a source content assertion — no network/credentials needed. The mechanism is
 * `noTools: "builtin"` (drops native read/bash/edit/write that would bypass the
 * gate, keeps gate-wrapped customTools) — NOT `tools: []`, which is a truthy
 * zero-tool allowlist that wrongly filters out customTools too.
 *
 * SPEC-F1-6 "every builtin flows through wrapToolsWithApproval" is demonstrated
 * by showing that read and bash both produce audit records (they passed through
 * the gate), and bash is not auto-executed (it went through the resolver).
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ApprovalQueue,
  ApprovalSerializer,
  PolicyClassifier,
  type ApprovalRequest,
  type ApprovalResolver,
  type AuditEntry,
  type AuditLog,
  type Decision,
  type ToolResult,
  type WrappableTool,
  wrapToolsWithApproval,
} from "@zia/callbacks";

// ---------------------------------------------------------------------------
// POLICIES.md content — same text as agents/_template/POLICIES.md (PR A result)
// Inline so the test is self-contained and independent of the filesystem.
// ---------------------------------------------------------------------------

const TEMPLATE_POLICIES = `# Clasificación de acciones

Las políticas controlan qué acciones del agente requieren aprobación humana. El módulo \`packages/callbacks/approval.ts\` lee este archivo para clasificar cada tool call.

## Trivial — auto-ejecuta, solo notifica

Acciones de solo lectura o internas que no afectan a terceros.

- Leer el inbox y resumir (tools: read_email)
- Consultar Linear, Notion, Drive, GitHub (tools: search_linear)
- Generar reportes internos en markdown (tools: generate_report)
- Buscar en la memoria propia del agente (tools: search_memory)
- Herramientas builtin de lectura y búsqueda
tools: read, grep, find, ls, search_session

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
- Herramientas builtin de escritura y ejecución de comandos
tools: bash, write, edit
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** In-memory AuditLog stub — collects records for assertions. */
class MemAuditLog implements AuditLog {
  readonly records: AuditEntry[] = [];
  record(entry: AuditEntry): Promise<void> {
    this.records.push(entry);
    return Promise.resolve();
  }
}

const AlwaysApproveResolver: ApprovalResolver = {
  resolve(_req: ApprovalRequest): Promise<Decision> {
    return Promise.resolve({ approved: true, approver: "test-admin" });
  },
};

/** Build a trivial named tool — classifies against TEMPLATE_POLICIES. */
function makeTool(name: string, store: string[]): WrappableTool {
  return {
    name,
    label: name,
    description: `Mock ${name}`,
    parameters: {},
    async execute(toolCallId: string, _params: Record<string, unknown>): Promise<ToolResult> {
      store.push(`${name}:${toolCallId}`);
      return {
        content: [{ type: "text", text: `${name} executed for ${toolCallId}` }],
        details: {},
      };
    },
  };
}

function makeDeps(resolver: ApprovalResolver = AlwaysApproveResolver) {
  const classifier = PolicyClassifier.fromPolicies(TEMPLATE_POLICIES);
  const auditLog = new MemAuditLog();
  const queue = new ApprovalQueue(resolver, new ApprovalSerializer());
  return { classifier, auditLog, queue };
}

// ---------------------------------------------------------------------------
// SPEC-P-2 — trivial path: read auto-executes without resolver involvement
// ---------------------------------------------------------------------------

describe("SPEC-P-2 — trivial tool: read auto-executes (template POLICIES.md)", () => {
  it("read tool runs immediately without queuing", async () => {
    const store: string[] = [];
    const deps = makeDeps();
    const wrapped = wrapToolsWithApproval([makeTool("read", store)], deps)[0]!;

    const result = await wrapped.execute("r-1", {});

    expect(store).toEqual(["read:r-1"]);
    expect(deps.queue.pending).toHaveLength(0);
    expect(result.content[0]?.text).toContain("read executed");
  });

  it("read audit record has decision=auto and approver=null", async () => {
    const store: string[] = [];
    const deps = makeDeps();
    const wrapped = wrapToolsWithApproval([makeTool("read", store)], deps)[0]!;

    await wrapped.execute("r-2", {});

    expect(deps.auditLog.records).toHaveLength(1);
    const rec = deps.auditLog.records[0]!;
    expect(rec.decision).toBe("auto");
    expect(rec.approver).toBeNull();
    expect(rec.toolName).toBe("read");
    expect(rec.riskLevel).toBe("trivial");
  });

  it("grep, find, ls, search_session are also trivial (same gate path)", async () => {
    for (const name of ["grep", "find", "ls", "search_session"]) {
      const store: string[] = [];
      const deps = makeDeps();
      const wrapped = wrapToolsWithApproval([makeTool(name, store)], deps)[0]!;

      await wrapped.execute(`${name}-1`, {});

      expect(store).toEqual([`${name}:${name}-1`]);
      const rec = deps.auditLog.records[0]!;
      expect(rec.decision).toBe("auto");
      expect(rec.riskLevel).toBe("trivial");
    }
  });
});

// ---------------------------------------------------------------------------
// SPEC-P-2 — alto path: bash queues for approval
// ---------------------------------------------------------------------------

describe("SPEC-P-2 — alto tool: bash goes through approval queue (template POLICIES.md)", () => {
  it("bash tool is approved and executes with AlwaysApproveResolver", async () => {
    const store: string[] = [];
    const deps = makeDeps(AlwaysApproveResolver);
    const wrapped = wrapToolsWithApproval([makeTool("bash", store)], deps)[0]!;

    await wrapped.execute("b-1", { cmd: "ls" });

    expect(store).toEqual(["bash:b-1"]);
    const rec = deps.auditLog.records[0]!;
    expect(rec.decision).toBe("approved");
    expect(rec.toolName).toBe("bash");
    expect(rec.riskLevel).toBe("alto");
  });

  it("write and edit are also alto", async () => {
    for (const name of ["write", "edit"]) {
      const store: string[] = [];
      const deps = makeDeps(AlwaysApproveResolver);
      const wrapped = wrapToolsWithApproval([makeTool(name, store)], deps)[0]!;

      await wrapped.execute(`${name}-1`, {});

      const rec = deps.auditLog.records[0]!;
      expect(rec.decision).toBe("approved");
      expect(rec.riskLevel).toBe("alto");
    }
  });
});

// ---------------------------------------------------------------------------
// SPEC-P-3 — unknown tool names default to alto
// ---------------------------------------------------------------------------

describe("SPEC-P-3 — unknown tool name defaults to alto", () => {
  it("a tool not listed in POLICIES.md is classified as alto", async () => {
    const store: string[] = [];
    const deps = makeDeps(AlwaysApproveResolver);
    const wrapped = wrapToolsWithApproval([makeTool("unknown_tool_xyz", store)], deps)[0]!;

    await wrapped.execute("u-1", {});

    const rec = deps.auditLog.records[0]!;
    expect(rec.riskLevel).toBe("alto");
    // Ensure it still ran (approved path) — the default is alto, not blocked
    expect(store).toEqual(["unknown_tool_xyz:u-1"]);
  });

  it("PolicyClassifier.classify returns 'alto' for unknown tool names", () => {
    const classifier = PolicyClassifier.fromPolicies(TEMPLATE_POLICIES);
    expect(classifier.classify({ toolName: "not_a_real_tool" })).toBe("alto");
    expect(classifier.classify({ toolName: "another_unknown" })).toBe("alto");
  });
});

// ---------------------------------------------------------------------------
// SPEC-F1-6 — every builtin flows through wrapToolsWithApproval
//
// Demonstrated: read and bash both produce audit records (the gate intercepted
// and recorded them). No tool bypasses the gate — audit records are only
// produced by wrapToolsWithApproval.
// ---------------------------------------------------------------------------

describe("SPEC-F1-6 — all tools produce audit records (passed through gate)", () => {
  it("all 8 builtin names produce audit records when executed", async () => {
    const builtinNames = ["read", "write", "edit", "bash", "grep", "find", "ls", "search_session"];
    const deps = makeDeps(AlwaysApproveResolver);
    const tools = builtinNames.map((n) => makeTool(n, []));
    const wrapped = wrapToolsWithApproval(tools, deps);

    for (let i = 0; i < wrapped.length; i++) {
      await wrapped[i]!.execute(`call-${i}`, {});
    }

    expect(deps.auditLog.records).toHaveLength(8);
    const recordedNames = deps.auditLog.records.map((r) => r.toolName);
    for (const name of builtinNames) {
      expect(recordedNames).toContain(name);
    }
  });
});

// ---------------------------------------------------------------------------
// SPEC-F1-7 — pi.dev native builtins suppressed in agent.ts
//
// Source-level assertion: the agent must suppress pi.dev's native builtins
// (read/bash/edit/write — they would bypass the governance gate) via
// `noTools: "builtin"`, while keeping its gate-wrapped customTools active.
// This is a structural invariant.
//
// It must NOT use `tools: []` — that is a truthy zero-tool allowlist that pi.dev
// applies to customTools too, filtering EVERYTHING out, so the model receives no
// tools and emits no tool calls. (Root cause of the empty-tools smoke-test bug.)
// ---------------------------------------------------------------------------

describe("SPEC-F1-7 — native builtins suppressed in agent.ts (noTools: 'builtin')", () => {
  it("agent.ts source suppresses native builtins via noTools: 'builtin'", async () => {
    const agentPath = resolve(
      new URL(".", import.meta.url).pathname,
      "../../../packages/core/src/agent.ts",
    );
    const source = await readFile(agentPath, "utf8");
    expect(source).toMatch(/noTools:\s*["'`]builtin["'`]/);
  });

  it("agent.ts does NOT use the buggy `tools: []` zero-allowlist as a session arg", async () => {
    const agentPath = resolve(
      new URL(".", import.meta.url).pathname,
      "../../../packages/core/src/agent.ts",
    );
    const source = await readFile(agentPath, "utf8");
    // `tools: []` kills customTools too — it must never reappear as a session arg.
    // Match only code lines (ignore explanatory comments/JSDoc that quote the
    // anti-pattern): a real arg is a trimmed line that is exactly `tools: [],`.
    const codeToolsEmpty = source
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => !line.startsWith("//") && !line.startsWith("*"))
      .some((line) => /^tools:\s*\[\],?$/.test(line));
    expect(codeToolsEmpty).toBe(false);
  });

  it("agent.ts does NOT pass any non-empty tools array to createAgentSessionFromServices", async () => {
    const agentPath = resolve(
      new URL(".", import.meta.url).pathname,
      "../../../packages/core/src/agent.ts",
    );
    const source = await readFile(agentPath, "utf8");
    // A native-builtin allowlist like `tools: ["read"` must NOT appear — those
    // would bypass the gate. Only customTools (gate-wrapped) may carry tools.
    expect(source).not.toMatch(/tools:\s*\[["'`]/);
  });
});
