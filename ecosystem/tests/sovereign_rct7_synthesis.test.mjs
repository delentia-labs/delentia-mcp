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

import worker from "../packages/sovereign/dist/worker.js";

const FAKE_ENV = { ENVIRONMENT: "test" };

async function callEvaluateFdia(args) {
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
  const response = await worker.fetch(request, FAKE_ENV, {});
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
