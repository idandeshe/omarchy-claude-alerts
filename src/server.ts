import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { config, log, paths, token, watchConfig } from "./config.ts";
import { dispatch, fromHook, fromRequest } from "./dispatch.ts";
import { clearWaiting, initState, snapshot, statePaths } from "./state.ts";
import type { AlertRequest, HookPayload } from "./types.ts";

const MAX_BODY = 256 * 1024;
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const SECRET = token();
const bound: string[] = [];

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Constant-time compare over digests, so unequal lengths are safe. */
function tokenOk(supplied: string | undefined): boolean {
  if (!supplied) return false;
  const a = createHash("sha256").update(supplied).digest();
  const b = createHash("sha256").update(SECRET).digest();
  return timingSafeEqual(a, b);
}

function authorized(req: IncomingMessage): boolean {
  const header = req.headers["x-alert-token"];
  const direct = Array.isArray(header) ? header[0] : header;
  if (tokenOk(direct)) return true;

  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return tokenOk(auth.slice(7).trim());
  return false;
}

function isLoopback(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress ?? "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const route = url.pathname.replace(/\/+$/, "") || "/";

  // Liveness is open on loopback so you can check it without digging out the token.
  if (route === "/health" && req.method === "GET") {
    if (!isLoopback(req) && !authorized(req)) return json(res, 401, { error: "unauthorized" });
    const { port, bind, debounceMs, uuidTtlMs, rules } = config();
    return json(res, 200, {
      ok: true,
      port,
      configured: bind,
      listening: bound,
      debounceMs,
      uuidTtlMs,
      channels: ["sound", "notify"],
      events: Object.keys(rules),
      tokenFile: paths.TOKEN_FILE,
      stateFile: statePaths.STATE_FILE,
      waiting: snapshot().length,
    });
  }

  // What the bar widget renders, also handy for scripting.
  if (route === "/state" && req.method === "GET") {
    if (!authorized(req)) return json(res, 401, { error: "unauthorized" });
    return json(res, 200, { waiting: snapshot() });
  }

  if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
  if (!authorized(req)) return json(res, 401, { error: "unauthorized" });

  let parsed: unknown = {};
  try {
    const raw = await readBody(req);
    if (raw.trim()) parsed = JSON.parse(raw);
  } catch (err) {
    // A hook must never see a failure because of us; answer 200 and log it.
    log(`bad request body on ${route}: ${(err as Error).message}`);
    if (route === "/hook") return json(res, 200, {});
    return json(res, 400, { error: "invalid JSON body" });
  }

  switch (route) {
    case "/hook": {
      const resolved = fromHook(parsed as HookPayload);
      // Respond first, alert after: this call is on the agent's critical path.
      json(res, 200, {});
      dispatch(resolved);
      return;
    }
    case "/alert": {
      const resolved = fromRequest(parsed as AlertRequest);
      const status = dispatch(resolved);
      return json(res, 200, {
        ok: true,
        status,
        uuid: resolved.alert.uuid,
        project: resolved.alert.project,
        event: resolved.alert.event,
      });
    }
    case "/test": {
      const body = parsed as AlertRequest;
      const resolved = fromRequest({
        ...body,
        event: body.event ?? "Notification",
        project: body.project ?? "claude-alerts",
        message: body.message ?? "Test alert from claude-alerts.",
      });
      const status = dispatch(resolved);
      return json(res, 200, { ok: true, status, sent: resolved.alert, channels: resolved.channels });
    }
    case "/clear": {
      // The widget calls this when you act on an agent, or dismiss the list.
      const body = parsed as { project?: string };
      const removed = clearWaiting(body.project);
      return json(res, 200, { ok: true, removed, waiting: snapshot().length });
    }
    default:
      return json(res, 404, { error: "not found" });
  }
}

function requestListener(req: IncomingMessage, res: ServerResponse): void {
  handle(req, res).catch((err) => {
    log(`handler error: ${err.message}`);
    if (!res.headersSent) json(res, 200, {});
  });
}

/**
 * One server per address. 172.17.0.1 only exists once Docker has created
 * docker0, so a failed bind retries with backoff instead of killing the
 * service — that also recovers if Docker restarts.
 */
function listenOn(host: string, port: number): void {
  const server = http.createServer(requestListener);
  let delay = 2_000;

  server.on("error", (err: NodeJS.ErrnoException) => {
    // The Omarchy plugin spawns this service, and a systemd unit or a shell
    // might too. Losing the loopback port means another instance already owns
    // it: say so once and step aside instead of retrying against ourselves.
    if (err.code === "EADDRINUSE" && LOOPBACK.has(host)) {
      log(`${host}:${port} already in use — another claude-alerts is running; exiting`);
      process.exit(0);
    }
    log(`bind ${host}:${port} failed (${err.code}); retrying in ${delay / 1000}s`);
    setTimeout(() => server.listen(port, host), delay);
    delay = Math.min(delay * 2, 60_000);
  });

  server.on("listening", () => {
    delay = 2_000;
    if (!bound.includes(host)) bound.push(host);
    log(`listening on http://${host}:${port}`);
  });

  server.listen(port, host);
}

watchConfig();
initState();
const { port, bind } = config();
for (const host of bind) listenOn(host, port);
log(`token file: ${paths.TOKEN_FILE}`);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    log(`${signal} received, shutting down`);
    process.exit(0);
  });
}
