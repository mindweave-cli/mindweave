/**
 * feedback.test.ts — what `/feedback` sends, what it refuses, and what it says when the
 * relay is down.
 *
 * Three things have to hold for a feature that mails text off the machine. It sends ONLY
 * what the confirm screen showed — a payload that quietly grew a field would be the worst
 * kind of surprise in an open-source tool. It refuses a message carrying a key, because a
 * feedback box invites pasting the request that just failed and a key mailed to a relay
 * cannot be unmailed. And every failure ends somewhere else to go, so someone who took
 * the trouble to write is never left with nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ISSUES_URL, MAX_MESSAGE, buildFeedback, previewOf, refuseReason, sendFeedback, withAddition } from "./feedback.js";

test("the payload is the message, the version and the platform, and nothing else", async () => {
  let sent: { url: string; init: RequestInit } | undefined;
  const fake = (async (url: string | URL, init?: RequestInit) => {
    sent = { url: String(url), init: init ?? {} };
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  }) as unknown as typeof fetch;

  const result = await sendFeedback(buildFeedback("the picker scrolls past the end", "2.4.9", "win32"), fake);
  assert.equal(result.ok, true);
  assert.ok(sent, "nothing was sent");
  assert.match(sent!.url, new RegExp(String.raw`docs.google.com/forms/.*/formResponse$`), "it posts to the form");
  const body = new URLSearchParams(String(sent!.init.body));
  const values = [...body.values()].sort();
  assert.deepEqual(values, ["2.4.9", "the picker scrolls past the end", "win32"].sort());
  // Three fields and no more. One added later has to be added here on purpose, which is
  // the only guard against this quietly growing to carry more than the confirm screen says.
  assert.equal([...body.keys()].length, 3);
  for (const key of body.keys()) {
    assert.match(key, new RegExp(String.raw`^entry.[0-9]+$`), "the fields are the form's own");
  }
});

test("the confirm text shows the message and names what is NOT sent", () => {
  const preview = previewOf(buildFeedback("could /model remember my last pick?", "2.4.9", "win32"));
  assert.match(preview, /could \/model remember my last pick\?/);
  assert.match(preview, /2\.4\.9/);
  assert.match(preview, /conversation, code and keys are not sent/);
});

test("the confirm fits the box it renders in: one paragraph, no newlines, bounded", () => {
  // It shows INSIDE the shared command box, which clips a question at four wrapped rows.
  // A preview cut by the renderer would leave the sender unsure what was actually going.
  const long = previewOf(buildFeedback("y".repeat(3000), "2.4.9", "win32"));
  assert.ok(!long.includes(String.fromCharCode(10)), "a newline would eat one of the four rows");
  assert.ok(long.length < 400, `the confirm is ${long.length} characters and will be clipped`);
  assert.match(long, /all 3000 characters are sent/, "the sender must know the whole message still goes");
});

test("a message carrying a key is refused before anything leaves", () => {
  const keys = [
    "this fails: sk-abcdefghijklmnopqrstuvwx",
    "OPENROUTER_API_KEY=sk-or-v1-0123456789abcdef0123",
    "my token ghp_abcdefghijklmnopqrstuvwxyz0123",
    'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
    "api_key: 8f14e45fceea167a5a36dedd4bea2543",
  ];
  for (const message of keys) {
    assert.ok(refuseReason(message), `this was allowed through: ${message}`);
  }
});

test("an ordinary message that merely talks about keys is allowed", () => {
  // The refusal has to be about a key being PRESENT, not about the word appearing.
  assert.equal(refuseReason("adding my api key through /key was confusing, the box closed"), null);
  assert.equal(refuseReason("the secret sauce is the picker filter, it is great"), null);
});

test("an empty message is refused, and an enormous one points at issues", () => {
  assert.match(refuseReason("   ") ?? "", /Nothing to send/);
  const huge = "x".repeat(MAX_MESSAGE + 1);
  const reason = refuseReason(huge) ?? "";
  assert.match(reason, new RegExp(String(MAX_MESSAGE)));
  assert.ok(reason.includes(ISSUES_URL), "an over-long message must still have somewhere to go");
});

test("a relay that refuses the post says so, in its own words, and where to go instead", async () => {
  // The relay explains itself and that sentence is the diagnosis: a bare status code cost
  // a real debugging round when the body read "Pro plan is required".
  const fake = (async () =>
    new Response(JSON.stringify({ success: false, message: "This method is not allowed." }), {
      status: 403,
    })) as unknown as typeof fetch;
  const result = await sendFeedback(buildFeedback("hello", "2.4.9", "win32"), fake);
  assert.equal(result.ok, false);
  assert.match(result.message, /403/);
  assert.match(result.message, /This method is not allowed/);
  assert.ok(result.message.includes(ISSUES_URL));
});

test("no connection is reported as that, not as silence", async () => {
  const fake = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  const result = await sendFeedback(buildFeedback("hello", "2.4.9", "win32"), fake);
  assert.equal(result.ok, false);
  assert.match(result.message, /could not be sent/);
  assert.ok(result.message.includes(ISSUES_URL));
});

test("adding a line keeps the message and appends, so nothing is retyped", () => {
  const first = "the model picker should remember my last pick";
  const withEmail = withAddition(first, "  me@example.com  ");
  assert.equal(withEmail, first + String.fromCharCode(10) + "me@example.com");
  // Adding again stacks rather than replacing.
  // Adding again stacks rather than replacing: three lines, in the order they were typed.
  const twice = withAddition(withEmail, "happens on windows only");
  assert.deepEqual(twice.split(String.fromCharCode(10)), [first, "me@example.com", "happens on windows only"]);
});

test("an empty addition changes nothing", () => {
  assert.equal(withAddition("hello", "   "), "hello");
});

test("an addition is checked for keys like anything else", () => {
  // The refusal runs on the whole message after each addition, not only on the first draft.
  const message = withAddition("this fails when I run it", "my key is sk-abcdefghijklmnopqrstuvwx");
  assert.ok(refuseReason(message), "a key added on the second pass was allowed through");
});

test("a build with no destination says so instead of posting into the void", async () => {
  // The alias is configured per build. With none there is nowhere to post, and the sender
  // has to be told that plainly rather than watching a request fail for an odd reason.
  const previous = process.env.MINDWEAVE_FEEDBACK_URL;
  process.env.MINDWEAVE_FEEDBACK_URL = "";
  try {
    let posted = false;
    const fake = (async () => {
      posted = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const result = await sendFeedback(buildFeedback("hello", "2.4.9", "win32"), fake);
    assert.equal(result.ok, false);
    assert.equal(posted, false, "nothing may be posted when there is no destination");
    assert.ok(result.message.includes(ISSUES_URL));
  } finally {
    if (previous === undefined) delete process.env.MINDWEAVE_FEEDBACK_URL;
    else process.env.MINDWEAVE_FEEDBACK_URL = previous;
  }
});

test("a relay that refuses inside a 200 is not reported as sent", async () => {
  // The first live send: HTTP 200, and the refusal in the body. Believing the status told
  // the sender their message had arrived when nothing had been mailed.
  const fake = (async () =>
    new Response(JSON.stringify({ success: "false", message: "Make sure you open this page through a web server." }), {
      status: 200,
    })) as unknown as typeof fetch;
  const result = await sendFeedback(buildFeedback("hello", "2.4.9", "win32"), fake);
  assert.equal(result.ok, false, "a body saying success:false must not read as delivered");
  assert.match(result.message, /web server/, "the relay's own sentence is the diagnosis");
  assert.ok(result.message.includes(ISSUES_URL));
});

test("a relay that accepts is still reported as sent", async () => {
  // The other half: the guard above must not turn every send into a failure.
  const fake = (async () =>
    new Response(JSON.stringify({ success: "true", message: "The form was submitted successfully." }), {
      status: 200,
    })) as unknown as typeof fetch;
  const result = await sendFeedback(buildFeedback("hello", "2.4.9", "win32"), fake);
  assert.equal(result.ok, true);
  assert.match(result.message, /Sent/);
});

test("a form served back instead of a confirmation is not reported as sent", async () => {
  // A refused post is answered with the form itself and a 200. Believing the status would
  // tell the sender their message had arrived when nothing was recorded.
  const fake = (async () =>
    new Response(`<html><script>var FB_PUBLIC_LOAD_DATA_ = [null,[null,[[1,"Message"]]]];</script></html>`, {
      status: 200,
    })) as unknown as typeof fetch;
  const result = await sendFeedback(buildFeedback("hello", "2.4.9", "win32"), fake);
  assert.equal(result.ok, false);
  assert.match(result.message, /nothing was recorded/);
  assert.ok(result.message.includes(ISSUES_URL));
});

test("the confirmation a form answers an accepted post with is reported as sent", async () => {
  // The other half: a real confirmation carries an EMPTY list where the form carries its
  // questions, and that must still read as delivered.
  const fake = (async () =>
    new Response(`<html><script>var FB_PUBLIC_LOAD_DATA_ = [null,[],"/forms"];</script></html>`, {
      status: 200,
    })) as unknown as typeof fetch;
  const result = await sendFeedback(buildFeedback("hello", "2.4.9", "win32"), fake);
  assert.equal(result.ok, true);
});
