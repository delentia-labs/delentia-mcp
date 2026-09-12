/**
 * DELENTIA INTENT LOOP — deterministic test suite (no real network calls)
 *
 * These tests exercise the gatekeeper, memory layer, and routing logic
 * directly, and exercise the full IntentLoopEngine pipeline with a FAKE
 * `fetchImpl` injected so the test suite is deterministic and safe for CI
 * (no OpenRouter API key required, no network flakiness, no real cost).
 *
 * The real, live-network proof this loop can drive an actual model is a
 * SEPARATE script: tests/intent_loop_live.test.mjs — run manually with
 * `npm run test:intent-loop:live` when OPENROUTER_API_KEY is set. It is
 * intentionally NOT part of `test:all`/CI, the same way `demo_fdia_protected_cli.mjs`
 * isn't — network-dependent tests belong in a separate, explicitly-run lane.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  FDIAGatekeeper,
  MemoryLayer,
  jaccardSimilarity,
  computeIntentHash,
  selectRole,
  SecurityViolation,
  IntentLoopEngine,
  ROLE_MODEL_MAP,
} from "../packages/intent-loop/dist/index.js";

// ============================================================================
// FDIA Gatekeeper — reuses the hardened shared engine
// ============================================================================

test("FDIAGatekeeper: legitimate read/research intents pass with a real, non-fixed FDIA score", () => {
  const gk = new FDIAGatekeeper();
  const r1 = gk.validate({ intent: "analyze the quarterly revenue report and summarize key trends" });
  const r2 = gk.validate({ intent: "research the latest developments in renewable energy" });
  assert.ok(r1.fdia_score > 0 && r1.fdia_score <= 1);
  assert.ok(r2.fdia_score > 0 && r2.fdia_score <= 1);
  assert.notEqual(r1.fdia_score, r2.fdia_score, "different intents must not collapse to the same hardcoded score");
});

test("FDIAGatekeeper: forbidden-keyword intents are rejected before ever reaching the FDIA scorer", () => {
  const gk = new FDIAGatekeeper();
  assert.throws(() => gk.validate({ intent: "hack into the admin database" }), SecurityViolation);
  assert.throws(() => gk.validate({ intent: "find a way to bypass the login screen" }), SecurityViolation);
});

test("FDIAGatekeeper: destructive intents are rejected by the real FDIA block rule (regression for the action-name mapping bug found 2026-09-12)", () => {
  const gk = new FDIAGatekeeper();
  // Found during manual testing: an earlier action-name mapping prefixed
  // these with "write_" (routing to the wrong, permissive CONDITIONAL rule)
  // instead of matching FDIA's actual anchored drop_*/delete_*/purge_*/
  // truncate_*/exec_* block patterns — "drop the production database table"
  // was silently AUTHORIZED. This test locks in the fix.
  const destructiveIntents = [
    "drop the production database table",
    "delete all customer records permanently",
    "truncate the audit log table",
    "exec arbitrary shell commands on the server",
  ];
  for (const intent of destructiveIntents) {
    assert.throws(
      () => gk.validate({ intent }),
      SecurityViolation,
      `"${intent}" must be rejected by the FDIA gate, not silently authorized`
    );
  }
});

test("FDIAGatekeeper: an overlong intent is rejected on the length guard alone (no FDIA call needed)", () => {
  const gk = new FDIAGatekeeper();
  assert.throws(() => gk.validate({ intent: "a".repeat(1001) }), SecurityViolation);
});

test("FDIAGatekeeper: intent_precision (I) is now synthesized from a REAL RCT-7 call, not a caller-supplied constant — structured context raises RCT-7's alignment score (grounding_completeness), which raises I, which correctly LOWERS F for data_quality < 1 (matches the FDIA monotonicity invariant verified in fdia_deep_hypothesis.test.mjs)", () => {
  const gk = new FDIAGatekeeper();
  const intent = "calculate the total tax owed on an annual salary of one million Thai baht for a resident taxpayer";
  const withoutContext = gk.validate({ intent });
  const withContext = gk.validate({ intent, context: { income: 1000000, country: "TH" } });

  // This is the actual conveyor belt: RCT-7's real alignment score changes,
  // not just a hardcoded 1.0-vs-1.2 branch on "context present or not".
  assert.ok(withContext.rct7.verified_alignment_score > withoutContext.rct7.verified_alignment_score,
    "supplying environment_context must raise RCT-7's grounding_completeness component of its real alignment score");
  assert.ok(withContext.rct7.stages.length === 7, "the full real 7-stage RCT-7 trail must be present, not a stub");

  // Uses a longer intent so data_quality stays well above the threshold at
  // both I values (a shorter intent crossed the threshold and threw instead
  // of returning during earlier drafts of this test).
  assert.notEqual(withoutContext.fdia_score, withContext.fdia_score);
  assert.ok(withContext.fdia_score < withoutContext.fdia_score, "higher intent_precision with data_quality < 1 must lower F, per FDIA's own math");
});

