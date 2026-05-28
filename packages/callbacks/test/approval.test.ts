import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  PolicyClassifier,
  classifyToolCall,
  MalformedPoliciesError,
} from "../src/approval.ts";

// ---------------------------------------------------------------------------
// Shared POLICIES.md fixtures
// ---------------------------------------------------------------------------

const POLICIES_FULL = `
# Clasificación de acciones

## Alto — requiere aprobación + comentario del jefe

- Enviar email a destinatarios externos (tools: send_email, forward_email)
- Emitir facturas finales (tools: issue_invoice)

## Medio — requiere aprobación con un click

- Crear borradores de factura (tools: create_invoice_draft)
- Crear tickets en Linear (tools: create_ticket)

## Trivial — auto-ejecuta, solo notifica

- Leer el inbox y resumir (tools: read_email)
- Consultar Linear, Notion, Drive, GitHub (tools: search_linear)

# Reglas de modelo por tipo de tarea (opcional)

- Para cálculos financieros: usar Opus.
`;

// ---------------------------------------------------------------------------
// Group 1: basic classification
// ---------------------------------------------------------------------------

describe("PolicyClassifier.fromPolicies — basic classification", () => {
  it("PC-SC-1: classifies send_email as alto via inline annotation", () => {
    const classifier = PolicyClassifier.fromPolicies(POLICIES_FULL);
    expect(classifier.classify({ toolName: "send_email" })).toBe("alto");
  });

  it("PC-SC-2: classifies read_email as trivial", () => {
    const classifier = PolicyClassifier.fromPolicies(POLICIES_FULL);
    expect(classifier.classify({ toolName: "read_email" })).toBe("trivial");
  });

  it("PC-SC-3: classifies create_ticket as medio", () => {
    const classifier = PolicyClassifier.fromPolicies(POLICIES_FULL);
    expect(classifier.classify({ toolName: "create_ticket" })).toBe("medio");
  });

  it("PC-SC-4: unknown tool defaults to alto (fail-safe)", () => {
    const classifier = PolicyClassifier.fromPolicies(POLICIES_FULL);
    expect(classifier.classify({ toolName: "unknown_tool_xyz" })).toBe("alto");
  });

  it("PC-SC-5: tool in both trivial and medio → medio wins (highest)", () => {
    const text = `
## Trivial — auto-ejecuta
- Action A (tools: post_slack)

## Medio — requiere aprobación
- Action B (tools: post_slack)
`;
    const classifier = PolicyClassifier.fromPolicies(text);
    expect(classifier.classify({ toolName: "post_slack" })).toBe("medio");
  });

  it("PC-SC-6: tool in trivial and alto → alto wins", () => {
    const text = `
## Trivial — auto-ejecuta
- Acción (tools: some_tool)

## Alto — requiere aprobación + comentario
- Acción (tools: some_tool)
`;
    const classifier = PolicyClassifier.fromPolicies(text);
    expect(classifier.classify({ toolName: "some_tool" })).toBe("alto");
  });
});

// ---------------------------------------------------------------------------
// Group 2: empty / absent POLICIES
// ---------------------------------------------------------------------------

