# Known issues

Written down rather than quietly carried. Several are good places to start if you want to
contribute, and each says what it would actually take.

## macOS has not been run

Mindweave is developed on Windows. The whole test suite also passes on Linux, and the
process handling that used to hang there has been fixed. macOS shares the Linux code paths
and has fixes of its own (folder names that differ only in case are one folder there), but
nothing has been run on a real Mac. Continuous testing still runs on Windows alone, so a
green run says nothing about the other two yet.

The desktop app, [mwcode](https://github.com/mindweave-cli/mwcode), ships for macOS and
Linux too, with Mindweave and its own Node inside.

Adding Linux and macOS jobs to continuous testing, and running the suite on a real Mac, is
the most useful thing an outside contributor can take on. See [CONTRIBUTING.md](CONTRIBUTING.md).

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