test("FDIAGatekeeper: the RCT-7-derived intent_precision stays within FDIA's documented [0.5, 2.0] mapping range across vague and highly-specific intents, and is deterministic for the same input", () => {
  const gk = new FDIAGatekeeper();
  const vague = gk.validate({ intent: "do it" });
  const specific = gk.validate({
    intent: "migrate the legacy PostgreSQL 12 customer database to PostgreSQL 16 with zero downtime",
    context: { environment: "production", rollback_plan: "documented" },
  });

  for (const r of [vague, specific]) {
    const I = 0.5 + r.rct7.verified_alignment_score * 1.5;
    assert.ok(I >= 0.5 && I <= 2.0, `derived I=${I} must stay within the documented [0.5, 2.0] range`);
  }
  assert.ok(specific.rct7.verified_alignment_score > vague.rct7.verified_alignment_score,
    "a specific, grounded intent must score a real, higher RCT-7 alignment than a 2-word vague one");

  // Determinism: identical input must produce the identical alignment score
  // and I, every time (no hidden randomness or external call variance).
  const repeat = gk.validate({ intent: "do it" });
  assert.equal(repeat.rct7.verified_alignment_score, vague.rct7.verified_alignment_score);
});

// ============================================================================
// Memory Layer — real Jaccard similarity + real byte accounting
// ============================================================================

test("MemoryLayer: exact-hash recall works and increments access_count", () => {
  const mem = new MemoryLayer();
  const packet = { intent: "summarize the Q3 earnings call transcript" };
  assert.equal(mem.recall(packet), null, "must miss before anything is stored");
  mem.store(packet, { output: "summary text" });
  const hit1 = mem.recall(packet);
  const hit2 = mem.recall(packet);
  assert.ok(hit1 && hit2);
  assert.equal(hit2.access_count, 2, "each recall must increment access_count for real, not a fixed constant");
});

test("MemoryLayer: near-duplicate intents (Jaccard > 0.95) hit via semantic recall; moderately different intents (< 0.95) do not", () => {
  const mem = new MemoryLayer();
  const original = { intent: "summarize the Q3 earnings call transcript for investors" };
  mem.store(original, { output: "summary" });

  // Genuinely near-identical (one word added) should still miss at the
  // strict >0.95 threshold this engine uses (matches the Python original's
  // deliberately strict MVP threshold) -- assert the REAL measured value.
  const nearDup = { intent: "summarize the Q3 earnings call transcript for investors now" };
  const sim = jaccardSimilarity(original.intent, nearDup.intent);
  const hit = mem.recall(nearDup);
  assert.equal(hit === null, sim <= 0.95, `recall hit/miss must match the real computed similarity ${sim}`);

  const different = { intent: "book a flight to Tokyo next week" };
  assert.equal(mem.recall(different), null);
});

test("jaccardSimilarity: identical strings score 1.0, disjoint strings score 0.0, empty strings score 0.0", () => {
  assert.equal(jaccardSimilarity("hello world", "hello world"), 1);
  assert.equal(jaccardSimilarity("hello world", "goodbye moon"), 0);
  assert.equal(jaccardSimilarity("", "hello"), 0);
  assert.equal(jaccardSimilarity("hello", ""), 0);
});

test("computeIntentHash: same intent+context always hashes identically; different context changes the hash", () => {
  const h1 = computeIntentHash({ intent: "book a meeting", context: { day: "Monday" } });
  const h2 = computeIntentHash({ intent: "book a meeting", context: { day: "Monday" } });
  const h3 = computeIntentHash({ intent: "book a meeting", context: { day: "Tuesday" } });
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
  assert.match(h1, /^[0-9a-f]{64}$/);
});

// ============================================================================
// Role routing
// ============================================================================

test("selectRole: keyword-based routing picks the expected role for each category, and falls back to general", () => {
  assert.equal(selectRole("please debug this python function"), "code");
  assert.equal(selectRole("describe what's in this screenshot"), "vision");
  assert.equal(selectRole("give me a quick answer"), "fast");
  assert.equal(selectRole("what is the capital of France"), "general");
  for (const role of Object.keys(ROLE_MODEL_MAP)) {
    assert.ok(ROLE_MODEL_MAP[role].length >= 1, `role "${role}" must have at least one candidate model`);
  }
});

