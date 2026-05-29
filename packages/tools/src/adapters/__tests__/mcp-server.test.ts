/**
 * mcp-server.test.ts — Unit tests for McpServerClient / connectServer.
 *
 * Uses dependency injection via the `clientFactory` option to avoid vi.mock
 * hoisting issues. No real subprocess is spawned; all SDK calls are in-memory stubs.
 *
 * Pattern: create a fake SdkClientFactory + SdkClientLike for each test group.
 * connectServer({ spawn, clientFactory }) receives the fake and exercises the
 * real orchestration logic in mcp-server.ts without touching the filesystem.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SdkClientFactory, SdkClientLike, SdkTransportLike } from "../mcp-server.ts";
import { connectServer } from "../mcp-server.ts";
import type { ResolvedServerSpawn } from "../../config/mcp-config.ts";

// ---------------------------------------------------------------------------
// Helpers — in-memory stubs
// ---------------------------------------------------------------------------

type ListToolsResult = {
  tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>;
  nextCursor?: string;
};

type CallToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
};

interface FakeClientOpts {
  listToolsPages?: ListToolsResult[];
  callToolResult?: CallToolResult;
  connectError?: Error;
  closeError?: Error;
}

function makeFakeClientFactory(opts: FakeClientOpts = {}): {
  factory: SdkClientFactory;
  transportClose: ReturnType<typeof vi.fn>;
  clientConnect: ReturnType<typeof vi.fn>;
  clientListTools: ReturnType<typeof vi.fn>;
  clientCallTool: ReturnType<typeof vi.fn>;
  clientClose: ReturnType<typeof vi.fn>;
} {
  const transportClose = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const clientClose = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

  let pageIndex = 0;
  const pages = opts.listToolsPages ?? [{ tools: [], nextCursor: undefined }];

  const clientListTools = vi.fn(async (_params?: { cursor?: string }) => {
    const page = pages[pageIndex] ?? { tools: [], nextCursor: undefined };
    pageIndex += 1;
    return page;
  });

  const clientCallTool = vi.fn(async (_params: { name: string; arguments?: Record<string, unknown> }) => {
    return opts.callToolResult ?? { isError: false, content: [{ type: "text", text: "ok" }] };
  });

  const clientConnect = vi.fn(async (_transport: SdkTransportLike) => {
    if (opts.connectError) throw opts.connectError;
  });

  const fakeTransport: SdkTransportLike = { close: transportClose };

  const fakeClient: SdkClientLike = {
    connect: clientConnect,
    listTools: clientListTools,
    callTool: clientCallTool,
    close: opts.closeError
      ? vi.fn<() => Promise<void>>().mockRejectedValue(opts.closeError)
      : clientClose,
  };

  const factory: SdkClientFactory = {
    createTransport: vi.fn(() => fakeTransport),
    createClient: vi.fn(() => fakeClient),
  };

  return { factory, transportClose, clientConnect, clientListTools, clientCallTool, clientClose };
}

function makeSpawn(overrides: Partial<ResolvedServerSpawn> = {}): ResolvedServerSpawn {
  return {
    name: "linear",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-linear"],
    env: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("connectServer", () => {
  describe("basic connection", () => {
    it("resolves and returns a McpServerClient with the correct name", async () => {
      const { factory } = makeFakeClientFactory({
        listToolsPages: [{ tools: [{ name: "create_issue", inputSchema: {} }] }],
      });
      const client = await connectServer(makeSpawn({ name: "linear" }), { clientFactory: factory });
      expect(client.name).toBe("linear");
    });

    it("creates the transport with correct spawn params", async () => {
      const { factory } = makeFakeClientFactory();
      const spawn = makeSpawn({
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-linear"],
        env: { LINEAR_API_KEY: "test-key" },
      });
      await connectServer(spawn, { clientFactory: factory });
      expect(factory.createTransport).toHaveBeenCalledOnce();
      expect(factory.createTransport).toHaveBeenCalledWith({
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-linear"],
        env: { LINEAR_API_KEY: "test-key" },
      });
    });

    it("calls client.connect with the transport (performs MCP handshake)", async () => {
      const { factory, clientConnect } = makeFakeClientFactory();
      await connectServer(makeSpawn(), { clientFactory: factory });
      expect(clientConnect).toHaveBeenCalledOnce();
      // The transport object itself is passed in
      expect(clientConnect).toHaveBeenCalledWith(expect.objectContaining({ close: expect.any(Function) }));
    });
  });

  describe("listTools()", () => {
    it("returns tools from a single-page response", async () => {
      const { factory } = makeFakeClientFactory({
        listToolsPages: [
          {
            tools: [
              { name: "create_issue", description: "Create issue", inputSchema: {} },
              { name: "query_issues", description: "Query issues", inputSchema: {} },
            ],
          },
        ],
      });

      const client = await connectServer(makeSpawn(), { clientFactory: factory });
      const tools = await client.listTools();
      expect(tools).toHaveLength(2);
      expect(tools[0]?.name).toBe("create_issue");
      expect(tools[1]?.name).toBe("query_issues");
    });

    it("follows nextCursor pagination loop (SC-02)", async () => {
      const { factory, clientListTools } = makeFakeClientFactory({
        listToolsPages: [
          {
            tools: [
              { name: "tool_1", inputSchema: {} },
              { name: "tool_2", inputSchema: {} },
              { name: "tool_3", inputSchema: {} },
            ],
            nextCursor: "cursor-abc",
          },
          {
            tools: [
              { name: "tool_4", inputSchema: {} },
              { name: "tool_5", inputSchema: {} },
            ],
            nextCursor: undefined,
          },
        ],
      });

      const client = await connectServer(makeSpawn(), { clientFactory: factory });
      const tools = await client.listTools();
      expect(tools).toHaveLength(5);
      expect(tools.map((t) => t.name)).toEqual(["tool_1", "tool_2", "tool_3", "tool_4", "tool_5"]);
      expect(clientListTools).toHaveBeenCalledTimes(2);
      // Second call receives the cursor
      expect(clientListTools).toHaveBeenLastCalledWith({ cursor: "cursor-abc" });
    });
  });

  describe("callTool()", () => {
    it("calls the underlying client with correct params and returns the result", async () => {
      const { factory, clientCallTool } = makeFakeClientFactory({
        callToolResult: {
          isError: false,
          content: [{ type: "text", text: "created" }],
        },
      });

      const client = await connectServer(makeSpawn(), { clientFactory: factory });
      const result = await client.callTool("create_issue", { title: "My Issue" });
      expect(clientCallTool).toHaveBeenCalledOnce();
      expect(clientCallTool).toHaveBeenCalledWith({
        name: "create_issue",
        arguments: { title: "My Issue" },
      });
      expect(result.content[0]).toMatchObject({ type: "text", text: "created" });
    });

    it("passes isError:true from the MCP response through unchanged", async () => {
      const { factory } = makeFakeClientFactory({
        callToolResult: {
          isError: true,
          content: [{ type: "text", text: "API error" }],
        },
      });

      const client = await connectServer(makeSpawn(), { clientFactory: factory });
      const result = await client.callTool("create_issue", {});
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toBe("API error");
    });
  });

  describe("close()", () => {
    it("calls underlying client.close() and resolves", async () => {
      const { factory, clientClose } = makeFakeClientFactory();
      const client = await connectServer(makeSpawn(), { clientFactory: factory });
      await expect(client.close()).resolves.toBeUndefined();
      expect(clientClose).toHaveBeenCalledOnce();
    });

    it("swallows errors thrown by client.close() (SPEC-LIFE-3)", async () => {
      const { factory } = makeFakeClientFactory({
        closeError: new Error("Transport already closed"),
      });
      const client = await connectServer(makeSpawn(), { clientFactory: factory });
      // Must resolve, not throw
      await expect(client.close()).resolves.toBeUndefined();
    });
  });

  describe("connect rejection", () => {
    it("rejects when client.connect throws — caller must warn+skip (SPEC-ERR-1)", async () => {
      const { factory } = makeFakeClientFactory({
        connectError: new Error("ENOENT: npx not found"),
      });
      await expect(connectServer(makeSpawn(), { clientFactory: factory })).rejects.toThrow(
        "ENOENT: npx not found",
      );
    });
  });
});