describe("PolicyClassifier.fromPolicies — empty/absent POLICIES", () => {
  it("PC-SC-7: empty string → any tool returns alto", () => {
    const classifier = PolicyClassifier.fromPolicies("");
    expect(classifier.classify({ toolName: "read_email" })).toBe("alto");
  });

  it("PC-SC-8: empty string → fromPolicies does NOT throw", () => {
    expect(() => PolicyClassifier.fromPolicies("")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Group 3: malformed / edge cases
// ---------------------------------------------------------------------------

describe("PolicyClassifier.fromPolicies — malformed / edge cases", () => {
  it("PC-SC-9: empty inline annotation (tools:) extracts no tools → fail-safe alto", () => {
    const text = `
## Trivial — auto-ejecuta
- Some action (tools:)
`;
    const classifier = PolicyClassifier.fromPolicies(text);
    expect(classifier.classify({ toolName: "some_tool" })).toBe("alto");
  });

  it("PC-SC-11: tool name Send_Email in annotation → query send_email resolves correctly", () => {
    const text = `
## Alto — requiere aprobación + comentario
- Enviar email (tools: Send_Email)
`;
    const classifier = PolicyClassifier.fromPolicies(text);
    expect(classifier.classify({ toolName: "send_email" })).toBe("alto");
  });

  it("PC-SC-12: tool only under H1 section → returns alto (H1 is ignored)", () => {
    const text = `
# Reglas de modelo por tipo de tarea

- Para cálculos (tools: some_h1_tool)
`;
    const classifier = PolicyClassifier.fromPolicies(text);
    expect(classifier.classify({ toolName: "some_h1_tool" })).toBe("alto");
  });

  it("PC-SC-16: unrecognized H2 keyword → tools inside are ignored → alto", () => {
    const text = `
## Custom section — something else

- Acción custom (tools: my_tool)
`;
    const classifier = PolicyClassifier.fromPolicies(text);
    expect(classifier.classify({ toolName: "my_tool" })).toBe("alto");
  });
});

// ---------------------------------------------------------------------------
// Group 4: standalone Tools: line syntax
// ---------------------------------------------------------------------------

describe("PolicyClassifier.fromPolicies — Tools: standalone line syntax", () => {
  it("PC-SC-10: standalone Tools: line under trivial → query_linear is trivial", () => {
    const text = `
## Trivial — auto-ejecuta, solo notifica
- Leer el inbox y resumir

Tools: read_email, query_linear
`;
    const classifier = PolicyClassifier.fromPolicies(text);
    expect(classifier.classify({ toolName: "query_linear" })).toBe("trivial");
  });

  it("PC-SC-14: multiple tools in one inline annotation → all extracted", () => {
    const text = `
## Alto — requiere aprobación + comentario del jefe
- Forward and send (tools: send_email, forward_email)
`;
    const classifier = PolicyClassifier.fromPolicies(text);
    expect(classifier.classify({ toolName: "forward_email" })).toBe("alto");
  });
});

// ---------------------------------------------------------------------------
// Group 5: params does not affect result
// ---------------------------------------------------------------------------

describe("PolicyClassifier — params does not affect result", () => {
  it("PC-SC-15: classify send_email with heavy params → still alto", () => {
    const classifier = PolicyClassifier.fromPolicies(POLICIES_FULL);
    expect(
      classifier.classify({
        toolName: "send_email",
        params: { to: "ceo@evil.com", amount: 99999 },
      } as { toolName: string; params: Record<string, unknown> })
    ).toBe("alto");
  });
});

// ---------------------------------------------------------------------------
// Group 6: classifyToolCall helper
// ---------------------------------------------------------------------------

describe("classifyToolCall helper", () => {
  it("PC-SC-13: convenience helper returns alto for send_email", () => {
    expect(
      classifyToolCall(POLICIES_FULL, { toolName: "send_email" })
    ).toBe("alto");
  });
});

// ---------------------------------------------------------------------------
// Group 7: fromFichaDir — file I/O
// ---------------------------------------------------------------------------

describe("PolicyClassifier.fromFichaDir — file I/O", () => {
  let createdDirs: string[] = [];

  afterEach(async () => {
    for (const dir of createdDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    createdDirs = [];
  });

  it("reads POLICIES.md from fichaDir and classifies correctly", async () => {
    const fichaDir = await mkdtemp(join(tmpdir(), "zia-ficha-"));
    createdDirs.push(fichaDir);
    await writeFile(
      join(fichaDir, "POLICIES.md"),
      `## Alto — requiere aprobación + comentario\n- Enviar (tools: send_email)\n`,
      "utf8"
    );
    const classifier = await PolicyClassifier.fromFichaDir(fichaDir);
    expect(classifier.classify({ toolName: "send_email" })).toBe("alto");
  });

  it("missing POLICIES.md → fromFichaDir does NOT throw; every tool returns alto", async () => {
    const fichaDir = await mkdtemp(join(tmpdir(), "zia-ficha-"));
    createdDirs.push(fichaDir);
    // no POLICIES.md written
    const classifier = await PolicyClassifier.fromFichaDir(fichaDir);
    expect(classifier.classify({ toolName: "read_email" })).toBe("alto");
  });

  it("MalformedPoliciesError is exported (available for Slice-2 use)", () => {
    expect(MalformedPoliciesError).toBeDefined();
    const err = new MalformedPoliciesError("test");
    expect(err).toBeInstanceOf(Error);
  });
});
