# Changelog

Notable changes to Mindweave. Dates are release dates.


## v2.5.0 (2026-09-18): the 2.4 releases, checked against real sessions and fixed where they were wrong

Nothing in this release is new for its own sake. Every change since 2.4.0 was checked
against real sessions and by driving the whole app through a fake terminal, and what was
wrong is fixed here. Three of the bugs below were invisible to the test suite and only
showed up when the app was actually used.

A build that succeeded could be reported as failed. Programs like cargo, npm and git print
their progress on stderr, and Windows PowerShell counts that as an error whenever the
output is redirected with `2>&1`, so a finished build came back as exit code 1. A command
that deliberately silenced an error, such as stopping a process that may not be running,
was reported the same way. The exit code now comes from what actually happened. The
progress lines themselves also reached the model wrapped in PowerShell's error formatting
("At line:2 char:1", "NativeCommandError"), which made a clean build look full of errors;
they now arrive as the lines the program printed. An exit code of -1 no longer shows as
4294967295.

Commands started in the background had their output ignored since 2.4.0. Reading a
background command showed nothing, every notice said "no output", and the check for a
command stuck waiting on a question could never see the question. Their output is read
again. A command that asks a question, like "Proceed? [y/N]", also no longer waits out the
two-minute timeout for an answer nobody can type: it gets end of input straight away and
takes its default.

When the agent stopped its own app to restart it, it was then told that you had closed it.
It is no longer told anything about a stop it made itself. A command Mindweave stops for
writing without end is reported as that. When an app it launched to check its own work
fails to start, it is told to fix that as part of the work, rather than stopping to ask
you. And being told an app is running no longer invites it to describe a window it never
looked at.

A reply you answered is kept whole. Older long replies were being condensed to a
placeholder to save space, but almost every one of them was a question or proposal you had
answered, so "yes" or "go with B" was left pointing at nothing. After a command moves into
a subfolder, the agent is now told that the next turn starts back at the project root, and
a turn that starts there says so, instead of commands failing because they ran in the wrong
place.

The header at the top of the screen could be overwritten by a row from the conversation
scrolling past it. The cause was in how nested clipping works in the terminal renderer, and
the row that triggered it no longer asks for its own clipping.

### Asking it to change its own setup

What you could only do through commands, you can now also just ask for. The agent can add
and remove standing rules, create and delete skills, and add, remove, disable or enable MCP
servers, in the same plain words you would use for anything else: "forget the rule about
force-pushing", "stop using the Figma server for now", "turn it back on". Lifting a
restriction is included, because a ban you cannot lift without hunting for the right
command is a trap rather than a safeguard. Every one of these still shows you exactly what
it is about to change and waits for you to agree.

For the things it genuinely cannot do, it now says so and tells you the command that does
it, instead of guessing or going quiet. It can also answer questions about itself: which
version is running, which model and provider are in use, which mode it is in, which
folders it can reach, and which rules, skills and servers are active in this project.

### Sending feedback without an account

`/feedback <what you want to say>` sends a message to the maintainer from inside the app.
No account, no sign-in, no issue tracker: type a sentence, read back exactly what will be
sent, and confirm. What leaves the machine is the message, the version and the platform,
and nothing else. Your conversation, your code, your file paths and your keys stay where
they are.

The confirm screen shows the message it is about to send and offers one more row where you
can add a line, so you can put an email address on it for a reply without starting over. A
message that looks like it contains an API key or token is refused before anything is sent,
because a feedback box invites pasting the request that just failed, and a key sent to a
third party cannot be taken back. If sending fails, it says so in the words the other end
used and points you at the issue tracker, and it never claims a message was sent when it
was not.

Smaller fixes: taking a screenshot with no window named, at a moment when no window has
focus, says that instead of claiming several windows matched. A task list is no longer
refused over a missing optional field. Each model call in a session's usage log carries its
own time instead of all sharing the time the turn ended. Sessions with nothing in them no
longer appear in `/continue`. Images opened from a file are no longer described as just
captured. `/model openrouter` followed by words while already on OpenRouter finds the
matching models instead of opening an empty list, the list also matches a model's id, and
it reads "Choose an OpenRouter model". The CHANGELOG entries for 2.4.4 and 2.4.5 are back
under their own headings.

## v2.4.9 (2026-09-17): OpenRouter is a provider, and any list can be searched by typing

OpenRouter is now the fifteenth provider. One key reaches models from nearly every vendor,
and Mindweave lists every one of them that can run an agent turn, which today is about 280.
Nothing about those models is guessed: the price, the context window, whether a model can
see images and which reasoning levels it accepts all come from OpenRouter's own catalogue.
A model that always reasons gets no option to switch reasoning off, because OpenRouter
rejects that request. Free models are listed and marked as free. Batch-only entries,
OpenRouter's automatic routers and "latest" aliases are left out, because they either fail
on first use or quietly change which model you are paying for. The catalogue is saved
between runs and fetched again after six hours, so `/model` opens straight away.

OpenRouter model ids are stored with their own `openrouter:` prefix. Some ids exist on more
than one provider, and without the prefix picking `openai/gpt-oss-120b` on OpenRouter would
have run it on Groq instead. By default OpenRouter may send prompts to hosts that store or
train on them, and Mindweave says so when you switch to it. Set
`MINDWEAVE_OPENROUTER_DATA=deny` to use only hosts that do not.

Every picker can now be searched. With `/model`, `/continue` or any other list open, type
and the list narrows to the rows that contain every word you typed, in any order. Backspace
edits what you typed and closes the list once there is nothing left to delete. `/model` also
takes words directly: `/model openrouter deepseek flash` switches provider and model in one
go, and when several models match, the list opens showing just those instead of printing
every name.

A provider failing on its own side no longer shows up as a red crash like
`API error 502: ERROR`. Once the retries run out it now reads as a notice naming the model,
saying the problem is with the provider and not your key or setup, and suggesting you try
again in a moment or choose another model with `/model`. A failure reported part way
through a reply, which a provider can send after the response has already started, used to
be recorded as a finished reply. It is now treated as the failure it is, and any text that
already arrived is kept and marked incomplete.

## v2.4.8 (2026-09-16): the transcript stays put while you're reading it

Scrolling back to read while a reply was still streaming in used to drift toward the
newest line on its own, with no wheel touched. The scroll position was stored as a
distance from the newest line, and every line a running turn appended moved that point
further down, so holding the same distance actually slid the view toward the new
content instead of holding still. It now holds the exact rows you were looking at as
the transcript grows underneath them, the way it already did across a terminal resize.

The chip that appears when you're scrolled back now says "Catch up" instead of naming
where it takes you.

## v2.4.7 (2026-09-16): pasted images reach the model by name again, and file reads count lines correctly

An image you paste or drop in shows up in the input as a short handle like `mwimg5`, so a
long path does not bury what you are typing. Since v2.4.0 that handle was also what the
model received as the image's name. It names nothing on disk, so a model asked about the
picture could end up looking for a file called `mwimg5.png`. The model now gets the real
file name, plus a line saying where the image lives. Once an old image is cleared from
context to save room, the note left in its place keeps that full path, so the model can open
it again with `view_image` instead of asking you to attach it a second time. Your chat still
shows the handle you saw while typing.

`read_file` counted one line too many in nearly every file. The final newline was treated as
the start of an extra, empty line, so files showed a blank last line that is not there, line
totals were off by one, and asking for the line just past the end returned a blank line
instead of saying the file had ended. An empty file came back looking like a file with one
blank line in it. It now says the file is empty.

A background command that finished while a menu was open could start a turn underneath it.
With `/continue` open, picking a session at that moment would swap out the session the turn
was still running on. A finished command now waits until the menu, `/mcp`, `/key` or any
other open screen is closed, and is reported as soon as it is.

`/context` now shows what is actually filling the context window: the system prompt and
tools, tool results, tool call arguments, the model's replies and your messages, with the
heaviest tools named and how much `/compact` could free without a summary. Figures the
provider reported are shown as they are, and estimates are marked as estimates. The project
summary it used to print is still there as `/context project`.

When a command prints more than fits, the start and the end are shown as before, but the
full output is now kept in a file and the model is told where. Previously the middle was
thrown away, so the only way back to it was running the command again, which is not always
possible. The model is also told that older tool results are cleared as a session grows, so
it writes down the details it will need later rather than expecting them to stay.

