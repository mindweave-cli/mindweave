/**
 * callback.ts — catching the redirect the browser makes after the user approves.
 *
 * The authorization server cannot talk to a terminal, so the flow ends the only way it
 * can for a native app (RFC 8252): we listen on loopback for a moment, hand the browser a
 * `http://localhost:<port>/callback` address to come back to, and read the code off the
 * query string. The listener exists for one request and then stops.
 *
 * THREE THINGS HERE ARE SECURITY, NOT PLUMBING:
 *
 *  - It binds LOOPBACK ONLY, never `0.0.0.0`. The default binds every interface, which on
 *    a laptop on a café network means anyone on that network can reach the port an
 *    authorization code is about to arrive on. Advertising `localhost` while binding the
 *    loopback addresses is not a loosening: the name resolves to the same two places.
 *  - The port is chosen at RANDOM from a range rather than fixed, so nothing else on the
 *    machine can sit on a known port waiting to receive somebody's code.
 *  - `state` is checked before the code is accepted, and a mismatch is a hard failure
 *    rather than a retry, because a request arriving with the wrong state is by
 *    definition not the flow we started.
 *
 * The port range differs on Windows on purpose: 49152-65535 is the dynamic range the OS
 * hands out to everything else, so picking from it there is a collision waiting to happen.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { stateMatches } from "./pkce.js";

const WINDOWS_RANGE = { min: 39152, max: 49151 };
const POSIX_RANGE = { min: 49152, max: 65535 };
const PORT_ATTEMPTS = 40;

/** How long to hold the port open waiting for a person to finish in a browser. Long
 *  enough to find a password and approve a consent screen, short enough that an abandoned
 *  attempt does not leave a listener behind for the rest of the session. */
export const CALLBACK_TIMEOUT_MS = 5 * 60_000;

export function redirectUri(port: number): string {
  // `localhost`, NOT the `127.0.0.1` this listens on, and the difference is not cosmetic:
  // authorization servers validate the redirect URI as a string, and a great many of them
  // accept only the literal host `localhost` for an http redirect — the IP form is
  // rejected outright ("Invalid redirect URI") even though RFC 8252 §7.3 permits it. The
  // spec's own advice prefers the IP literal; the deployed reality does not, and this is
  // the value a stranger's server has to agree with.
  //
  // The LISTENER still binds 127.0.0.1 (see below), so nothing is exposed off the machine:
  // only the advertised name differs, and every browser resolves localhost to loopback.
  //
  // The path is fixed and the port is not, which is what RFC 8252 §7.3 allows a loopback
  // redirect to do: clients match on path, so a random port needs no re-registration.
  return `http://localhost:${port}/callback`;
}

function portRange(platform: NodeJS.Platform = process.platform): { min: number; max: number } {
  return platform === "win32" ? WINDOWS_RANGE : POSIX_RANGE;
}

/** Bind a random free port, or throw having said why. */
export async function findAvailablePort(platform: NodeJS.Platform = process.platform): Promise<number> {
  const configured = Number.parseInt(process.env.MINDWEAVE_OAUTH_PORT ?? "", 10);
  if (Number.isInteger(configured) && configured > 0) return configured;

  const { min, max } = portRange(platform);
  for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt++) {
    const port = min + Math.floor(Math.random() * (max - min + 1));
    if (await isFree(port)) return port;
  }
  throw new Error("could not find a free local port to receive the authorization redirect");
}

/**
 * Free on BOTH loopback families, since the redirect says `localhost` and the browser may resolve that to either.
 * A port busy on `::1` alone looked free, and the code then went to whatever was listening there.
 */
async function isFree(port: number): Promise<boolean> {
  if (!(await isFreeOn(port, "127.0.0.1"))) return false;
  return isFreeOn(port, "::1");
}

function isFreeOn(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    // Only "in use" means taken. A machine with IPv6 off cannot bind `::1` at all, and nothing can be listening there.
    probe.once("error", (err: NodeJS.ErrnoException) => resolve(err.code !== "EADDRINUSE"));
    probe.listen(port, host, () => probe.close(() => resolve(true)));
  });
}

export interface CallbackResult {
  code: string;
}

export interface WaitOptions {
  port: number;
  /** The value we sent; anything else arriving is refused. */
  state: string;
  timeoutMs?: number;
  /** Cancels the wait and closes the listener — the user pressing Esc, or the overlay
   *  closing. Without it an abandoned flow holds the port for the full timeout. */
  signal?: AbortSignal;
}

