/**
 * Validate a custom OpenAI-compatible endpoint (Ollama, vLLM, LiteLLM, …)
 * by issuing a GET to `${baseUrl}/v1/models` with a bounded timeout.
 *
 * Accepts a baseUrl with or without a trailing `/v1` (pi-ai expects baseUrl
 * to end with `/v1`; operators typing the host alone is the common case).
 *
 * @throws Error on non-2xx, network failure, or timeout. The message always
 * names the URL and (on timeout) the timeoutMs so the operator can recognise
 * the misconfiguration before any file write happens.
 */
export async function validateEndpoint(
  baseUrl: string,
  timeoutMs = 5000,
): Promise<void> {
  const url = buildModelsUrl(baseUrl);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) {
      throw new Error(`${url}: HTTP ${res.status}`);
    }
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error(`${url}: timed out after ${timeoutMs}ms`);
    }
    if (err instanceof Error && err.message.startsWith(url)) {
      throw err;
    }
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(`${url}: ${cause}`);
  } finally {
    clearTimeout(timer);
  }
}

function buildModelsUrl(baseUrl: string): string {
  let normalized = baseUrl.replace(/\/+$/, "");
  if (normalized.endsWith("/v1")) {
    normalized = normalized.slice(0, -"/v1".length);
  }
  return `${normalized}/v1/models`;
}
