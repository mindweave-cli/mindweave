# Known issues

Written down rather than quietly carried. Several are good places to start if you want to
contribute, and each says what it would actually take.

## macOS and Linux: what is and is not covered

Mindweave is developed on Windows. The whole test suite, the typecheck and the build also run
on every change on Linux (Ubuntu) and on macOS (an Apple silicon runner), and pass.

What that does not cover:

- **A person at a real terminal on a Mac or Linux desktop.** The suite drives the program
  through fake terminals. How it looks and feels in Terminal.app, iTerm2, GNOME Terminal or
  Konsole (colours, mouse, copy and paste) has not been checked by eye. Copying handles the Mac, X11,
  Wayland, tmux and SSH cases, but only the parts that can be tested without a screen are. Reports of anything off are the most useful thing
  you can send.
- **Intel Macs.** The runner is Apple silicon. The code does not depend on the chip, but it
  has not been run on one.
- **Driving a native desktop app, and window screenshots.** The `ui` tool can drive a web
  page or a dev server in a browser on every platform. Driving another program's window by
  its title, and taking a screenshot of a window, work on Windows only and say so elsewhere.
  Doing it on macOS needs the system's accessibility and screen-recording permissions and a
  helper program, and on Linux it depends on the display server.

The desktop app, [mwcode](https://github.com/mindweave-cli/mwcode), ships for macOS and
Linux too, with Mindweave and its own Node inside.

## The out-of-memory crash is contained, not cured

Loading the OCaml grammar can exhaust V8 when the machine is already under memory
pressure. Test runs are given heap headroom and the grammar-heavy files run in their own
sequential phase, which holds, but the underlying cost of that grammar is unchanged.

## Some models look things up one at a time

A model that asks for several things at once finishes a task in fewer calls than one
that asks for them one after another, and how much of that a model does is largely its
own habit. Mindweave gives it the room to batch: reads take a list, search pages, and
repeated reads of the same content are caught rather than re-sent.

## MCP has been driven against one real published server

Tools have been exercised end to end; resources and prompts have only been tested against
servers written for the purpose. Real servers will find edges these did not.

Deliberately not being worked on right now: OAuth for remote servers (they report
`needs-auth` and stop), multi-round tool requests and elicitation, and attaching a
resource yourself with `@`.

