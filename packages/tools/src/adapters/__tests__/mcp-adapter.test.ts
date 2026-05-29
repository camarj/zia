/**
 * mcp-adapter.test.ts — Integration-level unit tests for createMcpAdapter.
 *
 * Uses fake implementations of connectServer and McpServerClient.
 * No real subprocess is spawned; mcp.yaml is provided as in-memory fixtures
 * written to a temp dir.
 *
 * Covers: SC-01..SC-12.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { McpServerClient, McpToolDescriptor, SdkClientFactory, SdkClientLike, SdkTransportLike } from "../mcp-server.ts";
import { connectServer } from "../mcp-server.ts";
import type { McpCallResult } from "../result-mapper.ts";
import { createMcpAdapter } from "../mcp-adapter.ts";

// ---------------------------------------------------------------------------
// Helpers — fake client builder
// ---------------------------------------------------------------------------

function makeFakeClient(
  name: string,
  tools: McpToolDescriptor[],
  opts: {
    pages?: McpToolDescriptor[][];
    callToolResult?: McpCallResult;
    closeError?: Error;
  } = {},
): McpServerClient {
  const pages = opts.pages ?? [tools];
  let pageIndex = 0;

  return {
    name,
    listTools: vi.fn(async () => {
      const page = pages[pageIndex] ?? [];
      pageIndex += 1;
      return page;
    }),
    callTool: vi.fn<(n: string, a: Record<string, unknown>) => Promise<McpCallResult>>().mockResolvedValue(
      opts.callToolResult ?? { isError: false, content: [{ type: "text", text: "ok" }] },
    ),
    close: opts.closeError
      ? vi.fn<() => Promise<void>>().mockRejectedValue(opts.closeError)
      : vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Test fixture infrastructure
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = join(tmpdir(), `mcp-adapter-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function writeMcpYaml(content: string): Promise<void> {
  await writeFile(join(tmpDir, "mcp.yaml"), content, "utf8");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createMcpAdapter", () => {
  describe("SC-01 — happy path: single server, single tool", () => {
    it("returns one WrappableTool with correct name and label", async () => {
      await writeMcpYaml(`
servers:
  - name: linear
    command: npx -y @modelcontextprotocol/server-linear
`);

      const linearClient = makeFakeClient("linear", [
        {
          name: "create_issue",
          description: "Create a Linear issue",
          inputSchema: { type: "object", properties: { title: { type: "string" } } },
        },
      ]);

      const handle = await createMcpAdapter(
        { fichaDir: tmpDir, env: {} },
        { connectServerFn: vi.fn().mockResolvedValue(linearClient) },
      );

      expect(handle.tools).toHaveLength(1);
      expect(handle.tools[0]?.name).toBe("mcp_linear_create_issue");
      expect(handle.tools[0]?.label).toBe("MCP: linear/create_issue");
    });
  });

  describe("SC-02a — multi-server tool aggregation", () => {
    it("loads 12 tools total: 8 from linear + 4 from notion across two servers", async () => {
      await writeMcpYaml(`
servers:
  - name: linear
    command: npx linear
  - name: notion
    command: npx notion
`);

      const linearTools: McpToolDescriptor[] = Array.from({ length: 8 }, (_, i) => ({
        name: `linear_tool_${i + 1}`,
        inputSchema: {},
      }));
      const notionTools: McpToolDescriptor[] = Array.from({ length: 4 }, (_, i) => ({
        name: `notion_tool_${i + 1}`,
        inputSchema: {},
      }));

      const linearClient = makeFakeClient("linear", linearTools);
      const notionClient = makeFakeClient("notion", notionTools);

      const connectMock = vi.fn()
        .mockResolvedValueOnce(linearClient)
        .mockResolvedValueOnce(notionClient);

      const handle = await createMcpAdapter(
        { fichaDir: tmpDir, env: {} },
        { connectServerFn: connectMock },
      );

      expect(handle.tools).toHaveLength(12);
      const toolNames = handle.tools.map((t) => t.name);
      expect(toolNames.filter((n) => n.startsWith("mcp_linear_"))).toHaveLength(8);
      expect(toolNames.filter((n) => n.startsWith("mcp_notion_"))).toHaveLength(4);
    });
  });

  describe("SC-02b — multi-page pagination cursor loop (end-to-end via real connectServer)", () => {
    it("adapter receives all tools across 2 pages when sdkClient.listTools is called twice", async () => {
      await writeMcpYaml(`
servers:
  - name: linear
    command: npx linear
`);

      // Build a fake SdkClientFactory whose listTools returns page 1 on the first
      // call (with nextCursor) and page 2 on the second call (no nextCursor).
      // This exercises the do/while cursor loop inside mcp-server.ts::buildClient.
      const page1Tools = Array.from({ length: 3 }, (_, i) => ({ name: `tool_${i + 1}`, inputSchema: {} }));
      const page2Tools = Array.from({ length: 2 }, (_, i) => ({ name: `tool_${i + 4}`, inputSchema: {} }));

      let callCount = 0;
      const sdkListTools = vi.fn(async (_params?: { cursor?: string }) => {
        callCount += 1;
        if (callCount === 1) {
          return { tools: page1Tools, nextCursor: "cursor-xyz" };
        }
        return { tools: page2Tools, nextCursor: undefined };
      });

      const fakeTransport: SdkTransportLike = { close: vi.fn<() => Promise<void>>().mockResolvedValue(undefined) };
      const fakeSdkClient: SdkClientLike = {
        connect: vi.fn<(t: SdkTransportLike) => Promise<void>>().mockResolvedValue(undefined),
        listTools: sdkListTools,
        callTool: vi.fn(),
        close: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      };
      const fakeSdkFactory: SdkClientFactory = {
        createTransport: vi.fn(() => fakeTransport),
        createClient: vi.fn(() => fakeSdkClient),
      };

      // Use the real connectServer (with injected factory) so the adapter goes
      // through the full mcp-server.ts pagination loop.
      const handle = await createMcpAdapter(
        { fichaDir: tmpDir, env: {} },
        { connectServerFn: (spawn) => connectServer(spawn, { clientFactory: fakeSdkFactory }) },
      );

      // sdkClient.listTools must be called exactly twice (one per page).
      expect(sdkListTools).toHaveBeenCalledTimes(2);
      // Second call must pass the cursor from page 1.
      expect(sdkListTools).toHaveBeenLastCalledWith({ cursor: "cursor-xyz" });
      // Adapter accumulates all 5 tools across both pages.
      expect(handle.tools).toHaveLength(5);
      expect(handle.tools.map((t) => t.name)).toEqual(
        ["mcp_linear_tool_1", "mcp_linear_tool_2", "mcp_linear_tool_3", "mcp_linear_tool_4", "mcp_linear_tool_5"],
      );
    });
  });

  describe("SC-03 — one server fails to boot, other loads", () => {
    it("resolves with tools from healthy server only; warns about broken server", async () => {
      await writeMcpYaml(`
servers:
  - name: linear
    command: npx linear
  - name: broken
    command: npx broken-server
`);

      const warnSpy = vi.fn();
      const linearClient = makeFakeClient("linear", [
        { name: "create_issue", inputSchema: {} },
        { name: "query_issues", inputSchema: {} },
      ]);

      const connectMock = vi.fn()
        .mockResolvedValueOnce(linearClient)
        .mockRejectedValueOnce(new Error("ENOENT: broken-server not found"));

      const handle = await createMcpAdapter(
        { fichaDir: tmpDir, env: {}, logger: warnSpy },
        { connectServerFn: connectMock },
      );

      // Must resolve, not reject
      expect(handle.tools).toHaveLength(2);
      expect(handle.tools.every((t) => t.name.startsWith("mcp_linear_"))).toBe(true);

      // Warn was emitted about the broken server
      const warnCalls = warnSpy.mock.calls.map((c) => c[0] as string);
      expect(warnCalls.some((msg) => msg.includes("broken") && msg.includes("failed to start"))).toBe(true);
    });
  });

  describe("SC-04 — missing env var causes server skip", () => {
    it("skips server and warns when required env var is absent", async () => {
      await writeMcpYaml(`
servers:
  - name: linear
    command: npx linear
    env:
      LINEAR_API_KEY: $AGENT_LINEAR_KEY
`);

      const warnSpy = vi.fn();
      const connectMock = vi.fn();

      const handle = await createMcpAdapter(
        { fichaDir: tmpDir, env: {}, logger: warnSpy }, // AGENT_LINEAR_KEY not set
        { connectServerFn: connectMock },
      );

      expect(handle.tools).toHaveLength(0);
      expect(connectMock).not.toHaveBeenCalled();

      const warnCalls = warnSpy.mock.calls.map((c) => c[0] as string);
      expect(
        warnCalls.some(
          (msg) => msg.includes("AGENT_LINEAR_KEY") && msg.includes("not set"),
        ),
      ).toBe(true);
    });
  });

  describe("SC-05 — literal env values pass through unchanged", () => {
    it("passes literal env values (no $ prefix) to the server spawn", async () => {
      await writeMcpYaml(`
servers:
  - name: linear
    command: npx linear
    env:
      SOME_KEY: literal-value
`);

      const linearClient = makeFakeClient("linear", [{ name: "t1", inputSchema: {} }]);
      const connectMock = vi.fn().mockResolvedValue(linearClient);

      await createMcpAdapter(
        { fichaDir: tmpDir, env: {} },
        { connectServerFn: connectMock },
      );

      expect(connectMock).toHaveBeenCalledOnce();
      const spawnArg = connectMock.mock.calls[0]?.[0] as { env: Record<string, string> };
      expect(spawnArg.env["SOME_KEY"]).toBe("literal-value");
    });
  });

  describe("SC-08 — dispose() closes all connections", () => {
    it("calls close on all connected clients and resolves", async () => {
      await writeMcpYaml(`
servers:
  - name: linear
    command: npx linear
  - name: notion
    command: npx notion
`);

      const linearClient = makeFakeClient("linear", [{ name: "t1", inputSchema: {} }]);
      const notionClient = makeFakeClient("notion", [{ name: "t2", inputSchema: {} }]);

      const connectMock = vi.fn()
        .mockResolvedValueOnce(linearClient)
        .mockResolvedValueOnce(notionClient);

      const handle = await createMcpAdapter(
        { fichaDir: tmpDir, env: {} },
        { connectServerFn: connectMock },
      );

      await expect(handle.dispose()).resolves.toBeUndefined();
      expect(linearClient.close).toHaveBeenCalledOnce();
      expect(notionClient.close).toHaveBeenCalledOnce();
    });

    it("dispose() is idempotent — second call is a no-op", async () => {
      await writeMcpYaml(`
servers:
  - name: linear
    command: npx linear
`);

      const linearClient = makeFakeClient("linear", [{ name: "t1", inputSchema: {} }]);
      const connectMock = vi.fn().mockResolvedValue(linearClient);

      const handle = await createMcpAdapter(
        { fichaDir: tmpDir, env: {} },
        { connectServerFn: connectMock },
      );

      await handle.dispose();
      await handle.dispose(); // second call must not throw

      expect(linearClient.close).toHaveBeenCalledOnce(); // called only once
    });

    it("dispose() swallows individual close errors", async () => {
      await writeMcpYaml(`
servers:
  - name: broken
    command: npx broken
`);

      const brokenClient = makeFakeClient("broken", [{ name: "t1", inputSchema: {} }], {
        closeError: new Error("Transport already gone"),
      });
      const connectMock = vi.fn().mockResolvedValue(brokenClient);

      const handle = await createMcpAdapter(
        { fichaDir: tmpDir, env: {} },
        { connectServerFn: connectMock },
      );

      // Must resolve, not throw
      await expect(handle.dispose()).resolves.toBeUndefined();
    });
  });

  describe("SC-09 — command string is split correctly", () => {
    it("passes split command + args to the server factory", async () => {
      await writeMcpYaml(`
servers:
  - name: linear
    command: npx -y @modelcontextprotocol/server-linear
`);

      const linearClient = makeFakeClient("linear", [{ name: "t1", inputSchema: {} }]);
      const connectMock = vi.fn().mockResolvedValue(linearClient);

      await createMcpAdapter(
        { fichaDir: tmpDir, env: {} },
        { connectServerFn: connectMock },
      );

      expect(connectMock).toHaveBeenCalledOnce();
      const spawnArg = connectMock.mock.calls[0]?.[0] as { command: string; args: string[] };
      expect(spawnArg.command).toBe("npx");
      expect(spawnArg.args).toEqual(["-y", "@modelcontextprotocol/server-linear"]);
    });
  });

  describe("SC-10 — missing mcp.yaml returns empty handle", () => {
    it("resolves with empty tools when mcp.yaml does not exist", async () => {
      // No mcp.yaml written to tmpDir
      const connectMock = vi.fn();

      const handle = await createMcpAdapter(
        { fichaDir: tmpDir, env: {} },
        { connectServerFn: connectMock },
      );

      expect(handle.tools).toHaveLength(0);
      await expect(handle.dispose()).resolves.toBeUndefined();
      expect(connectMock).not.toHaveBeenCalled();
    });
  });

  describe("SC-11 — server entry missing name is skipped", () => {
    it("skips unnamed server entry and warns", async () => {
      await writeMcpYaml(`
servers:
  - command: npx unnamed-server
`);

      const warnSpy = vi.fn();
      const connectMock = vi.fn();

      const handle = await createMcpAdapter(
        { fichaDir: tmpDir, env: {}, logger: warnSpy },
        { connectServerFn: connectMock },
      );

      expect(handle.tools).toHaveLength(0);
      expect(connectMock).not.toHaveBeenCalled();

      const warnCalls = warnSpy.mock.calls.map((c) => c[0] as string);
      expect(
        warnCalls.some((msg) => msg.includes("missing required") && msg.includes("name")),
      ).toBe(true);
    });
  });

  describe("SC-12 — absent inputSchema uses permissive fallback", () => {
    it("tool with no inputSchema gets a non-null parameters object", async () => {
      await writeMcpYaml(`
servers:
  - name: linear
    command: npx linear
`);

      const linearClient = makeFakeClient("linear", [
        { name: "no_schema_tool", inputSchema: {} },
      ]);
      const connectMock = vi.fn().mockResolvedValue(linearClient);

      const handle = await createMcpAdapter(
        { fichaDir: tmpDir, env: {} },
        { connectServerFn: connectMock },
      );

      expect(handle.tools).toHaveLength(1);
      expect(handle.tools[0]?.parameters).toBeTruthy();
    });
  });

  describe("boot report", () => {
    it("records ok:true and toolCount for each successful server", async () => {
      await writeMcpYaml(`
servers:
  - name: linear
    command: npx linear
`);

      const linearClient = makeFakeClient("linear", [
        { name: "t1", inputSchema: {} },
        { name: "t2", inputSchema: {} },
      ]);
      const connectMock = vi.fn().mockResolvedValue(linearClient);

      const handle = await createMcpAdapter(
        { fichaDir: tmpDir, env: {} },
        { connectServerFn: connectMock },
      );

      expect(handle.servers).toHaveLength(1);
      expect(handle.servers[0]).toMatchObject({ name: "linear", ok: true, toolCount: 2 });
    });

    it("records ok:false and error message for failed server", async () => {
      await writeMcpYaml(`
servers:
  - name: broken
    command: npx broken
`);

      const connectMock = vi.fn().mockRejectedValue(new Error("ENOENT: not found"));
      const warnSpy = vi.fn();

      const handle = await createMcpAdapter(
        { fichaDir: tmpDir, env: {}, logger: warnSpy },
        { connectServerFn: connectMock },
      );

      expect(handle.servers).toHaveLength(1);
      expect(handle.servers[0]).toMatchObject({ name: "broken", ok: false });
      expect(handle.servers[0]?.error).toContain("ENOENT");
    });
  });
});
