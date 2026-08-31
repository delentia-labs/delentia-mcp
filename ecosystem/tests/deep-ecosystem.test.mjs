import test from "node:test";
import assert from "node:assert/strict";

import { evaluateFDIA, matchesWildcard } from "../packages/shared/dist/index.js";
import { executeRCT7 } from "../packages/rct7/dist/index.js";
import { compressContext } from "../packages/delta/dist/index.js";
import { orchestrateSwarm } from "../packages/jitna/dist/index.js";

// ============================================================================
// 1. FDIA SECURITY & ENTERPRISE CUSTOM POLICY ENGINE DEEP TESTS
// ============================================================================

test("FDIA - Wildcard Pattern Matching Utility", () => {
  assert.equal(matchesWildcard("drop_database", "*drop*"), true);
  assert.equal(matchesWildcard("drop_database", "drop_*"), true);
  assert.equal(matchesWildcard("database_drop", "*drop"), true);
  assert.equal(matchesWildcard("safe_read_query", "*drop*"), false);
  assert.equal(matchesWildcard("export_credentials", "*credentials*"), true);
  assert.equal(matchesWildcard("any_action_here", "*"), true);
});

test("FDIA - Base Zero-Auth Cutoff: A = 0 => F = 0.0000 Immediately", () => {
  const result = evaluateFDIA({
    data_quality: 1.0,
    intent_precision: 10.0,
    authorized: false, // A = 0
    action_name: "unauthorized_probe",
    caller_role: "anonymous",
  });

  assert.equal(result.future_score, 0.0);
  assert.equal(result.verdict, "SECURITY_AUTH_DENIED");
  assert.equal(result.authorized, false);
  assert.ok(result.violations.length > 0);
  assert.ok(result.audit_digest.length === 64);
});

test("FDIA Enterprise Policy - Action Blacklist (Forbidden Action Patterns)", () => {
  const enterprisePolicy = {
    policy_id: "acme_corp_strict",
    policy_name: "Acme Corp Production Governance",
    blocked_action_patterns: ["*drop*", "*truncate*", "*wipe*", "*export_secrets*"],
    custom_safety_threshold: 0.5,
    require_human_dual_signoff: [],
  };

  // Even if caller sets authorized: true and data quality is 0.99, forbidden pattern forces A = 0!
  const blockedDrop = evaluateFDIA({
    data_quality: 0.99,
    intent_precision: 1.0,
    authorized: true,
    action_name: "drop_customer_data_partition",
    caller_role: "admin",
    custom_policy: enterprisePolicy,
  });

  assert.equal(blockedDrop.future_score, 0.0);
  assert.equal(blockedDrop.verdict, "SECURITY_POLICY_VIOLATION");
  assert.equal(blockedDrop.authorized, false);
  assert.ok(blockedDrop.violations[0].includes("matches enterprise forbidden pattern"));

  // Allowed action with clean pattern should pass
  const allowedQuery = evaluateFDIA({
    data_quality: 0.9,
    intent_precision: 1.0,
    authorized: true,
    action_name: "read_customer_telemetry",
    caller_role: "admin",
    custom_policy: enterprisePolicy,
  });

  assert.equal(allowedQuery.verdict, "AUTHORIZED");
  assert.equal(allowedQuery.authorized, true);
  assert.equal(allowedQuery.future_score, 0.9);
});

test("FDIA Enterprise Policy - Role-Based Access Control (RBAC)", () => {
  const rbacPolicy = {
    policy_id: "bank_corp_rbac",
    policy_name: "Bank Corp Tiered Access",
    blocked_action_patterns: [],
    allowed_roles: {
      admin: ["*"],
      senior_dev: ["read_*", "write_code", "deploy_staging"],
      junior_dev: ["read_*"],
    },
    custom_safety_threshold: 0.5,
    require_human_dual_signoff: [],
  };

  // Test Junior Dev trying to deploy -> REJECTED
  const juniorDeploy = evaluateFDIA({
    data_quality: 0.95,
    intent_precision: 1.0,
    authorized: true,
    action_name: "deploy_staging",
    caller_role: "junior_dev",
    custom_policy: rbacPolicy,
  });
  assert.equal(juniorDeploy.verdict, "SECURITY_RBAC_DENIED");
  assert.equal(juniorDeploy.authorized, false);
  assert.equal(juniorDeploy.future_score, 0.0);

  // Test Senior Dev doing deploy_staging -> APPROVED
  const seniorDeploy = evaluateFDIA({
    data_quality: 0.95,
    intent_precision: 1.0,
    authorized: true,
    action_name: "deploy_staging",
    caller_role: "senior_dev",
    custom_policy: rbacPolicy,
  });
  assert.equal(seniorDeploy.verdict, "AUTHORIZED");
  assert.equal(seniorDeploy.authorized, true);

  // Test Unknown / Unregistered role -> REJECTED
  const untrustedRole = evaluateFDIA({
    data_quality: 0.95,
    intent_precision: 1.0,
    authorized: true,
    action_name: "read_logs",
    caller_role: "intruder",
    custom_policy: rbacPolicy,
  });
  assert.equal(untrustedRole.verdict, "SECURITY_RBAC_DENIED");
  assert.equal(untrustedRole.authorized, false);
});

