/**
 * servers.ts — which language server handles which file, and how to obtain it.
 *
 * Resolution order per language: BUNDLED (shipped with Mindweave) → on PATH (you
 * already have it) → INSTALLED in Mindweave's cache → AUTO-INSTALL (fetch it) → none
 * (the file stays on the tree-sitter tier). This single table is where language
 * coverage grows; `provision.ts` does the fetching.
 */
import { createRequire } from "node:module";
import { isExecutableFile } from "../../tools/posixShell.js";
import { delimiter, extname, join } from "node:path";
import { ensureInstalled, resolveInstalled, type GithubTarget, type InstallSpec } from "./provision.js";

const require = createRequire(import.meta.url);

export interface ServerSpec {
  key: string;
  command: string;
  args: string[];
}

// ── file extension → LSP languageId ───────────────────────────────────────────
const EXT_LANG: Record<string, string> = {
  ".ts": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".jsx": "javascriptreact",
  ".py": "python", ".pyi": "python",
  ".go": "go",
  ".rs": "rust",
  ".c": "c", ".h": "c",
  ".cpp": "cpp", ".cc": "cpp", ".cxx": "cpp", ".hpp": "cpp", ".hh": "cpp",
  ".zig": "zig",
  ".lua": "lua",
  ".rb": "ruby",
  ".php": "php",
  ".sh": "shellscript", ".bash": "shellscript",
  ".java": "java",
  ".cs": "csharp",
  ".hs": "haskell",
  ".ex": "elixir", ".exs": "elixir",
  ".ml": "ocaml", ".mli": "ocaml",
  ".swift": "swift",
  ".kt": "kotlin", ".kts": "kotlin",
  ".scala": "scala", ".sbt": "scala",
  ".dart": "dart",
  ".tf": "terraform",
  ".yaml": "yaml", ".yml": "yaml",
  ".json": "json",
  ".html": "html", ".htm": "html",
  ".css": "css", ".scss": "scss", ".less": "less",
};

export function languageIdFor(absPath: string): string | undefined {
  return EXT_LANG[extname(absPath).toLowerCase()];
}

// ── registry ────────────────────────────────────────────────────────────────
interface Entry {
  key: string;
  langIds: string[];
  /** A server bundled with Mindweave (resolves to a full spec or null). */
  bundled?: () => ServerSpec | null;
  /** Command names to look for on PATH. */
  pathNames?: string[];
  /** Launch args for PATH / installed launches. */
  args: string[];
  /** How to auto-install this server if it isn't otherwise available. */
  install?: InstallSpec;
}

function bundledNode(key: string, modulePath: string, args: string[]): ServerSpec | null {
  try {
    return { key, command: process.execPath, args: [require.resolve(modulePath), ...args] };
  } catch {
    return null;
  }
}

function findOnPath(names: string[]): string | null {
  const dirs = (process.env.PATH || "").split(delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""];
  for (const name of names) {
    for (const dir of dirs) {
      for (const ext of exts) {
        const candidate = join(dir, name + ext.toLowerCase());
        // Executable, not merely present. On POSIX a readable-but-not-executable file
        // (or a directory) of the right name would satisfy existsSync and then fail to
        // spawn, which reads as "the language server is broken" rather than "not found".
        if (isExecutableFile(candidate)) return candidate;
      }
    }
  }
  return null;
}

const npm = (pkg: string, version: string, binName: string): InstallSpec => ({
  source: "npm",
  package: pkg,
  version,
  binName,
});

const github = (repo: string, version: string, targets: Record<string, GithubTarget>): InstallSpec => ({
  source: "github",
  repo,
  version,
  targets,
});

