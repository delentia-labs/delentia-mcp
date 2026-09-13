/**
 * DELENTIA INTENT LOOP WORKER — RCTDB logging wiring tests
 *
 * Tests logToRctdb() (exported from packages/intent-loop/src/worker.ts)
 * directly against a REAL RCTDBLogSessionDO (via the same fake-namespace
 * harness used elsewhere), using a realistic IntentResult shape as
 * produced by IntentLoopEngine.process() — without needing a real
 * OPENROUTER_API_KEY/network call, since this only tests the logging glue
 * between a completed result and the Durable Object, not the model call
 * that produced it (that's covered by tests/intent_loop.test.mjs and the
 * live test).
 */

import test from "node:test";
import assert from "node:assert/strict";

import { logToRctdb } from "../packages/intent-loop/dist/worker.js";
import { RCTDBLogSessionDO } from "../packages/shared/dist/index.js";
import { createFakeDurableObjectNamespace } from "./helpers/fake-durable-object.mjs";

function fakeEnv() {
  return { RCTDB_LOG_DO: createFakeDurableObjectNamespace(RCTDBLogSessionDO) };
}

async function queryLog(namespace, sessionId) {
  const doId = namespace.idFromName(sessionId);
  const stub = namespace.get(doId);
  const resp = await stub.fetch("http://rctdb/all");
  return resp.json();
}

test("logToRctdb: a completed run_intent_loop result is logged with all 8 real dimensions", async () => {
  const env = fakeEnv();
  const packet = { intent: "explain how photosynthesis works" };
  const result = {
    intent_hash: "abc123",
    state: "completed",
    output: { specialist_model: "nex-agi/nex-n2.5-pro:free", output: "Photosynthesis converts light into chemical energy." },
    latency_ms: 3200,
    cache_hit: false,
    verification: {
      passed: true,
      confidence: 1,
      votes: [
        { model: "liquid/lfm-2.5-2.6b:free", agree: true },
        { model: "inclusionai/ling-3.0-flash-vl:free", agree: true },
        { model: "cohere/north-mini-code:free", agree: true },
      ],
    },
    fdia_score: 0.675,
    mee_step: { step: 1, g_before: 1.0, g_after: 1.1, delta: 1, meta_rate: 0.1, resilience: 1, governance_violation: false, growth_ratio: 1.1, timestamp: "2026-09-13T00:00:00.000Z" },
    metadata: { specialist_role: "general" },
  };

  await logToRctdb(env, "test-session-1", packet, result);

  const stored = await queryLog(env.RCTDB_LOG_DO, "test-session-1");
  assert.equal(stored.total, 1);
  const entry = stored.entries[0];
  assert.equal(entry.fdia_scores.future_score, 0.675);
  assert.deepEqual(entry.model_chain, ["nex-agi/nex-n2.5-pro:free", "liquid/lfm-2.5-2.6b:free", "inclusionai/ling-3.0-flash-vl:free", "cohere/north-mini-code:free"]);
  assert.deepEqual(entry.consensus_result, { passed: true, confidence: 1 });
  assert.deepEqual(entry.delta_chain, { g_before: 1.0, g_after: 1.1, delta: 1 });
  assert.equal(entry.provenance.source, "run_intent_loop");
});

test("logToRctdb: a rejected (gate-failed) result — no fdia_score, no verification, no mee_step — logs a minimal-but-real entry, not a crash", async () => {
  const env = fakeEnv();
  const packet = { intent: "drop the production database table" };
  const result = {
    intent_hash: "def456",
    state: "failed",
    error: "FDIA gate rejected intent: ...",
    latency_ms: 0,
    cache_hit: false,
    metadata: {},
  };

  await logToRctdb(env, "test-session-2", packet, result);

  const stored = await queryLog(env.RCTDB_LOG_DO, "test-session-2");
  assert.equal(stored.total, 1);
  assert.equal(stored.entries[0].fdia_scores, null, "no fdia_score on the result means fdia_scores must be honestly null, not fabricated");
  assert.equal(stored.entries[0].consensus_result, null);
  assert.equal(stored.entries[0].delta_chain, null);
});

test("logToRctdb: missing RCTDB_LOG_DO binding is a silent no-op, never throws", async () => {
  await assert.doesNotReject(logToRctdb({}, "test-session", { intent: "x" }, { intent_hash: "h", state: "completed", latency_ms: 1, cache_hit: false, metadata: {} }));
});

test("logToRctdb: different session ids get genuinely isolated RCTDB logs, matching the same explicit-scoping design as MEE growth", async () => {
  const env = fakeEnv();
  await logToRctdb(env, "session-alice", { intent: "task one" }, { intent_hash: "h1", state: "completed", latency_ms: 1, cache_hit: false, fdia_score: 0.8, metadata: {} });
  await logToRctdb(env, "session-bob", { intent: "task two" }, { intent_hash: "h2", state: "completed", latency_ms: 1, cache_hit: false, fdia_score: 0.6, metadata: {} });

  const aliceLog = await queryLog(env.RCTDB_LOG_DO, "session-alice");
  const bobLog = await queryLog(env.RCTDB_LOG_DO, "session-bob");
  assert.equal(aliceLog.total, 1);
  assert.equal(bobLog.total, 1);
  assert.equal(aliceLog.entries[0].fdia_scores.future_score, 0.8);
  assert.equal(bobLog.entries[0].fdia_scores.future_score, 0.6);
});
