/**
 * serverConsent.ts — ask the user before Mindweave installs a language server.
 *
 * A language server is someone else's program: it is downloaded, then runs on this
 * machine and reads the project. The code-map wants one the first time a project has
 * files in its language, but it runs in the background with nobody to ask, so it only
 * records the wish (see alternator/chassis/provision.ts). This asks about each one when a
 * turn starts, which is the first moment a front end is surely listening, and remembers
 * the answer for good. Until then, and after a "never", the code-map works from
 * tree-sitter as it always could.
 */
import type { ToolContext } from "./types.js";
import { recordInstallDecision, takeUndecidedInstalls, type InstallSpec } from "../alternator/chassis/provision.js";
import { installApproved } from "../alternator/chassis/servers.js";

export const INSTALL_OPTIONS = ["Install", "Not now", "Never"] as const;

/** Where the server would come from, as the user is shown it. */
export function describeInstall(spec: InstallSpec): string {
  return spec.source === "npm"
    ? `the npm package ${spec.package}@${spec.version} (installed without running its install scripts)`
    : `the ${spec.version} release of github.com/${spec.repo} (checked against its published SHA-256)`;
}

/** Ask about every server wanted since the last turn. With nobody to ask, they wait. */
export async function askPendingInstalls(ctx: ToolContext): Promise<void> {
  if (!ctx.requestApproval) return;
  for (const { key, spec } of takeUndecidedInstalls()) {
    const choice = await ctx.requestApproval(
      `Install the '${key}' language server? It makes code navigation and error checks exact for this kind of file.`,
      [...INSTALL_OPTIONS],
      `From ${describeInstall(spec)}. It runs on this computer and reads your project's files. ` +
        `Without it, Mindweave still works from its built-in parser.`,
      "Language server",
    );
    if (choice === INSTALL_OPTIONS[0]) {
      await recordInstallDecision(key, "yes").catch(() => {});
      void installApproved(key).catch(() => {});
    } else if (choice === INSTALL_OPTIONS[2]) {
      await recordInstallDecision(key, "never").catch(() => {});
    }
    // "Not now" records nothing: the next session that wants it asks again.
  }
}
