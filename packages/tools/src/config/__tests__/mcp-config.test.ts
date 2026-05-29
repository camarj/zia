import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readMcpConfig, resolveSpawn } from "../mcp-config.js";
import { readFile } from "node:fs/promises";
import * as path from "node:path";

// Mock fs/promises so tests don't need real files
vi.mock("node:fs/promises");

const mockReadFile = vi.mocked(readFile);

describe("readMcpConfig", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("parses a valid mcp.yaml with one server", async () => {
    mockReadFile.mockResolvedValue(
      `servers:\n  - name: linear\n    command: npx -y @modelcontextprotocol/server-linear\n` as unknown as string,
    );
    const configs = await readMcpConfig("/fake/ficha");
    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({
      name: "linear",
      command: "npx -y @modelcontextprotocol/server-linear",
    });
  });

  it("returns [] when servers key is absent", async () => {
    mockReadFile.mockResolvedValue(`{}` as unknown as string);
    const configs = await readMcpConfig("/fake/ficha");
    expect(configs).toEqual([]);
  });

  it("returns [] when servers array is empty", async () => {
    mockReadFile.mockResolvedValue(`servers: []` as unknown as string);
    const configs = await readMcpConfig("/fake/ficha");
    expect(configs).toEqual([]);
  });

  it("returns [] when mcp.yaml does not exist", async () => {
    const err = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    mockReadFile.mockRejectedValue(err);
    const configs = await readMcpConfig("/fake/ficha");
    expect(configs).toEqual([]);
  });

  it("re-throws non-ENOENT filesystem errors (e.g. EACCES permission denied)", async () => {
    const err = Object.assign(new Error("EACCES"), { code: "EACCES" });
    mockReadFile.mockRejectedValue(err);
    await expect(readMcpConfig("/fake/ficha")).rejects.toThrow("EACCES");
  });

  it("rejects with 'not valid YAML' when file content is syntactically invalid YAML (S-1)", async () => {
    mockReadFile.mockResolvedValue(`{ unclosed` as unknown as string);
    await expect(readMcpConfig("/fake/ficha")).rejects.toThrow(/not valid YAML/);
  });

  it("returns [] and warns on structural violation (W-4)", async () => {
    const warnSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    // 'servers' must be an array; passing a string is a structural violation
    mockReadFile.mockResolvedValue(`servers: "linear"` as unknown as string);
    const configs = await readMcpConfig("/fake/ficha");
    expect(configs).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("mcp.yaml"),
    );
    warnSpy.mockRestore();
  });

  it("reads from fichaDir/mcp.yaml", async () => {
    mockReadFile.mockResolvedValue(`servers: []` as unknown as string);
    await readMcpConfig("/my/agent");
    expect(mockReadFile).toHaveBeenCalledWith(
      path.join("/my/agent", "mcp.yaml"),
      "utf8",
    );
  });

  it("skips server entry with missing name (SC-11)", async () => {
    const warnSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    mockReadFile.mockResolvedValue(
      `servers:\n  - command: npx some-server\n` as unknown as string,
    );
    const configs = await readMcpConfig("/fake/ficha");
    expect(configs).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("missing required"),
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("name"));
    warnSpy.mockRestore();
  });
});

describe("resolveSpawn", () => {
  const baseEnv: NodeJS.ProcessEnv = {};

  it("splits command string on spaces (SC-09)", () => {
    const result = resolveSpawn(
      { name: "linear", command: "npx -y @modelcontextprotocol/server-linear" },
      baseEnv,
    );
    expect(result).not.toBeNull();
    expect(result!.command).toBe("npx");
    expect(result!.args).toEqual(["-y", "@modelcontextprotocol/server-linear"]);
  });

  it("handles command with no args (single token)", () => {
    const result = resolveSpawn({ name: "foo", command: "my-server" }, baseEnv);
    expect(result).not.toBeNull();
    expect(result!.command).toBe("my-server");
    expect(result!.args).toEqual([]);
  });

  it("expands $VAR env references from supplied env (SC-05)", () => {
    const result = resolveSpawn(
      { name: "linear", command: "npx server", env: { LINEAR_API_KEY: "$MY_LINEAR_KEY" } },
      { MY_LINEAR_KEY: "secret-token" },
    );
    expect(result).not.toBeNull();
    expect(result!.env).toEqual({ LINEAR_API_KEY: "secret-token" });
  });

  it("passes literal values through without expansion (SC-05 literal path)", () => {
    const result = resolveSpawn(
      { name: "foo", command: "my-server", env: { SOME_KEY: "literal-value" } },
      {},
    );
    expect(result).not.toBeNull();
    expect(result!.env).toEqual({ SOME_KEY: "literal-value" });
  });

  it("warns and returns null when $VAR is not set in env (SC-04)", () => {
    const warnSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = resolveSpawn(
      { name: "linear", command: "npx server", env: { LINEAR_API_KEY: "$AGENT_LINEAR_KEY" } },
      {},
    );
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("$AGENT_LINEAR_KEY"));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("not set"));
    warnSpy.mockRestore();
  });

  it("passes resolved server name through", () => {
    const result = resolveSpawn(
      { name: "notion", command: "npx server" },
      {},
    );
    expect(result!.name).toBe("notion");
  });

  it("handles empty env object", () => {
    const result = resolveSpawn({ name: "srv", command: "npx srv", env: {} }, {});
    expect(result).not.toBeNull();
    expect(result!.env).toEqual({});
  });

  // W-1: brace form ${VARNAME} must be supported in addition to bare $VARNAME
  it("expands ${VAR} brace form when the env var is set (W-1)", () => {
    const result = resolveSpawn(
      { name: "linear", command: "npx server", env: { LINEAR_API_KEY: "${MY_LINEAR_KEY}" } },
      { MY_LINEAR_KEY: "brace-token" },
    );
    expect(result).not.toBeNull();
    expect(result!.env).toEqual({ LINEAR_API_KEY: "brace-token" });
  });

  it("warns and returns null when ${VAR} brace form var is not set in env (W-1)", () => {
    const warnSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = resolveSpawn(
      { name: "linear", command: "npx server", env: { LINEAR_API_KEY: "${AGENT_LINEAR_KEY}" } },
      {},
    );
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("$AGENT_LINEAR_KEY"));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("not set"));
    warnSpy.mockRestore();
  });
});