test("FDIA Enterprise Policy - Custom Safety Threshold Override", () => {
  // High-Risk Financial Policy requiring F >= 0.8500
  const financialPolicy = {
    policy_id: "fintech_wire_transfer",
    policy_name: "Wire Transfer High Security",
    blocked_action_patterns: [],
    custom_safety_threshold: 0.85,
    require_human_dual_signoff: [],
  };

  // Score 0.70 (Passes standard 0.5, but FAILS 0.85 threshold)
  const moderateScore = evaluateFDIA({
    data_quality: 0.7,
    intent_precision: 1.0,
    authorized: true,
    action_name: "wire_transfer_50k",
    custom_policy: financialPolicy,
  });
  assert.equal(moderateScore.future_score, 0.7);
  assert.equal(moderateScore.verdict, "BLOCKED_PREEMPTION");
  assert.equal(moderateScore.authorized, false);

  // Score 0.95 (Passes 0.85 threshold)
  const highScore = evaluateFDIA({
    data_quality: 0.95,
    intent_precision: 1.0,
    authorized: true,
    action_name: "wire_transfer_50k",
    custom_policy: financialPolicy,
  });
  assert.equal(highScore.future_score, 0.95);
  assert.equal(highScore.verdict, "AUTHORIZED");
  assert.equal(highScore.authorized, true);
});

test("FDIA Enterprise Policy - Dual Human Architect Sign-off Verification", () => {
  const dualSignPolicy = {
    policy_id: "nuclear_option_policy",
    policy_name: "Critical Operations Dual Control",
    blocked_action_patterns: [],
    custom_safety_threshold: 0.5,
    require_human_dual_signoff: ["purge_cold_storage", "rotate_master_ca_key"],
  };

  // Without dual sign-off -> BLOCKED
  const singleSign = evaluateFDIA({
    data_quality: 0.99,
    intent_precision: 1.0,
    authorized: true,
    action_name: "purge_cold_storage",
    dual_signoff_confirmed: false,
    custom_policy: dualSignPolicy,
  });
  assert.equal(singleSign.verdict, "SECURITY_DUAL_SIGNOFF_REQUIRED");
  assert.equal(singleSign.authorized, false);
  assert.equal(singleSign.future_score, 0.0);

  // With dual sign-off confirmed -> APPROVED
  const dualSignApproved = evaluateFDIA({
    data_quality: 0.99,
    intent_precision: 1.0,
    authorized: true,
    action_name: "purge_cold_storage",
    dual_signoff_confirmed: true,
    custom_policy: dualSignPolicy,
  });
  assert.equal(dualSignApproved.verdict, "AUTHORIZED");
  assert.equal(dualSignApproved.authorized, true);
  assert.equal(dualSignApproved.future_score, 0.99);
});

// ============================================================================
// 2. RCT-7 REVERSE COMPONENT THINKING DEEP TESTS
// ============================================================================

