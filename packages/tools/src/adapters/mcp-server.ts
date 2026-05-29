/**
 * mcp-server.ts — Per-server MCP client lifecycle: connect, listTools, callTool, close.
 *
 * Wraps @modelcontextprotocol/sdk Client + StdioClientTransport into a simple
 * McpServerClient interface.
 *
 * Dependency injection: `connectServer` accepts an optional `clientFactory` option
 * so tests can inject in-memory stubs without vi.mock (avoids hoisting issues).
 *
 * SPEC-LIFE-1: Boot sequence — connect → listTools (with pagination).
 * SPEC-LIFE-2: Pagination — follows nextCursor until exhausted.
 * SPEC-LIFE-3: dispose — close() swallows individual errors.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import type { ResolvedServerSpawn } from "../config/mcp-config.ts";
import type { McpCallResult } from "./result-mapper.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface McpToolDescriptor {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
}

/**
 * A handle for one connected MCP server process.
 * Interface-abstracted so tests can inject a fake without the real SDK.
 */
export interface McpServerClient {
  /** Server name from mcp.yaml */
  readonly name: string;
  /** Fetch all tools from this server, following nextCursor pagination. */
  listTools(): Promise<McpToolDescriptor[]>;
  /** Invoke a named tool with args, returning a raw MCP call result. */
  callTool(toolName: string, args: Record<string, unknown>): Promise<McpCallResult>;
  /** Close the transport / subprocess. Swallows errors. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Injectable SDK client seam (for testing)
// ---------------------------------------------------------------------------

/**
 * Minimal interface matching the parts of `@modelcontextprotocol/sdk Client` that
 * `connectServer` uses. Tests inject a fake implementing this interface.
 */
export interface SdkClientLike {
  connect(transport: SdkTransportLike): Promise<void>;
  listTools(params?: { cursor?: string }): Promise<{
    tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>;
    nextCursor?: string;
  }>;
  callTool(params: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<{
    isError?: boolean;
    content: Array<{ type: string; text?: string }>;
  }>;
  close(): Promise<void>;
}

/** Minimal interface for the transport object. */
export interface SdkTransportLike {
  close(): Promise<void>;
}

/**
 * Factory that produces (transport, client) pairs.
 * Tests pass a fake factory; production uses the real SDK.
 */
export interface SdkClientFactory {
  createTransport(params: {
    command: string;
    args: string[];
    env: Record<string, string>;
  }): SdkTransportLike;
  createClient(): SdkClientLike;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ConnectServerOptions {
  /**
   * Injectable factory for SDK transport + client. Defaults to the real
   * `@modelcontextprotocol/sdk` implementations. Override in tests.
   */
  clientFactory?: SdkClientFactory;
}

/**
 * Spawn the MCP server subprocess, perform the MCP initialize handshake,
 * and return a connected McpServerClient.
 *
 * Rejects when `client.connect()` throws — the caller (mcp-adapter) must
 * catch this and warn+skip the server (SPEC-ERR-1).
 */
export async function connectServer(
  spawn: ResolvedServerSpawn,
  options: ConnectServerOptions = {},
): Promise<McpServerClient> {
  const factory = options.clientFactory ?? defaultSdkClientFactory;

  const transport = factory.createTransport({
    command: spawn.command,
    args: spawn.args,
    env: spawn.env,
  });

  const client = factory.createClient();

  // Performs the MCP initialize + initialized handshake (SPEC-LIFE-1 step 3).
  // Throws on ENOENT, non-zero exit, timeout, etc. — caller must handle.
  await client.connect(transport);

  return buildClient(spawn.name, client);
}

// ---------------------------------------------------------------------------
// Default production factory
// ---------------------------------------------------------------------------

const defaultSdkClientFactory: SdkClientFactory = {
  createTransport({ command, args, env }) {
    return new StdioClientTransport({ command, args, env });
  },
  createClient() {
    return new Client({ name: "zia-mcp-client", version: "0.0.0" }) as unknown as SdkClientLike;
  },
};

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function buildClient(serverName: string, sdkClient: SdkClientLike): McpServerClient {
  return {
    name: serverName,

    async listTools(): Promise<McpToolDescriptor[]> {
      const all: McpToolDescriptor[] = [];
      let cursor: string | undefined;

      // Pagination loop — follows nextCursor until exhausted (SPEC-LIFE-2).
      do {
        const page = await sdkClient.listTools(cursor ? { cursor } : undefined);
        for (const t of page.tools) {
          all.push({
            name: t.name,
            description: t.description,
            // inputSchema from the SDK is typed as an object with known fields,
            // but MCP servers may return arbitrary JSON Schema — cast to the
            // looser Record shape our adapter uses.
            inputSchema: t.inputSchema as Record<string, unknown>,
          });
        }
        cursor = page.nextCursor;
      } while (cursor !== undefined);

      return all;
    },

    async callTool(toolName: string, args: Record<string, unknown>): Promise<McpCallResult> {
      const result = await sdkClient.callTool({ name: toolName, arguments: args });
      // The SDK returns a union type; the classic shape has content + isError.
      // We cast to McpCallResult — result-mapper.ts handles content normalisation.
      return result as unknown as McpCallResult;
    },

    async close(): Promise<void> {
      try {
        await sdkClient.close();
      } catch {
        // SPEC-LIFE-3: individual close errors are swallowed
      }
    },
  };
}
