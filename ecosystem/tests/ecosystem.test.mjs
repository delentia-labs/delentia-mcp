import test from "node:test";
import assert from "node:assert/strict";

// Dynamic import of compiled or source modules
import { evaluateFDIA } from "../packages/shared/dist/index.js";
import { executeRCT7, computeAlignmentScore } from "../packages/rct7/dist/index.js";
import { compressContext } from "../packages/delta/dist/index.js";
import { orchestrateSwarm } from "../packages/jitna/dist/index.js";

test("FDIA Security Gate - Mathematical Preemption Proof", () => {
  // Test 1: Valid authorized execution with high data quality
  const approved = evaluateFDIA({
    data_quality: 0.9,
    intent_precision: 1.0,
    authorized: true,
    action_name: "read_safe_telemetry",
  });
  assert.equal(approved.verdict, "AUTHORIZED");
  assert.equal(approved.future_score, 0.9);
  assert.equal(approved.authorized, true);
  assert.ok(approved.audit_digest.length === 64);

  // Test 2: Zero-Auth rule: A = 0 => F collapses to 0.0000 instantly
  const blockedAuth = evaluateFDIA({
    data_quality: 0.99,
    intent_precision: 1.5,
    authorized: false,
    action_name: "drop_database_injection",
  });
  assert.equal(blockedAuth.verdict, "SECURITY_AUTH_DENIED");
  assert.equal(blockedAuth.future_score, 0.0);
  assert.equal(blockedAuth.authorized, false);

  // Test 3: Low data quality preemption: F < 0.5 => BLOCKED_PREEMPTION
  const lowData = evaluateFDIA({
    data_quality: 0.4,
    intent_precision: 1.0,
    authorized: true,
    action_name: "risky_operation",
  });
  assert.equal(lowData.verdict, "BLOCKED_PREEMPTION");
  assert.ok(lowData.future_score < 0.5);
});

test("FDIA Security Gate - fails closed on malformed numeric input (regression)", () => {
  // Previously: Math.pow(-0.5, 1.5) => NaN, which compared false against
  // every threshold check and fell through to verdict "AUTHORIZED" with a
  // NaN future_score. Must now be a hard, explicit deny.
  const negative = evaluateFDIA({
    data_quality: -0.5,
    intent_precision: 1.5,
    authorized: true,
    action_name: "read_something",
  });
  assert.equal(negative.verdict, "SECURITY_POLICY_VIOLATION");
  assert.equal(negative.future_score, 0);
  assert.equal(negative.authorized, false);
  assert.ok(Number.isFinite(negative.future_score));

  const nonFinite = evaluateFDIA({
    data_quality: Infinity,
    intent_precision: 1.0,
    authorized: true,
    action_name: "read_something",
  });
  assert.equal(nonFinite.authorized, false);
  assert.ok(Number.isFinite(nonFinite.future_score));
});

test("RCT-7 Mental OS - Authentic 7-Stage Pipeline Verification", () => {
  const result = executeRCT7({
    problem_statement: "Fix cross-border payment latency",
    environment_context: "Enterprise Banking Gateway",
    target_desired_outcome: "Sub-50ms deterministic settlement",
  });

  assert.equal(result.stages.length, 7);
  const expectedNames = [
    "OBSERVE",
    "ANALYZE",
    "DECONSTRUCT",
    "REVERSE REASONING",
    "IDENTIFY CORE INTENT",
    "RECONSTRUCT",
    "COMPARE WITH INTENT",
  ];

  result.stages.forEach((stage, idx) => {
    assert.equal(stage.stage, idx + 1);
    assert.equal(stage.name, expectedNames[idx]);
    assert.ok(stage.output.length > 0);
  });

  // verified_alignment_score is a real heuristic (see docs/RCT7_SCORING_SPEC.md),
  // not a hardcoded constant — assert it's in range and matches the
  // independently-computed breakdown, not that it equals any fixed number.
  assert.ok(result.verified_alignment_score >= 0 && result.verified_alignment_score <= 1);
  assert.deepEqual(
    result.verified_alignment_score,
    computeAlignmentScore({
      problem_statement: "Fix cross-border payment latency",
      environment_context: "Enterprise Banking Gateway",
      target_desired_outcome: "Sub-50ms deterministic settlement",
    }).score
  );
});