Saved memories that are months or more than a year old are now marked that way in the
memory index, so older facts are treated with more caution. Recent memories are unchanged.

## v2.4.6 (2026-09-14): a finished background command is announced once, and work can be checked by something that did not do it

A command left running in the background used to be reported to the model again on every
single step of a turn. It was drained once and then re-attached to the end of every
request, so a `cargo check` that exited an hour ago kept arriving as fresh news. In a real
session that cost 19 of 37 steps: the agent kept stopping to re-explain one finished
command while doing unrelated work in between. It is now delivered once, becomes part of
the conversation like anything else, and a command that finishes mid-turn is reported at
the next step instead of waiting for the turn to end. Each report also carries only what
the command has said since it was last mentioned, rather than repeating output you have
already seen.

Finishing non-trivial work can now be checked by a separate agent that did not build it.
It is read-only, it is told to try to break the change rather than confirm it, and it has
to show the command and the output behind every check it claims — a pass with nothing to
back it is recorded as unverified rather than taken at its word. It reports pass, fail or
partial, and after a pass the agent re-runs a couple of its commands to confirm they say
what was reported. Closing out a run of tasks without any checking in it is now a prompt
to do this, at the moment the work ends rather than as a rule read at the start.

Also fixed: a retry that backed off before trying a token refresh again could, in the
right conditions, wait forever instead of resuming.

## v2.4.5 (2026-09-14): sign in to remote MCP servers, and /mcp redesigned as two panes

Mindweave can now connect to hosted MCP servers, not just local ones. A server that answers
401 leads with "Sign in" instead of a dead end: approve it in your browser, come back
connected. The whole thing runs inside the `/mcp` box itself. Nothing is printed to the
transcript, and the authorize link only ever appears if the browser did not open, offered
as something to copy rather than read. Tokens are stored separately from your own config,
refreshed automatically, and only cleared when they are actually dead. A dropped connection
or a slow server never signs you out of something that still works.

`/mcp` is rebuilt around two panes sharing one box: your list of servers on the left, and
whatever you are doing to one of them on the right, whether that is adding a server, editing
one, or signing in. The list never moves when the right side opens. Picking a transport is
no longer its own step before you are asked to type the command; the two are one field now,
with the one you are not using left as a greyed-out example. The tab bar stays in the same
place on every screen, and every key is an arrow: left steps back and takes you all the way
out from anywhere, right and down move forward, Escape is reserved for closing the box.

A couple of longstanding rough edges went with it. Pasting a line that starts with a slash
command used to get mistaken for a dropped file path and silently rewritten, so `/mcp add
...` from a saved snippet was never actually run. And exiting while a picker or a turn was
open could leave the terminal's cursor stranded mid-frame, so the next few things you typed
printed over the conversation instead of below it.

## v2.4.4 (2026-09-12): a long command shows it is working, and the header stops catching stray rows

A running command now counts up beside it, so a build or a test that takes minutes reads
as working rather than hung, and the same live count rides the background bar for anything
running there. Its timeout reads as a duration too, `10m` or `1m 20s`, instead of a raw
`600s` you had to divide in your head.

A brief flicker came in with that count. It was flashing on every read and write that
finished in a blink, so a burst of tool calls stuttered. The count is now only on actual
commands, where a live clock means something, and the screen is steady again.

Rows that produce output, a command or a web lookup, keep their blank line from the moment
they start, instead of hugging the next row while they run and springing apart the instant
their output lands.

When Mindweave asks you a question, you can read it. A long option no longer trails off the
edge of its row: the one you are on shows in full below the list, wrapping down. Every
question also carries a "write my own answer" row, so when none of the options is quite it
you say the real thing instead of picking the nearest wrong one, and it comes back to the
model as your own words rather than a choice. The options are also asked to carry a short
"(recommended)" or "(simplest)" where they trade off, so you can decide without
reverse-engineering the difference.

After a long piece of work, the wrap-up is as long as the work earns. Finishing a task was
capped at a few lines, which is right for a one-line fix and wrong for a session that made
real findings across an hour. Those now get the outcome first, then the findings and
decisions that matter, then what is verified and what is still open. A small task still
closes in a line; the length follows the work, not the clock.

The pinned header, and the rule under it, stop catching a stray transcript row. Scrolling,
or a new row appearing at the bottom, can move a line out from under the renderer's model
of the screen, and because the renderer only repaints what it believes changed, that stray
line could sit on the header or its separator until something else redrew it. Both of those
moments already repaint almost everything on screen, so the header and its rule are redrawn
with them now, and the glitch is gone.

## v2.4.3 (2026-09-11): a background command that hangs no longer waits out the timeout

A command sent to the background used to run unwatched: you were told when it finished
and nothing before that, so one that wedged sat invisible until it hit its timeout,
minutes later. Mindweave now watches a backgrounded command while it runs. If it goes
quiet and its last line reads as a question waiting for the keyboard, you are told it is
likely blocked on input and to re-run it non-interactively. And a command that was meant
to finish but has printed nothing for a long time is flagged as possibly stuck, with its
recent output to judge it by, so you can read it or stop it instead of waiting on a
deadlock. A server going quiet is left alone, because that is its normal resting state
rather than a stall.

## v2.4.2 (2026-09-11): screenshots see windows that have no title bar

The screenshot tool could not capture an app with a custom title bar. A window with its
OS decorations turned off, which is normal for desktop apps built on web tech, reports a
blank title, and the tool was dropping every untitled window before it could be listed or
captured, by name or as the focused one. Untitled windows are kept now and labelled by
their app, and the list uses the same test the taskbar does for which windows count, so
hidden and background ones stay out of it.

It also no longer waits several seconds for a named window that is not there. That wait
stalled on every mistyped name and did not even help the case it was built for, since a
window whose title has not loaded yet cannot be waited into existence. If the app is still
coming up the tool says so and you call again, and when a title does not match it points at
the path that works: leave `window` out to capture whichever window is focused.

## v2.4.1 (2026-09-11): DeepSeek V4.1 Flash, and lists that put your keys on top

DeepSeek's default is now V4.1 Flash, and it reads images on its own. The separate
vision model is gone, folded into Flash, so a screenshot you attach works on the model a
fresh project already opens with, and a saved selection of the old vision model moves to
Flash by itself. Prices are updated to V4.1's.

V4 Pro is still offered until DeepSeek routes it into V4.1 Flash on September 14. After
that it drops out of the picker on its own and a saved Pro selection resolves to Flash,
so a build installed before the date stays right after it with nothing to reinstall.

The provider, key and model lists stopped making you hunt. With fourteen providers, the
two or three you actually have a key for were scattered down a list you had to scroll
through. Now the default comes first, then the providers you hold a key for, then the
rest, each part alphabetical. A provider's models read the same way, its own default
first and then alphabetical. `/provider`, `/key` and `/model` all follow it.

## v2.4.0 (2026-09-10): scroll without losing the prompt

Both shells let you scroll back now with the prompt staying put. The inline shell pins
it while you scroll (wheel, PgUp) and drops back to normal the moment you reach the
bottom. `/screen` picks between the two instead of toggling, with inline marked beta,
because it takes the mouse and the terminal's own scrollbar and selection stop while it
is up. Scrolled up in fullscreen you get a jump-to-bottom chip: click it, or press
ctrl+End.

The fullscreen frame reaches the bottom edge. On Windows it floated above a band of dead
rows, because the terminal size came from a value the console caches and rarely refreshes.
It reads the live size now and fills the screen.

Ctrl+C copies your selection instead of quitting. Drag, copy, done, with no session ending
under you; nothing selected still quits. Selected text is one clean colour too, not a red
block over an error line and a cyan one over a hint.

Lighter on memory. A language server used to spawn on the first symbol lookup and hold its
whole index for the rest of the session, hundreds of megabytes sitting idle most of the
time. Idle servers shut down and respawn on demand now, and V8 is told to favour a smaller
footprint.

The terminal tab says Mindweave. GPT-6 Astra is available under OpenAI.

Menus got a pass: `/key` fills its box with its row numbers lined up, `/continue` reads as
a table with the times pinned right, and a long option description wraps below the list
instead of being cut off. Plus a stack of rendering fixes: resizing no longer flashes
half-drawn shapes, switching shells no longer lands on a blank screen, quitting no longer
prints the shell prompt over the conversation, and a first-run crash that could blank the
screen the moment a key was accepted is closed.

## v2.3.1 (2026-09-05): a count of how many people are running it

