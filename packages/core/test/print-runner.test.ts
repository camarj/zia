/**
 * print-runner.test.ts — runZiaAgentPrint wiring.
 *
 * Mocks the pi.dev SDK (same pattern as audit-log-injection.test.ts) so the
 * runner executes without network. Asserts:
 *  - runPrintMode is driven with the right runtime + options (prompt → initialMessage);
 *  - fail-closed by default: no resolver is bound when approvalResolver is omitted;
 *  - an explicit approvalResolver IS bound to the queue;
 *  - the exit code from runPrintMode is returned verbatim.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted to the top of the file, so the mock factory must not close
// over module-scope variables. Use vi.hoisted to build the shared mocks in a
// block that runs BEFORE the hoisted vi.mock factory.
const { fakeRuntime, runPrintModeMock } = vi.hoisted(() => ({
  fakeRuntime: { dispose: vi.fn().mockResolvedValue(undefined) },
  runPrintModeMock: vi.fn().mockResolvedValue(0),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  AuthStorage: { create: () => ({ hasAuth: () => false, setRuntimeApiKey: () => {} }) },
  ModelRegistry: { create: () => ({}) },
  SessionManager: { create: () => ({}) },
  getAgentDir: () => "/fake-agent-dir",
  createAgentSessionFromServices: vi.fn().mockResolvedValue(fakeRuntime),
  createAgentSessionRuntime: vi.fn().mockResolvedValue(fakeRuntime),
  createAgentSessionServices: vi.fn().mockResolvedValue({ diagnostics: {} }),
  runPrintMode: runPrintModeMock,
}));

vi.mock("@earendil-works/pi-ai", () => ({
  getModel: () => ({ provider: "anthropic", model: "claude-haiku-4-5-20251001" }),
}));

import { AutoApproveResolver } from "@zia/callbacks";
import { runZiaAgentPrint } from "../src/print-runner.ts";

const PROFILE_YAML = `
llm:
  default:
    provider: anthropic
    model: claude-haiku-4-5-20251001
`.trim();

const SOUL_MD = "# Test Agent\nA soul for the print-runner test.";
const POLICIES_MD = "# Policies\n## Trivial\nTools: test_read\n";

async function makeFicha(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zia-print-"));
  await writeFile(join(dir, "profile.yaml"), PROFILE_YAML, "utf8");
  await writeFile(join(dir, "SOUL.md"), SOUL_MD, "utf8");
  await writeFile(join(dir, "POLICIES.md"), POLICIES_MD, "utf8");
  return dir;
}

describe("runZiaAgentPrint", () => {
  let createdDirs: string[] = [];
  let originalEnv: typeof process.env;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.ANTHROPIC_API_KEY = "fake-test-key-print";
    // Reset both call history AND the default return (afterEach's
    // restoreAllMocks would otherwise wipe the resolved value to undefined).
    runPrintModeMock.mockReset();
    runPrintModeMock.mockResolvedValue(0);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.env = originalEnv;
    for (const dir of createdDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    createdDirs = [];
  });

  async function fixture(): Promise<string> {
    const dir = await makeFicha();
    createdDirs.push(dir);
    return dir;
  }

  it("drives runPrintMode with the prompt as initialMessage and default text mode", async () => {
    const fichaDir = await fixture();
    await runZiaAgentPrint({ fichaDir, prompt: "List your files", rawTools: [] });

    expect(runPrintModeMock).toHaveBeenCalledTimes(1);
    const [runtimeArg, optionsArg] = runPrintModeMock.mock.calls[0]!;
    expect(runtimeArg).toBe(fakeRuntime);
    expect(optionsArg.initialMessage).toBe("List your files");
    expect(optionsArg.mode).toBe("text");
  });

  it("passes mode and followUps through to runPrintMode", async () => {
    const fichaDir = await fixture();
    await runZiaAgentPrint({
      fichaDir,
      prompt: "first",
      mode: "json",
      followUps: ["second", "third"],
      rawTools: [],
    });

    const [, optionsArg] = runPrintModeMock.mock.calls[0]!;
    expect(optionsArg.mode).toBe("json");
    expect(optionsArg.messages).toEqual(["second", "third"]);
  });

  it("returns the exit code from runPrintMode verbatim", async () => {
    runPrintModeMock.mockResolvedValueOnce(1);
    const fichaDir = await fixture();
    const code = await runZiaAgentPrint({ fichaDir, prompt: "x", rawTools: [] });
    expect(code).toBe(1);
  });

  it("completes a run with an explicit approvalResolver supplied", async () => {
    const fichaDir = await fixture();
    const code = await runZiaAgentPrint({
      fichaDir,
      prompt: "x",
      approvalResolver: new AutoApproveResolver(),
      rawTools: [],
    });
    expect(code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Governance contract — proven WITHOUT mocking the SDK, against the real
// ApprovalQueue + gate. This is the load-bearing guarantee: fail-closed by
// default (deny medio/alto), auto-approve only when AutoApproveResolver is bound.
// ---------------------------------------------------------------------------

describe("print-mode governance contract (fail-closed default)", () => {
  it("fail-closed: an unbound queue denies a medio call and the body never runs", async () => {
    const { ApprovalQueue, ApprovalSerializer, PolicyClassifier, wrapToolsWithApproval } =
      await import("@zia/callbacks");

    const policies = "# P\n## Medio\nTools: write_memory\n";
    const classifier = PolicyClassifier.fromPolicies(policies);
    // null resolver = the print-mode default (no approvalResolver supplied).
    const queue = new ApprovalQueue(null, new ApprovalSerializer());
    const records: { decision: string; approver: string | null }[] = [];
    const auditLog = { record: (e: { decision: string; approver: string | null }) => { records.push(e); return Promise.resolve(); } };

    const ran: string[] = [];
    const tool = {
      name: "write_memory",
      label: "Write Memory",
      description: "medio",
      parameters: {},
      execute: async (id: string, _params: Record<string, unknown>) => { ran.push(id); return { content: [{ type: "text" as const, text: "ok" }], details: {} }; },
    };
    const gated = wrapToolsWithApproval([tool], { classifier, queue, auditLog })[0]!;

    const result = await gated.execute("c-1", {});

    expect(ran).toHaveLength(0); // body never ran — fail-closed denied it
    expect(result.content[0]?.text).toMatch(/No approval channel/i);
    expect(records[0]?.approver).toBe("system:fail-closed");
  });

  it("AutoApproveResolver bound: the same medio call is approved and runs", async () => {
    const { ApprovalQueue, ApprovalSerializer, PolicyClassifier, wrapToolsWithApproval, AutoApproveResolver: AAR } =
      await import("@zia/callbacks");

    const policies = "# P\n## Medio\nTools: write_memory\n";
    const classifier = PolicyClassifier.fromPolicies(policies);
    const queue = new ApprovalQueue(new AAR(), new ApprovalSerializer());
    const records: { decision: string; approver: string | null }[] = [];
    const auditLog = { record: (e: { decision: string; approver: string | null }) => { records.push(e); return Promise.resolve(); } };

    const ran: string[] = [];
    const tool = {
      name: "write_memory",
      label: "Write Memory",
      description: "medio",
      parameters: {},
      execute: async (id: string, _params: Record<string, unknown>) => { ran.push(id); return { content: [{ type: "text" as const, text: "ok" }], details: {} }; },
    };
    const gated = wrapToolsWithApproval([tool], { classifier, queue, auditLog })[0]!;

    await gated.execute("c-2", {});

    expect(ran).toEqual(["c-2"]); // body ran — auto-approved
    expect(records[0]?.decision).toBe("approved");
    expect(records[0]?.approver).toBe("system:auto-approve");
  });
});
