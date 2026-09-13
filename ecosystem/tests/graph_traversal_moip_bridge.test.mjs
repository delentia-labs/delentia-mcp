/**
 * REAL TS<->Python BRIDGE TEST — Graph Traversal and MOIP Planner
 *
 * Extends the TS<->Python bridge (Phase A item 1 of the 2026-09-13
 * follow-up roadmap) to the last 2 of the 5 Python services audited real
 * this session: Graph Traversal (ALGO-17) and MOIP Planner (ALGO-02).
 * Both real Python services are started as real subprocesses.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { syncToGraphTraversal, analyzeIntentLoopTradeoffs } from "../packages/intent-loop/dist/worker.js";
import { ingestGraphragDocument, searchGraphragDocuments } from "../packages/shared/dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MICROSERVICES_DIR = path.resolve(__dirname, "../../the private services repo/<private>/microservices");
const SERVICES_AVAILABLE = fs.existsSync(path.join(MICROSERVICES_DIR, "graph-traversal", "app", "main.py"))
  && fs.existsSync(path.join(MICROSERVICES_DIR, "moip-planner", "app", "main.py"))
  && fs.existsSync(path.join(MICROSERVICES_DIR, "graphrag-complete", "app", "main.py"));

if (!SERVICES_AVAILABLE) {
  console.log(`SKIPPING graph_traversal_moip_bridge.test.mjs — sibling Python repo/services not found under ${MICROSERVICES_DIR}`);
}

const GRAPH_TRAVERSAL_PORT = 8117; // distinct from graph-traversal's own default 8017, which collides with algo-17-code-generation
const GRAPH_TRAVERSAL_BASE_URL = `http://127.0.0.1:${GRAPH_TRAVERSAL_PORT}`;
const MOIP_PORT = 8102;
const MOIP_BASE_URL = `http://127.0.0.1:${MOIP_PORT}`;
const GRAPHRAG_PORT = 8013;
const GRAPHRAG_BASE_URL = `http://127.0.0.1:${GRAPHRAG_PORT}`;

async function waitForHealth(url, timeoutMs = 30000, perAttemptMs = 10000) {
  // graph-traversal's real /graph/health handler synchronously re-checks
  // live Neo4j connectivity on every single call (handler.
  // verify_connectivity() in routes.py), which genuinely takes several
  // real seconds to time out when no Neo4j server is reachable (as in
  // this dev/test environment) - a real characteristic of that endpoint,
  // not a bug in this test. A short per-attempt abort (fine for every
  // other bridged service's near-instant health check) would keep
  // cutting the request off before it ever completes here.
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(perAttemptMs) });
      if (resp.ok) return;
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Service at ${url} did not become healthy in time: ${lastError}`);
}

function startService(dirName, port) {
  const cwd = path.join(MICROSERVICES_DIR, dirName);
  const proc = spawn(
    "python",
    ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(port)],
    { cwd, env: { ...process.env, PYTHONPATH: cwd, PORT: String(port) }, stdio: "pipe" }
  );
  return proc;
}

test("syncToGraphTraversal: a completed IntentResult creates real Intent/Outcome nodes and a PRODUCED relationship in the real Python Graph Traversal service", { skip: !SERVICES_AVAILABLE }, async (t) => {
  const proc = startService("graph-traversal", GRAPH_TRAVERSAL_PORT);
  t.after(() => proc.kill());
  await waitForHealth(`${GRAPH_TRAVERSAL_BASE_URL}/graph/health`);

  const env = { GRAPH_TRAVERSAL_BASE_URL };
  const packet = { intent: "explain the RCT-7 decomposition process" };
  const result = {
    intent_hash: "gt-bridge-test-hash",
    state: "completed",
    output: { specialist_model: "test-model", output: "RCT-7 decomposes intent into observe/analyze/deconstruct stages." },
    latency_ms: 500,
    cache_hit: false,
    metadata: {},
  };

  await syncToGraphTraversal(env, "gt-bridge-session", packet, result);

  // Real verification: query the real service directly for the node it
  // was told to fetch, not just that syncToGraphTraversal() didn't throw.
  const nodeResp = await fetch(`${GRAPH_TRAVERSAL_BASE_URL}/graph/nodes/intent-gt-bridge-session-gt-bridge-test-hash`);
  assert.equal(nodeResp.status, 200, "the Intent node must genuinely exist in Graph Traversal");
  const node = await nodeResp.json();
  assert.ok(node.labels?.includes("Intent"), "the node must carry the Intent label");
  assert.equal(node.properties?.text, packet.intent, "the node's real properties must match what was synced");
});

test("syncToGraphTraversal: without GRAPH_TRAVERSAL_BASE_URL configured, it is a genuine silent no-op", async () => {
  const env = {};
  const packet = { intent: "anything" };
  const result = { intent_hash: "x", state: "completed", output: { output: "y" }, latency_ms: 1, cache_hit: false, metadata: {} };
  await assert.doesNotReject(() => syncToGraphTraversal(env, "no-bridge-session", packet, result));
});

test("analyzeIntentLoopTradeoffs: a completed IntentResult gets a real MOIP trade-off analysis, remembered in GraphRAG", { skip: !SERVICES_AVAILABLE }, async (t) => {
  const moip = startService("moip-planner", MOIP_PORT);
  const graphrag = startService("graphrag-complete", GRAPHRAG_PORT);
  t.after(() => {
    moip.kill();
    graphrag.kill();
  });
  await Promise.all([waitForHealth(`${MOIP_BASE_URL}/health`), waitForHealth(`${GRAPHRAG_BASE_URL}/health`)]);

  const env = { MOIP_PLANNER_BASE_URL: MOIP_BASE_URL, GRAPHRAG_BASE_URL };
  const uniqueMarker = `moip-bridge-marker-${Date.now()}`;
  const packet = { intent: `analyze this real run ${uniqueMarker}` };
  const result = {
    intent_hash: "moip-bridge-test-hash",
    state: "completed",
    output: { specialist_model: "test-model", output: `result ${uniqueMarker}` },
    latency_ms: 800,
    cache_hit: false,
    fdia_score: 0.85,
    verification: { passed: true, confidence: 0.9, votes: [] },
    metadata: {},
  };

  await analyzeIntentLoopTradeoffs(env, "moip-bridge-session", packet, result);

  // The recommendation must be genuinely remembered in GraphRAG - not
  // just that the call didn't throw.
  const session = await searchGraphragDocuments(GRAPHRAG_BASE_URL, uniqueMarker, "vector", 5);
  const found = session.results.find((r) => r.content.includes(uniqueMarker));
  assert.ok(found, "the MOIP trade-off recommendation must be synced into GraphRAG as real semantic memory");
  assert.match(found.content, /MOIP trade-off analysis/);
});

test("analyzeIntentLoopTradeoffs: without MOIP_PLANNER_BASE_URL configured, it is a genuine silent no-op", async () => {
  const env = {};
  const packet = { intent: "anything" };
  const result = { intent_hash: "x", state: "completed", output: { output: "y" }, latency_ms: 1, cache_hit: false, metadata: {} };
  await assert.doesNotReject(() => analyzeIntentLoopTradeoffs(env, "no-bridge-session", packet, result));
});