Mindweave has no account and no server of its own, which meant nobody could answer the
simplest question about it: whether anyone is using it. This release adds the smallest
thing that answers that. Once at startup it sends a random identifier and the version
number, and nothing else. Not code, not keys, not paths, not which provider answered,
not a token count.

It is on by default and says so on every launch rather than once, because a notice shown
a single time is one somebody scrolls past and then discovers months later. `/analytics`
opens the same fixed box every other setting uses, with the switch and, underneath it,
what is actually sent and where to check both halves of that claim: the source that
sends it, and the public numbers it produces. `/analytics on` and `/analytics off` still
work for anyone who would rather type than pick. The identifier is generated once and
kept in `~/.mindweave/analytics.json` beside the flag, so turning it off is a fact on
disk rather than a preference that quietly resets. The address it reports to is a single
constant, overridable with `MINDWEAVE_ANALYTICS_URL`, so what sits behind it can be
replaced without the client changing.

The picker gained a place for text that belongs under the choices rather than in the
title, counted into the same fixed height budget so the box still never resizes as its
contents change. And the keyboard hint got a second space after the backspace glyph,
which renders wide enough in most terminal fonts to collide with the word after it.

You can see the results into the website so to check how many users are using the tool.

https://mindweavedev.netlify.app/

## v2.3.0 (2026-09-04): `/update`, a screen that stops tearing, and resumed sessions that look like the ones they resume

`/update` takes the newest release and reopens on the conversation it left. It resolves
the prefix from where this copy actually sits rather than asking npm where global
packages go those two disagree often enough that trusting the second either fails on
permissions or, worse, succeeds: a fresh copy installed somewhere the `mindweave` command
does not look, reported as done, leaving the old version running with nothing on screen
to say so. A working tree, a linked install and another project's dependency are refused
outright and handed the command to type instead, because `npm i -g` over a source build
silently replaces the work in it.

The restart is the point rather than a convenience. Driver modules load on demand, so a
copy that rewrote itself mid-session would be an old process reading new files, which
fails later and somewhere else. The old process stays alive only to hand the terminal
over in a defined order alternate screen left, mouse reporting off, cursor and autowrap
restored, stdin out of raw mode and to pass the exit code up, so the shell that started
it sees one process from beginning to end. A version that cannot start is reported as
such, with the command to go back.

A stray newline could reach the terminal, and one written on the bottom row scrolls the
whole screen up a line. The renderer draws only the cells it believes changed, so every
row afterwards was painted somewhere it was not the banner ending up half beneath a
tool row, a character of "Mindweave" surviving under a filename. Writes that carry no
printable content are still forwarded, because that is how the alternate screen is
entered and the cursor hidden, but the test now asks whether anything is left rather than
trimming first, and a write that is nothing but control characters is dropped. Vertical
position here is decided entirely by absolute cursor moves; a newline from anywhere else
can only move the screen out from under the model of it.

Two more sources of the same corruption are closed. Autowrap is switched off while the
app owns the screen, so a row one column too long is clipped at the margin instead of
continuing onto the next one and pushing everything below it down. And a tool header
counted its own width without the qualifier it then appended, so every command with a
timeout built a row wider than the terminal.

A resumed session now redraws the rows it is resuming. The fields that decide how a row
looks are recorded with its result, and several were not: whether a block of text is a
diff, so every edit came back as plain dim lines with its green and red gone; whether a
row was hidden, so a session filled with rows the tool that produced them had suppressed;
a command's timeout; and the name and colour a result gives itself, so a red "Build
Error" returned as a routine "Check". The two sites that build a row the live stream
and the replay — are now checked against each other from source, since listing the fields
would only move the problem to the next one added.

Dismissing a question stops the turn. `ask_user` used to tell the model to "proceed with
the most reasonable default" when its question was closed unanswered, and the model duly
announced a choice a moment after the person had declined to make one. Closing a plan
was read as rejecting it, which attributed a verdict to someone who had given none. Both
now end the turn the way Esc does, because someone who closes a question is reaching for
the keyboard, not waiting to see what gets decided for them.

A command's output is shown as a result rather than as a log. The verdict sits beside the
command with the time it took, not at the bottom of however many lines came out. Repeated
column chrome — job names, timestamps — is removed before anything is counted, so the
budget is spent on what was said rather than on text identical from line to line. What is
kept is the END of the output, since that is where an error is, and it is capped: three
lines for a command that worked, twelve for one that did not. A recognised test run
collapses to its counts and the first few failures, and a green run to a single line;
anything not recognised falls through to the ordinary block, whole.

Gemini 3.8 Flash is available and is the Gemini default. It costs what 3.7 Flash costs,
carries the same promotional rate ending 2026-12-31, and takes the same three-rung
reasoning dial.

The `diagnostics` tool is gone. Every edit already returns the language server's errors
for the file it changed, so a separate call for the same answer only added a row that
hid itself when it found nothing and a hidden row between two things the agent said
fused them into what read as two closing statements.

A turn that is re-opened to verify no longer ends twice. Finishing without running a
check prompts one, and the reply written before that check is dropped rather than left on
screen above the one written after it.

Smaller things. The caret no longer hides the character being typed when a line fills the
box exactly. A failure is marked with a glyph one column wide, like the tick beside it,
rather than one terminals draw as two and paint over the space after. A read of several
files counts files instead of calls and names them. A block with output keeps its blank
line, so one command's last line no longer touches the next command's header. A
screenshot whose window was chosen between identically titled candidates says so, and
says what would choose differently.


## v2.2.1 (2026-09-03): a symbol search that waits for the index, and Muse Spark's reasoning dial

Asking for a symbol could return nothing while the answer was still being computed.
Opening a document is a notification — it returns as soon as it is written, while the
language server is still reading — so a symbol query sent immediately after was answered
honestly and emptily. That reached the caller as "no such symbol" rather than "not
indexed yet", and the fallback to tree-sitter that followed looked like a deliberate
choice. The query is now retried while an empty answer might still be a cold index,
bounded and paid at most once per server, and only when that call actually opened
documents: on a server already asked and answered, an empty result is the real one.

It showed up as a language server failing to resolve a Python symbol on a four-core
machine while the same commit resolved it everywhere else, which is the shape this kind
of race always takes — a wait tuned on a fast machine, holding until something slower
runs it.

Muse Spark has a reasoning dial and this driver said it did not. `reasoning_effort`
accepts `minimal` through `xhigh` on Meta's Model API; nothing was sent, so every call
reasoned at whatever depth the provider picks when the field is absent, with no way for
anyone to steer it. `/think` now offers three depths, and the request always states one.

There is still no rung that skips reasoning, because the model cannot: `none` is the one
value the API refuses outright. A configuration carried over from a provider that can
answer directly is corrected rather than sent, and so is `max`, which this API has never
heard of.


## v2.2.0 (2026-09-03): a fourteenth provider, five new models, and a reasoning dial that was there all along

Tencent's Hy models are available, through TokenHub's international endpoint with a
`TOKENHUB_API_KEY`. Hy3 leads the lineup and hy4-preview sits beside it: the preview
costs about six times as much per input token, and a provider whose default is the
expensive preview picks a bill on someone else's behalf. Both take a reasoning dial with
a genuine off position — thinking off, brief, or full — and thinking is switched off
explicitly rather than by omission, because the provider's own default is to reason and
bill for it. An account on the mainland console, which serves the same weights under
different model ids, sets `MINDWEAVE_TENCENT_URL` and picks the id that console lists.

Claude Fable 5.1 and Muse Spark 1.3 are offered. Fable 5.1 costs what Fable 5 costs to
send and reads back from cache at a quarter of the price — 2.5% of base input, where
every other model on that surface reads back at 10%, which is most of the bill for a
loop that re-sends its prefix on every step. Muse Spark 1.3 ships at 1.2's rates on both
tiers and takes the default. The superseded models stay listed at their own prices, so a
saved configuration naming one keeps working.

GLM-5.3 Flash offers all three of its reasoning depths. It had one rung, pinned to the
deepest setting, on the reading that it documented a single effort value; it documents
`low`, `high` and `max`, and `max` is only what a request falls back to when the field is
absent. A session on it therefore reasoned at its most expensive setting for every step
of every turn — including the steps that were a file read — with nothing for the user to
turn down. Thinking still cannot be switched off on that model, so no rung claims to.

