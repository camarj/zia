import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { validateEndpoint } from "../../src/cli/validate-endpoint.ts";

describe("validateEndpoint", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("resolves when GET ${baseUrl}/v1/models returns 200", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(validateEndpoint("http://localhost:11434")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://localhost:11434/v1/models");
  });

  it("accepts a baseUrl that already ends with /v1", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("[]", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await validateEndpoint("http://localhost:11434/v1");

    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://localhost:11434/v1/models");
  });

  it("throws on HTTP 404 and names the URL + status", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("not found", { status: 404 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(validateEndpoint("http://localhost:11434")).rejects.toThrow(
      /http:\/\/localhost:11434.*404/,
    );
  });

  it("throws on HTTP 5xx", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("boom", { status: 503 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(validateEndpoint("http://localhost:11434")).rejects.toThrow(/503/);
  });

  it("throws on network error (fetch rejects)", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(validateEndpoint("http://localhost:99999")).rejects.toThrow(
      /http:\/\/localhost:99999/,
    );
  });

  describe("timeout", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("aborts and throws a timeout error after timeoutMs", async () => {
      const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      // Attach the rejects matcher BEFORE advancing timers so the rejection
      // never goes unhandled when the AbortController fires.
      const assertion = expect(
        validateEndpoint("http://localhost:11434", 100),
      ).rejects.toThrow(/timed out after 100ms/);
      await vi.advanceTimersByTimeAsync(150);
      await assertion;
    });
  });
});
