/**
 * DELENTIA SOVEREIGN WORKER — RCT-7 -> intent_precision synthesis regression tests
 *
 * The `sovereign` worker (packages/sovereign) is the one production deployment
 * that already bundles both evaluate_fdia and executeRCT7 together, so it was
 * extended (2026-09-12) with the same optional `problem_statement` ->
 * intent_precision synthesis as packages/intent-loop, with zero new
 * dependencies. These tests call the worker's real `fetch` handler directly
 * (Cloudflare Workers' fetch handler is a plain async function, callable in
 * Node with the built-in Request/Response), not a mock of it.
 */

import test from "node:test";
import assert from "node:assert/strict";

import worker, { MEEGrowthSessionDO } from "../packages/sovereign/dist/worker.js";
import { createFakeDurableObjectNamespace } from "./helpers/fake-durable-object.mjs";

const FAKE_ENV = { ENVIRONMENT: "test" };

async function callEvaluateFdia(args, env = FAKE_ENV) {
  const request = new Request("http://worker.test/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "evaluate_fdia", arguments: args },
    }),
  });
  const response = await worker.fetch(request, env, {});
  const body = await response.json();
  return JSON.parse(body.result.content[0].text);
}

test("sovereign evaluate_fdia: backward compatible — no problem_statement, explicit intent_precision behaves exactly as before this change", async () => {
  const result = await callEvaluateFdia({ data_quality: 0.9, intent_precision: 1.2, action_name: "read_report" });
  assert.equal(result.intent_precision, 1.2);
  assert.equal(result.future_score, Math.round(Math.pow(0.9, 1.2) * 10000) / 10000);
  assert.equal(result.rct7_synthesis, undefined, "must not add an rct7_synthesis field when problem_statement wasn't supplied");
});

test("sovereign evaluate_fdia: backward compatible — no problem_statement, no intent_precision defaults to 1.0 exactly as before", async () => {
  const result = await callEvaluateFdia({ data_quality: 0.9, action_name: "read_report" });
  assert.equal(result.intent_precision, 1);
  assert.equal(result.future_score, 0.9);
  assert.equal(result.rct7_synthesis, undefined);
});

test("sovereign evaluate_fdia: supplying problem_statement triggers real RCT-7 synthesis and surfaces it in the response", async () => {
  const result = await callEvaluateFdia({
    data_quality: 0.9,
    action_name: "read_report",
    problem_statement: "analyze the quarterly revenue report and summarize key trends for the board",
  });
  assert.ok(result.rct7_synthesis, "rct7_synthesis must be present when problem_statement was supplied");
  assert.ok(result.rct7_synthesis.verified_alignment_score >= 0 && result.rct7_synthesis.verified_alignment_score <= 1);
  assert.equal(result.intent_precision, result.rct7_synthesis.derived_intent_precision);
  assert.ok(result.intent_precision >= 0.5 && result.intent_precision <= 2.0, "derived I must stay within the documented [0.5, 2.0] range");
  // Explicitly NOT 1.0/1.2 (the old fixed defaults) — proves this took the RCT-7 path, not the legacy one.
  assert.notEqual(result.intent_precision, 1.0);
});

test("sovereign evaluate_fdia: a destructive action_name is still blocked by the independent action_name gate, regardless of RCT-7 synthesis", async () => {
  const result = await callEvaluateFdia({
    data_quality: 0.9,
    action_name: "drop_production_table",
    problem_statement: "drop the production database table immediately",
  });
  assert.equal(result.authorized, false);
  assert.equal(result.future_score, 0);
  assert.equal(result.rule_triggered, "RULE-DATABASE-DESTRUCTIVE-BLOCK");
  // RCT-7 still ran and is reported, even though the action_name gate is what actually blocked it.
  assert.ok(result.rct7_synthesis);
});

test("sovereign evaluate_fdia: an empty/whitespace-only problem_statement does NOT trigger synthesis (falls back to legacy default)", async () => {
  const result = await callEvaluateFdia({ data_quality: 0.9, action_name: "read_report", problem_statement: "   " });
  assert.equal(result.rct7_synthesis, undefined);
  assert.equal(result.intent_precision, 1);
});

// ============================================================================
// MEE growth via a real Durable Object (2026-09-13) — these tests provide a
// FAKE Durable Object namespace (see helpers/fake-durable-object.mjs) that
// runs the REAL MEEGrowthSessionDO class with real in-memory persistence,
// not a mock of the growth math or the DO's own fetch handler.
// ============================================================================

function envWithMee() {
  return { ...FAKE_ENV, MEE_SESSION_DO: createFakeDurableObjectNamespace(MEEGrowthSessionDO) };
}

test("sovereign evaluate_fdia: without a MEE_SESSION_DO binding, mee_growth is simply absent (graceful, backward compatible)", async () => {
  const result = await callEvaluateFdia({ data_quality: 0.9, action_name: "read_report" }, FAKE_ENV);
  assert.equal(result.mee_growth, undefined);
});

test("sovereign evaluate_fdia: with a real MEE_SESSION_DO binding, a real growth step is returned and reflects this call's own future_score", async () => {
  const env = envWithMee();
  const result = await callEvaluateFdia({ data_quality: 0.9, action_name: "read_report" }, env);
  assert.ok(result.mee_growth, "mee_growth must be present when the binding exists");
  assert.equal(result.mee_growth.step.delta, result.future_score - 0.5);
  assert.equal(result.mee_growth.step.governance_violation, false);
  assert.equal(result.mee_growth.step.g_before, 1.0, "first step in a fresh session starts from G=1.0");
});

test("sovereign evaluate_fdia: growth genuinely PERSISTS across calls to the same default session — G compounds, it's not reset per request", async () => {
  const env = envWithMee();
  const first = await callEvaluateFdia({ data_quality: 0.9, action_name: "read_report" }, env);
  const second = await callEvaluateFdia({ data_quality: 0.9, action_name: "read_report" }, env);
  assert.equal(second.mee_growth.step.g_before, first.mee_growth.step.g_after, "second call must continue from the first call's ending G, proving real persistence, not an ephemeral per-request tracker");
  assert.equal(second.mee_growth.summary.steps, 2);
});

test("sovereign evaluate_fdia: an unauthorized result is a real governance_violation and genuinely degrades resilience", async () => {
  const env = envWithMee();
  const denied = await callEvaluateFdia({ data_quality: 0.9, action_name: "drop_production_table", authorized: false }, env);
  assert.equal(denied.authorized, false);
  assert.equal(denied.mee_growth.step.governance_violation, true);
  assert.equal(denied.mee_growth.step.resilience, 0.98, "one violation must degrade resilience by exactly the documented 0.02 penalty");
});

test("sovereign evaluate_fdia: a distinct session_id gets a genuinely ISOLATED growth trajectory from the shared default", async () => {
  const env = envWithMee();
  await callEvaluateFdia({ data_quality: 0.9, action_name: "read_report" }, env); // steps the "default" session once
  const isolated = await callEvaluateFdia({ data_quality: 0.9, action_name: "read_report", session_id: "agent-alpha" }, env);
  assert.equal(isolated.mee_growth.step.g_before, 1.0, "a never-before-seen session_id must start fresh at G=1.0, unaffected by the default session's prior step");
  assert.equal(isolated.mee_growth.summary.steps, 1);
});