An `.env.example` file is no longer treated as a secret. It is committed on purpose, it
holds variable names and placeholder values, and refusing it withheld a project's own
account of its configuration while protecting nothing. A shell command naming one
alongside ordinary files was refused whole. The live files — `.env`, `.env.local`,
`.env.production`, `prod.env` — are unchanged, as is anything that merely begins like a
template.

Taking a screenshot no longer interrupts an auto-accept session. The capture asked for
confirmation in every mode, which made one tool the exception to a mode chosen to stop
confirming. A guarded session still approves the specific window by title before anything
is captured, and a context with nobody to ask — a sub-agent, a non-interactive run — is
still refused outright in every mode.

Where a prompt cache broke, and why, can now be recorded. Setting `MINDWEAVE_CACHE_LOG`
to a file writes one line per model call: which call, the gap since the previous one, how
much of the prompt was served from cache, and which part of the request moved if any did.
The detector behind it already ran on every call and its answer was discarded, so a break
was still only findable by reading a session file after the fact. A zero cache hit with a
reason named is a prefix that moved; a zero hit with nothing changed is a cache that
expired, and the two want different fixes.


## v2.1.4 (2026-09-03): a first run that survives its own key, and tool rows that arrive one at a time

Adding an API key on the setup screen and pressing Continue blanked the terminal. The
screen that asks for a key returns before the rest of the interface is built, so the
first render that reached the chat declared one more React hook than the render before
it, which is a condition React treats as fatal and takes the whole interface down for.
Starting Mindweave again looked fine, because a machine that already has a key never
opens that screen, and the count never changes. The hook is declared above the screens
that return early, and a test now fails if another one is added below them.

Tool rows arrived in bursts. A turn read calmly, waited while the model composed, and
then dropped five or eight rows and their comments into a single frame. Two things
caused it. Calls issued together were revealed together: the reveal step assumed a
call's result followed its own start, and when several ran at once it swallowed the
whole batch into one paint. And the pause between blocks was measured from the last
one revealed, so a model that had just spent a minute thinking produced no pause at
all — the turns that most needed spacing were the ones that got none.

Blocks now appear one to a beat, at the same tempo, whatever a turn contains and however
much of it: two tools and eight hundred look the same. The pause is time added to
whatever the model took, not a minimum since the last block, so the rhythm never becomes
a report on how fast the provider is answering. Esc still releases everything held.
`MINDWEAVE_REVEAL_GAP_MS` sets the interval, and `0` restores the previous behaviour of
painting each block the moment it exists.


## v2.1.3 (2026-09-01): the release name everywhere, including mid-turn

The bar shown while a turn is running still read the raw package version. It is
the one surface in the interface with no room to spare for a number nobody reads
it for there the exact version is a keystroke away through `--help`, and whether
it is current is what the update-check note already answers. It reads the release
name alone now, the same one the first-run screen and `--help` already lead with.


## v2.1.2 (2026-09-01): naming the release, and a quiet check for a newer one

The first-run screen and `--help` both said only "Mindweave", with the bare package
version beside it, naming neither the release most people would recognise it by.
Both now lead with "Mindweave 1"; the exact version stays in parentheses for anyone
who needs it. `--version` is unchanged: it stays one parseable line for a script,
which is a different contract from a person reading `--help`.

There was no way to know a newer release existed short of checking by hand. On
startup, in the background, a session now reads the one version currently tagged
latest on the registry the same request `npm install` itself makes and says so
if it is newer than what is running. Nothing describing the session leaves the
machine: no identifier, no payload, nothing that turns this into the telemetry the
project promises it does not have. The check is cached for a day, fails silent on
every path so a slow or unreachable registry can never delay the first prompt, and
`MINDWEAVE_NO_UPDATE_CHECK` turns it off outright for anyone who would rather no
request happen at all.

## v2.1.1 (2026-09-01): a terminal it can read from, and a suite that passes on a clean clone

Mindweave draws an interactive screen and reads keystrokes, which needs a terminal to
read from. Started without one — through a pipe, a redirect, or a wrapper that provides
no console — it printed a stack trace through React and renderer internals, naming files
inside node_modules and nothing that could be acted on. It then exited 0, so a script
that ran it was told the run had succeeded. It now says what is missing and what to do,
and exits non-zero. `--help` and `--version` are answered before any of this and still
work wherever they are called from.

Three screen tests read rendered frames with the colour codes left in them. Styling sits
between the characters of a phrase, so text the screen displays plainly was not found,
and one test measured row width with the escape byte still counted, reporting rows two
columns wider than they draw. They passed wherever colour happened to be off, which
includes the integration runners, and failed in an ordinary terminal: a clone and
`npm test` reported three failures the project's own checks never saw. The frames are
read with the codes removed, so the result no longer depends on colour at all.

Two test files were listed nowhere. The test script names its files one by one rather
than matching a pattern, so a file that is not named is silently never run; the
block-spacing probe and the working-verb tests, eight assertions between them, were
present in the repository and providing no protection. Both run now.

The contributing guide described a feature freeze ahead of a release that has already
happened, so the first thing a prospective contributor read about the project's
direction was out of date.


## v2.1.0 (2026-08-31): one box for everything the prompt opens

The sections below are ordered by what a user would notice: an interface that stops
rebuilding itself every time a command opens something, a class of tool that could be
found but never called, and a token figure that reported the session when it meant to
report the task.

### Every surface the prompt opens is the same box

The command list, every picker, the key manager and an approval prompt all render in one
box beneath the input, at a fixed size. Opening `/provider` from the command list used to
replace one box with another, and moving between them changed the height of the footer,
so the conversation above it jumped.

The box is now held across the change. A command that opens one of these surfaces has
work to do first, reading the sessions on disk or refreshing the model list, and the input
clears the moment it is submitted; between the two there was a render with nothing to put
in the box, so the box unmounted and its frame left the screen and came back. The frame is
kept from the submit itself, and only its contents change.

Nothing inside it resizes either. Each surface pads or scrolls to the box's height rather
than growing, and the rows that used to say `↑ 8 more` are gone, since they appeared and
disappeared as the ends of a list were reached and changed the height doing it. The
position is on the title row instead, as `3 of 9`, which cannot resize anything. The hint
line sits on the bottom row of the box at every level of every surface.

### Backspace leaves what it opened

Escape was the only way out of a picker or the key manager. Deleting what was just chosen
is the instinctive way back, and a screen that ignores it reads as frozen. Backspace and
Delete now step back one level wherever a list is showing, and the hint says so. Inside
the field where a key is typed they still belong to the text.

### The provider, model and key screens say more

`/provider` names the model actually running on the provider you are on, which was the one
thing the screen could not tell you. `/model` leads each row with the size of the model's
context window and whether it can read an attached image, ahead of the prose, because the
row truncates from the right and a narrow terminal is where those two facts matter most.

### A tool that could be found could not be called

Tools that are not advertised up front are discovered through `find_tools`. Finding one
returned its schema but did not add it to the tools sent with the next request, and a
model that will only call a function present in that list therefore could not use anything
it found. Screenshots, and every other deferred tool, were unreachable on those models.

`find_tools` now activates what it finds: the tool joins the advertised set for the rest
of the session, is written to the session file, and comes back on resume. A forked session
gets its own copy rather than sharing the parent's.

### The live counter reports the task, not the session

The figure beside the working line, and the receipt at the end of a turn, count the output
of the task in front of you. The whole conversation is re-sent on every tool round, so a
running billed total counts the session's context once per round and climbs into the
hundreds of thousands for a task that produced a few pages. That number described the
session, not the work.

The context the model is holding is a separate measurement, and it is the one that decides
when the conversation is summarized. It now has its own notice, which appears as the room
runs out and says how much is left before that happens.

### Background shells

A list of shells that are still running no longer reads as an invitation to check again.
The reply says that a finished shell announces itself, that a server's ordinary running
state is not an event to wait for, and that the turn should end. A shell the user closed
themselves is not reopened for two minutes, so closing something is not immediately undone.

### Format-Table was refused as an attempt to reformat a disk

The pattern guarding against destroying a filesystem matched the word `format` anywhere in
a command, so PowerShell's display cmdlets — `Format-Table`, `Format-List`, `Format-Hex` —
and even `git log --format=…` were blocked. It now matches `mkfs`, `format` applied to a
drive or a switch, and the cmdlets that actually erase a volume.

### GLM-5.3-Flash reads images