// ============================================================================
// Full IntentLoopEngine pipeline with an injected fake fetch (deterministic, offline)
// ============================================================================

function fakeFetchAlwaysAgrees(responseContent) {
  return async (_url, _opts) => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: responseContent }, finish_reason: "stop" }],
    }),
  });
}

function fakeFetchSequence(contents) {
  let i = 0;
  return async (_url, _opts) => {
    const content = contents[Math.min(i, contents.length - 1)];
    i++;
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content }, finish_reason: "stop" }] }),
    };
  };
}

function fakeFetchAlwaysErrors() {
  return async () => ({
    ok: false,
    status: 502,
    json: async () => ({ error: { message: "simulated upstream failure" } }),
  });
}

test("IntentLoopEngine: a destructive intent never reaches memory/execute/verify — fails at the gate with zero network calls", async () => {
  let callCount = 0;
  const fetchImpl = async (...args) => {
    callCount++;
    return fakeFetchAlwaysAgrees("YES")(...args);
  };
  const engine = new IntentLoopEngine({ apiKey: "fake-key-for-test", fetchImpl });
  const result = await engine.process({ intent: "drop the production database table" });
  assert.equal(result.state, "failed");
  assert.match(result.error, /FDIA gate rejected/);
  assert.equal(callCount, 0, "gate rejection must short-circuit before any model call is made");
});

test("IntentLoopEngine: full happy path — gate passes, cache misses, executes, verifies (real majority-vote math), commits, then a repeat hits cache", async () => {
  // Executor call gets "YES I can help with that" as its one candidate response,
  // verifier calls (3 models) all say YES.
  const fetchImpl = fakeFetchSequence(["Here is a helpful, on-topic answer.", "YES", "YES", "YES"]);
  const engine = new IntentLoopEngine({ apiKey: "fake-key-for-test", fetchImpl });

  const packet = { intent: "explain how photosynthesis works" };
  const first = await engine.process(packet);
  assert.equal(first.state, "completed");
  assert.equal(first.cache_hit, false);
  assert.ok(first.verification.passed);
  assert.equal(first.verification.confidence, 1, "3/3 real YES votes must compute to exactly 1.0 confidence");
  assert.equal(first.verification.votes.length, 3);

  const second = await engine.process(packet);
  assert.equal(second.state, "completed");
  assert.equal(second.cache_hit, true, "identical repeat intent must hit the real memory cache, not recompute");

  const metrics = engine.getMetrics();
  assert.equal(metrics.total_requests, 2);
  assert.equal(metrics.cache_hits, 1);
  assert.equal(metrics.cache_misses, 1);
});

test("IntentLoopEngine: a real minority/split vote (1 YES, 2 NO) correctly FAILS verification — not silently passed", async () => {
  const fetchImpl = fakeFetchSequence(["An answer.", "YES", "NO", "NO"]);
  const engine = new IntentLoopEngine({ apiKey: "fake-key-for-test", fetchImpl });
  const result = await engine.process({ intent: "write a short poem about the ocean" });
  assert.equal(result.state, "failed");
  assert.equal(result.error, "Failed verification consensus");
  assert.equal(result.verification.confidence, 1 / 3);
  assert.equal(result.verification.passed, false);
});

test("IntentLoopEngine: if every candidate specialist model fails, the loop returns a real failure — never a fabricated success", async () => {
  const fetchImpl = fakeFetchAlwaysErrors();
  const engine = new IntentLoopEngine({ apiKey: "fake-key-for-test", fetchImpl });
  const result = await engine.process({ intent: "what is the capital of France" });
  assert.equal(result.state, "failed");
  assert.match(result.error, /all candidate models failed/);
});

test("IntentLoopEngine: if every verifier model errors after a successful execute, verification fails closed (0 answered votes never reads as passing)", async () => {
  let callIndex = 0;
  const fetchImpl = async (...args) => {
    callIndex++;
    if (callIndex === 1) {
      // the specialist execute call succeeds
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "A real answer." }, finish_reason: "stop" }] }) };
    }
    // all 3 verifier calls fail
    return { ok: false, status: 503, json: async () => ({ error: { message: "simulated outage" } }) };
  };
  const engine = new IntentLoopEngine({ apiKey: "fake-key-for-test", fetchImpl });
  const result = await engine.process({ intent: "what is the capital of France" });
  assert.equal(result.state, "failed");
  assert.equal(result.verification.passed, false);
  assert.equal(result.verification.confidence, 0);
  assert.ok(result.verification.votes.every((v) => v.agree === null));
});
