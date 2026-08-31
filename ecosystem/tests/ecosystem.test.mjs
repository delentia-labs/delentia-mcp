import test from "node:test";
import assert from "node:assert/strict";

// Dynamic import of compiled or source modules
import { evaluateFDIA } from "../packages/shared/dist/index.js";
import { executeRCT7 } from "../packages/rct7/dist/index.js";
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

  assert.equal(result.verified_alignment_score, 1.0);
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