/**
 * Serve one request on `port` and resolve with the authorization code it carried.
 *
 * Rejects rather than resolving on every unhappy path (the server sent `error=`, the
 * state did not match, nobody came back in time, the caller aborted), because each of
 * those has a different sentence to show the user and none of them should read as a
 * connection that merely did not work yet.
 */
export function waitForCallback(options: WaitOptions): Promise<CallbackResult> {
  const { port, state, timeoutMs = CALLBACK_TIMEOUT_MS, signal } = options;
  return new Promise<CallbackResult>((resolve, reject) => {
    let settled = false;
    const servers: Server[] = [];

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      // Close AFTER the response has been flushed, or the browser shows a connection
      // reset instead of the page telling the user they can go back to the terminal.
      for (const s of servers) s.close();
      fn();
    };

    const timer = setTimeout(() => finish(() => reject(new Error("timed out waiting for the browser to come back"))), timeoutMs);
    // The listener must never be the reason the process stays alive: if the session ends
    // while a forgotten flow is open, the CLI should exit, not hang for five minutes.
    timer.unref?.();

    const onAbort = (): void => finish(() => reject(new Error("authentication cancelled")));
    signal?.addEventListener("abort", onAbort, { once: true });

    const handle = (req: IncomingMessage, res: ServerResponse): void => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      if (url.pathname !== "/callback") {
        // Anything else on this port is not ours. A bare 404 rather than a hint about
        // what this server is for.
        res.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const received = url.searchParams.get("state");

      if (error) {
        const description = url.searchParams.get("error_description");
        respond(res, "Authorization was declined.", "You can close this tab and return to the terminal.");
        finish(() => reject(new Error(description ? `${error}: ${description}` : error)));
        return;
      }
      if (!stateMatches(state, received)) {
        respond(res, "That request did not match.", "Close this tab and start the connection again.");
        finish(() => reject(new Error("the redirect did not match the request we started (state mismatch)")));
        return;
      }
      if (!code) {
        respond(res, "No authorization code came back.", "Close this tab and try again.");
        finish(() => reject(new Error("the redirect carried no authorization code")));
        return;
      }
      respond(res, "Connected.", "You can close this tab and return to the terminal.");
      finish(() => resolve({ code }));
    };

    // BOTH LOOPBACK FAMILIES, because the redirect says `localhost` and the browser is the
    // one that resolves it. On a dual-stack machine that can be ::1 rather than 127.0.0.1,
    // and a listener on only one of them means the approval succeeds and the browser then
    // cannot deliver the code — the worst shape of failure, since everything looked right
    // until the last step. Browsers mostly retry the other family, but "mostly" is not a
    // thing to rest an auth flow on.
    //
    // IPv4 is required and IPv6 is best effort: a machine with IPv6 disabled must still
    // work, and there `::1` simply refuses to bind. Someone else already on `::1` is not that
    // case: the browser may go there, handing them the code and leaving this waiting.
    const listenOn = (host: string, required: boolean): void => {
      const server = createServer(handle);
      servers.push(server);
      server.once("error", (err: NodeJS.ErrnoException) => {
        if (!required && err.code !== "EADDRINUSE") return; // no IPv6 here; the IPv4 listener is the real one
        const reason =
          err.code === "EADDRINUSE"
            ? `local port ${port} is already in use, so the redirect cannot be received`
            : `could not listen for the redirect: ${err.message}`;
        finish(() => reject(new Error(reason)));
      });
      server.listen(port, host);
      // Same reasoning as the timer: an open listener is not a reason to keep running.
      server.unref?.();
    };
    listenOn("127.0.0.1", true);
    listenOn("::1", false);

    if (signal?.aborted) onAbort();
  });
}

/** The page the browser lands on. Deliberately plain text-ish HTML with no resources to
 *  fetch: it renders identically offline, which is the situation a loopback page is
 *  always in, and there is nothing in it worth a network round trip. */
function respond(res: ServerResponse, title: string, detail: string): void {
  const body = `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font:16px system-ui,sans-serif;margin:4rem auto;max-width:32rem;color:#111">
<h1 style="font-size:1.25rem">${title}</h1><p>${detail}</p></body>`;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
}
