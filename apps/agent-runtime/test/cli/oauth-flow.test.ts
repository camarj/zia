import { describe, expect, it, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock @earendil-works/pi-coding-agent so tests do NOT hit the network or
// touch the filesystem's auth.json.
//
// vi.mock() is hoisted to the top of the file by vitest's transformer, so any
// variables it references in its factory must also be hoisted via vi.hoisted().
// ---------------------------------------------------------------------------
const { loginMock, createMock } = vi.hoisted(() => {
  const loginMock = vi.fn();
  const createMock = vi.fn(() => ({ login: loginMock }));
  return { loginMock, createMock };
});

vi.mock("@earendil-works/pi-coding-agent", () => ({
  AuthStorage: { create: createMock },
}));

import { runOAuthFlow, isOAuthProvider, OAUTH_PROVIDER_IDS } from "../../src/cli/oauth-flow.ts";

describe("isOAuthProvider", () => {
  it("returns true for github-copilot", () => {
    expect(isOAuthProvider("github-copilot")).toBe(true);
  });

  it("returns true for openai-codex", () => {
    expect(isOAuthProvider("openai-codex")).toBe(true);
  });

  it("returns false for api-key providers", () => {
    expect(isOAuthProvider("anthropic")).toBe(false);
    expect(isOAuthProvider("openai")).toBe(false);
    expect(isOAuthProvider("google")).toBe(false);
    expect(isOAuthProvider("custom")).toBe(false);
  });

  it("returns false for unknown strings", () => {
    expect(isOAuthProvider("codex")).toBe(false);
    expect(isOAuthProvider("")).toBe(false);
  });
});

describe("OAUTH_PROVIDER_IDS", () => {
  it("contains exactly github-copilot and openai-codex", () => {
    expect([...OAUTH_PROVIDER_IDS].sort()).toEqual(["github-copilot", "openai-codex"]);
  });
});

describe("runOAuthFlow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loginMock.mockResolvedValue(undefined);
  });

  it("creates an AuthStorage and calls login with the correct provider id (github-copilot)", async () => {
    await runOAuthFlow("github-copilot");

    expect(createMock).toHaveBeenCalledOnce();
    expect(loginMock).toHaveBeenCalledOnce();

    const calls = loginMock.mock.calls as Array<[string, unknown]>;
    expect(calls[0]![0]).toBe("github-copilot");
  });

  it("creates an AuthStorage and calls login with the correct provider id (openai-codex)", async () => {
    await runOAuthFlow("openai-codex");

    expect(loginMock).toHaveBeenCalledOnce();
    const calls = loginMock.mock.calls as Array<[string, unknown]>;
    expect(calls[0]![0]).toBe("openai-codex");
  });

  it("passes callbacks with all required keys (onAuth, onDeviceCode, onPrompt, onSelect)", async () => {
    await runOAuthFlow("github-copilot");

    const calls = loginMock.mock.calls as Array<[string, Record<string, unknown>]>;
    const firstCall = calls[0];
    expect(firstCall).toBeDefined();
    const callbacks = firstCall![1];
    expect(typeof callbacks.onAuth).toBe("function");
    expect(typeof callbacks.onDeviceCode).toBe("function");
    expect(typeof callbacks.onPrompt).toBe("function");
    expect(typeof callbacks.onSelect).toBe("function");
  });

  it("passes optional callbacks (onProgress, onManualCodeInput)", async () => {
    await runOAuthFlow("github-copilot");

    const calls = loginMock.mock.calls as Array<[string, Record<string, unknown>]>;
    const firstCall = calls[0];
    expect(firstCall).toBeDefined();
    const callbacks = firstCall![1];
    expect(typeof callbacks.onProgress).toBe("function");
    expect(typeof callbacks.onManualCodeInput).toBe("function");
  });

  it("onDeviceCode callback writes user code and verification URI to stdout", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    loginMock.mockImplementationOnce(async (_id: string, cbs: Record<string, unknown>) => {
      (cbs.onDeviceCode as (info: unknown) => void)({
        userCode: "ABCD-1234",
        verificationUri: "https://github.com/login/device",
      });
    });

    await runOAuthFlow("github-copilot");

    const combined = writeSpy.mock.calls.map((c) => c[0]).join("");
    expect(combined).toContain("ABCD-1234");
    expect(combined).toContain("https://github.com/login/device");

    writeSpy.mockRestore();
  });

  it("onAuth callback writes the auth URL to stdout", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    loginMock.mockImplementationOnce(async (_id: string, cbs: Record<string, unknown>) => {
      (cbs.onAuth as (info: unknown) => void)({
        url: "https://auth.example.com/oauth",
        instructions: "Follow this link",
      });
    });

    await runOAuthFlow("openai-codex");

    const combined = writeSpy.mock.calls.map((c) => c[0]).join("");
    expect(combined).toContain("https://auth.example.com/oauth");

    writeSpy.mockRestore();
  });

  it("propagates login rejection as an error", async () => {
    loginMock.mockRejectedValueOnce(new Error("OAuth flow cancelled"));

    await expect(runOAuthFlow("github-copilot")).rejects.toThrow("OAuth flow cancelled");
  });
});