// rust-analyzer ships prebuilt binaries: .zip on Windows (contains the .exe),
// single-file .gz on macOS/Linux (decompresses straight to the binary).
const RUST_ANALYZER = github("rust-lang/rust-analyzer", "2026-06-22", {
  "win32-x64": { asset: "rust-analyzer-x86_64-pc-windows-msvc.zip", sha256: "6071dc5b28aa6d22c715f63c08d75b827c066be4ea866796587e52ed48b2922f", bin: "rust-analyzer.exe" },
  "win32-arm64": { asset: "rust-analyzer-aarch64-pc-windows-msvc.zip", sha256: "30f873713ea3663db10999c23e95b74fe19968c893d5c0e9b8a896b31dbf8cf8", bin: "rust-analyzer.exe" },
  "darwin-x64": { asset: "rust-analyzer-x86_64-apple-darwin.gz", sha256: "bf65b0d4586f127ab11bf33476dd6aac82dad173946c5d3b1cede19d63ae85ed", bin: "rust-analyzer" },
  "darwin-arm64": { asset: "rust-analyzer-aarch64-apple-darwin.gz", sha256: "c8cdf6d5e488752b907d5ee15e31768b59a78d992e9a54b9f9660e1bfdf39f27", bin: "rust-analyzer" },
  "linux-x64": { asset: "rust-analyzer-x86_64-unknown-linux-gnu.gz", sha256: "feb7c170d2c1a2e4b8a88ac73f937eddb576828e3821b0a63ee0e64bd0bc9440", bin: "rust-analyzer" },
  "linux-arm64": { asset: "rust-analyzer-aarch64-unknown-linux-gnu.gz", sha256: "9602ca5b24dcaa07a5a021274763bed367d8a32da9a226fe3e139de3306569cb", bin: "rust-analyzer" },
});

// clangd: per-OS .zip; the binary is at clangd_<version>/bin/clangd. The mac build
// is a universal binary (used for both arches); clangd has no arm64-linux build.
const CLANGD = github("clangd/clangd", "22.1.0", {
  "win32-x64": { asset: "clangd-windows-{version}.zip", sha256: "e31e271fe11f6dcd7cf87ca74be4a12788ff8ce5a0b07762583e335c058e939a", bin: "clangd_{version}/bin/clangd.exe" },
  "darwin-x64": { asset: "clangd-mac-{version}.zip", sha256: "71eddc5303da9a5bc5e8b509488b5b2c5acf45f20e33b8394e71a12a56d67198", bin: "clangd_{version}/bin/clangd" },
  "darwin-arm64": { asset: "clangd-mac-{version}.zip", sha256: "71eddc5303da9a5bc5e8b509488b5b2c5acf45f20e33b8394e71a12a56d67198", bin: "clangd_{version}/bin/clangd" },
  "linux-x64": { asset: "clangd-linux-{version}.zip", sha256: "c54e57dbff3ccc9e8352367ddb7030ad3f624073ec58c7477424e7919f578572", bin: "clangd_{version}/bin/clangd" },
});

// zls: .zip on Windows, .tar.xz on Unix (system tar extracts xz); binary at root.
const ZLS = github("zigtools/zls", "0.16.0", {
  "win32-x64": { asset: "zls-x86_64-windows.zip", sha256: "35cbb7163224e8cf92d21099c1b1391f2aba927f25d389f021b13a21d40b96dd", bin: "zls.exe" },
  "win32-arm64": { asset: "zls-aarch64-windows.zip", sha256: "ef4c5ccb93c80c9f023105c5f558ae8774ac6668d560ba6f92a2f87d95df2311", bin: "zls.exe" },
  "darwin-x64": { asset: "zls-x86_64-macos.tar.xz", sha256: "49f716ea96c1aadaecaa5d9c0a50874cbcf443dc42b825f1e7ee35499ad3eb96", bin: "zls" },
  "darwin-arm64": { asset: "zls-aarch64-macos.tar.xz", sha256: "b93ec549f8558a7e85984a840e9276d274f1059b54ade4254296ef4982958359", bin: "zls" },
  "linux-x64": { asset: "zls-x86_64-linux.tar.xz", sha256: "ded6d562a0b86ee878b1ddf70ffab2797ce3cdca3b02d6077548f9d56dff96b6", bin: "zls" },
  "linux-arm64": { asset: "zls-aarch64-linux.tar.xz", sha256: "430cd293d201eb70ae2519dbc96c854bf8791b8df7fc9392e8d2dc9680a2bed7", bin: "zls" },
});