test("RCT-7 Alignment Score - varies with input and is deterministic", () => {
  const vague = executeRCT7({ problem_statement: "fix it" });
  const specific = executeRCT7({
    problem_statement: "Reduce checkout API p99 latency below 200ms",
    environment_context: "Node.js, 3 replicas, Redis cache",
    target_desired_outcome: "p99 latency under 200ms sustained for 24h",
  });

  // A vague, ungrounded request must score lower than a specific, grounded one.
  assert.ok(vague.verified_alignment_score < specific.verified_alignment_score);

  // Same input, called twice, must produce the identical score (no hidden randomness/time-dependence).
  const repeat = executeRCT7({
    problem_statement: "Reduce checkout API p99 latency below 200ms",
    environment_context: "Node.js, 3 replicas, Redis cache",
    target_desired_outcome: "p99 latency under 200ms sustained for 24h",
  });
  assert.equal(repeat.verified_alignment_score, specific.verified_alignment_score);

  // A target that shares no vocabulary with the problem should score lower
  // than one that does, holding grounding_completeness role constant.
  const misaligned = executeRCT7({
    problem_statement: "Reduce checkout API p99 latency",
    target_desired_outcome: "Ship a mobile app redesign",
  });
  assert.ok(misaligned.alignment_breakdown.lexical_alignment === 0);
});

test("Delta Engine - State Differential Context Compression", () => {
  const verboseContext = `
    [INFO] Server started on port 8000
    [INFO] Server started on port 8000
    [DEBUG] Database connection pool initialized
    [DEBUG] Database connection pool initialized
    + Added transaction row ID 94819
    - Removed old session cache
    [INFO] Heartbeat OK
    [INFO] Heartbeat OK
  `.repeat(10);

  const result = compressContext({
    raw_context: verboseContext,
    intent_focus: "transaction",
    aggressive_mode: true,
  });

  assert.ok(result.reduction_percentage > 0);
  assert.ok(result.compressed_char_count < result.original_char_count);
  assert.ok(result.context_hash.length === 64);
});

test("Delta Engine - reduction_percentage is not clamped to a fixed range (regression)", () => {
  // Previously: negative results were forced to a fake 15.0 floor, and
  // anything above 91.5 was capped. A short, already-unique input (where
  // the added [DELENTIA-DELTA-STREAM] header outweighs any dedup savings)
  // must now be able to show a real negative reduction.
  const tiny = compressContext({ raw_context: "a" });
  assert.ok(tiny.reduction_percentage < 0, `expected a negative reduction, got ${tiny.reduction_percentage}`);
  assert.notEqual(tiny.reduction_percentage, 15.0);

  // A highly repetitive input can legitimately exceed the old 91.5 cap.
  const veryRepetitive = compressContext({ raw_context: "duplicate line\n".repeat(500) });
  assert.ok(veryRepetitive.reduction_percentage > 91.5, `expected >91.5, got ${veryRepetitive.reduction_percentage}`);
});

test("JITNA Orchestrator - 1+4 LoRA Swarm Dispatch", () => {
  const result = orchestrateSwarm({
    objective: "Audit enterprise security and deploy hotfix",
    data_readiness: 85,
    target_pillar: "auto",
  });

  assert.ok(result.jitna_packet.I.length > 0);
  assert.equal(result.jitna_packet.D, 85);
  assert.equal(result.jitna_packet.delta, 15);
  assert.equal(result.assigned_pillars.length, 4);

  const roles = result.assigned_pillars.map((p) => p.pillar);
  assert.deepEqual(roles.sort(), ["executor", "guardian", "router", "scribe"].sort());
});

test("JITNA Orchestrator - assigned_pillars reflects the real routing decision (regression)", () => {
  // Previously: all 4 pillars always got an identical, objective-specific
  // subtask string regardless of which pillar was actually routed to.
  const result = orchestrateSwarm({
    objective: "Audit enterprise security posture",
    data_readiness: 85,
    target_pillar: "auto",
  });

  assert.equal(result.jitna_packet.A, "guardian", "security-flavored objective should route to guardian");

  const primaries = result.assigned_pillars.filter((p) => p.role === "primary");
  const supports = result.assigned_pillars.filter((p) => p.role === "support");
  assert.equal(primaries.length, 1);
  assert.equal(supports.length, 3);
  assert.equal(primaries[0].pillar, "guardian");

  // The primary pillar gets an objective-specific action; support pillars
  // must explicitly say they are NOT actively engaged, not silently reuse
  // the same "doing the work" phrasing the primary pillar gets.
  assert.ok(primaries[0].assigned_subtask.includes("Audit enterprise security posture"));
  for (const s of supports) {
    assert.ok(s.assigned_subtask.toLowerCase().includes("not actively engaged"));
  }
});
