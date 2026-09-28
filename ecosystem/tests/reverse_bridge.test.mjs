/**
 * REAL REVERSE BRIDGE TEST — Python calling INTO the TS kernel
 *
 * Every other bridge test in this repo proves TS calling OUT to a real
 * Python service. This is the other direction: GET /rctdb/query on
 * packages/intent-loop's worker lets an authenticated caller (a Python
 * service, or anything else) read this kernel's own RCTDB audit log over
 * real HTTP - added because "the reverse direction (Python services
 * calling back into this TS kernel)" was explicitly named as not-yet-done
 * in ROADMAP.md.
 *
 * Starts a REAL `wrangler dev --local` server (Miniflare-simulated,
 * entirely local - no Cloudflare deployment or account access involved),
 * then spawns tests/reverse_bridge_check.py as a REAL Python subprocess
 * to make the actual HTTP calls, so this genuinely proves Python-calls-TS,
 * not just Node calling Node.
 *
 * Honest limitation: fully populating the log via a real completed
 * run_intent_loop call (then verifying the reverse read sees real data,
 * not just an honest empty list) needs a real OPENROUTER_API_KEY, which
 * is not available in this environment - see reverse_bridge_check.py's
 * own comments. What IS verified for real here is the security-critical
 * part: unauthenticated and wrongly-authenticated requests are genuinely
 * rejected, validation genuinely runs, and a correctly authenticated
 * request genuinely reaches the real Durable Object and gets a real
 * (honestly empty) response back.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

/**
 * `wrangler dev` spawns its own `workerd` runtime as a further child
 * process. On Windows, node's plain `child.kill()` only signals the
 * immediate process, not its descendants, which can leave `workerd`
 * running and the port still bound. `taskkill /T` kills the whole
 * process tree for real; on non-Windows, SIGKILL on the process group
 * (negative pid) covers the same case. Best-effort: failures here are
 * swallowed since the test itself doesn't depend on this succeeding.
 */
function killProcessTree(proc) {
  try {
    if (os.platform() === "win32") {
      execFileSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(-proc.pid, "SIGKILL");
    }
  } catch {
    try {
      proc.kill("SIGKILL");
    } catch {
      // best-effort cleanup only
    }
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INTENT_LOOP_DIR = path.resolve(__dirname, "../packages/intent-loop");
// Resolved and spawned directly via `node`, not `npx` with shell:true -
// found for real (2026-09-13): on Windows, spawn(..., {shell:true})
// launches a cmd.exe wrapper around npx, and child.kill() only signals
// that wrapper, orphaning the actual wrangler/workerd process tree
// underneath it (still listening on its port, never reaped) instead of
// genuinely stopping it. Spawning wrangler's own JS entry point directly
// with node avoids the shell wrapper entirely, so .kill() actually works.
const WRANGLER_BIN = path.resolve(__dirname, "../node_modules/wrangler/bin/wrangler.js");
const PORT = 8792;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const API_KEY = "test-reverse-bridge-key-12345";

async function waitForReady(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (resp.ok) return;
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`wrangler dev did not become ready in time: ${lastError}`);
}

test("GET /rctdb/query: a real Python process authenticates and queries the TS kernel's RCTDB log over real HTTP", async (t) => {
  const proc = spawn(
    process.execPath,
    [WRANGLER_BIN, "dev", "--local", "--port", String(PORT), "--var", `BRIDGE_API_KEY:${API_KEY}`],
    { cwd: INTENT_LOOP_DIR, stdio: "pipe" }
  );
  t.after(() => killProcessTree(proc));

  await waitForReady(`${BASE_URL}/health`);

  const pyOutput = execFileSync("python", [path.join(__dirname, "reverse_bridge_check.py"), BASE_URL, API_KEY], {
    encoding: "utf-8",
  });
  const results = JSON.parse(pyOutput.trim().split("\n").pop());

  assert.equal(results.no_key_rejected, true);
  assert.equal(results.wrong_key_rejected, true);
  assert.equal(results.missing_session_id_rejected, true);
  assert.equal(results.authenticated_query_succeeded, true);
});

test("GET /rctdb/query: without BRIDGE_API_KEY configured on the deployment, the route is disabled (501), never an open bypass", async (t) => {
  const proc = spawn(
    process.execPath,
    [WRANGLER_BIN, "dev", "--local", "--port", String(PORT + 1)],
    { cwd: INTENT_LOOP_DIR, stdio: "pipe" }
  );
  t.after(() => killProcessTree(proc));

  const base = `http://127.0.0.1:${PORT + 1}`;
  await waitForReady(`${base}/health`);

  const resp = await fetch(`${base}/rctdb/query?session_id=x`, { headers: { "x-bridge-api-key": "anything" } });
  assert.equal(resp.status, 501);
});