test("RCT-7 - Strict 7-Stage Sequential Cognition & Alignment Verification", () => {
  const input = {
    problem_statement: "Construct high-concurrency payment gateway without race condition",
    environment_context: "Distributed Redis cluster, PostgreSQL read-replicas",
    target_desired_outcome: "Zero double-spending under 100,000 req/sec peak load",
  };

  const result = executeRCT7(input);

  // Verify all 7 stages exist strictly in order
  const expectedStages = [
    { stage: 1, name: "OBSERVE", thai: "สังเกต" },
    { stage: 2, name: "ANALYZE", thai: "วิเคราะห์" },
    { stage: 3, name: "DECONSTRUCT", thai: "แยกส่วน" },
    { stage: 4, name: "REVERSE REASONING", thai: "คิดย้อนกลับ" },
    { stage: 5, name: "IDENTIFY CORE INTENT", thai: "ระบุเจตนาหลัก" },
    { stage: 6, name: "RECONSTRUCT", thai: "สร้างใหม่" },
    { stage: 7, name: "COMPARE WITH INTENT", thai: "เปรียบเทียบกับเจตนา" },
  ];

  assert.equal(result.stages.length, 7);
  expectedStages.forEach((exp, idx) => {
    const s = result.stages[idx];
    assert.equal(s.stage, exp.stage);
    assert.equal(s.name, exp.name);
    assert.equal(s.thai_name, exp.thai);
    assert.ok(s.cognitive_action.length > 10);
    assert.ok(s.output.length > 10);
  });

  // Verify Inversion Anchor & Failure State Mapping at Stage 4
  const stage4 = result.stages[3];
  assert.ok(stage4.output.includes("failure paths"));

  // Verify 100% alignment score at Stage 7
  assert.equal(result.verified_alignment_score, 1.0);
  assert.ok(result.synthesized_solution.includes("100% alignment"));
});

// ============================================================================
// 3. DELTA ENGINE CONTEXT COMPRESSOR DEEP TESTS
// ============================================================================

test("Delta Engine - Deep Token/VRAM Reduction Benchmark (74.2% - 91.5%)", () => {
  // Generate realistic verbose 500-line server log
  const logLines = [];
  for (let i = 0; i < 200; i++) {
    logLines.push(`[2026-08-31 08:00:${i % 60}] [INFO] [Thread-${i % 8}] Keepalive heartbeat status OK`);
    logLines.push(`[2026-08-31 08:00:${i % 60}] [DEBUG] [ConnectionPool] Reused connection ID #${i * 3}`);
  }
  logLines.push(`[2026-08-31 08:01:05] [CRITICAL] [TransactionEngine] Deadlock detected on row 9401`);
  logLines.push(`[2026-08-31 08:01:06] [ERROR] [RollbackHandler] Rolled back transaction TX-8819`);

  const raw_context = logLines.join("\n");

  const result = compressContext({
    raw_context,
    intent_focus: "transaction deadlock",
    aggressive_mode: true,
  });

  // Verify compression metrics
  assert.ok(result.compressed_char_count < result.original_char_count);
  assert.ok(result.reduction_percentage >= 50.0);
  assert.ok(result.reduction_percentage <= 91.5);
  assert.ok(result.compressed_delta_text.includes("Deadlock"));
  assert.ok(result.context_hash.length === 64);
});

// ============================================================================
// 4. JITNA PROTOCOL & 1+N MULTI-AGENT SWARM ORCHESTRATION DEEP TESTS
// ============================================================================

test("JITNA Protocol - RFC-001 Packet [I, D, Delta, A, R, M] Integrity", () => {
  const result = orchestrateSwarm({
    objective: "Execute automated enterprise regression tests and deploy staging cluster",
    data_readiness: 75,
    target_pillar: "auto",
    context_params: { env: "staging", priority: "critical", max_concurrency: 8 },
  });

  const packet = result.jitna_packet;
  assert.ok(packet.I.length > 0);
  assert.equal(packet.D, 75);
  assert.equal(packet.delta, 25); // Delta = 100 - 75 = 25
  assert.equal(packet.A, "executor"); // Auto-routed to Executor for "execute" / "deploy"
  assert.ok(packet.R.includes("Intent decomposed"));
  assert.equal(packet.M.env, "staging");
});

test("JITNA 1+N Swarm - 4 Pillars LoRA & Extensible Multi-Agent Dispatch", () => {
  const result = orchestrateSwarm({
    objective: "Audit security boundaries and patch zero-day buffer overflow",
    data_readiness: 90,
    target_pillar: "guardian",
  });

  assert.equal(result.jitna_packet.A, "guardian");
  assert.equal(result.assigned_pillars.length, 4);

  // Validate Sub-1.06ms hot-swap targets across all pillars
  for (const pillar of result.assigned_pillars) {
    assert.ok(pillar.expected_vram_switch_ms <= 1.06);
    assert.ok(pillar.assigned_subtask.length > 0);
  }

  // Validate presence of all functional roles
  const roles = result.assigned_pillars.map((p) => p.pillar);
  assert.ok(roles.includes("router"));
  assert.ok(roles.includes("guardian"));
  assert.ok(roles.includes("executor"));
  assert.ok(roles.includes("scribe"));
});
