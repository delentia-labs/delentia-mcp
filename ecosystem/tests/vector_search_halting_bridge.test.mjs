/**
 * REAL TS<->Python BRIDGE TEST — Vector Search and Halting Detection
 *
 * Extends the TS<->Python bridge (see graphrag_bridge.test.mjs for the
 * GraphRAG half) to the other two audited-real Python services:
 *
 * - Vector Search (ALGO-16, real FAISS backend): syncToVectorSearch()
 *   embeds a completed intent-loop result via the shared hashing-trick
 *   algorithm (verified byte-for-byte identical to GraphRAG's Python-side
 *   embedding — see hashing-embedding.test.mjs) and indexes it into a
 *   real ANN index, a second complementary real memory backend alongside
 *   GraphRAG.
 * - Halting Detection (ALGO-22, real sandboxed timeout+memory-limit
 *   enforcement): checkGeneratedCodeHalts() safety-checks a real fenced
 *   code block found in a "code" specialist role's output, and — the
 *   same pattern already proven end-to-end on the Python side
 *   (integration-tests/test_graphrag_halting_e2e.py) — remembers the
 *   finding in GraphRAG when both bridges are configured together.
 *
 * All three real Python services are started as real subprocesses; no
 * mocking of the far side.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { syncToVectorSearch, checkGeneratedCodeHalts } from "../packages/intent-loop/dist/worker.js";
import { searchTextAsVector, searchGraphragDocuments } from "../packages/shared/dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Set DELENTIA_PRIVATE_SERVICES_DIR to a local checkout of the (non-public) Python services to run this.
const MICROSERVICES_DIR = process.env.DELENTIA_PRIVATE_SERVICES_DIR ? path.resolve(process.env.DELENTIA_PRIVATE_SERVICES_DIR) : path.join(__dirname, "__private_services_not_configured__");
const SERVICES_AVAILABLE = fs.existsSync(path.join(MICROSERVICES_DIR, "vector-search", "app", "main.py"))
  && fs.existsSync(path.join(MICROSERVICES_DIR, "halting-detection", "app", "main.py"))
  && fs.existsSync(path.join(MICROSERVICES_DIR, "graphrag-complete", "app", "main.py"));

if (!SERVICES_AVAILABLE) {
  console.log(`SKIPPING vector_search_halting_bridge.test.mjs — sibling Python repo/services not found under ${MICROSERVICES_DIR}`);
}

const VECTOR_SEARCH_PORT = 8016;
const VECTOR_SEARCH_BASE_URL = `http://127.0.0.1:${VECTOR_SEARCH_PORT}`;
const VECTOR_SEARCH_DIMENSION = "768"; // matches the real service's own default (app/main.py DIMENSION)

const HALTING_PORT = 8022;
const HALTING_BASE_URL = `http://127.0.0.1:${HALTING_PORT}`;

const GRAPHRAG_PORT = 8013;
const GRAPHRAG_BASE_URL = `http://127.0.0.1:${GRAPHRAG_PORT}`;

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
  throw new Error(`Service at ${url} did not become healthy in time: ${lastError}`);
}

function startService(dirName, port, healthPath) {
  const cwd = path.join(MICROSERVICES_DIR, dirName);
  const proc = spawn(
    "python",
    ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(port)],
    { cwd, env: { ...process.env, PYTHONPATH: cwd }, stdio: "pipe" }
  );
  return { proc, healthUrl: `http://127.0.0.1:${port}${healthPath}` };
}

function stopService(handle) {
  handle.proc.kill();
}

test("syncToVectorSearch: a real completed IntentResult is embedded and indexed into the real Python Vector Search service", { skip: !SERVICES_AVAILABLE }, async (t) => {
  const svc = startService("vector-search", VECTOR_SEARCH_PORT, "/vector/health");
  t.after(() => stopService(svc));
  await waitForHealth(svc.healthUrl);

  const env = { VECTOR_SEARCH_BASE_URL, VECTOR_SEARCH_DIMENSION };
  const uniqueMarker = `vs-bridge-marker-${Date.now()}`;
  const packet = { intent: `Explain the RCTDB 8-dimension schema ${uniqueMarker}` };
  const result = {
    intent_hash: "vs-bridge-test-hash",
    state: "completed",
    output: { specialist_model: "test-model", output: `RCTDB records query_hash, fdia_scores, subject_uuid ${uniqueMarker}` },
    latency_ms: 500,
    cache_hit: false,
    metadata: {},
  };

  await syncToVectorSearch(env, "vs-bridge-session", packet, result);

  // Real search over the network against the same live service, using the
  // identical hashing-trick embedding — this is the actual round trip.
  const search = await searchTextAsVector(VECTOR_SEARCH_BASE_URL, uniqueMarker, 768, 5);
  const found = search.results.find((r) => r.id === `intent-loop-vs-bridge-session-vs-bridge-test-hash`);
  assert.ok(found, "the document synced from the intent-loop result must be found by real vector search");
  assert.ok(found.score > 0, "a real embedding must produce a non-zero similarity score for a query sharing its exact vocabulary");
});

test("syncToVectorSearch: without VECTOR_SEARCH_BASE_URL configured, it is a genuine silent no-op", async () => {
  const env = {};
  const packet = { intent: "anything" };
  const result = { intent_hash: "x", state: "completed", output: { output: "y" }, latency_ms: 1, cache_hit: false, metadata: {} };
  await assert.doesNotReject(() => syncToVectorSearch(env, "no-bridge-session", packet, result));
});

test("checkGeneratedCodeHalts: a genuinely infinite generated code block is safety-checked by the real Halting Detection service and remembered in GraphRAG", { skip: !SERVICES_AVAILABLE }, async (t) => {
  const halting = startService("halting-detection", HALTING_PORT, "/halting/health");
  const graphrag = startService("graphrag-complete", GRAPHRAG_PORT, "/health");
  t.after(() => {
    stopService(halting);
    stopService(graphrag);
  });
  await Promise.all([waitForHealth(halting.healthUrl), waitForHealth(graphrag.healthUrl)]);

  const env = { HALTING_DETECTION_BASE_URL: HALTING_BASE_URL, GRAPHRAG_BASE_URL };
  const uniqueMarker = `halting-bridge-marker-${Date.now()}`;
  const packet = { intent: `debug this function ${uniqueMarker}` }; // matches CODE_INTENT_RE ("debug"/"function")
  const result = {
    intent_hash: "halting-bridge-test-hash",
    state: "completed",
    output: {
      specialist_model: "test-model",
      output: `Here is the generated function ${uniqueMarker}:\n\`\`\`python\nwhile True:\n    pass\n\`\`\`\n`,
    },
    latency_ms: 500,
    cache_hit: false,
    metadata: {},
  };

  const start = Date.now();
  await checkGeneratedCodeHalts(env, "halting-bridge-session", packet, result);
  const elapsed = Date.now() - start;

  // Real enforcement through the full chain: this took real time to
  // actually run the code in Halting Detection's sandbox (bounded by the
  // 3000ms passed to checkCodeHalts), not an instant no-op.
  assert.ok(elapsed >= 1000, `expected the real sandboxed check to take real time, took ${elapsed}ms`);

  // Confirm the finding was genuinely remembered in GraphRAG - not just
  // that checkGeneratedCodeHalts() didn't throw.
  const session = await searchGraphragDocuments(GRAPHRAG_BASE_URL, uniqueMarker, "vector", 5);
  const found = session.results.find((r) => r.content.includes(uniqueMarker));
  assert.ok(found, "the halting-check finding must be synced into GraphRAG as real semantic memory");
  assert.match(found.content, /did NOT halt within the timeout/, "an infinite loop must be reported as not halting, not silently passed");
});

test("checkGeneratedCodeHalts: an intent unrelated to code is never checked, even with both bridges configured", { skip: !SERVICES_AVAILABLE }, async (t) => {
  const halting = startService("halting-detection", HALTING_PORT, "/halting/health");
  t.after(() => stopService(halting));
  await waitForHealth(halting.healthUrl);

  const env = { HALTING_DETECTION_BASE_URL: HALTING_BASE_URL, GRAPHRAG_BASE_URL };
  const packet = { intent: "Explain how photosynthesis works" }; // no code-role keywords
  const result = {
    intent_hash: "non-code-hash",
    state: "completed",
    output: { specialist_model: "test-model", output: "```python\nwhile True:\n    pass\n```" },
    latency_ms: 500,
    cache_hit: false,
    metadata: {},
  };

  const start = Date.now();
  await assert.doesNotReject(() => checkGeneratedCodeHalts(env, "non-code-session", packet, result));
  const elapsed = Date.now() - start;
  // Must return near-instantly - never reaches the real sandboxed check
  // because the intent doesn't match the code-role heuristic.
  assert.ok(elapsed < 500, `expected an instant no-op for a non-code intent, took ${elapsed}ms`);
});