// lua-language-server: .zip on Windows, .tar.gz on Unix; binary at bin/.
const LUA_LS = github("LuaLS/lua-language-server", "3.18.2", {
  "win32-x64": { asset: "lua-language-server-{version}-win32-x64.zip", sha256: "a4439a8f5e8e9e6505c11f045a7bf45db602124a1e246371c1dbe34924f3cf71", bin: "bin/lua-language-server.exe" },
  "darwin-x64": { asset: "lua-language-server-{version}-darwin-x64.tar.gz", sha256: "e26cfefe423dd7326fc7c649539e4d4aaa4f35f34d2fefd8af2ed7090b72c556", bin: "bin/lua-language-server" },
  "darwin-arm64": { asset: "lua-language-server-{version}-darwin-arm64.tar.gz", sha256: "cec99d70b1f612acec4a10a79a03664e3aa0c229d4d8a586cb3f928ec37d509e", bin: "bin/lua-language-server" },
  "linux-x64": { asset: "lua-language-server-{version}-linux-x64.tar.gz", sha256: "ca71415dd19f19e30aaa35a4915aefca9fdb5fec31b98331cc3d77f778d539c5", bin: "bin/lua-language-server" },
  "linux-arm64": { asset: "lua-language-server-{version}-linux-arm64.tar.gz", sha256: "273af33f26f4a1143f27c96d9f9e1188aba619c71e0807042134f66b4bd27f24", bin: "bin/lua-language-server" },
});

const REGISTRY: Entry[] = [
  // Bundled — instant, offline.
  { key: "typescript-language-server", langIds: ["typescript", "typescriptreact", "javascript", "javascriptreact"], args: [],
    bundled: () => bundledNode("typescript-language-server", "typescript-language-server/lib/cli.mjs", ["--stdio"]) },
  { key: "pyright", langIds: ["python"], args: [],
    bundled: () => bundledNode("pyright", "pyright/langserver.index.js", ["--stdio"]) },

  // npm-installable — PATH first, else auto-install via npm.
  { key: "bash-language-server", langIds: ["shellscript"], pathNames: ["bash-language-server"], args: ["start"],
    install: npm("bash-language-server", "5.4.3", "bash-language-server") },
  { key: "intelephense", langIds: ["php"], pathNames: ["intelephense"], args: ["--stdio"],
    install: npm("intelephense", "1.12.6", "intelephense") },
  { key: "yaml-language-server", langIds: ["yaml"], pathNames: ["yaml-language-server"], args: ["--stdio"],
    install: npm("yaml-language-server", "1.15.0", "yaml-language-server") },
  { key: "json-language-server", langIds: ["json"], pathNames: ["vscode-json-language-server"], args: ["--stdio"],
    install: npm("vscode-langservers-extracted", "4.10.0", "vscode-json-language-server") },
  { key: "html-language-server", langIds: ["html"], pathNames: ["vscode-html-language-server"], args: ["--stdio"],
    install: npm("vscode-langservers-extracted", "4.10.0", "vscode-html-language-server") },
  { key: "css-language-server", langIds: ["css", "scss", "less"], pathNames: ["vscode-css-language-server"], args: ["--stdio"],
    install: npm("vscode-langservers-extracted", "4.10.0", "vscode-css-language-server") },

  // PATH-detected (binary servers — GitHub-release auto-install lands in the next
  // phase; toolchain servers like gopls stay PATH-only).
  { key: "gopls", langIds: ["go"], pathNames: ["gopls"], args: [] },
  { key: "rust-analyzer", langIds: ["rust"], pathNames: ["rust-analyzer"], args: [], install: RUST_ANALYZER },
  { key: "clangd", langIds: ["c", "cpp"], pathNames: ["clangd"], args: [], install: CLANGD },
  { key: "zls", langIds: ["zig"], pathNames: ["zls"], args: [], install: ZLS },
  { key: "lua-ls", langIds: ["lua"], pathNames: ["lua-language-server"], args: [], install: LUA_LS },
  { key: "solargraph", langIds: ["ruby"], pathNames: ["solargraph"], args: ["stdio"] },
  { key: "jdtls", langIds: ["java"], pathNames: ["jdtls"], args: [] },
  { key: "csharp-ls", langIds: ["csharp"], pathNames: ["csharp-ls"], args: [] },
  { key: "haskell-ls", langIds: ["haskell"], pathNames: ["haskell-language-server-wrapper"], args: ["--lsp"] },
  { key: "elixir-ls", langIds: ["elixir"], pathNames: ["language_server.sh", "elixir-ls"], args: [] },
  { key: "ocaml-ls", langIds: ["ocaml"], pathNames: ["ocamllsp"], args: [] },
  { key: "sourcekit", langIds: ["swift"], pathNames: ["sourcekit-lsp"], args: [] },
  { key: "kotlin-ls", langIds: ["kotlin"], pathNames: ["kotlin-language-server"], args: [] },
  { key: "metals", langIds: ["scala"], pathNames: ["metals"], args: [] },
  { key: "dart", langIds: ["dart"], pathNames: ["dart"], args: ["language-server"] },
  { key: "terraform-ls", langIds: ["terraform"], pathNames: ["terraform-ls"], args: ["serve"] },
];