The GLM driver declared no vision support, so an image attached while it was running was
dropped before the request was built. GLM-5.3-Flash takes image input on its own id
through the ordinary request shape, and is now declared as such. The other GLM models
remain text-only, and an image pointed at one is still dropped rather than sent.


## v2.0.2 (2026-08-27): key and provider fixes

Choosing a provider with `/provider` that has no key yet now opens straight on the field
for that provider's key. It used to reopen the full provider list, so the provider just
chosen had to be picked a second time before the key could be typed.

A key added or changed through `/key` or `/provider` is written to `~/.mindweave/.env`.
When that file already held the variable written with an `export` prefix, or indented,
the update could not find the existing line and wrote a second one below it. The config
reader accepts both of those forms and keeps the first value it reads, so the old key won
again on the next launch and the change looked lost. The line is now found the way the
reader reads it, so an update replaces it in place and a removal takes it away. Removing a
key no longer leaves a blank line behind.


## v2.0.1 (2026-08-27): GLM-5.3 and GLM-5.3-Flash are now supported

GLM-5.3 and GLM-5.3-Flash are offered by `/model`. They were left out when the driver
was written because they existed only behind a subscription with no per-token rate, and
a driver that cannot describe what a call costs should not offer the call. They are on
the pay-per-token endpoint now, so they are listed with real prices.

Both of them think unconditionally: the provider documents no way to turn reasoning off
on either. Every other model on this driver can, so the reasoning menu now branches
rather than offering a setting that would be refused, and a configuration carried over
from another model is corrected instead of being sent.


---

## Mindweave 1 (2026-08-27), tagged `mindweave-1`

Everything since v1.9.9 (2026-08-09), covering 69 commits made between 16 and 27
August. This release is named rather than numbered; the package version at the tag is
2.0.0.

It is a large stretch of work and the sections below are ordered by what a user would
notice, not by when it happened: two commands that never ran, two new ones, the queue
becoming reversible, an interface that stopped narrating itself, and underneath all of
it eleven more model providers and a rebuilt terminal.

### /mcp add and /mcp remove never ran

The guard routing those sub-commands read as a word-boundary pattern and held a stray
control byte where the escape belonged, so it required a control character to be typed
and never matched anything. Every `/mcp add` opened the server-health view instead,
while the command advertised itself in its own help text. The code behind it was correct
and covered by tests; only the route to it was dead.

Command routing now lives in one place as data rather than a pattern, and is tested. The
eighteen built-in commands had no coverage before this, because the routing was a chain
of conditions inside a view component with nothing to call. A test also holds the command
list and the handlers together, so a command cannot be advertised with nothing behind it
or work while appearing in no list.

### Two new commands, and arguments that are no longer discarded

`/clear` starts a fresh conversation without leaving the folder; until now the only way
was to quit, or to take the third option in the session picker. `/init` has the model
write MINDWEAVE.md, the file loaded into context every turn that nothing had ever been
able to create.

`/model`, `/think` and `/compact` accepted an argument and threw it away in silence.
All three take it now. A name that is ambiguous or unrecognised is refused with the real
options rather than resolved to the nearest match, because the wrong model is billed on
the next turn. A `/compact` focus is additive and says so in the prompt: that summary
replaces the older conversation, so a focus read as a narrowing instruction would
destroy the rest of it permanently.

Starting a fresh conversation also stopped quietly shrinking the workspace. Folders added
with `/include` or `/link` were dropped, so every tool silently searched one folder
instead of several, and undo history went with them even though the files stayed edited.

### Messages queued while it works can be taken back

Typing while Mindweave is working queues the message, and that was a one-way door.
Pressing up looked like editing the queued message but replayed it from history, leaving
the queued copy live, so editing and sending produced two messages. Up, or escape,
now pulls the whole queue back into the input as editable text; clearing the box is how
a queued message is cancelled. Escape during a turn still means stop and leaves the queue
alone, so one key never carries two decisions. Consecutive queued messages are sent as a
single turn rather than one turn each.

### The interface stopped talking about itself

Every turn printed lines about the tool's own housekeeping — which prompt cache had been
invalidated, that a checkpoint had been sealed, how close the context was to a
compaction, that a background command had started and then been stopped by the person
who stopped it. None of it was news, several fired more than once a turn, and together
they crowded out the work. What survives is the small set that reports something wrong
and actionable.

Prose between tool calls is no longer capped at one block per turn. The cap could not
tell a repetitive model from a sparing one, so against a model that narrates rarely it
only guaranteed silence for the rest of a long turn. Each block is still trimmed, which
is what bounds the wall.

A shell command reads as `Run(npm test)` now, the same shape as `Read(index.ts)`,
instead of a sentence with the command on a row beneath it. Output no longer waits on a
three-second beat before appearing: an earlier version held every block back on the
theory that a visible pause reads as deliberate work, and in use it read as an animation.


### Forbidden paths now cover every folder in the workspace

v1.9.9 recorded the opposite, and it was accurate at the time: patterns were measured
only against the project you opened, so a rule refusing a folder did nothing in one
added with `/include` while still being listed and still appearing to be in force.
Paths are now measured against every root in the workspace.

Matching also became case-insensitive. Windows and macOS filesystems are, so `.env` and
`.ENV` are one file, and a case-sensitive comparison let the second spelling past a rule
written with the first.

### An image can reach any model that reads one

The shared transport used by eleven providers had no way to send an image at all. The
field carrying one was ours, spread onto the request untouched, so a provider saw an
unknown key and the bytes never left the machine. A request built that way looks
perfectly well formed, which is why nothing caught it. That transport emits proper
multimodal content now, and every provider on it inherits that.

Whether a given model can actually read an image is a fact the driver declares rather
than something assumed. Point a picture at one that cannot and Mindweave says so,
instead of sending the message with the image quietly dropped.


### The project's notes grew three layers

MINDWEAVE.md is what makes a new session continue rather than start over: it is loaded
for the agent every time, and the agent maintains it. It was one file at the project
root, read whole, which works until a project has more to say than fits on a readable
page. Then it is either too long to keep accurate or too short to be worth loading.

**Imports.** A line containing `@./docs/architecture.md` pulls that file in as part of
the notes. They nest five deep, a cycle stops instead of hanging, and an `@` inside
code or backticks is left alone, which matters because a notes file is exactly the
document that mentions `@scope/package` and decorators. An import naming a file that is
not there is reported rather than silently dropped.

**A personal layer.** `~/.mindweave/MINDWEAVE.md` applies to every project on the
machine, for what is true of how you work rather than of one codebase. The project's
notes are read after it, so where the two disagree the project wins.

**Notes for a folder.** A MINDWEAVE.md inside a directory describes that directory and
is given to the agent only while it is working on files there. A convention that is true
of one area costs nothing everywhere else. These arrive in the volatile part of the
request rather than the cached prefix, so moving between folders cannot invalidate the
cache.


### Eleven more providers

Mindweave shipped the 1.x line with two. It now speaks to thirteen: DeepSeek, Anthropic,
OpenAI, Gemini, xAI, Mistral, Groq, Cerebras, Qwen, Kimi, GLM, Meta and MiniMax, across
47 models. Each family keeps its own driver, so a provider's quirks live with that
provider and never leak into the shared core, and only the driver you are using is
loaded. Mindweave also identifies itself to every provider now, rather than arriving
anonymously.

### The terminal interface was rebuilt

It runs on its own screen instead of scrolling your history away, with a pinned header
and footer and the whole conversation scrollable behind them.

The changes underneath were mostly things that had been quietly wrong. Resizing could
fuse an old frame onto the new one, because the screen was repainted without being
erased first. Prose was capped narrower than the window, so a maximised terminal wasted
half its width. The conversation and the input box could end up flush against each other.
Diffs and shell output were hard to tell apart at a glance. The input box lost its border
in one revision and got it back. The caret is a blinking bar rather than a static block,
which is the difference between a cursor and a rendering artifact.

A terminal left in a bad state by a crash is also repaired on the next launch, rather
than leaving every scroll writing escape codes into your shell.

### Prompt caching, token accounting, and the tools

The cacheable part of a request was being invalidated by things that did not need to
touch it, so a conversation paid to re-send its own prefix. Reworked, along with how
tokens are counted and reported.

Reading and searching changed shape. A whole-file read that is too large now answers with
the file's structure instead of a truncation, so the model can ask for the part it wants.
A read of several files with a line range no longer drops the files the range did not
apply to. Symbol ranking was deleted outright after measuring zero uses across 774 calls.
Twenty-two copies of "this tool failed" became one. And a model mistyping a tool call no
longer paints a red row: it is told what was wrong and writes the call again a moment
later, which is not news, and training people to skim past error rows is how the ones
that matter get missed.

