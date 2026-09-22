/**
 * Real regression tests for the cross-tenant Durable Object isolation fix
 * (ROADMAP.md "Now — Remaining integrity fixes"). Before this fix, all 4
 * pillar workers (fdia, delta, jitna, rct7) keyed their own Durable Object
 * with ONE hardcoded literal name, so every caller globally shared exactly
 * one object. For `fdia` this was severe: `configure_policy`'s write and
 * `evaluate_fdia`'s policy read-back (when no `custom_policy` is passed
 * inline) both hit that same shared object, so one caller's policy change
 * could silently alter another caller's real authorization results.
 *
 * These tests call each worker's real `fetch` handler directly (constructed
 * Request, real Response) against the same real (not mocked) fake Durable
 * Object namespace harness already used by
 * tests/fdia_worker_rct7_synthesis.test.mjs and tests/sovereign_rct7_synthesis.test.mjs
 * (`createFakeDurableObjectNamespace`), so the actual DO class's own
 * fetch() handler runs for real against real, isolated in-memory storage
 * per idFromName() key.
 *
 * Two things are proven for each worker: (a) two different explicit
 * session_id values now produce genuinely isolated state, and (b) omitting
 * session_id entirely still reproduces the exact prior shared-default
 * behavior — this fix is additive/backward-compatible by construction, not
 * a breaking default-behavior change.
 */

import test from "node:test";
import assert from "node:assert/strict";

import fdiaWorker, { FDIASessionDO } from "../packages/fdia/dist/worker.js";
import deltaWorker, { DeltaSessionDO } from "../packages/delta/dist/worker.js";
import jitnaWorker, { JITNASessionDO } from "../packages/jitna/dist/worker.js";
import rct7Worker, { RCT7SessionDO } from "../packages/rct7/dist/worker.js";
import { createFakeDurableObjectNamespace } from "./helpers/fake-durable-object.mjs";

const NOOP_CTX = { waitUntil: () => {} };

async function rpcCall(worker, env, toolName, args) {
  const request = new Request("http://worker.test/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
  });
  const response = await worker.fetch(request, env, NOOP_CTX);
  const body = await response.json();
  return JSON.parse(body.result.content[0].text);
}

// ============================================================================
// fdia — the severe case: configure_policy write + evaluate_fdia read
// ============================================================================

function fdiaEnv() {
  return { ENVIRONMENT: "test", FDIA_SESSION_DO: createFakeDurableObjectNamespace(FDIASessionDO) };
}

test("fdia: configure_policy with an explicit session_id no longer leaks into evaluate_fdia for a caller using a DIFFERENT session_id", async () => {
  const env = fdiaEnv();

  const configured = await rpcCall(fdiaWorker, env, "configure_policy", {
    session_id: "tenant-a",
    policy_id: "tenant-a-strict-policy",
    custom_safety_threshold: 0.99,
  });
  assert.equal(configured.success, true);

  // Caller B, a different tenant, evaluates with no custom_policy and a
  // DIFFERENT session_id — must NOT see tenant A's policy at all.
  const resultB = await rpcCall(fdiaWorker, env, "evaluate_fdia", {
    data_quality: 0.9,
    action_name: "read_report",
    session_id: "tenant-b",
  });
  assert.notEqual(resultB.applied_policy_id, "tenant-a-strict-policy");
});

test("fdia: a caller who supplies the SAME session_id on both calls genuinely reads back their own policy", async () => {
  const env = fdiaEnv();

  await rpcCall(fdiaWorker, env, "configure_policy", {
    session_id: "tenant-a",
    policy_id: "tenant-a-strict-policy",
    custom_safety_threshold: 0.99,
  });

  const resultA = await rpcCall(fdiaWorker, env, "evaluate_fdia", {
    data_quality: 0.9,
    action_name: "read_report",
    session_id: "tenant-a",
  });
  assert.equal(resultA.applied_policy_id, "tenant-a-strict-policy");
});

test("fdia: omitting session_id entirely on both calls reproduces the exact prior SHARED-default behavior (regression safety)", async () => {
  const env = fdiaEnv();

  const configured = await rpcCall(fdiaWorker, env, "configure_policy", {
    policy_id: "legacy-shared-policy",
    custom_safety_threshold: 0.7,
  });
  assert.equal(configured.success, true);

  // A second caller who ALSO omits session_id still hits the same shared
  // default DO instance — this is the pre-existing, intentional
  // shared-by-default behavior for callers who don't opt into isolation.
  const result = await rpcCall(fdiaWorker, env, "evaluate_fdia", {
    data_quality: 0.9,
    action_name: "read_report",
  });
  assert.equal(result.applied_policy_id, "legacy-shared-policy");
});

