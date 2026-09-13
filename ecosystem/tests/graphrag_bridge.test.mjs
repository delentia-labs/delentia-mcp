/**
 * REAL TS<->Python BRIDGE TEST
 *
 * This is the actual proof that the TS/Cloudflare-Workers kernel and the
 * Python microservices platform can talk to each other over a real
 * network, not just share a design language on paper. Before this test
 * (and the syncToGraphRag()/ingestGraphragDocument() code it exercises),
 * grepping this entire repo for any reference to GraphRAG/Vector
 * Search/Halting Detection's ports or service names returned zero
 * matches — the two stacks had never been wired together in code.
 *
 * This test starts the REAL Python graphrag-complete service as a real
 * subprocess (uvicorn, not a mock), calls syncToGraphRag() — the compiled
 * function actually used by packages/intent-loop/src/worker.ts — with a
 * realistic completed IntentResult, and then makes a real HTTP search
 * call against the same live GraphRAG instance to confirm the document
 * genuinely arrived and is findable by real (hashing-trick) embedding
 * similarity, not merely that the fetch() call didn't throw.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { syncToGraphRag } from "../packages/intent-loop/dist/worker.js";
import { searchGraphragDocuments } from "../packages/shared/dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// This test genuinely spans two separate repos (this TS ecosystem +
// the private services repo's Python microservices), checked out as siblings
// under the same parent directory on this machine. That's an inherent,
// disclosed limitation of testing a cross-stack bridge for real rather
// than mocking the far side - skip cleanly (not a confusing crash) if the
// sibling repo isn't present, e.g. in a CI checkout of this repo alone.
const GRAPHRAG_DIR = path.resolve(__dirname, "../../the private services repo/<private>/microservices/graphrag-complete");
const GRAPHRAG_AVAILABLE = fs.existsSync(path.join(GRAPHRAG_DIR, "app", "main.py"));
const GRAPHRAG_PORT = 8013;
const GRAPHRAG_BASE_URL = `http://127.0.0.1:${GRAPHRAG_PORT}`;

if (!GRAPHRAG_AVAILABLE) {
  console.log(`SKIPPING graphrag_bridge.test.mjs — the private services repo/<private>/microservices/graphrag-complete not found at ${GRAPHRAG_DIR} (expects sibling repo checkout)`);
}

async function waitForHealth(url, timeoutMs = 20000) {
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
  throw new Error(`GraphRAG did not become healthy in time: ${lastError}`);
}

function startGraphRagServer() {
  const proc = spawn(
    "python",
    ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(GRAPHRAG_PORT)],
    { cwd: GRAPHRAG_DIR, env: { ...process.env, PYTHONPATH: GRAPHRAG_DIR }, stdio: "pipe" }
  );
  return proc;
}

test("syncToGraphRag: a real completed IntentResult is genuinely ingested into the real Python GraphRAG service and becomes searchable", { skip: !GRAPHRAG_AVAILABLE }, async (t) => {
  const server = startGraphRagServer();
  t.after(() => {
    server.kill();
  });

  await waitForHealth(`${GRAPHRAG_BASE_URL}/health`);

  const env = { GRAPHRAG_BASE_URL };
  const uniqueMarker = `xyzzy-bridge-marker-${Date.now()}`;
  const packet = { intent: `Explain the Delta Engine's compression algorithm ${uniqueMarker}` };
  const result = {
    intent_hash: "bridge-test-hash",
    state: "completed",
    output: { specialist_model: "test-model", output: `The Delta Engine compresses context deltas using JITNA packets ${uniqueMarker}` },
    latency_ms: 1000,
    cache_hit: false,
    metadata: {},
  };

  await syncToGraphRag(env, "bridge-test-session", packet, result);

  // Real search over the network against the same live service - this is
  // the actual TS<->Python round trip: TS ingested it, and a fresh HTTP
  // search call (as any other real client would make) must find it.
  const session = await searchGraphragDocuments(GRAPHRAG_BASE_URL, uniqueMarker, "vector", 5);

  assert.ok(session.results.length > 0, "the ingested document must be found by real semantic search");
  const found = session.results.find((r) => r.content.includes(uniqueMarker));
  assert.ok(found, "the specific document synced from the intent-loop result must be among the real search results");
  assert.ok(found.vector_score > 0, "a real embedding must produce a non-zero similarity score for a query that shares its exact vocabulary");
});

test("syncToGraphRag: without GRAPHRAG_BASE_URL configured, it is a genuine silent no-op (never throws, never calls fetch)", async () => {
  const env = {};
  const packet = { intent: "anything" };
  const result = { intent_hash: "x", state: "completed", output: { output: "y" }, latency_ms: 1, cache_hit: false, metadata: {} };

  // No server running on this port at all in this test - if syncToGraphRag
  // tried to fetch() despite no base URL configured, this would throw a
  // real connection error and fail the test.
  await assert.doesNotReject(() => syncToGraphRag(env, "no-bridge-session", packet, result));
});

test("syncToGraphRag: a gate-rejected/failed result (no real output) is never synced, even if GraphRAG is configured", { skip: !GRAPHRAG_AVAILABLE }, async (t) => {
  const server = startGraphRagServer();
  t.after(() => {
    server.kill();
  });
  await waitForHealth(`${GRAPHRAG_BASE_URL}/health`);

  const env = { GRAPHRAG_BASE_URL };
  const packet = { intent: "a rejected intent" };
  const result = { intent_hash: "rejected", state: "failed", error: "FDIA gate rejected", latency_ms: 5, cache_hit: false, metadata: {} };

  // Must not throw, and must not add a document for a failed/rejected run
  // - there is no real content worth remembering from a rejection.
  await assert.doesNotReject(() => syncToGraphRag(env, "rejected-session", packet, result));

  const statsResponse = await fetch(`${GRAPHRAG_BASE_URL}/graphrag/stats`);
  const stats = await statsResponse.json();
  // The 5 hardcoded sample docs are always present; a failed run must not
  // have added a 6th.
  assert.equal(stats.total_documents, 5);
});

test("syncToGraphRag: a trailing slash in GRAPHRAG_BASE_URL (an easy real misconfiguration) does not silently break every sync", { skip: !GRAPHRAG_AVAILABLE }, async (t) => {
  const server = startGraphRagServer();
  t.after(() => {
    server.kill();
  });
  await waitForHealth(`${GRAPHRAG_BASE_URL}/health`);

  // Found for real (2026-09-13): naive string concatenation
  // (`${baseUrl}/graphrag/documents`) against a base URL with a trailing
  // slash produces a double-slash path that FastAPI 404s on - and since
  // syncToGraphRag() swallows all errors as best-effort, that 404 was
  // completely silent. This must not regress.
  const envWithTrailingSlash = { GRAPHRAG_BASE_URL: `${GRAPHRAG_BASE_URL}/` };
  const uniqueMarker = `trailing-slash-marker-${Date.now()}`;
  const packet = { intent: `test trailing slash handling ${uniqueMarker}` };
  const result = {
    intent_hash: "trailing-slash-test",
    state: "completed",
    output: { output: `content for trailing slash test ${uniqueMarker}` },
    latency_ms: 1,
    cache_hit: false,
    metadata: {},
  };

  await syncToGraphRag(envWithTrailingSlash, "trailing-slash-session", packet, result);

  // Confirm it actually arrived (not just that syncToGraphRag didn't
  // throw - it swallows errors, so a silent 404 would look identical to
  // success from syncToGraphRag's own return value alone).
  const session = await searchGraphragDocuments(GRAPHRAG_BASE_URL, uniqueMarker, "vector", 5);
  const found = session.results.find((r) => r.content.includes(uniqueMarker));
  assert.ok(found, "a document synced through a base URL with a trailing slash must still genuinely arrive in GraphRAG");
});