### The first run

The path a new user takes had never been audited, and it had five dead ends. A key for
any provider except the default one left you stuck on a prompt with no way past. The
config template listed two providers of thirteen. A wrong key could only be fixed by
finding and hand-editing a file, because none of the commands could replace one. Escape
could not leave the key field. Scrolling the wheel while typing a key corrupted it.

What replaces it: a trust prompt that asks once per folder and says plainly when the
folder is an entire drive, a provider list you can add as many keys to as you like, and
`/key` as a real manager, three levels deep, where you can show, switch, edit or remove
any key for any provider. The screens are centred and carry a welcome, the version, and
four things worth knowing while you are pasting a key.

A second screen that asked for a key you had already entered was deleted.

### Plan mode, permissions, and sub-agents

An approved plan now actually ends, and can start the work from a clean slate while
keeping the planning conversation. Two approval questions can no longer cancel each
other. A permission answer grants what it was asked about rather than everything of that
shape, and a sub-agent no longer inherits a grant you gave in person about different
work. A sub-agent also stopped paying for session notes that nobody keeps.

Switching provider mid-session no longer lets one vendor's opaque data reach another.

### The governor

A scoped rule is decided when a file is touched, not when the prompt happens to render,
which is what makes a rule reliable rather than incidental. The governor re-reads its own
files when they change on disk. Standing rules stay in force across a summary and inside
an added folder. Two ways round the file protections were closed: a deny list that
ignored case, so `.ENV` walked past a rule written for `.env`, and a floor that missed
`prod.env` and `.envrc`.

### A saved session says which model answered it

The model is written into the session record. It was previously visible only inside the
per-call cost breakdown, which is kept only once a session has spent something, so most
sessions carried no attribution at all.

It earns its place for the same reason the cost breakdown does. Without it, a question
of the form "did this behave differently, or was it a different model?" cannot be
settled from anything on disk.

### Durability

A long session holds together across a summary. A provider blip is survived rather than
losing the turn. A dropped connection keeps the reply you had already seen. Sessions are
written the same careful way files are, so a crash mid-write cannot leave a truncated
one, and a restore puts a file back with the same care. A failing tool can no longer take
the whole session with it, and a saved memory can no longer become unfindable.

### MCP

Requests now mirror the body fields Streamable HTTP requires into headers, which is what
some servers check rather than the body. A tool call is carried through however many
round trips a server asks for, instead of being abandoned after the first.

---

## v1.9.9 (2026-08-09): the last three audits

Compaction, session resume, and the governor were the only parts of the core never
read end to end. They were left for last because none of them fails loudly: a bad
summary replaces a session's history with something wrong and the model carries on as
if it were true.

Six defects, none of which could throw, all of which type-checked and passed the suite.
Two were sitting under comments describing the safeguard that was missing, which is why
reading the files had not been enough.

### A refused summary could replace the conversation

Before the older transcript is thrown away and a summary kept instead, the reply is
checked for the ways it can be unusable. It checked one of them. A refusal, a context
overflow, and an overloaded provider all returned text that passed every other check
and became the session's record of itself.

Only a cleanly finished reply is accepted now, so a new failure mode arriving with a
future provider is rejected rather than admitted by omission. A reply is also checked
for the numbered structure it was asked to produce, because a refusal is fluent, long,
and shaped nothing like a summary — length alone could not tell them apart.

### An image could be dropped while the model was still looking at it

Old tool output is cleared on a window that deliberately spares whatever the model has
not acted on yet. Attached images were cleared on a different window that did not,
despite the code saying the two matched, so a screenshot could be evicted while every
result around it was kept.

### A sub-agent inherited "allow all"

In the mode that asks before each action, answering "allow all" applies to the work in
front of you. A sub-agent started afterwards inherited that answer, and since a
sub-agent has no way to reach you, nothing would have asked. It now starts vigilant:
its changes are refused and it reports back instead.

### A rule's file patterns could rewrite the rule

Rules and skills are stored with a small header, and every value written into it is
flattened to one line first, because a line break starts what the loader reads as a new
setting. Every value except the file patterns — the field that decides when a rule
applies. Flattening now happens where the header is built, so a field added later
cannot miss it.

### Forbidding a command could block unrelated ones

Forbidden commands matched anywhere in the text, so forbidding `rm` also refused
`npm run warm` and `npm run format`. They match whole words now, and still match
patterns that begin or end in punctuation such as `--force` or `./deploy`.

### Also

The security policy now states three things it did not: that forbidden paths are
relative to the project root and do not extend into folders added with `/include`
(built-in secret protection still covers every root), that "allow all" is not inherited
by a sub-agent, and how forbidden commands match.

---

## v1.9.8 (2026-08-09): DeepSeek can search the web

Web search is a capability of the model's own provider rather than a service
Mindweave buys, so it worked on Claude models and reported itself unavailable on
DeepSeek. DeepSeek does have native search; it is simply served over a different
protocol than the one used for chat.

DeepSeek now searches. It runs on DeepSeek's own servers, with the key already
configured, and nothing third-party is involved. There is no second key, no account
to create, and nothing to choose: chat continues over the endpoint it always used and
only the search call speaks the other protocol. Moving everything there would have
cost the prompt cache, images, and MCP support, none of which that endpoint carries.

Searching on DeepSeek costs more than an ordinary turn, because their side makes
further requests to summarise what it finds.

This is the pattern for every provider added from here: a provider declares whether it
has native search, and the driver routes that one call over whichever protocol carries
it. Providers without native search continue to say so plainly and point at
`web_fetch`.

### Fixes

**A malformed search result reached the model.** A live DeepSeek search returned a
result carrying neither a title nor an address, which rendered in the source list as
"undefined — undefined". Results without a usable address are now dropped, and a
result with an address but no title is listed by its address.

**`--version` and `--help` now work.** Both flags were ignored: the interactive
session started instead, and without a terminal attached it hung rather than exiting.
They print and exit immediately, which is what a script or a packaging tool expects.

---

## v1.9.7 (2026-08-09): hardening what reaches outside the machine

A review of the tools that leave the machine found that none of them went through a
guard. Every file tool passes through `guard.ts` and every MCP result is framed as
external data; web pages, search results, and screen captures went through neither.

### A redirect could reach a private address

`web_fetch` checked the address it was given and then followed redirects without
checking again. A public URL answering with a redirect to `127.0.0.1`, an internal
host, or a cloud instance metadata address was fetched anyway, and its contents
returned. Redirects are now followed one hop at a time and each destination is checked
before anything connects to it.

The address check itself was thin. It now covers private and link-local IPv6, addresses
written in decimal or hexadecimal to slip past a text match, IPv4 addresses wrapped in
IPv6 notation, and carrier-grade NAT ranges. Redirects to schemes other than http and
https are refused rather than followed.

### Web content is marked as data

Pages and search results now arrive inside a delimited block that says plainly it is
external content to reason about rather than instructions to follow, which is the
treatment MCP output already had. Search results need it most: the model chooses the
query, and whatever answers chooses the words, including page titles that sit next to
a real answer.

This is a boundary the model is asked to respect, not a wall, and the documentation
says so rather than claiming more.

### Screenshots no longer accumulate

Each capture was written to a temporary folder and never removed, so every window ever
photographed stayed on disk indefinitely, holding whatever was on screen at the time.
Captures are now cleared after a retention period, swept at startup so a crash cannot
leave them behind.

### The security policy describes the product again

SECURITY.md gained sections on web content and on screen capture, including the honest
limit: a screenshot can capture a secret that is visible on screen, which the file
tools would have refused to read. The approval prompt naming the window is the control,
which is why it appears every time.

### Both search engines are tested

Search runs on ripgrep when it is installed and a built-in walker otherwise, and a
given machine only ever exercised one of them. The two had already drifted apart once.
The engine can now be forced, and the build runs the search tests on both paths.

---

## v1.9.6 (2026-08-09): approving a plan starts the work

Plan mode could produce a plan and then had no way to finish. Approving one meant
switching modes by hand and asking again for the thing that had just been described,
and the plan itself often arrived in pieces.

### The plan is shown whole