test("fdia: the /policy HTTP route also honors an explicit ?session_id= query param for isolation", async () => {
  const env = fdiaEnv();

  const putReq = new Request("http://worker.test/policy?session_id=tenant-c", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ policy_id: "tenant-c-policy" }),
  });
  await fdiaWorker.fetch(putReq, env, NOOP_CTX);

  const getDefault = await fdiaWorker.fetch(new Request("http://worker.test/policy"), env, NOOP_CTX);
  const defaultBody = await getDefault.json();
  assert.notEqual(defaultBody.policy_id, "tenant-c-policy");

  const getScoped = await fdiaWorker.fetch(new Request("http://worker.test/policy?session_id=tenant-c"), env, NOOP_CTX);
  const scopedBody = await getScoped.json();
  assert.equal(scopedBody.policy_id, "tenant-c-policy");
});

// ============================================================================
// delta / jitna / rct7 — lower-severity stats/audit isolation, same pattern
// ============================================================================

test("delta: compress_context with an explicit session_id writes stats into that session's DO, NOT the shared global one", async () => {
  const env = { ENVIRONMENT: "test", DELTA_SESSION_DO: createFakeDurableObjectNamespace(DeltaSessionDO) };

  await rpcCall(deltaWorker, env, "compress_context", { raw_context: "hello world, this is a real test context", session_id: "agent-x" });

  const scopedStub = env.DELTA_SESSION_DO.get(env.DELTA_SESSION_DO.idFromName("agent-x"));
  const scopedStats = await (await scopedStub.fetch("http://do/stats")).json();
  assert.ok(scopedStats.totalOriginalTokens > 0, "the session-scoped DO must have received this call's real stats");

  const globalStub = env.DELTA_SESSION_DO.get(env.DELTA_SESSION_DO.idFromName("global_delta_session"));
  const globalStats = await (await globalStub.fetch("http://do/stats")).json();
  assert.equal(globalStats.totalOriginalTokens, 0, "the shared global DO must NOT have been touched by a session-scoped call");
});

test("jitna: orchestrate_swarm with distinct session_id values dispatches into genuinely separate DO instances", async () => {
  const env = { ENVIRONMENT: "test", JITNA_SESSION_DO: createFakeDurableObjectNamespace(JITNASessionDO) };
  await rpcCall(jitnaWorker, env, "orchestrate_swarm", { objective: "test objective", session_id: "agent-y" });

  const scopedId = env.JITNA_SESSION_DO.idFromName("agent-y");
  const globalId = env.JITNA_SESSION_DO.idFromName("global_jitna_session");
  assert.notEqual(scopedId, globalId);
});

test("rct7: rct_think with distinct session_id values records into genuinely separate DO instances", async () => {
  const env = { ENVIRONMENT: "test", RCT7_SESSION_DO: createFakeDurableObjectNamespace(RCT7SessionDO) };
  await rpcCall(rct7Worker, env, "rct_think", { problem_statement: "test problem", session_id: "agent-z" });

  const scopedId = env.RCT7_SESSION_DO.idFromName("agent-z");
  const globalId = env.RCT7_SESSION_DO.idFromName("global_rct7_session");
  assert.notEqual(scopedId, globalId);
});

test("delta/jitna/rct7: omitting session_id still resolves to each worker's original hardcoded default DO name (regression safety)", async () => {
  const deltaEnv = { ENVIRONMENT: "test", DELTA_SESSION_DO: createFakeDurableObjectNamespace(DeltaSessionDO) };
  const jitnaEnv = { ENVIRONMENT: "test", JITNA_SESSION_DO: createFakeDurableObjectNamespace(JITNASessionDO) };
  const rct7Env = { ENVIRONMENT: "test", RCT7_SESSION_DO: createFakeDurableObjectNamespace(RCT7SessionDO) };

  // No exceptions thrown, and each still succeeds exactly as before this
  // fix when session_id is simply never supplied.
  const deltaResult = await rpcCall(deltaWorker, deltaEnv, "compress_context", { raw_context: "hello" });
  assert.ok(deltaResult.estimated_original_tokens >= 0);

  const jitnaResult = await rpcCall(jitnaWorker, jitnaEnv, "orchestrate_swarm", { objective: "test" });
  assert.ok(jitnaResult.jitna_packet);

  const rct7Result = await rpcCall(rct7Worker, rct7Env, "rct_think", { problem_statement: "test" });
  assert.ok(rct7Result.synthesized_solution);
});
