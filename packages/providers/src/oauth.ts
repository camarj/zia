/**
 * OAuth provider helpers shared across packages.
 *
 * Keeping this in @zia/providers means both packages/core/agent.ts and
 * apps/agent-runtime/src/cli/model.ts can import isOAuthProvider from one
 * authoritative source rather than duplicating the list.
 */

/** Valid OAuth provider IDs (must match pi.dev's OAuthProviderId exactly). */
export const OAUTH_PROVIDER_IDS = ["github-copilot", "openai-codex"] as const;

/**
 * Returns true when the given provider key uses the OAuth credential flow
 * (pi.dev AuthStorage + auth.json) rather than an env-var API key.
 *
 * Export this from @zia/providers so agent.ts and the CLI share one source of
 * truth for which providers are OAuth-based.
 */
export function isOAuthProvider(providerKey: string): boolean {
  return (OAUTH_PROVIDER_IDS as readonly string[]).includes(providerKey);
}