A plan used to be ordinary prose, and prose written before a tool call is treated as
narration: shortened to two sentences, and dropped entirely after the first one in a
turn. That is right for "checking the config now" and wrong for the plan itself, so a
plan composed between lookups reached the screen in fragments.

Plans now come through their own channel and are shown in full, once.

### Approving it is the instruction

The plan arrives with four answers: approve and let it work, approve and confirm each
action, reject, or send it back for changes. Approving starts the work immediately,
in the same turn, following the plan that was just read rather than a version of it
recovered from the conversation.

Approval covers that piece of work and not the session. When the work ends, planning
resumes, including after an interruption or an error. Anything unrecognised coming
back from the prompt counts as a refusal, so an empty or unexpected answer can never
start work.

Decisions that are genuinely the user's are asked during planning rather than assumed.

---

## v1.9.5 (2026-08-09): the agent can look things up, and look at your app

Two things the agent could not do before, and four fixes to how commands are reported.

### Searching the web

`web_fetch` could read a page you already knew the address of. There was no way to
find one, so any question whose answer changed after the model was trained had no
route to an answer: current library APIs, recent releases, whether a package still
exists.

`web_search` fills that in. It returns an answer with the pages behind it, so the
common question resolves in one step instead of a search followed by a fetch, and you
can follow any source with `web_fetch` for the full page.

Searching belongs to the model's own provider. Mindweave does not sign up to a search
service, hold a second API key, or route your queries through anything of its own. A
model that cannot search says so plainly and points you at `web_fetch` rather than
failing in a way that invites the agent to keep retrying.

### Seeing a window

A process being alive is not the same as an app working: a window rendering a stack
trace is alive. `screenshot` captures one window so the agent can look at it and tell
you what is actually on screen, which also covers a layout that is subtly wrong, a
chart with no data, or a dialog nobody expected.

It captures **one window and never the whole screen**, and it asks before every
capture, naming the window it is about to photograph and saying the image goes to the
model. A screenshot is the one thing here that can pick up what the agent was never
pointed at, so the narrow scope and the question are the design rather than a setting.
There is no clicking or typing: seeing closes the loop, acting is a different tool with
a much larger risk surface.

On a model without vision the file is captured and named rather than sent, because
being told a picture exists is more useful than being handed one that cannot be read.

### Commands report what actually happened

**A failed PowerShell command could report success.** Exit codes were read from
`$LASTEXITCODE`, which only native programs set. A cmdlet that failed left it unset,
that was read as zero, and the agent was told the command worked. It hit most of what
gets written day to day, `Get-Content`, `Remove-Item`, `Copy-Item`, and the agent would
then build on work that had not happened. Both signals are now read, so a cmdlet failure
is a failure and a program's own exit code still survives intact.

**Long output kept the wrong end.** Only the first 30,000 characters reached the model.
Builds and test runs put their banner at the start and their diagnosis at the end, so a
verbose run filled the budget with progress and the failure was discarded. Both ends are
kept now, and the gap is marked where it falls.

**Backgrounded `cmd` commands left their script behind** in the temp directory, once per
run, forever. They are cleaned up when the shell ends.

**Non-English output could arrive corrupted.** Output was decoded one chunk at a time, so
a character split across two reads became a replacement glyph. Decoding now spans chunks.

### Also

Process cleanup on macOS and Linux, carried over from work that was diagnosed but held
back: killing a process group silently did nothing when the child was not spawned as a
group leader, a killed process could be reported as still running while it waited to be
reaped, and shutdown skipped shells whose wrapper had exited while their children had
not. Windows is unaffected by all three. Three test files that had never run in the
suite are now part of it.

---

## v1.9.4 (2026-08-07): the first automated build, and the two bugs it found

v1.9.3 shipped without an automated build. Adding one took a few hours and found two
real defects in that time, both of which had been present for a while and neither of
which any test on a developer machine could have caught.

### One directory, two names

Windows keeps an 8.3 short alias for any path component longer than eight characters,
so `C:\Users\johnsmith\...` and `C:\Users\JOHNSM~1\...` are two names for one place.
`run_command` decides whether a command moved the shell by comparing the working
directory before and after as text, and the two sides came from different places: one
from the session, the other from whatever spelling the shell printed.

When they disagreed, every command reported a working-directory change it had not
made, and the recorded directory no longer matched the project root, which is what
makes Mindweave give up on relative paths and show you absolute ones everywhere.

This affects any Windows account whose name is over eight characters, which is most
of them. It stayed invisible because it cannot happen on a short account name, and it
appeared within minutes of the suite running somewhere else.

Paths are now resolved through the operating system rather than Node's own
implementation of the same idea. The difference is the whole fix: Node's version
follows symbolic links but leaves a short name exactly as it found it, so it can
never bring the two spellings together.

### Search could list the files it refuses to open

With ripgrep installed, `glob` listed `.env` and private keys. Ripgrep applies its
filename rules last-match-wins, like `.gitignore`, and the exclusions were registered
BEFORE the caller's pattern, so a pattern as ordinary as `**/*` matched last and
cancelled every one of them. `read_file` refuses those files and `grep` never searches
them, so this was the one route that did not hold the line. The caller's pattern is
now registered first and the guards after it.

Two smaller disagreements between the two search engines went with it: a leading slash
matched under ripgrep and not under the built-in walker, and multi-root results came
back with paths that no longer pointed at a root.

### Builds now run on every push

Windows, on Node 20 and 22. Failures are reported as annotations, which are readable
without special access, unlike run logs.

macOS and Linux are not covered. They were tried, and the suite HANGS there rather
than failing, which is a real defect with a real starting point rather than something
to leave running red. Windows is the supported platform today and the README says so.

---

## v1.9.3 (2026-08-07): the same answer either way, and installs that cannot hang

Mostly about search and indexing telling the truth, plus the first automated test runs.

### Search gave different answers depending on your machine

Mindweave searches with ripgrep when it is installed and with a built-in walker when it
is not. Only ripgrep respected `.gitignore`, while both tools described that behaviour as
though it always applied. The same query on the same project therefore returned different
results on two machines, and nothing in the reply said which engine had answered.

The built-in walker now honours `.gitignore` too: nested ignore files, negated rules,
directory-only rules, and last-match-wins precedence. An unsupported rule is treated as
matching nothing, so the walker errs toward showing a file rather than hiding one, since
a wrongly hidden file looks exactly like a file that does not exist.

Symlinked directories are now skipped deliberately rather than by accident. They used to
fall through an `isDirectory`/`isFile` check and vanish with no decision behind it.
Ripgrep does not follow them either, and code that lives elsewhere is better added as a
workspace root with `/link`, which labels and indexes it properly.

### The code map indexed files every other tool refuses to open

`definition`, `references`, `relevant` and the folder rollup all read out of the code
map, and the code map was built from an unfiltered walk. So symbols from `.env`-adjacent
files and from other coding agents' directories could be surfaced by a lookup, even
though `read_file`, `grep` and `glob` all decline those paths directly. The exclusion is
now applied when indexing, at the source, rather than at each query.

### Answers that claimed more certainty than they had

* `references` asked the language server about only the first definition of a name, then
  reported the result as compiler-resolved. A name defined in three places returned one
  set of callers with full confidence. It now covers every definition and removes
  duplicate call sites.
* A symbol the language server confirms has no callers is now reported as unused. It
  previously fell back to matching the name as text, which invented callers for it.
* In a multi-root workspace, a merged list is only labelled resolved when every root
  resolved it. One root running a language server no longer vouches for a root that is
  not, which had been suppressing the "verify this" note on the half that needed it.
* `outline` on a large directory now says how many files it actually covered. It stops
  after 40, and a partial survey that does not say so reads as the shape of the whole
  folder.

### Sessions that hung, and processes that piled up

Installing a language server ran `npm install` with no timeout and never killed it, and
downloads had no deadline. A stalled install waited forever, left its process tree
running, and because installs are shared, handed that same never-finishing wait to
everything that asked afterwards. This is why fresh project directories could hang for
ten minutes or more while background processes accumulated: a fresh directory is exactly
when a server gets installed, and a warm one skips the step.

Every step now has a deadline and kills its whole process tree when it expires. A failed
install is a normal outcome that leaves the language on the tree-sitter tier, which
works.

### Tests now run automatically

There is a CI workflow, running on Windows on Node 20 and 22.

