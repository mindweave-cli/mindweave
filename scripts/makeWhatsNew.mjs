// Cuts the CHANGELOG section for this package's version into dist/whatsnew.json, which ships inside the
// package (CHANGELOG.md itself does not). Run by `prepack`, after the build. A version with no section of
// its own ships no file, and the stale one from an earlier pack is removed, so the app shows nothing rather
// than the wrong list.
import { readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist", "whatsnew.json");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const { parseWhatsNew } = await import("../dist/cli/whatsNew.js");

const notes = existsSync(join(root, "CHANGELOG.md")) ? parseWhatsNew(readFileSync(join(root, "CHANGELOG.md"), "utf8"), version) : null;
if (notes) {
  writeFileSync(out, JSON.stringify(notes, null, 2));
  console.log(`whatsnew: v${version}, ${notes.groups.length} groups`);
} else {
  rmSync(out, { force: true });
  console.log(`whatsnew: no section for v${version}; nothing will be shown`);
}