const byLang = new Map<string, Entry>();
for (const e of REGISTRY) for (const l of e.langIds) byLang.set(l, e);

// Resolved spec per entry key (cleared by invalidate after an install).
const specCache = new Map<string, ServerSpec | null>();

function resolveEntry(entry: Entry): ServerSpec | null {
  if (entry.bundled) {
    const s = entry.bundled();
    if (s) return s;
  }
  if (entry.pathNames) {
    const found = findOnPath(entry.pathNames);
    if (found) return { key: entry.key, command: found, args: entry.args };
  }
  if (entry.install) {
    const cmd = resolveInstalled(entry.key, entry.install);
    if (cmd) return { key: entry.key, command: cmd, args: entry.args };
  }
  return null;
}

/** The server spec for an LSP languageId, or null if none is available yet. */
export function specForLanguage(langId: string): ServerSpec | null {
  const entry = byLang.get(langId);
  if (!entry) return null;
  if (!specCache.has(entry.key)) specCache.set(entry.key, resolveEntry(entry));
  return specCache.get(entry.key) ?? null;
}

/** The server spec for a file, or null. */
export function serverFor(absPath: string): ServerSpec | null {
  const lang = languageIdFor(absPath);
  return lang ? specForLanguage(lang) : null;
}

/**
 * Install server `key` now that the user has approved it, and let the next query use it.
 * Returns whether it is available afterwards.
 */
export async function installApproved(key: string, log?: (m: string) => void): Promise<boolean> {
  const entry = REGISTRY.find((e) => e.key === key);
  if (!entry?.install) return false;
  const cmd = await ensureInstalled(entry.key, entry.install, log);
  if (cmd) specCache.delete(entry.key);
  return cmd !== null;
}

/**
 * Auto-install any servers needed for `langIds` that aren't already available.
 * Best-effort and deduped; after a successful install the cache is invalidated so
 * the server resolves on the next query. Called by the alternator in the background.
 */
export async function ensureServers(langIds: Iterable<string>, log?: (m: string) => void): Promise<void> {
  const seen = new Set<string>();
  for (const langId of langIds) {
    const entry = byLang.get(langId);
    if (!entry?.install || seen.has(entry.key)) continue;
    seen.add(entry.key);
    if (specForLanguage(langId)) continue; // already available (bundled/PATH/installed)
    const cmd = await ensureInstalled(entry.key, entry.install, log);
    if (cmd) specCache.delete(entry.key); // re-resolve to the freshly installed server
  }
}
