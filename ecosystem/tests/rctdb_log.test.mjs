/**
 * DELENTIA RCTDB-inspired 8-dimension log — schema + Durable Object tests
 *
 * Context: "RCTDB" as originally designed (a separately-hosted database
 * service) was found this session to be mostly a stub — a client with no
 * real server, a schema file with a real shipped bug, self-mocking tests.
 * The 8-dimension SCHEMA itself was judged worth keeping; the recommended
 * fix was folding it into the same Durable-Object-backed pattern already
 * proven with MEEGrowthSessionDO, rather than building a separate hosted
 * service. These tests prove the schema against REAL output from three
 * different real tools (FDIA, Delta Engine, JITNA/orchestrate_swarm) — not
 * hand-crafted fixtures — and prove the Durable Object persists/queries
 * real entries correctly via the same real (not mocked) fake-namespace
 * harness used for MEEGrowthSessionDO.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  RCTDBLog,
  RCTDBLogSessionDO,
  computeQueryHash,
  buildRctdbEntryFromFdia,
  buildRctdbEntryFromDelta,
  buildRctdbEntryFromJitna,
  buildRctdbEntryFromIntentLoop,
  evaluateFDIA,
} from "../packages/shared/dist/index.js";
import { compressContext } from "../packages/delta/dist/index.js";
import { orchestrateSwarm } from "../packages/jitna/dist/index.js";
import { createFakeDurableObjectNamespace } from "./helpers/fake-durable-object.mjs";

// ============================================================================
// Schema tested against REAL output from 3 different real tools
// ============================================================================

test("buildRctdbEntryFromFdia: captures a REAL evaluate_fdia() result, trimmed to exactly the documented 3 fields (not a leak of the full internal result)", () => {
  const realResult = evaluateFDIA({
    data_quality: 0.9,
    intent_precision: 1.2,
    authorized: true,
    action_name: "deploy_new_service",
    caller_role: "developer",
    dual_signoff_confirmed: false,
  });
  const entry = buildRctdbEntryFromFdia({
    actionName: "deploy_new_service",
    fdiaResult: realResult,
    subjectUuid: "agent-session-001",
    provenance: { source: "evaluate_fdia", version: "1.2.0" },
  });

  assert.deepEqual(Object.keys(entry.fdia_scores).sort(), ["effective_A", "future_score", "verdict"]);
  assert.equal(entry.fdia_scores.future_score, realResult.future_score);
  assert.equal(entry.fdia_scores.verdict, realResult.verdict);
  assert.equal(entry.model_chain.length, 0, "FDIA alone never calls a model — model_chain must be honestly empty, not fabricated");
  assert.equal(entry.consensus_result, null, "FDIA alone runs no consensus vote");
});

test("buildRctdbEntryFromDelta: captures a REAL compress_context() result — delta_chain reflects the tool's actual computed reduction, not a placeholder", () => {
  const realCompression = compressContext({
    raw_context: "Agent called tool X.\nAgent called tool X.\nAgent called tool Y.\nError: timeout.\nRetrying...\nSuccess.",
    intent_focus: "debug the timeout error",
  });
  const entry = buildRctdbEntryFromDelta({
    subjectUuid: "agent-session-001",
    compressionResult: realCompression,
    provenance: { source: "compress_context", version: "1.1.0" },
  });

  assert.equal(entry.query_hash, realCompression.context_hash, "query_hash must be the tool's own real content hash, not a re-derived one");
  assert.equal(entry.delta_chain.reduction_percentage, realCompression.reduction_percentage);
  assert.equal(entry.fdia_scores, null, "Delta Engine alone never runs an FDIA gate");
  assert.equal(entry.model_chain.length, 0, "Delta Engine never calls a model");
});

test("buildRctdbEntryFromJitna: captures a REAL orchestrateSwarm() packet — model_chain reflects the actually-routed pillar, delta_chain the packet's real D/delta", () => {
  const realSwarm = orchestrateSwarm({ objective: "provision a new GPU cluster in us-east-1", data_readiness: 60, target_pillar: "auto" });
  const entry = buildRctdbEntryFromJitna({
    subjectUuid: "agent-session-001",
    packet: realSwarm.jitna_packet,
    provenance: { source: "orchestrate_swarm", version: "1.1.0" },
  });

  assert.equal(entry.query_hash, computeQueryHash(realSwarm.jitna_packet.I));
  assert.deepEqual(entry.model_chain, [realSwarm.jitna_packet.A]);
  assert.equal(entry.delta_chain.D, realSwarm.jitna_packet.D);
  assert.equal(entry.delta_chain.delta, realSwarm.jitna_packet.delta);
});

test("buildRctdbEntryFromIntentLoop: consensus_result is trimmed to {passed, confidence} even when handed the full real VerificationResult (which also carries a votes array)", () => {
  const fullVerificationResult = { passed: true, confidence: 0.8333, votes: [{ model: "a", agree: true }, { model: "b", agree: true }, { model: "c", agree: false }] };
  const entry = buildRctdbEntryFromIntentLoop({
    subjectUuid: "s1",
    queryText: "explain how photosynthesis works",
    fdiaScore: 0.72,
    verdict: "AUTHORIZED",
    specialistModel: "nex-agi/nex-n2.5-pro:free",
    verifierModels: ["liquid/lfm-2.5-2.6b:free", "inclusionai/ling-3.0-flash-vl:free", "cohere/north-mini-code:free"],
    verification: fullVerificationResult,
    meeStep: { g_before: 1.0, g_after: 1.1, delta: 1 },
    provenance: { source: "run_intent_loop", version: "0.1.0" },
  });

  assert.deepEqual(Object.keys(entry.consensus_result).sort(), ["confidence", "passed"]);
  assert.equal(entry.consensus_result.confidence, 0.8333);
  assert.equal(entry.model_chain.length, 4, "specialist + 3 verifier models");
  assert.equal(entry.delta_chain.g_after, 1.1);
});

// ============================================================================
// RCTDBLog — in-memory rolling log logic
// ============================================================================

test("RCTDBLog: query filters by subject_uuid and query_hash independently and combined", () => {
  const log = new RCTDBLog();
  const e1 = buildRctdbEntryFromJitna({ subjectUuid: "alice", packet: { I: "task_a", D: 50, delta: 50, A: "router" }, provenance: { source: "t", version: "1" } });
  const e2 = buildRctdbEntryFromJitna({ subjectUuid: "bob", packet: { I: "task_b", D: 50, delta: 50, A: "guardian" }, provenance: { source: "t", version: "1" } });
  const e3 = buildRctdbEntryFromJitna({ subjectUuid: "alice", packet: { I: "task_a", D: 60, delta: 40, A: "router" }, provenance: { source: "t", version: "1" } });
  log.append(e1);
  log.append(e2);
  log.append(e3);

  assert.equal(log.query({ subject_uuid: "alice" }).length, 2);
  assert.equal(log.query({ subject_uuid: "bob" }).length, 1);
  assert.equal(log.query({ query_hash: e1.query_hash }).length, 2, "e1 and e3 share the same intent text I, so the same query_hash");
  assert.equal(log.query({ subject_uuid: "alice", query_hash: e1.query_hash }).length, 2);
});

test("RCTDBLog: is a bounded rolling log — oldest entries are dropped, not grown without limit", () => {
  const log = new RCTDBLog([], 5);
  for (let i = 0; i < 10; i++) {
    log.append(buildRctdbEntryFromJitna({ subjectUuid: "s", packet: { I: `task_${i}`, D: 50, delta: 50, A: "router" }, provenance: { source: "t", version: "1" } }));
  }
  assert.equal(log.size, 5, "must be capped at maxEntries, not grow to 10");
  const all = log.all();
  assert.equal(all[0].query_hash, computeQueryHash("task_5"), "the oldest 5 entries (task_0..task_4) must have been dropped");
  assert.equal(all[4].query_hash, computeQueryHash("task_9"));
});

// ============================================================================
// RCTDBLogSessionDO — real Durable Object persistence (fake namespace, real class)
// ============================================================================

async function appendEntry(namespace, sessionId, entry) {
  const doId = namespace.idFromName(sessionId);
  const stub = namespace.get(doId);
  const resp = await stub.fetch("http://rctdb/append", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(entry),
  });
  return resp.json();
}

async function queryEntries(namespace, sessionId, params) {
  const doId = namespace.idFromName(sessionId);
  const stub = namespace.get(doId);
  const qs = new URLSearchParams(params).toString();
  const resp = await stub.fetch(`http://rctdb/query?${qs}`);
  return resp.json();
}

test("RCTDBLogSessionDO: real append + real persistence across separate calls to the same session", async () => {
  const namespace = createFakeDurableObjectNamespace(RCTDBLogSessionDO);
  const entry1 = buildRctdbEntryFromJitna({ subjectUuid: "alice", packet: { I: "first_task", D: 50, delta: 50, A: "router" }, provenance: { source: "t", version: "1" } });
  const entry2 = buildRctdbEntryFromJitna({ subjectUuid: "alice", packet: { I: "second_task", D: 60, delta: 40, A: "executor" }, provenance: { source: "t", version: "1" } });

  const r1 = await appendEntry(namespace, "prod-log", entry1);
  assert.equal(r1.appended, true);
  assert.equal(r1.total_entries, 1);

  const r2 = await appendEntry(namespace, "prod-log", entry2);
  assert.equal(r2.total_entries, 2, "second call must see the first call's entry still there — real persistence, not a fresh tracker each time");
});

test("RCTDBLogSessionDO: a different session id gets a genuinely isolated log", async () => {
  const namespace = createFakeDurableObjectNamespace(RCTDBLogSessionDO);
  await appendEntry(namespace, "session-a", buildRctdbEntryFromJitna({ subjectUuid: "x", packet: { I: "task", D: 50, delta: 50, A: "router" }, provenance: { source: "t", version: "1" } }));
  const otherSessionResult = await appendEntry(namespace, "session-b", buildRctdbEntryFromJitna({ subjectUuid: "y", packet: { I: "task", D: 50, delta: 50, A: "router" }, provenance: { source: "t", version: "1" } }));
  assert.equal(otherSessionResult.total_entries, 1, "a different session id must start its own log at 0, unaffected by session-a's entry");
});

test("RCTDBLogSessionDO: real query endpoint filters real persisted entries by subject_uuid", async () => {
  const namespace = createFakeDurableObjectNamespace(RCTDBLogSessionDO);
  await appendEntry(namespace, "shared-log", buildRctdbEntryFromJitna({ subjectUuid: "alice", packet: { I: "task_1", D: 50, delta: 50, A: "router" }, provenance: { source: "t", version: "1" } }));
  await appendEntry(namespace, "shared-log", buildRctdbEntryFromJitna({ subjectUuid: "bob", packet: { I: "task_2", D: 50, delta: 50, A: "guardian" }, provenance: { source: "t", version: "1" } }));
  await appendEntry(namespace, "shared-log", buildRctdbEntryFromJitna({ subjectUuid: "alice", packet: { I: "task_3", D: 50, delta: 50, A: "executor" }, provenance: { source: "t", version: "1" } }));

  const aliceResult = await queryEntries(namespace, "shared-log", { subject_uuid: "alice" });
  assert.equal(aliceResult.total, 2);
  assert.ok(aliceResult.results.every((e) => e.subject_uuid === "alice"));
});

test("RCTDBLogSessionDO: rejects a malformed entry (missing required fields) with 400, never silently accepting garbage", async () => {
  const namespace = createFakeDurableObjectNamespace(RCTDBLogSessionDO);
  const doId = namespace.idFromName("test-session");
  const stub = namespace.get(doId);
  const resp = await stub.fetch("http://rctdb/append", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ not_a_valid_entry: true }),
  });
  assert.equal(resp.status, 400);
});
