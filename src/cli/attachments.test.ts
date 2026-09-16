/**
 * attachments.test.ts — file sharing (`@mention` + drag-and-drop): the model gets
 * the bytes, the chat gets a chip.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAttachments, stripAttachments } from "./attachments.js";

/** The smallest byte sequence that is a readable PNG header of a given size. */
function png(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24);
  buf.writeUInt32BE(0x89504e47, 0); // signature
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

async function withTmp(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "mindweave-attach-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("@mention: full content to model, count-only chip to UI, mention stays visible", async () => {
  await withTmp(async (dir) => {
    await fs.writeFile(join(dir, "foo.ts"), "line1\nline2\nline3\n");
    const { modelText, displayText, notes } = await resolveAttachments("look at @foo.ts please", dir);

    assert.ok(modelText.includes('<attached_file path="foo.ts">'));
    assert.ok(modelText.includes("line2")); // full content reaches the model
    assert.equal(displayText, "look at @foo.ts please"); // mention left visible
    assert.equal(notes.length, 1);
    assert.match(notes[0]!, /attached foo\.ts \(\+4 lines\)/);
    assert.ok(!notes[0]!.includes("line2")); // chip is never the content
  });
});

test("dropped quoted path: content to model, path collapses to file name in chat", async () => {
  await withTmp(async (dir) => {
    const abs = join(dir, "dropped.txt");
    await fs.writeFile(abs, "hello\nworld\n");
    // A drag-and-drop pastes the (quoted) absolute path into the buffer.
    const { modelText, displayText, notes } = await resolveAttachments(`"${abs}"`, dir);

    assert.ok(modelText.includes("hello")); // model gets the bytes
    assert.equal(displayText, "dropped.txt"); // chat shows just the file name
    assert.ok(!displayText.includes(abs)); // the ugly path is gone from the chat
    assert.match(notes[0]!, /attached dropped\.txt \(\+3 lines\)/);
  });
});

test("dropped bare absolute path collapses too", async () => {
  await withTmp(async (dir) => {
    const abs = join(dir, "notes.md");
    await fs.writeFile(abs, "x\n");
    const { displayText, notes } = await resolveAttachments(`summarize ${abs}`, dir);
    assert.equal(displayText, "summarize notes.md");
    assert.equal(notes.length, 1);
  });
});

test("a mention that isn't a file is left as plain text", async () => {
  await withTmp(async (dir) => {
    const { modelText, displayText, notes } = await resolveAttachments("ping @someone about it", dir);
    assert.equal(modelText, "ping @someone about it");
    assert.equal(displayText, "ping @someone about it");
    assert.equal(notes.length, 0);
  });
});

test("a quoted phrase that isn't a path is left untouched", async () => {
  await withTmp(async (dir) => {
    const { displayText, notes } = await resolveAttachments('he said "hello world" today', dir);
    assert.equal(displayText, 'he said "hello world" today');
    assert.equal(notes.length, 0);
  });
});

test("trailing punctuation is trimmed off a mention", async () => {
  await withTmp(async (dir) => {
    await fs.writeFile(join(dir, "a.txt"), "x\n");
    const { notes } = await resolveAttachments("see @a.txt.", dir);
    assert.equal(notes.length, 1);
    assert.match(notes[0]!, /attached a\.txt/);
  });
});

test("a duplicate reference attaches once", async () => {
  await withTmp(async (dir) => {
    await fs.writeFile(join(dir, "a.txt"), "x\n");
    const { notes } = await resolveAttachments("@a.txt and again @a.txt", dir);
    assert.equal(notes.length, 1);
  });
});

