/**
 * fakeServer.test.ts — a small stand-in for an OpenAI-compatible server, for the tests of the providers that talk to one
 * (LM Studio, llama.cpp, a custom endpoint). It is a real HTTP server on a free port, so the request is the one the driver
 * really sends: the path, the headers and the body can all be looked at afterwards.
 *
 * Named like a test so it is left out of the published build, and holds no tests of its own.
 */
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** One request the server was sent. */
export interface Seen {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: unknown;
}

export type Handler = (seen: Seen, res: ServerResponse) => void;

export interface FakeServer {
  /** `http://127.0.0.1:<port>`, no trailing slash. */
  url: string;
  /** Every request so far, oldest first. */
  seen: Seen[];
  close(): Promise<void>;
}

/** Reply with JSON. */
export function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Reply the way a streaming chat completion does: one event per chunk, then the end marker. */
export function stream(res: ServerResponse, chunks: unknown[]): void {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

/** The chunks of a streamed plain-text answer, with the token counts in a last chunk the way servers send them. */
export function textAnswer(text: string, usage = { prompt_tokens: 40, completion_tokens: 5, total_tokens: 45 }): unknown[] {
  return [
    { choices: [{ index: 0, delta: { role: "assistant", content: text } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    { choices: [], usage },
  ];
}

/**
 * Start a server. `routes` is keyed by `"METHOD /path"`; any other request is a 404. The paths are matched without a query.
 */
export async function fakeServer(routes: Record<string, Handler>): Promise<FakeServer> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let body: unknown = undefined;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
      const path = (req.url ?? "").split("?")[0]!;
      const entry: Seen = { method: req.method ?? "GET", path, headers: req.headers, body };
      seen.push(entry);
      const handler = routes[`${entry.method} ${path}`];
      if (handler) handler(entry, res);
      else json(res, { error: { message: `no route for ${entry.method} ${path}` } }, 404);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/** An address nothing is listening on: a port that was free a moment ago. */
export async function deadAddress(): Promise<string> {
  const s = await fakeServer({});
  const url = s.url;
  await s.close();
  return url;
}

/** Run a body with some environment variables set, and put them back as they were. */
export async function withEnv(vars: Record<string, string | undefined>, body: () => void | Promise<void>): Promise<void> {
  const before: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    before[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await body();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
