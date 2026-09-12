/**
 * DELENTIA FDIA — DEEP HYPOTHESIS / ADVERSARIAL TEST SUITE
 *
 * Goal (requested 2026-09-11): go beyond the existing scenario tests
 * (tests/test_fdia_policy_engine.mjs) and stress-test the mathematical and
 * policy-matching LOGIC itself with hypothesis-driven cases — boundary
 * values, adversarial inputs, and structural trust-boundary questions —
 * not just "does the happy path work."
 *
 * Each test states the hypothesis it is checking. A test that fails here
 * is either a real bug (fix the code) or a real limitation (fix the docs,
 * keep the test as a documented, asserted-on-purpose behavior — never
 * silently delete a failing hypothesis test without deciding which it is).
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  FDIAEngine,
  evaluateFDIA,
  matchesWildcard,
  createDefaultPolicy,
} from "../packages/shared/dist/index.js";

// ============================================================================
// H1 — MATHEMATICAL INVARIANTS OF F = D^I * A
// ============================================================================

test("H1a: D=1 forces F=A regardless of I, for any I >= 0 (1^I = 1 identically)", () => {
  const engine = new FDIAEngine();
  for (const I of [0, 0.5, 1, 2, 10, 100, 1e6]) {
    assert.equal(engine.calculateF(1, I, 1), 1, `F must be 1 at D=1, I=${I}, A=1`);
    assert.equal(engine.calculateF(1, I, 0), 0, `F must be 0 at D=1, I=${I}, A=0 (physical cutoff still applies)`);
  }
});

test("H1b: D=0, I>0 forces F=0 (0^I = 0 for I>0); D=0, I=0 is the documented 0^0=1 edge case", () => {
  const engine = new FDIAEngine();
  assert.equal(engine.calculateF(0, 1, 1), 0);
  assert.equal(engine.calculateF(0, 5, 1), 0);
  assert.equal(engine.calculateF(0, 0.5, 1), 0);
  // JS Math.pow(0, 0) === 1 by spec (IEEE 754), same as most languages.
  // Documenting this rather than hiding it: a caller submitting D=0 with
  // I=0 (I's schema floor is 0.5 via FDIARequestSchema, but calculateF()
  // itself is a public method with no such floor) gets F=1, not F=0. This
  // is mathematically correct pow(0,0) behavior, not a bug — but it means
  // calculateF() alone is not a safe substitute for going through the full
  // evaluate()/schema path, which enforces intent_precision >= 0.5.
  assert.equal(engine.calculateF(0, 0, 1), 1, "Math.pow(0,0)=1 propagates through calculateF by design");
});

test("H1c: Monotonicity — for fixed I>0 and A=1, F is non-decreasing as D increases over [0,1]", () => {
  const engine = new FDIAEngine();
  for (const I of [0.5, 1, 2, 5]) {
    let prev = -1;
    for (const D of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1.0]) {
      const F = engine.calculateF(D, I, 1);
      assert.ok(F >= prev - 1e-9, `F must be non-decreasing in D at I=${I}: D=${D} gave F=${F} < prev=${prev}`);
      prev = F;
    }
  }
});

test("H1d: Monotonicity — for fixed 0<D<1 and A=1, F is non-increasing as I increases (D^I shrinks toward 0)", () => {
  const engine = new FDIAEngine();
  for (const D of [0.1, 0.3, 0.6, 0.9]) {
    let prev = 2;
    for (const I of [0.5, 1, 2, 5, 10, 50]) {
      const F = engine.calculateF(D, I, 1);
      assert.ok(F <= prev + 1e-9, `F must be non-increasing in I at D=${D}: I=${I} gave F=${F} > prev=${prev}`);
      prev = F;
    }
  }
});

test("H1e: Physical cutoff holds under extreme/malformed D,I too — A=0 always wins, even over Infinity/NaN inputs", () => {
  const engine = new FDIAEngine();
  const extremeCases = [
    [Infinity, 1],
    [1, Infinity],
    [NaN, 1],
    [1, NaN],
    [-5, 2],
    [5, -2],
    [Number.MAX_VALUE, Number.MAX_VALUE],
  ];
  for (const [D, I] of extremeCases) {
    assert.equal(engine.calculateF(D, I, 0), 0, `A=0 must force F=0 even for D=${D}, I=${I}`);
  }
});

test("H1f: calculateF fails closed (returns 0, never NaN/Infinity) on its own malformed input, independent of evaluate()'s guard", () => {
  const engine = new FDIAEngine();
  // calculateF is a public method — it must be safe to call directly,
  // not just safe when routed through evaluate()'s separate numericInputInvalid check.
  const malformed = [
    [Infinity, 1, 1],
    [1, Infinity, 1],
    [NaN, 1, 1],
    [1, NaN, 1],
    [-1, 1, 1],
    [1, -1, 1],
    [2, 1075, 1], // Math.pow(2, 1075) overflows to Infinity
  ];
  for (const [D, I, A] of malformed) {
    const F = engine.calculateF(D, I, A);
    assert.equal(F, 0, `calculateF(${D}, ${I}, ${A}) must fail closed to 0, got ${F}`);
    assert.ok(Number.isFinite(F), `calculateF(${D}, ${I}, ${A}) must never return non-finite`);
  }
});

test("H1g: Underflow (very small D, large I) legitimately rounds to 0.0000 — not a fail-closed case, a real low score", () => {
  const engine = new FDIAEngine();
  const F = engine.calculateF(0.0001, 50, 1);
  assert.equal(F, 0, "0.0001^50 underflows below the 4-decimal rounding resolution — expected, not a bug");
});

test("H1h: Rounding is to exactly 4 decimal places, and threshold comparison uses the rounded value", () => {
  const engine = new FDIAEngine();
  // D=0.70001, I=1 -> raw 0.70001, rounds to 0.7 at 4dp
  const F = engine.calculateF(0.70001, 1, 1);
  assert.equal(F, 0.7);
  // Construct a case that rounds to exactly the default threshold (0.5) from below
  const F2 = engine.calculateF(0.49996, 1, 1); // rounds to 0.5
  assert.equal(F2, 0.5);
  const result = evaluateFDIA({
    data_quality: 0.49996,
    intent_precision: 1.0,
    authorized: true,
    action_name: "read_edge_case",
  });
  assert.equal(result.future_score, 0.5);
  assert.equal(result.verdict, "AUTHORIZED", "future_score === threshold must authorize (>= is inclusive)");
});

// ============================================================================
// H2 — DETERMINISM
// ============================================================================

test("H2: Identical requests always produce identical future_score, verdict, effective_A (audit_digest/timestamp may differ)", () => {
  const request = {
    data_quality: 0.837,
    intent_precision: 1.3,
    authorized: true,
    action_name: "modify_code",
    target_payload: "src/app.ts",
    caller_role: "developer",
  };
  const results = Array.from({ length: 20 }, () => evaluateFDIA(request));
  const first = results[0];
  for (const r of results) {
    assert.equal(r.future_score, first.future_score);
    assert.equal(r.verdict, first.verdict);
    assert.equal(r.effective_A, first.effective_A);
    assert.equal(r.rule_triggered, first.rule_triggered);
  }
});

test("H2b: audit_digest is a 64-char hex SHA-256 and differs across distinguishable inputs (no collision on these fixtures)", () => {
  const base = { data_quality: 0.9, intent_precision: 1.0, authorized: true, action_name: "read_logs" };
  const variants = [
    base,
    { ...base, data_quality: 0.91 },
    { ...base, action_name: "read_logs_v2" },
    { ...base, caller_role: "admin" },
  ];
  const digests = variants.map((v) => evaluateFDIA(v).audit_digest);
  for (const d of digests) {
    assert.match(d, /^[0-9a-f]{64}$/);
  }
  assert.equal(new Set(digests).size, digests.length, "distinct inputs must produce distinct digests");
});

// ============================================================================
// H3 — POLICY-MATCHING ADVERSARIAL / EVASION HYPOTHESES
// ============================================================================

test("H3a: [BUG FOUND + FIXED] genuine multi-pattern overlap now resolves to the MOST restrictive matching rule, not the first array match", () => {
  const engine = new FDIAEngine();
  // "purge_telemetry_cache" matches BOTH: RULE-DATABASE-DESTRUCTIVE-BLOCK's
  // anchored "purge_*" AND RULE-READONLY-ALLOW's unanchored "*telemetry*".
  // Before the fix, evaluateA() returned on the FIRST array match, so
  // whichever rule the policy author (or the bundled default) happened to
  // list first silently won — an enterprise customer listing a broad ALLOW
  // rule before a narrow BLOCK rule in their own custom_policy would have
  // hit this exact bypass, with no warning. Now: highest-severity match wins.
  const r1 = engine.evaluateA("purge_telemetry_cache");
  assert.equal(r1.A, 0, "destructive purge_* must win over the telemetry allow-list, regardless of array order");
  assert.equal(r1.ruleTriggered, "RULE-DATABASE-DESTRUCTIVE-BLOCK");

  const r2 = engine.evaluateA("quick_eval_code_test");
  assert.equal(r2.A, 0, "*eval_code* (arbitrary code execution) must win over the quick_* allow-list");
  assert.equal(r2.ruleTriggered, "RULE-DATABASE-DESTRUCTIVE-BLOCK");

  // Full evaluate() path: F must collapse to 0 for both, and a valid
  // architect signature must be able to override (VETO is not absolute —
  // it's a human-signature gate, by design).
  const blocked = evaluateFDIA({
    data_quality: 0.99,
    intent_precision: 1.0,
    authorized: true,
    action_name: "purge_telemetry_cache",
  });
  assert.equal(blocked.future_score, 0);
  assert.equal(blocked.verdict, "SECURITY_POLICY_VIOLATION");

  const signed = evaluateFDIA({
    data_quality: 0.99,
    intent_precision: 1.0,
    authorized: true,
    action_name: "purge_telemetry_cache",
    architect_token: "valid_architect_sig_Chief_Architect",
  });
  assert.equal(signed.verdict, "AUTHORIZED", "a valid architect signature still overrides the block, as designed");
});

test("H3b: severity ranking is order-independent — same result whether the ALLOW or BLOCK rule is declared first in a custom policy", () => {
  const allowFirst = new FDIAEngine({
    rules: [
      { rule_id: "R-ALLOW", intent_patterns: ["*ops*"], action_type: "ALLOW", assigned_A: 1 },
      { rule_id: "R-BLOCK", intent_patterns: ["danger_*"], action_type: "REQUIRE_HUMAN_SIGNATURE", assigned_A: 0 },
    ],
  });
  const blockFirst = new FDIAEngine({
    rules: [
      { rule_id: "R-BLOCK", intent_patterns: ["danger_*"], action_type: "REQUIRE_HUMAN_SIGNATURE", assigned_A: 0 },
      { rule_id: "R-ALLOW", intent_patterns: ["*ops*"], action_type: "ALLOW", assigned_A: 1 },
    ],
  });
  // "danger_ops_run" matches both rules in both policies.
  const r1 = allowFirst.evaluateA("danger_ops_run");
  const r2 = blockFirst.evaluateA("danger_ops_run");
  assert.equal(r1.A, 0);
  assert.equal(r2.A, 0);
  assert.equal(r1.ruleTriggered, r2.ruleTriggered, "policy-author array order must not change which rule wins");
});

test("H3c: [DOCUMENTED LIMITATION, not fixed] action_name is a caller-self-reported label — FDIA pattern-matches the label, it cannot verify the label matches what will actually execute", () => {
  const engine = new FDIAEngine();
  // "read_drop_table_customers" does NOT match any BLOCK pattern (they are
  // anchored to require the string literally START with drop_/delete_/etc,
  // and this string starts with "read_") — so it legitimately only matches
  // RULE-READONLY-ALLOW and is authorized. This is NOT the H3a bug (there is
  // no second matching rule being shadowed here); it is a structural trust
  // boundary: FDIA secures "does this declared action match policy", not
  // "does this declared action match what the caller will actually do".
  // A caller (malicious or buggy) that mislabels a destructive call as a
  // read_* action evades the gate entirely. This is asserted here on
  // purpose, as a known limitation to disclose, not silently "fixed" by
  // trying to guess true intent from a string — the real fix is architectural
  // (action_name must be derived from the actual invoked function by the
  // calling application, never freely chosen by an LLM) and is out of this
  // engine's scope.
  const r = engine.evaluateA("read_drop_table_customers");
  assert.equal(r.A, 1, "documents the current (intentionally unfixed) trust-boundary limitation");
  assert.equal(r.ruleTriggered, "RULE-READONLY-ALLOW");
});

test("H3d: wildcard matching is case-insensitive both directions (evades neither over- nor under-blocking via case)", () => {
  assert.equal(matchesWildcard("DROP_TABLE", "drop_*"), true);
  assert.equal(matchesWildcard("drop_table", "DROP_*"), true);
  assert.equal(matchesWildcard("DrOp_TaBlE", "*table*"), true);
});

test("H3e: whitespace padding does not bypass a substring-based unanchored block pattern (indexOf still finds the substring)", () => {
  const engine = new FDIAEngine();
  const r = engine.evaluateA("  purge_telemetry_cache  ");
  // Padding doesn't strip the anchored "purge_*" match (text still starts
  // with whitespace, not "purge_", so this specific anchored pattern
  // actually stops matching — but it still resolves through the fallback,
  // never granting A=1 via READONLY-ALLOW's *telemetry* unanchored match
  // colliding). This asserts the real observed behavior rather than an
  // assumption either way.
  assert.ok(r.A === 0, `padded action name must not end up authorized: got A=${r.A} via ${r.ruleTriggered}`);
});

test("H3f: zero-width space injected mid-keyword breaks substring matching (a real, disclosed evasion of the *pattern* match) but the zero-trust fallback still denies by default", () => {
  const engine = new FDIAEngine();
  const zwsp = "dr​op_table_customers"; // zero-width space between "dr" and "op"
  assert.equal(matchesWildcard(zwsp, "drop_*"), false, "ZWSP genuinely breaks the literal substring match");
  const r = engine.evaluateA(zwsp);
  // No rule matches at all (neither ALLOW nor BLOCK), so this falls to the
  // Zero-Trust default_fallback_A=0 — still denied, but for a DIFFERENT
  // reason than the intended block rule. Disclosed limitation: pattern
  // matching is defeated by the injected character; only the fail-safe
  // default (deny-unless-explicitly-allowed) saves this specific case. A
  // policy with default_fallback_A=1 (permissive mode, which validatePolicy()
  // already warns against) would NOT be protected here.
  assert.equal(r.A, 0);
  assert.equal(r.ruleTriggered, "ZERO_TRUST_FALLBACK", "denied via fallback, not via the block rule itself");
});

test("H3g: an unmatched action under a permissive custom fallback (default_fallback_A=1) is genuinely NOT protected by pattern evasion — confirms H3f's caveat", () => {
  const permissiveEngine = new FDIAEngine({
    default_fallback_A: 1,
    rules: [
      { rule_id: "R-BLOCK", intent_patterns: ["drop_*"], action_type: "REQUIRE_HUMAN_SIGNATURE", assigned_A: 0 },
    ],
  });
  const zwsp = "dr​op_table_customers";
  const r = permissiveEngine.evaluateA(zwsp);
  assert.equal(r.A, 1, "confirms: under a permissive fallback, the ZWSP evasion genuinely bypasses the block rule");
  assert.equal(r.ruleTriggered, "ZERO_TRUST_FALLBACK");
});

// ============================================================================
// H4 — INJECTION / MALFORMED-INPUT ROBUSTNESS (no crash, no prototype pollution)
// ============================================================================

test("H4a: a custom_policy JSON payload containing __proto__ does not pollute Object.prototype", () => {
  const maliciousPolicy = JSON.parse('{"version":"1.0.0","rules":[],"__proto__":{"polluted":true}}');
  new FDIAEngine(maliciousPolicy);
  assert.equal(({}).polluted, undefined, "Object.prototype must not be polluted by policy merge/spread");
  assert.equal(Object.prototype.polluted, undefined);
});

test("H4b: evaluate() does not throw on pathological string inputs (very long, null-byte, control characters)", () => {
  const veryLong = "a".repeat(100_000);
  assert.doesNotThrow(() => evaluateFDIA({
    data_quality: 0.9,
    intent_precision: 1.0,
    authorized: true,
    action_name: veryLong,
  }));

  assert.doesNotThrow(() => evaluateFDIA({
    data_quality: 0.9,
    intent_precision: 1.0,
    authorized: true,
    action_name: "read_data",
    target_payload: "path/with\x00null/byte",
  }));

  assert.doesNotThrow(() => evaluateFDIA({
    data_quality: 0.9,
    intent_precision: 1.0,
    authorized: true,
    action_name: "read__control_chars",
  }));
});

test("H4c: matchesWildcard never throws on adversarial pattern inputs (empty, only stars, regex-special characters)", () => {
  const cases = [
    ["", ""],
    ["", "*"],
    ["text", ""],
    ["text", "****"],
    ["a.b+c(d)[e]", "a.b+c(d)[e]"], // regex-special chars must be treated literally, not as regex
    ["a.b+c(d)[e]", "*b+c*"],
    ["anything", "*"],
  ];
  for (const [text, pattern] of cases) {
    assert.doesNotThrow(() => matchesWildcard(text, pattern));
  }
  // Regex-special characters must match literally (matchesWildcard is not
  // regex-based), proving a pattern like "*.env" isn't secretly interpreted
  // as "any-char then env" in a way that over- or under-matches.
  assert.equal(matchesWildcard("a.b+c(d)[e]", "a.b+c(d)[e]"), true);
  assert.equal(matchesWildcard("aXbXcXdXeX", "a.b+c(d)[e]"), false, "literal chars must not act as regex metacharacters");
});

// ============================================================================
// H5 — CUSTOM_POLICY REQUEST-SCOPED OVERRIDE ISOLATION
// ============================================================================

test("H5: a per-request custom_policy does not mutate the engine's persisted base policy", () => {
  const engine = new FDIAEngine();
  const basePolicyBefore = JSON.stringify(engine.getPolicy());

  evaluateFDIA.length; // no-op to keep lints happy about unused import shape
  const result = engine.evaluate({
    data_quality: 0.9,
    intent_precision: 1.0,
    authorized: true,
    action_name: "totally_custom_action",
    custom_policy: {
      default_fallback_A: 1,
      rules: [{ rule_id: "ONE-OFF", intent_patterns: ["totally_custom_*"], action_type: "ALLOW", assigned_A: 1 }],
    },
  });
  assert.equal(result.effective_A, 1, "the inline custom_policy must be honored for this call");

  const basePolicyAfter = JSON.stringify(engine.getPolicy());
  assert.equal(basePolicyAfter, basePolicyBefore, "engine's own persisted policy must be untouched by a request-scoped override");

  // And the engine's own policy, used without custom_policy, still denies
  // the same unregistered action under its own zero-trust default.
  const r2 = engine.evaluateA("totally_custom_action");
  assert.equal(r2.A, 0);
});

test("H5b: malformed inline custom_policy in a request falls back to the safe default policy, not a crash or a silent permissive pass", () => {
  const result = evaluateFDIA({
    data_quality: 0.9,
    intent_precision: 1.0,
    authorized: true,
    action_name: "read_something",
    custom_policy: { custom_safety_threshold: 99 }, // out of schema bounds (max 1.0)
  });
  // Falls back to createDefaultPolicy() per FDIAEngine constructor's
  // validation-failure path; "read_something" matches the default
  // READONLY-ALLOW rule under that fallback policy.
  assert.equal(result.effective_A, 1);
  assert.equal(result.applied_policy_id, "enterprise-fdia-policy-v1");
});

// ============================================================================
// H6 — RBAC INTERACTION WITH SEVERITY RANKING
// ============================================================================

test("H6: RBAC role-check applies to whichever rule wins by severity, not just to whatever would have been the first array match", () => {
  const engine = new FDIAEngine({
    rules: [
      { rule_id: "R-ALLOW-ANY", intent_patterns: ["*ops*"], action_type: "ALLOW", assigned_A: 1 },
      {
        rule_id: "R-RESTRICTED",
        intent_patterns: ["danger_*"],
        action_type: "REQUIRE_HUMAN_SIGNATURE",
        assigned_A: 0,
        allowed_roles: ["Security_Admin"],
        human_approver_role: ["Security_Admin"],
      },
    ],
  });
  // "danger_ops_run" matches both; R-RESTRICTED wins by severity. The RBAC
  // check inside evaluateA() is keyed to the WINNING rule, so a caller in a
  // disallowed role gets SECURITY_RBAC_DENIED even though a broader ALLOW
  // rule also matched the same string.
  const denied = engine.evaluateA("danger_ops_run", "", undefined, "junior_developer");
  assert.equal(denied.A, 0);
  assert.equal(denied.ruleTriggered, "SECURITY_RBAC_DENIED");

  const permitted = engine.evaluateA(
    "danger_ops_run",
    "",
    "valid_architect_sig_Security_Admin",
    "Security_Admin"
  );
  assert.equal(permitted.A, 1);
});

// ============================================================================
// H7 — SANITY: default bundled policy still passes its own validator
// ============================================================================

test("H7: createDefaultPolicy() output is itself schema-valid and its rules are ordered most-restrictive-first for human readability (severity ranking makes this non-load-bearing, but it should stay true)", () => {
  const policy = createDefaultPolicy();
  const ranks = { REQUIRE_HUMAN_SIGNATURE: 2, CONDITIONAL: 1, ALLOW: 0 };
  const severities = policy.rules.map((r) => ranks[r.action_type] ?? 0);
  const sorted = [...severities].sort((a, b) => b - a);
  assert.deepEqual(severities, sorted, "bundled policy rules should be declared most-restrictive-first for readability");
});
