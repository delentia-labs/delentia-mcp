/**
 * DELENTIA SOVEREIGN AI OS — FDIA DYNAMIC POLICY ENGINE COMPREHENSIVE UNIT TEST SUITE
 * Deterministic Mathematical Gate Verification: F = (D^I) * A
 * 
 * Chief Architect: อิทธิฤทธิ์ แซ่โง้ว (Ittirit Saengow) — Delentia Labs
 * 
 * Invariants Verified:
 * 1. Low Risk (ALLOW): Auto A = 1, Zero Latency Friction.
 * 2. Medium Risk (CONDITIONAL): Verified against denied paths, blocking if violated (A = 0 => F = 0).
 * 3. High Risk (REQUIRE_HUMAN_SIGNATURE): Strict VETO (A = 0 => F = 0) unless valid Architect Token is provided.
 * 4. Dynamic Rules Injection: On-the-fly rule registration without server restart.
 * 5. Zero-Trust Fallback: Unregistered intents collapse to A = 0 => F = 0.0000.
 * 6. Physical Cutoff Guarantee: When A = 0, F unconditionally equals 0.0000 regardless of D or I.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  FDIAEngine,
  createDefaultPolicy,
  evaluateFDIA,
  matchesWildcard,
  validatePolicy,
  FDIAPolicySchema,
} from "../packages/shared/dist/index.js";
// Round 48: Architect tokens are real Ed25519 signatures now; this registers
// test keys as trusted and provides sign(role, action, payload).
import { sign, signUntrusted } from "./helpers/architect-keys.mjs";

// ============================================================================
// SCENARIO 1: LOW RISK (ALLOW) — READ-ONLY & ANALYSIS (ZERO LATENCY FRICTION)
// ============================================================================

test("Scenario 1: Low-Risk Safe Read Operations automatically receive A = 1 (Zero Friction)", () => {
  const engine = new FDIAEngine();
  const lowRiskIntents = [
    "read_user_profile",
    "query_financial_report",
    "summarize_codebase",
    "search_knowledge_graph",
    "check_cluster_health",
    "inspect_docker_container",
    "evaluate_security_posture",
    "get_system_metrics",
    "list_active_sessions",
  ];

  for (const intent of lowRiskIntents) {
    const aEval = engine.evaluateA(intent);
    assert.equal(aEval.A, 1, `Intent "${intent}" must receive A = 1 automatically`);
    assert.equal(aEval.actionType, "ALLOW");

    // Full FDIA Evaluation
    const result = engine.evaluate({
      data_quality: 0.92,
      intent_precision: 1.0,
      authorized: true,
      action_name: intent,
    });

    assert.equal(result.effective_A, 1);
    assert.equal(result.verdict, "AUTHORIZED");
    assert.ok(result.future_score >= 0.50);
    assert.equal(result.future_score, 0.92);
  }
});

// ============================================================================
// SCENARIO 2: MEDIUM RISK (CONDITIONAL) — FILE WRITES & CODE MODIFICATIONS
// ============================================================================

test("Scenario 2A: Medium-Risk file write to a permitted path receives A = 1", () => {
  const engine = new FDIAEngine();
  const aEval = engine.evaluateA("write_file", "src/components/DashboardWidget.tsx");

  assert.equal(aEval.A, 1);
  assert.equal(aEval.actionType, "CONDITIONAL");

  const result = engine.evaluate({
    data_quality: 0.88,
    intent_precision: 1.0,
    authorized: true,
    action_name: "write_file",
    target_payload: "src/components/DashboardWidget.tsx",
  });

  assert.equal(result.effective_A, 1);
  assert.equal(result.verdict, "AUTHORIZED");
  assert.equal(result.future_score, 0.88);
});

test("Scenario 2B: Medium-Risk file write to sensitive paths triggers CONDITIONAL VETO (A = 0 => F = 0)", () => {
  const engine = new FDIAEngine();
  const forbiddenPaths = [
    ".env",
    ".env.production",
    ".git/config",
    "production.config.json",
    "/etc/shadow",
    "/etc/passwd",
    "id_rsa",
    "server.key",
    "cert.pem",
  ];

  for (const path of forbiddenPaths) {
    const aEval = engine.evaluateA("write_file", path);
    assert.equal(aEval.A, 0, `Path "${path}" must be denied under CONDITIONAL check`);
    assert.ok(aEval.reason.includes("restricted pattern") || aEval.reason.includes("violates"));

    const result = engine.evaluate({
      data_quality: 0.99, // Superb data quality
      intent_precision: 2.0, // High intent precision
      authorized: true,
      action_name: "modify_code",
      target_payload: path,
    });

    assert.equal(result.effective_A, 0);
    assert.equal(result.future_score, 0.0000, `F must collapse to 0.0000 when accessing "${path}"`);
    assert.equal(result.verdict, "SECURITY_POLICY_VIOLATION");
    assert.ok(result.violations.length > 0);
  }
});

// ============================================================================
// SCENARIO 3: HIGH RISK (REQUIRE_HUMAN_SIGNATURE) — DESTRUCTIVE COMMANDS
// ============================================================================

test("Scenario 3A: Destructive database / OS operations WITHOUT Architect Signature are strictly blocked (A = 0 => F = 0)", () => {
  const engine = new FDIAEngine();
  const destructiveIntents = [
    "drop_table_customers",
    "delete_all_records",
    "purge_audit_logs",
    "truncate_ledger",
    "execute_shell",
    "exec_bash_command",
    "chmod_root_permissions",
    "system_exec_rm",
  ];

  for (const intent of destructiveIntents) {
    // 1. No token supplied
    const noTokenEval = engine.evaluateA(intent);
    assert.equal(noTokenEval.A, 0);
    assert.equal(noTokenEval.actionType, "REQUIRE_HUMAN_SIGNATURE");
    assert.ok(noTokenEval.reason.includes("Missing or invalid Architect signature"));

    // 2. Invalid or spoofed token supplied - including the two formats the
    // pre-Round-48 check accepted (any 32+ chars, or a magic prefix), and a
    // real signature from a key nobody trusts.
    for (const forged of ["spoofed_fake_token_12345", "a".repeat(40), "valid_architect_sig_Chief_Architect", signUntrusted(intent)]) {
      assert.equal(engine.evaluateA(intent, "", forged).A, 0, `forged token accepted: ${forged.slice(0, 30)}`);
    }
    // 3. A real token for a DIFFERENT action does not carry over
    assert.equal(engine.evaluateA(intent, "", sign("Chief_Architect", "read_logs")).A, 0);

    const result = engine.evaluate({
      data_quality: 1.0,
      intent_precision: 3.0,
      authorized: true,
      action_name: intent,
      architect_token: "invalid_hacker_token",
    });

    assert.equal(result.effective_A, 0);
    assert.equal(result.future_score, 0.0000);
    assert.equal(result.verdict, "SECURITY_POLICY_VIOLATION");
  }
});

test("Scenario 3B: Destructive operations WITH valid Human Architect Cryptographic Token are authorized (A = 1)", () => {
  const engine = new FDIAEngine();
  const validArchitectToken = sign("Chief_Architect", "drop_table_customers");

  const aEval = engine.evaluateA("drop_table_customers", "", validArchitectToken);
  assert.equal(aEval.A, 1);
  assert.ok(aEval.reason.includes("Architect cryptographic signature verified"));
  // A role not listed as an approver for the rule cannot sign for it.
  assert.equal(engine.evaluateA("drop_table_customers", "", sign("Chief_Financial_Architect", "drop_table_customers")).A, 0);

  const result = engine.evaluate({
    data_quality: 0.95,
    intent_precision: 1.0,
    authorized: true,
    action_name: "drop_table_customers",
    architect_token: validArchitectToken,
  });

  assert.equal(result.effective_A, 1);
  assert.equal(result.verdict, "AUTHORIZED");
  assert.equal(result.future_score, 0.95);
});

// ============================================================================
// SCENARIO 4: SIMULATING ON-THE-FLY CUSTOM RULES INJECTION (DYNAMIC ENGINE)
// ============================================================================

test("Scenario 4A: Dynamically inject Fintech Wire Transfer Governance Rule", () => {
  const engine = new FDIAEngine();

  // Step 1: Verify transfer_funds falls back to A = 0 before rule is added
  const beforeEval = engine.evaluateA("transfer_funds");
  assert.equal(beforeEval.A, 0, "Before injection, transfer_funds must fall back to A = 0");

  // Step 2: Inject custom Fintech rule at runtime
  engine.addRule({
    rule_id: "RULE-FINTECH-HIGH-VALUE-TRANSFER",
    description: "Fintech wire transfers exceeding limit require Chief Financial Architect signature",
    intent_patterns: ["transfer_funds", "wire_remittance_*", "payout_vendor_*"],
    action_type: "REQUIRE_HUMAN_SIGNATURE",
    assigned_A: 0,
    require_human_confirmation: true,
    human_approver_role: ["Chief_Financial_Architect", "Treasury_Lead"],
  });

  // Step 3: Attempt wire transfer without CFO signature -> Blocked (A = 0)
  const unsignedTransfer = engine.evaluate({
    data_quality: 1.0,
    intent_precision: 1.0,
    authorized: true,
    action_name: "wire_remittance_swift",
  });
  assert.equal(unsignedTransfer.effective_A, 0);
  assert.equal(unsignedTransfer.future_score, 0.0000);
  assert.equal(unsignedTransfer.verdict, "SECURITY_POLICY_VIOLATION");

  // Step 4: Wire transfer with valid Chief Financial Architect signature -> Authorized (A = 1)
  const cfoToken = sign("Chief_Financial_Architect", "wire_remittance_swift");
  const signedTransfer = engine.evaluate({
    data_quality: 0.98,
    intent_precision: 1.0,
    authorized: true,
    action_name: "wire_remittance_swift",
    architect_token: cfoToken,
  });
  assert.equal(signedTransfer.effective_A, 1);
  assert.equal(signedTransfer.future_score, 0.98);
  assert.equal(signedTransfer.verdict, "AUTHORIZED");
});

test("Scenario 4B: Dynamically inject Healthcare / HIPAA Medical Data Governance Rule", () => {
  const engine = new FDIAEngine();

  // Inject HIPAA protection rule
  engine.addRule({
    rule_id: "RULE-HIPAA-PHI-EXPORT-RESTRICTED",
    description: "Exporting protected health information must never touch unencrypted storage",
    intent_patterns: ["export_patient_records", "dump_health_phi_*"],
    action_type: "CONDITIONAL",
    assigned_A: 1,
    require_human_confirmation: false,
    denied_paths: ["unencrypted_s3", "public_temp", "insecure_blob"],
  });

  // Test 1: Exporting to compliant encrypted vault -> Approved
  const safeExport = engine.evaluate({
    data_quality: 0.90,
    intent_precision: 1.0,
    authorized: true,
    action_name: "export_patient_records",
    target_payload: "vault/kms_encrypted/batch_01.parquet",
  });
  assert.equal(safeExport.effective_A, 1);
  assert.equal(safeExport.verdict, "AUTHORIZED");

  // Test 2: Exporting to unencrypted path -> Blocked instantly
  const unsafeExport = engine.evaluate({
    data_quality: 0.90,
    intent_precision: 1.0,
    authorized: true,
    action_name: "dump_health_phi_records",
    target_payload: "public_temp/leaked_patients.csv",
  });
  assert.equal(unsafeExport.effective_A, 0);
  assert.equal(unsafeExport.future_score, 0.0000);
  assert.equal(unsafeExport.verdict, "SECURITY_POLICY_VIOLATION");
});

test("Scenario 4C: Dynamically inject Kubernetes Production Cluster Rollout Rule", () => {
  const engine = new FDIAEngine();

  engine.addRule({
    rule_id: "RULE-K8S-CLUSTER-ROLLOUT",
    description: "Kubernetes production rollout restricted to DevOps_Lead role",
    intent_patterns: ["k8s_deploy_prod_*", "k8s_scale_cluster"],
    action_type: "ALLOW",
    assigned_A: 1,
    require_human_confirmation: false,
    allowed_roles: ["Chief_Architect", "DevOps_Lead"],
  });

  // Developer role -> Denied (RBAC)
  const devRollout = engine.evaluate({
    data_quality: 0.95,
    intent_precision: 1.0,
    authorized: true,
    action_name: "k8s_deploy_prod_api",
    caller_role: "junior_developer",
  });
  assert.equal(devRollout.effective_A, 0);
  assert.equal(devRollout.verdict, "SECURITY_RBAC_DENIED");

  // DevOps Lead role -> Approved
  const opsRollout = engine.evaluate({
    data_quality: 0.95,
    intent_precision: 1.0,
    authorized: true,
    action_name: "k8s_deploy_prod_api",
    caller_role: "DevOps_Lead",
  });
  assert.equal(opsRollout.effective_A, 1);
  assert.equal(opsRollout.verdict, "AUTHORIZED");
});

// ============================================================================
// SCENARIO 5: ZERO-TRUST FALLBACK FOR UNREGISTERED INTENTS
// ============================================================================

test("Scenario 5: Completely unregistered / alien intents fall back to A = 0 (Zero-Trust Gate)", () => {
  const engine = new FDIAEngine();
  const unknownIntents = [
    "alien_system_probe_99",
    "crypto_miner_spawn",
    "unclassified_raw_command",
    "bypass_all_firewalls",
  ];

  for (const alien of unknownIntents) {
    const aEval = engine.evaluateA(alien);
    assert.equal(aEval.A, 0, `Unregistered intent "${alien}" must fall back to A = 0`);
    assert.equal(aEval.ruleTriggered, "ZERO_TRUST_FALLBACK");

    const result = engine.evaluate({
      data_quality: 0.99,
      intent_precision: 1.0,
      authorized: true,
      action_name: alien,
    });

    assert.equal(result.effective_A, 0);
    assert.equal(result.future_score, 0.0000);
    assert.equal(result.verdict, "SECURITY_AUTH_DENIED");
  }
});

// ============================================================================
// SCENARIO 6: MATHEMATICAL PHYSICAL CUTOFF GUARANTEE (A = 0 => F = 0.0000)
// ============================================================================

test("Scenario 6: Mathematical Proof — When A = 0, F unconditionally equals 0.0000 regardless of D or I", () => {
  const engine = new FDIAEngine();

  const extremeInputs = [
    { D: 1.0, I: 1.0 },
    { D: 1.0, I: 10.0 },
    { D: 0.999, I: 5.5 },
    { D: 0.5, I: 0.5 },
    { D: 0.001, I: 100.0 },
  ];

  for (const { D, I } of extremeInputs) {
    // When A = 0
    const collapsedF = engine.calculateF(D, I, 0);
    assert.equal(collapsedF, 0.0, `F must strictly be 0.0 when A = 0 for D=${D}, I=${I}`);

    // When A = 1
    const activeF = engine.calculateF(D, I, 1);
    const expected = Math.round(Math.pow(D, I) * 10000) / 10000;
    assert.equal(activeF, expected, `F must equal D^I when A = 1 for D=${D}, I=${I}`);
  }
});

// ============================================================================
// SCENARIO 7: DYNAMIC POLICY REPLACEMENT & RULE DELETION AT RUNTIME
// ============================================================================

test("Scenario 7: Full live policy replacement and rule removal at runtime", () => {
  const engine = new FDIAEngine();

  // Add rule then remove it
  const tempRule = {
    rule_id: "RULE-TEMP-MAINTENANCE",
    intent_patterns: ["maintenance_*"],
    action_type: "ALLOW",
    assigned_A: 1,
    require_human_confirmation: false,
  };

  engine.addRule(tempRule);
  assert.equal(engine.evaluateA("maintenance_reboot").A, 1);

  const removed = engine.removeRule("RULE-TEMP-MAINTENANCE");
  assert.equal(removed, true);
  assert.equal(engine.evaluateA("maintenance_reboot").A, 0);

  // Replace complete policy
  const permissivePolicy = {
    version: "2.5.0",
    organization_id: "test-corp",
    default_fallback_A: 1, // Permissive fallback
    custom_safety_threshold: 0.4,
    rules: [],
  };

  engine.setPolicy(permissivePolicy);
  assert.equal(engine.getPolicy().default_fallback_A, 1);
  assert.equal(engine.evaluateA("random_new_operation").A, 1);
});

// ============================================================================
// SCENARIO 8: SERVERLESS CLOUDFLARE WORKERS KV LOADING & REAL-TIME SYNC
// ============================================================================

test("Scenario 8: Cloudflare Workers KV Loading & Zero-Deploy Live Sync", async () => {
  // Mock Cloudflare KV Storage
  const kvStore = new Map();
  const mockKv = {
    get: async (key) => kvStore.get(key) || null,
    put: async (key, val) => { kvStore.set(key, val); },
  };

  // 1. Initially KV is empty -> falls back to bundled default policy
  const defaultEngine = await FDIAEngine.fromWorkersEnv({ FDIA_POLICY_KV: mockKv });
  assert.equal(defaultEngine.getPolicy().version, "1.0.0");
  assert.equal(defaultEngine.getValidationStatus().valid, true);

  // 2. Enterprise Admin saves new custom policy in Cloudflare KV dashboard
  const enterpriseKvPolicy = {
    version: "2.1.0-kv",
    organization_id: "delentia-enterprise-kv",
    default_fallback_A: 0,
    custom_safety_threshold: 0.6500,
    rules: [
      {
        rule_id: "KV-ALLOW-ANALYTICS",
        description: "Permit analytics query dynamically updated from Cloudflare KV",
        intent_patterns: ["analytics_*"],
        action_type: "ALLOW",
        assigned_A: 1,
        require_human_confirmation: false,
      },
    ],
  };

  await mockKv.put("fdia-policy", JSON.stringify(enterpriseKvPolicy));

  // 3. Worker loads live policy without redeploying code
  const kvEngine = await FDIAEngine.fromWorkersEnv({ FDIA_POLICY_KV: mockKv });
  assert.equal(kvEngine.getPolicy().version, "2.1.0-kv");
  assert.equal(kvEngine.getPolicy().organization_id, "delentia-enterprise-kv");

  // Verify dynamic rule from KV works immediately
  const evalAllow = kvEngine.evaluateA("analytics_summary");
  assert.equal(evalAllow.A, 1);
  assert.equal(evalAllow.ruleTriggered, "KV-ALLOW-ANALYTICS");

  // 4. Update KV in real-time to revoke access
  enterpriseKvPolicy.rules[0].assigned_A = 0;
  enterpriseKvPolicy.rules[0].action_type = "REQUIRE_HUMAN_SIGNATURE";
  await mockKv.put("fdia-policy", JSON.stringify(enterpriseKvPolicy));

  const updatedEngine = await FDIAEngine.fromWorkersEnv({ FDIA_POLICY_KV: mockKv });
  const evalRevoked = updatedEngine.evaluateA("analytics_summary");
  assert.equal(evalRevoked.A, 0, "KV updated rule must immediately veto A = 0 without redeploy");
});

// ============================================================================
// SCENARIO 9: ZOD SCHEMA VALIDATION ON STARTUP & DIAGNOSTIC RECOVERY
// ============================================================================

test("Scenario 9: Zod Schema Validation catches corrupted syntax & recovers safely", () => {
  // 1. Direct validation with invalid bounds & bad types
  const corruptedConfigInvalidType = {
    version: "2.0.0",
    organization_id: "test",
    custom_safety_threshold: 2.5, // Violates max(1.0)
    rules: "NOT_AN_ARRAY", // Violates array requirement
  };

  const valInvalid = validatePolicy(corruptedConfigInvalidType);
  assert.equal(valInvalid.valid, false);
  assert.ok(valInvalid.errors && valInvalid.errors.length > 0);
  assert.ok(valInvalid.errors.some((err) => err.includes("custom_safety_threshold")), "Must flag threshold > 1.0");
  assert.ok(valInvalid.errors.some((err) => err.includes("rules")), "Must flag non-array rules");

  // 2. Corrupted rule with invalid types (string instead of number for assigned_A)
  const corruptedRuleType = {
    version: "2.0.0",
    organization_id: "test",
    rules: [
      {
        rule_id: "RULE-BAD",
        description: "Bad rule",
        intent_patterns: ["test_*"],
        action_type: "ALLOW",
        assigned_A: "INVALID_STRING_NOT_NUMBER", // Type violation!
      },
    ],
  };

  const valBadType = validatePolicy(corruptedRuleType);
  assert.equal(valBadType.valid, false);
  assert.ok(valBadType.errors.some((err) => err.includes("assigned_A")));

  // 3. FDIAEngine Constructor Safe Fail-Safe:
  // Must NOT crash the server isolate, but fall back to Zero-Trust safe default
  const safeEngine = new FDIAEngine(corruptedRuleType);
  const status = safeEngine.getValidationStatus();
  assert.equal(status.valid, false, "Engine must record that validation failed");
  assert.ok(status.errors.length > 0, "Engine must store detailed diagnostics");

  // Must fall back to safe default policy so the server remains operable and secure
  assert.equal(safeEngine.getPolicy().version, "1.0.0");
  const fallbackEval = safeEngine.evaluateA("arbitrary_action");
  assert.equal(fallbackEval.A, 0, "Corrupted config must fail-safe to Zero-Trust (A = 0)");
});

// ============================================================================
// SCENARIO 10: ENVIRONMENT VARIABLE REAL-TIME INJECTION IN SERVERLESS ISOLATES
// ============================================================================

test("Scenario 10: Environment Variable Policy Injection (FDIA_POLICY_RULES_JSON)", async () => {
  const envPolicy = {
    version: "2.2.0-env",
    organization_id: "delentia-env-injected",
    default_fallback_A: 0,
    rules: [
      {
        rule_id: "ENV-DYNAMIC-RULE",
        description: "Rule loaded from Worker environment variable string",
        intent_patterns: ["env_ops_*"],
        action_type: "ALLOW",
        assigned_A: 1,
        require_human_confirmation: false,
      },
    ],
  };

  const envEngine = await FDIAEngine.fromWorkersEnv({
    FDIA_POLICY_RULES_JSON: JSON.stringify(envPolicy),
  });

  assert.equal(envEngine.getPolicy().version, "2.2.0-env");
  assert.equal(envEngine.getValidationStatus().valid, true);

  const evalEnv = envEngine.evaluateA("env_ops_deploy");
  assert.equal(evalEnv.A, 1);
  assert.equal(evalEnv.ruleTriggered, "ENV-DYNAMIC-RULE");
});
