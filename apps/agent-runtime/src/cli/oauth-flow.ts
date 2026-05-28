/**
 * oauth-flow.ts — OAuth login helper for zia model picker (PR 4, Option B)
 *
 * DESIGN NOTE (engram #556): We delegate OAuth fully to pi.dev's native
 * `AuthStorage.login()` instead of serialising tokens into .env blobs.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Confirmed AuthStorage.login() signature (pi-coding-agent@0.76.0,
 * dist/core/auth-storage.d.ts, line 117):
 *
 *   login(providerId: OAuthProviderId, callbacks: OAuthLoginCallbacks): Promise<void>
 *
 * OAuthLoginCallbacks (pi-ai@0.76.0, dist/utils/oauth/types.d.ts, line 34):
 *
 *   interface OAuthLoginCallbacks {
 *     onAuth: (info: OAuthAuthInfo) => void;            // called with { url, instructions? }
 *     onDeviceCode: (info: OAuthDeviceCodeInfo) => void; // { userCode, verificationUri, ... }
 *     onPrompt: (prompt: OAuthPrompt) => Promise<string>; // { message, placeholder?, allowEmpty? }
 *     onProgress?: (message: string) => void;
 *     onManualCodeInput?: () => Promise<string>;
 *     onSelect: (prompt: OAuthSelectPrompt) => Promise<string | undefined>; // { message, options[] }
 *     signal?: AbortSignal;
 *   }
 *
 * After login() resolves the credential is persisted under
 *   ~/.pi/agent/auth.json   (or $PI_CODING_AGENT_DIR/auth.json)
 * with shape { type: "oauth", refresh, access, expires }.
 *
 * AUTH.JSON LOCATION DECISION:
 *   AuthStorage.create() calls getAgentDir() which returns:
 *     $PI_CODING_AGENT_DIR if set, else ~/.pi/agent/
 *   The CLI's login() and the agent runtime's AuthStorage.create() BOTH call
 *   this same function, so they share the same auth.json automatically.
 *
 *   On a shared dev host this means all zia agents on the same machine share
 *   one OAuth token per provider (e.g. one GitHub Copilot token for all agents).
 *   Inside a Docker container (zia's production deployment model) this is fine:
 *   each container has its own filesystem, so each agent's auth.json is isolated.
 *
 *   If per-ficha isolation is needed on a shared dev host, set
 *   PI_CODING_AGENT_DIR=<ficha-dir>/.pi before running `zia model`.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Valid OAuth provider IDs for AuthStorage.login():
 *   "github-copilot"  — device-code flow (no local callback server)
 *   "openai-codex"    — PKCE + local callback server; supports manual code input
 *
 * There is NO plain "codex" id; use "openai-codex".
 */

import { select } from "@inquirer/prompts";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import type {
  OAuthAuthInfo,
  OAuthDeviceCodeInfo,
  OAuthLoginCallbacks,
  OAuthPrompt,
  OAuthSelectPrompt,
} from "@earendil-works/pi-ai";

/** Provider IDs that use the OAuth flow rather than an API key. */
export const OAUTH_PROVIDER_IDS = ["github-copilot", "openai-codex"] as const;
export type OAuthProviderId = (typeof OAUTH_PROVIDER_IDS)[number];

/** Returns true when the given provider key should use the OAuth flow. */
export function isOAuthProvider(providerKey: string): providerKey is OAuthProviderId {
  return (OAUTH_PROVIDER_IDS as readonly string[]).includes(providerKey);
}

/**
 * Run the OAuth login flow for `providerId` using pi.dev's `AuthStorage`.
 * Terminal-friendly callbacks are wired:
 *   - `onDeviceCode`: prints the device code + URL to stdout.
 *   - `onAuth`:       prints the auth URL to stdout (PKCE flow).
 *   - `onPrompt`:     asks the user for input via @inquirer/prompts (manual code, etc.).
 *   - `onSelect`:     renders a list with @inquirer/prompts.
 *   - `onProgress`:   prints a progress line to stdout.
 *   - `onManualCodeInput`: prompts for manual code entry.
 *
 * When the function resolves, the credential is persisted to auth.json.
 */
export async function runOAuthFlow(providerId: OAuthProviderId): Promise<void> {
  const authStorage = AuthStorage.create();

  const callbacks: OAuthLoginCallbacks = {
    onDeviceCode(info: OAuthDeviceCodeInfo): void {
      process.stdout.write(
        `\nDevice code: ${info.userCode}\n` +
          `Open this URL and enter the code:\n  ${info.verificationUri}\n\n` +
          `Waiting for authorisation…\n`,
      );
    },

    onAuth(info: OAuthAuthInfo): void {
      process.stdout.write(
        `\nOpen this URL to authorise:\n  ${info.url}\n` +
          (info.instructions ? `\n${info.instructions}\n` : "") +
          `\nWaiting for authorisation…\n`,
      );
    },

    async onPrompt(prompt: OAuthPrompt): Promise<string> {
      // @inquirer/prompts — `input` handles plain text, `password` would mask.
      // The SDK uses onPrompt for things like "Enter the code shown in the browser".
      const { input } = await import("@inquirer/prompts");
      return input({
        message: prompt.message,
        default: prompt.placeholder,
        validate: (v) => {
          if (!prompt.allowEmpty && (!v || v.trim() === "")) {
            return "value cannot be empty";
          }
          return true;
        },
      });
    },

    async onSelect(prompt: OAuthSelectPrompt): Promise<string | undefined> {
      if (prompt.options.length === 0) {
        return undefined;
      }
      return select<string>({
        message: prompt.message,
        choices: prompt.options.map((o) => ({ name: o.label, value: o.id })),
      });
    },

    onProgress(message: string): void {
      process.stdout.write(`  ${message}\n`);
    },

    async onManualCodeInput(): Promise<string> {
      const { input } = await import("@inquirer/prompts");
      return input({
        message: "Paste the authorisation code:",
        validate: (v) => (v.trim() === "" ? "code cannot be empty" : true),
      });
    },
  };

  await authStorage.login(providerId, callbacks);

  process.stdout.write(
    `\nOAuth credentials for "${providerId}" saved to auth.json.\n`,
  );
}