macOS and Linux were tried and then removed again. The suite does not fail there, it
HANGS: the test step ran past fifteen minutes with no end while the same suite finished
on Windows in three. That points at process handling which has only ever been exercised
on one platform. Reporting a hang nobody is working on says nothing about whether a
change is good, so those jobs come back with the work that makes them pass. Windows is
the supported platform today, and the README says so plainly.

The suite's intermittent crash under load was diagnosed rather than worked around: it is
`Fatal process out of memory: Zone`, caused by the size of the OCaml grammar rather than
by test scheduling. It survived forcing single-file concurrency, and it followed the
OCaml cases when they were moved between files. Test runs now have heap headroom, and
the grammar-heavy files run in their own sequential phase. The language cases were also
rebalanced by grammar size, with a guard test that fails if that balance drifts.

---

## v1.9.2 (2026-08-07): what it says, and what it reads twice

Two problems, both found by running the agent on a real project rather than by reading
code. Neither could fail a test, which is why they survived nine releases.

### The agent talked more than it worked

A turn that made 23 tool calls printed 24 paragraphs of narration. Each one was short,
but two dozen of them is a wall, and the same function names came round in four
separate blocks: a plan stated, then restated, then restated again.

The cause was in the system prompt, which said the user could not see tool calls, and
then demonstrated `"Let me read the file."` as the house style. Both were wrong. Every
tool call is rendered on screen as it happens. So the model was being told to narrate
work the user was already watching, and shown an example of how.

* The prompt now states what is actually true: your text sits alongside a visible record
  of every call, so it has to add to that record rather than repeat it.
* **One line of narration per turn**, enforced where it renders rather than requested in
  prose. However many tool calls a turn takes, the tool rows are the progress indicator.
* Final answers now match the question. A finished task gets a line or two. A question
  that genuinely asks for an account ("what did we do last session", "why did that
  break") gets as many plain paragraphs as the answer needs. Headings, bullet lists and
  status recaps on a short answer are gone.

### The same lines were paid for repeatedly

Files the agent is working on are rebuilt into its context every turn. `read_symbol`
did not check that, so it re-sent a function body that was already on screen. Ranged
`read_file` had the same hole for large files, which are shown as focused regions
rather than whole. One session read the same file four separate times while its
contents sat in front of the model.

* Both now compare the request against what the working set **actually rendered this
  turn**, and point at it instead of re-sending. Checked against what was drawn, never
  against a record of what was read once: a stale claim that the model already has
  something is far worse than a wasted read, and a sub-agent has no working set at all.
* An edited file is always re-sent. Freshness beats saving tokens.

### Also

* A saved session whose tool calls and their results were stored out of order could not
  be resumed at all. Those are now repaired on load, with nothing dropped.
* Reminders the engine writes to itself (verify your changes, batch these edits) were
  indistinguishable from something you typed. They showed up as your own prompts in a
  resumed chat, and one could become the session's title in `/continue`. They are marked
  as engine-written and no longer surface as yours.
* `scripts/narration.mjs` reports how much a session talks against how much it does:
  prose per tool call, how many blocks ran over budget, and which identifiers were
  discussed in three or more separate blocks. Useful if you are working on this area.

---

## v1.9.1 (2026-08-07): tool audit

Every one of the 36 tools the agent can call was read against its own implementation,
one at a time. The rule for the pass was simple: read the code before writing a word
about it. Every defect below was invisible from the description alone.

Two causes accounted for nearly all of it. Some descriptions were accurate when written
and were never updated as the tool grew. Others were written as a one-line summary of a
feature and never revisited. Descriptions written against an observed failure were the
accurate ones, which is a useful thing to know when writing the next one.

21 of the findings were code, not wording.

### Answers that were quietly wrong

* **`diagnostics` checked the wrong files.** With no path given it picked the files to
  check by insertion order rather than recency, so the file you had just edited was
  skipped. It then reported "No diagnostics" while naming files it had never looked at.
* **`list_dir` showed a symlinked directory as a file.** A directory reached through a
  symlink or junction reports as neither a file nor a directory, so the trailing slash
  that tells them apart never appeared. Common in `node_modules/.bin` and linked
  monorepo packages. Symlinks are now marked, and a broken one says so.
* **`list_dir` said "directory not found" when pointed at a real file**, which sent the
  agent looking for something it had already located. Missing, is-a-file and
  permission-denied are now told apart.
* **`find_mcp_tools` silently returned only the first 8 matches.** Search is the only way
  to reach a large MCP catalog, so the tools it did not return also stayed unloaded and
  invisible. It now says when it hit the limit.
* **`list_mcp_resources` and `read_mcp_resource` disagreed about server names.** For some
  configured names the listing rejected the exact name the read accepted.

### Data that could be lost

* **Skill bodies were corrupted.** Placeholder substitution treated any `$` followed by
  digits as an argument, so `$100` became empty and, with no arguments passed, every
  `$1` in the body was deleted. A skill containing `awk '{print $1}'` silently became
  `awk '{print }'`. The steps the agent followed were not the steps on disk.
* **Saving one memory could delete another.** The index updater removed any line
  containing the saved file's name, so an entry whose text referenced another memory was
  deleted when that memory was next saved.
* **Two memory names that reduce to the same filename silently replaced each other.**
  Saving is deliberately not confirmed with you because memory is non-destructive; this
  was the one case where that was untrue, and it is now reported.
* **A standing rule could exist twice in a session and once on disk**, so a rule you had
  just set appeared to vanish on restart.
* **Frontmatter injection in three writers.** Memory, rules and skills all wrote
  user-supplied text into a line-oriented header that is read back and trusted. A line
  break in a name or description could forge fields, for example re-scoping a rule to
  every file. No malice required; a pasted title does it.

### Consent

* **Pressing Escape on a question returned the second option as your answer.** Correct
  for a yes/no prompt, wrong for `ask_user`, where the options are arbitrary. Dismissing
  "Postgres or SQLite?" told the agent you had chosen SQLite.
* **Sub-agents could put approval dialogs on your screen.** A parallel fan-out could
  stack several with nothing to say which agent asked. Sub-agents now proceed on a
  sensible default and report the assumption, which is what their briefing already
  assumed.
* **`add_directory` and `link_workspace` treated "no way to ask" as permission granted**,
  on the widest change either makes: pulling every discovered sibling repository into the
  workspace. Both now decline and say so.
* **`add_mcp_server` did not say what it was about to do.** It asked to "add" a server
  while replacing an existing one of the same name, and never mentioned that credentials
  were being written to a config file. Both are stated before the question now, naming
  the credential keys but never their values.

### Accuracy

* **`add_mcp_server` recommended something that cannot work.** It told the agent to
  reference an environment variable, with `"$TOKEN"` as the example. Nothing expands that,
  so it reached the server as those literal characters and failed as a bad credential.
  The server already inherits your environment, so a variable already set in your shell
  needs no entry at all.
* **`add_directory` could add the same folder several times** under different labels,
  because paths were compared as text. A case variant or a symlink produced a second
  root, and searches then walked the same tree twice.
* **`glob` listed secrets that every other tool refuses.** `read_file` declines `.env`,
  `grep` never searched it, `glob **/*` listed it.
* **MCP resource template listings were unbounded**, so a server could put as much into
  your context as it liked.
* **`link_workspace` reported only its successes**, so a partial link read as a complete
  one.
* Background shell output that had been dropped to stay within its buffer was recorded as
  truncated and never shown, so an incomplete log looked complete.

### Descriptions

The other 15 findings were wording, but the kind that changes behaviour: caps that were
enforced and never stated, results that looked identical whether they meant "clean" or
"I could not check", and tools that promised more certainty than they had. Every stated
number is now pinned to the constant it describes, so prose cannot drift from the code.

---

## v1.0 to v1.9.0

This changelog starts at v1.9.1. Earlier versions were released as commits rather than
tagged releases, so the detail lives in `git log`. What landed across that line:

* **v1.1** the Anthropic driver alongside DeepSeek, and providers loaded on demand
* **v1.2** sessions the agent can read back, so "what did we do last time" gets a real
  answer
* **v1.3, v1.4** MCP, including protection against a server changing a tool's description
  after you trusted it
* **v1.5** rebuilt editing tools and per-model compaction
* **v1.6** background jobs that report when they are actually up, not just when they exit
* **v1.7** undo that will not overwrite your own edits, and `/provider` split from
  `/model`
* **v1.8** images you can attach and have looked at
* **v1.9.0** core hardening, subsystem by subsystem, and POSIX process handling. Feature
  freeze starts here.