test("non-image binary files are skipped with a note, not attached", async () => {
  await withTmp(async (dir) => {
    await fs.writeFile(join(dir, "blob.dat"), Buffer.from([0x00, 0x01, 0x02]));
    const { modelText, notes } = await resolveAttachments("@blob.dat", dir);
    assert.ok(!modelText.includes("<attached_file"));
    assert.equal(notes.length, 1);
    assert.match(notes[0]!, /skipped blob\.dat \(binary file/);
  });
});

test("a model without vision: the image is NAMED but not attached", async () => {
  await withTmp(async (dir) => {
    await fs.writeFile(join(dir, "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));
    // Default is no vision — the common case, since not every provider ships it.
    const { modelText, displayText, notes, images } = await resolveAttachments(`look at @shot.png`, dir);
    assert.equal(images.length, 0, "nothing may be sent to a model that cannot see");
    assert.equal(notes.length, 1);
    assert.match(notes[0]!, /can't see images/);
    assert.ok(modelText.includes("shared an image file: shot.png")); // told, without bytes
    assert.ok(!modelText.includes("<attached_file")); // not a text attachment either
    assert.equal(displayText, "look at @shot.png");
  });
});

test("a model with vision: the image becomes a ref carrying its real dimensions", async () => {
  await withTmp(async (dir) => {
    await fs.writeFile(join(dir, "shot.png"), png(1920, 1080));
    const { notes, images } = await resolveAttachments(`look at @shot.png`, dir, true);

    assert.equal(images.length, 1);
    assert.equal(images[0]!.mediaType, "image/png");
    assert.equal(images[0]!.width, 1920);
    assert.equal(images[0]!.height, 1080);
    // A ref, never bytes — the payload is loaded at request time.
    assert.ok(!("data" in images[0]!));
    assert.match(notes[0]!, /attached image shot\.png \(1920x1080\)/);
  });
});

test("a format no provider takes is refused with a reason, even when vision is on", async () => {
  await withTmp(async (dir) => {
    await fs.writeFile(join(dir, "diagram.svg"), "<svg/>\n");
    const { notes, images, modelText } = await resolveAttachments("@diagram.svg", dir, true);
    assert.equal(images.length, 0);
    assert.match(notes[0]!, /skipped diagram\.svg \(\.svg images can't be sent/);
    // The model is still told it exists, so it can ask about it.
    assert.ok(modelText.includes("diagram.svg"));
  });
});

test("stripAttachments hides the payload but keeps the typed line", () => {
  const modelText = 'look at @foo.ts\n\n<attached_file path="foo.ts">\nsecret body\n</attached_file>';
  const shown = stripAttachments(modelText);
  assert.equal(shown, "look at @foo.ts");
  assert.ok(!shown.includes("secret body"));
});

// ── what the model is told a dropped file is called ──────────────────────────
// The input box shows a dropped file as a short handle (`mwimg5`). That handle is a
// display convenience and names nothing on disk. It used to be sent to the model as the
// file's name, and a model asked about "mwimg5" went looking for `mwimg5.png`.

test("a dropped image reaches the model by its name and source path, never the input box handle", async () => {
  await withTmp(async (dir) => {
    const abs = join(dir, "Screenshot 2026-09-15 112814.png");
    await fs.writeFile(abs, png(800, 600));
    const { modelText, displayText, images } = await resolveAttachments(
      `"${abs}" why is this broken`,
      dir,
      true,
      () => "mwimg5",
    );
    assert.equal(images.length, 1);
    assert.equal(displayText, "mwimg5 why is this broken", "the chat keeps what the user saw");
    assert.doesNotMatch(modelText, /mwimg5/, "the handle must never reach the model");
    assert.ok(modelText.startsWith("Screenshot 2026-09-15 112814.png why is this broken"), modelText);
    assert.ok(
      modelText.includes("[Image source: Screenshot 2026-09-15 112814.png]"),
      "the model needs the path to open the image again once it is cleared",
    );
  });
});

test("a dropped text file reaches the model by its name, never the input box handle", async () => {
  await withTmp(async (dir) => {
    const abs = join(dir, "notes.txt");
    await fs.writeFile(abs, "hello\n");
    const { modelText, displayText } = await resolveAttachments(`read "${abs}"`, dir, false, () => "mwfile1");
    assert.equal(displayText, "read mwfile1");
    assert.doesNotMatch(modelText, /mwfile1/);
    assert.ok(modelText.startsWith("read notes.txt"), modelText);
  });
});

test("a resumed chat does not show the image source line the model was given", () => {
  const stored = "look at shot.png\n\n[Image source: C:\Users\me\Pictures\shot.png]";
  assert.equal(stripAttachments(stored), "look at shot.png");
});
