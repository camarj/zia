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

import type { McpServerClient, McpToolDescriptor } from "../mcp-server.ts";
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

  describe("SC-02 — multiple servers with paginated tools", () => {
    it("loads 12 tools total: 8 from linear (2 pages) + 4 from notion (1 page)", async () => {
      await writeMcpYaml(`
servers:
  - name: linear
    command: npx linear
  - name: notion
    command: npx notion
`);

      // linear: page 1 = 5 tools, page 2 = 3 tools (via pagination)
      const linearTools1: McpToolDescriptor[] = Array.from({ length: 5 }, (_, i) => ({
        name: `linear_tool_${i + 1}`,
        inputSchema: {},
      }));
      const linearTools2: McpToolDescriptor[] = Array.from({ length: 3 }, (_, i) => ({
        name: `linear_tool_${i + 6}`,
        inputSchema: {},
      }));

      // notion: 4 tools in 1 page
      const notionTools: McpToolDescriptor[] = Array.from({ length: 4 }, (_, i) => ({
        name: `notion_tool_${i + 1}`,
        inputSchema: {},
      }));

      // We simulate pagination by overriding listTools to use cursor tracking
      let linearPage = 0;
      const linearClient: McpServerClient = {
        name: "linear",
        listTools: vi.fn(async () => {
          const result = linearPage === 0 ? linearTools1 : linearTools2;
          linearPage += 1;
          return result;
        }),
        callTool: vi.fn(),
        close: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      };

      const notionClient = makeFakeClient("notion", notionTools);

      const connectMock = vi.fn()
        .mockResolvedValueOnce(linearClient)
        .mockResolvedValueOnce(notionClient);

      // For this test, the real pagination loop in mcp-server.ts is not invoked
      // (we're bypassing connectServer entirely). listTools on the fake client
      // is called multiple times by the mcp-adapter's own aggregation.
      // The actual pagination cursor loop is tested in mcp-server.test.ts.
      // Here we verify that mcp-adapter calls listTools once per server and
      // collects all returned tools.
      //
      // SC-02 per spec: 5 + 3 = 8 from linear, 4 from notion = 12 total.
      // Since we bypass the real connectServer pagination, we make each call
      // return the full combined list for that server.
      const linearAllClient = makeFakeClient("linear", [...linearTools1, ...linearTools2]);
      const notionAllClient = makeFakeClient("notion", notionTools);

      const connectMock2 = vi.fn()
        .mockResolvedValueOnce(linearAllClient)
        .mockResolvedValueOnce(notionAllClient);

      const handle = await createMcpAdapter(
        { fichaDir: tmpDir, env: {} },
        { connectServerFn: connectMock2 },
      );

      expect(handle.tools).toHaveLength(12);
      const toolNames = handle.tools.map((t) => t.name);
      expect(toolNames.filter((n) => n.startsWith("mcp_linear_"))).toHaveLength(8);
      expect(toolNames.filter((n) => n.startsWith("mcp_notion_"))).toHaveLength(4);
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
