import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * zia version shown in the TUI banner.
 *
 * Kept as a const (not read from package.json) so @zia/core stays free of
 * filesystem reads and remains importable in any runtime. Wire it to the real
 * package version when zia ships as its own binary (Camino A — piConfig rebrand).
 */
const ZIA_VERSION = "0.1.0";

/**
 * "ZIA" wordmark in the figlet "ANSI Shadow" font. Rendered in the accent color
 * as the TUI startup banner, replacing pi.dev's built-in "pi vX.Y.Z" header.
 */
const ZIA_LOGO: readonly string[] = [
  "███████╗██╗ █████╗ ",
  "╚══███╔╝██║██╔══██╗",
  "  ███╔╝ ██║███████║",
  " ███╔╝  ██║██╔══██║",
  "███████╗██║██║  ██║",
  "╚══════╝╚═╝╚═╝  ╚═╝",
];

/** Subtitle shown under the logo. */
const ZIA_TAGLINE = "employee-style AI agents";

/**
 * zia TUI header extension.
 *
 * Replaces pi.dev's built-in header — the "pi vX.Y.Z" logo, the keybinding
 * hints, and the hardcoded "Pi can explain its own features…" onboarding line —
 * with zia's own branded banner via `ctx.ui.setHeader`. This is the
 * SDK-supported customization seam (see the SDK's
 * examples/extensions/custom-header.ts); the alternative (piConfig.name rebrand)
 * requires shipping zia as its own binary, so this is the clean path while zia
 * runs on top of the SDK as a dependency.
 *
 * Loaded in-process as an `extensionFactory` (not from disk), so it works while
 * `noExtensions: true` keeps host extension auto-discovery off — inline factories
 * are loaded regardless of that flag (verified in the SDK resource-loader).
 *
 * TUI-only: guarded by `ctx.hasUI`, so it is a no-op in RPC / print modes
 * (gateways, cron) where there is no header to render.
 */
export function ziaHeaderExtension(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) {
      return;
    }
    ctx.ui.setHeader((_tui, theme) => ({
      render(_width: number): string[] {
        const logo = ZIA_LOGO.map((line) => theme.fg("accent", line));
        const subtitle = theme.fg("dim", `   ${ZIA_TAGLINE} · v${ZIA_VERSION}`);
        return ["", ...logo, "", subtitle, ""];
      },
      invalidate(): void {},
    }));
  });
}
