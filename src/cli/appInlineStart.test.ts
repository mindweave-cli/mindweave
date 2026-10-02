/**
 * appInlineStart.test.ts — starting directly in the inline shell must not touch a value the
 * render has not made yet.
 *
 * `const committed = stateRef.current.committed` is declared well down the App function, after
 * the overlay screens that return early. An effect further up that read `committed.length` was
 * fine whenever the render got past that line and threw "Cannot access 'committed' before
 * initialization" when it did not, which is exactly what the first render of an inline start does.
 * Anyone who had chosen the inline shell (the choice is remembered per project) got an error
 * screen instead of the app. Effects and callbacks defined above the declaration have to read the
 * live ref.
 *
 * Enforced by reading the source: the failure needs the whole app mounted on a real terminal.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("nothing above the declaration of `committed` reads it as a bare variable", async () => {
  const source = await readFile(new URL("./App.tsx", import.meta.url), "utf8");
  const declaration = source.indexOf("const committed = stateRef.current.committed;");
  assert.ok(declaration > 0, "the declaration moved: update this test");
  const above = source.slice(0, declaration).split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
  const offenders = above.filter((line) => /(^|[^.\w])committed\b(?!\s*[:=])/.test(line) && !/current\.committed/.test(line));
  assert.deepEqual(offenders, [], "a bare `committed` above its declaration is read before it exists on some renders");
});
