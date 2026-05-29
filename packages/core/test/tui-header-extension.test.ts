/**
 * tui-header-extension.test.ts — zia TUI branding.
 *
 * Pins the behaviour of ziaHeaderExtension:
 * - On session_start WITH a UI, it replaces the header via ctx.ui.setHeader,
 *   and the rendered banner contains the ZIA wordmark + tagline + version.
 * - WITHOUT a UI (RPC / print modes), it is a no-op — never calls setHeader.
 *
 * This guards against a future change silently dropping the zia banner or
 * leaking pi.dev's built-in "pi vX.Y.Z" header back in.
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { describe, it, expect, vi } from "vitest";

import { ziaHeaderExtension } from "../src/tui-header-extension.ts";

// Minimal stand-ins for the SDK objects the extension touches. fg() returns the
// text unchanged so assertions can match on the raw glyphs/strings. The `tui`
// arg is passed through to the header factory but never read by render().
const theme = { fg: (_color: string, text: string) => text } as unknown as Theme;
const tui = {} as unknown;

type SessionStartHandler = (event: unknown, ctx: unknown) => unknown;
type HeaderFactory = (t: unknown, th: Theme) => { render(w: number): string[] };

/** Run the extension and return the registered session_start handler. */
function captureHandler(): SessionStartHandler {
  let handler: SessionStartHandler | undefined;
  const pi = {
    on: (event: string, h: SessionStartHandler) => {
      if (event === "session_start") handler = h;
    },
  } as unknown as ExtensionAPI;
  ziaHeaderExtension(pi);
  if (!handler) throw new Error("extension did not register a session_start handler");
  return handler;
}

describe("ziaHeaderExtension", () => {
  it("registers a session_start handler", () => {
    expect(() => captureHandler()).not.toThrow();
  });

  it("renders the ZIA banner via setHeader when a UI is present", () => {
    const handler = captureHandler();
    const setHeader = vi.fn();
    handler({ type: "session_start", reason: "startup" }, { hasUI: true, ui: { setHeader } });

    expect(setHeader).toHaveBeenCalledOnce();
    const factory = setHeader.mock.calls[0]?.[0] as HeaderFactory;
    const lines = factory(tui, theme).render(80);
    const banner = lines.join("\n");

    // ANSI Shadow wordmark — the first logo row is a stable, unique signature.
    expect(banner).toContain("███████╗██╗ █████╗");
    // Subtitle: tagline + version.
    expect(banner).toContain("employee-style AI agents · v0.1.0");
  });

  it("is a no-op without a UI (RPC / print modes)", () => {
    const handler = captureHandler();
    const setHeader = vi.fn();
    handler({ type: "session_start", reason: "startup" }, { hasUI: false, ui: { setHeader } });

    expect(setHeader).not.toHaveBeenCalled();
  });
});
