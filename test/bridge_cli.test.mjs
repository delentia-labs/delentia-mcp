/**
 * The stdio bridge (bin/cli.js) against a REAL local HTTP server, with the real CLI as a child process: JSON replies pass through, notifications get no answer, an event-stream reply is read,
 * a JSON-RPC error body keeps its code (the quota answer), a hung server is answered with an error instead of hanging the client, the session id is sent back, --help/--version answer.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, "../bin/cli.js");
const VERSION = JSON.parse(readFileSync(path.join(here, "../package.json"), "utf8")).version;

async function withServer(handler, fn) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const msg = body ? JSON.parse(body) : {};
      seen.push({ headers: req.headers, msg });
      handler(req, res, msg);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}/mcp`, seen);
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
}

function run(args, lines, env = {}, waitMs = 0) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [CLI, ...args], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => resolve({ code, out, err, replies: out.split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }) }));
    for (const l of lines) p.stdin.write(JSON.stringify(l) + "\n");
    setTimeout(() => p.stdin.end(), waitMs);
  });
}

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

test("--version and --help answer and exit (they used to wait on stdin forever)", async () => {
  const v = await run(["--version"], []);
  assert.equal(v.code, 0);
  assert.equal(v.out.trim(), VERSION);
  const h = await run(["--help"], []);
  assert.equal(h.code, 0);
  assert.match(h.out, /advisory/);
  assert.match(h.out, /delentia-guard/);
});

test("a JSON reply passes through, the User-Agent carries the real version, and a notification gets no answer", async () => {
  await withServer((req, res, msg) => json(res, 200, { jsonrpc: "2.0", id: msg.id, result: { ok: true, method: msg.method } }), async (url, seen) => {
    const r = await run(["--endpoint", url], [
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "initialize", params: {} },
    ], {}, 400);
    assert.deepEqual(r.replies.map((m) => m.id).sort(), [1, 2]);
    assert.equal(r.replies[0].result.ok, true);
    assert.equal(seen.length, 3, "the notification still reached the server");
    assert.equal(seen[0].headers["user-agent"], "Delentia-MCP-CLI/" + VERSION);
    assert.match(seen[0].headers.accept, /text\/event-stream/);
  });
});

test("a text/event-stream reply is read: every data: event is one message", async () => {
  await withServer((req, res, msg) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { via: "sse" } })}\n\n`);
  }, async (url) => {
    const r = await run(["--endpoint", url], [{ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "x" } }], {}, 400);
    assert.equal(r.replies.length, 1);
    assert.equal(r.replies[0].result.via, "sse");
  });
});

test("an event stream with nothing in it is an error, not a silence", async () => {
  await withServer((req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(": keep-alive\n\n"); }, async (url) => {
    const r = await run(["--endpoint", url], [{ jsonrpc: "2.0", id: 6, method: "tools/list" }], {}, 400);
    assert.equal(r.replies[0].error.code, -32603);
    assert.equal(r.replies[0].id, 6);
  });
});

test("a JSON-RPC error body keeps its own code (the free-tier quota answer is -32002); other failures are -32603", async () => {
  await withServer((req, res, msg) => {
    if (msg.id === 1) return json(res, 429, { jsonrpc: "2.0", id: null, error: { code: -32002, message: "Free Developer Sandbox quota exceeded (50/50 calls reached)" } });
    res.writeHead(502, { "content-type": "text/plain" });
    res.end("bad gateway");
  }, async (url) => {
    const r = await run(["--endpoint", url], [{ jsonrpc: "2.0", id: 1, method: "tools/call" }, { jsonrpc: "2.0", id: 2, method: "tools/call" }], {}, 400);
    const byId = Object.fromEntries(r.replies.map((m) => [m.id, m]));
    assert.equal(byId[1].error.code, -32002);
    assert.match(byId[1].error.message, /quota/);
    assert.equal(byId[2].error.code, -32603);
    assert.match(byId[2].error.message, /status 502/);
  });
});

test("a server that never answers gets a timeout error back to the client instead of a hang", async () => {
  await withServer(() => { /* never respond */ }, async (url) => {
    const started = Date.now();
    const r = await run(["--endpoint", url], [{ jsonrpc: "2.0", id: 9, method: "tools/call" }], { DELENTIA_TIMEOUT_MS: "300" }, 1500);
    assert.equal(r.replies.length, 1);
    assert.equal(r.replies[0].id, 9);
    assert.equal(r.replies[0].error.code, -32001);
    assert.match(r.replies[0].error.message, /300 ms/);
    assert.ok(Date.now() - started < 5000);
  });
});

test("the server's Mcp-Session-Id is sent back on later requests", async () => {
  await withServer((req, res, msg) => json(res, 200, { jsonrpc: "2.0", id: msg.id, result: {} }, msg.method === "initialize" ? { "mcp-session-id": "abc123" } : {}), async (url, seen) => {
    // the second request must wait for the first answer, so send them in two runs of one process
    const r = await new Promise((resolve, reject) => {
      const p = spawn(process.execPath, [CLI, "--endpoint", url], { stdio: ["pipe", "pipe", "inherit"] });
      let out = "";
      p.stdout.on("data", (d) => {
        out += d;
        if (out.includes('"id":1') && !out.includes('"id":2')) p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
        if (out.includes('"id":2')) p.stdin.end();
      });
      p.on("error", reject);
      p.on("close", () => resolve(out));
      p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
    });
    assert.match(r, /"id":2/);
    assert.equal(seen[0].headers["mcp-session-id"], undefined);
    assert.equal(seen[1].headers["mcp-session-id"], "abc123");
  });
});

test("an API key goes out as a bearer token and a malformed line is a parse error, not a crash", async () => {
  await withServer((req, res, msg) => json(res, 200, { jsonrpc: "2.0", id: msg.id, result: {} }), async (url, seen) => {
    const p = spawn(process.execPath, [CLI, "--endpoint", url], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, DELENTIA_API_KEY: "k-test-123" } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stdin.write("this is not json\n");
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }) + "\n");
    await new Promise((r) => setTimeout(r, 500));
    p.stdin.end();
    await new Promise((r) => p.on("close", r));
    const replies = out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(replies.some((m) => m.error?.code === -32700));
    assert.ok(replies.some((m) => m.id === 3));
    assert.equal(seen[0].headers.authorization, "Bearer k-test-123");
  });
});
