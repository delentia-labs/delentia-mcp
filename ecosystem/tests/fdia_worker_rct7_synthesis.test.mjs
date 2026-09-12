/**
 * DELENTIA FDIA (standalone) WORKER — RCT-7 -> intent_precision synthesis regression tests
 *
 * Extends the same optional `problem_statement` synthesis already added to
 * packages/sovereign and packages/intent-loop to the standalone `fdia`
 * worker — the pillar worker that IS the officially-published, standalone
 * FDIA MCP server (npm package delentia-mcp bundles this worker's logic).
 * Unlike `sovereign`, this worker did not already import RCT-7 in the same
 * deployment — @delentia/mcp-rct7 was added as a genuinely new dependency.
 *
 * These tests call the worker's real `fetch` handler directly (constructed
 * Request, real Response — no mocking of the handler itself). No
 * FDIA_SESSION_DO binding is provided; the worker's own try/catch fallbacks
 * around Durable Object calls are exercised for real here, same as they
 * would be on a first request before any session ever existed.
 */

import test from "node:test";
import assert from "node:assert/strict";

import worker from "../packages/fdia/dist/worker.js";

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
  const response = await worker.fetch(request, FAKE_ENV, { waitUntil: () => {} });
  const body = await response.json();
  return JSON.parse(body.result.content[0].text);
}

test("fdia worker evaluate_fdia: backward compatible — no problem_statement, explicit intent_precision behaves exactly as before this change", async () => {
  const result = await callEvaluateFdia({ data_quality: 0.9, intent_precision: 1.2, action_name: "read_report" });
  assert.equal(result.intent_precision, 1.2);
  assert.equal(result.future_score, Math.round(Math.pow(0.9, 1.2) * 10000) / 10000);
  assert.equal(result.rct7_synthesis, undefined, "must not add an rct7_synthesis field when problem_statement wasn't supplied");
});

test("fdia worker evaluate_fdia: backward compatible — no problem_statement, no intent_precision defaults to 1.0 exactly as before", async () => {
  const result = await callEvaluateFdia({ data_quality: 0.9, action_name: "read_report" });
  assert.equal(result.intent_precision, 1);
  assert.equal(result.future_score, 0.9);
  assert.equal(result.rct7_synthesis, undefined);
});

test("fdia worker evaluate_fdia: supplying problem_statement triggers real RCT-7 synthesis and surfaces it in the response", async () => {
  const result = await callEvaluateFdia({
    data_quality: 0.9,
    action_name: "read_report",
    problem_statement: "analyze the quarterly revenue report and summarize key trends for the board",
  });
  assert.ok(result.rct7_synthesis, "rct7_synthesis must be present when problem_statement was supplied");
  assert.ok(result.rct7_synthesis.verified_alignment_score >= 0 && result.rct7_synthesis.verified_alignment_score <= 1);
  assert.equal(result.intent_precision, result.rct7_synthesis.derived_intent_precision);
  assert.ok(result.intent_precision >= 0.5 && result.intent_precision <= 2.0, "derived I must stay within the documented [0.5, 2.0] range");
  assert.notEqual(result.intent_precision, 1.0);
});

test("fdia worker evaluate_fdia: a destructive action_name is still blocked by the independent action_name gate, regardless of RCT-7 synthesis", async () => {
  const result = await callEvaluateFdia({
    data_quality: 0.9,
    action_name: "drop_production_table",
    problem_statement: "drop the production database table immediately",
  });
  assert.equal(result.authorized, false);
  assert.equal(result.future_score, 0);
  assert.equal(result.rule_triggered, "RULE-DATABASE-DESTRUCTIVE-BLOCK");
  assert.ok(result.rct7_synthesis);
});

test("fdia worker evaluate_fdia: an empty/whitespace-only problem_statement does NOT trigger synthesis (falls back to legacy default)", async () => {
  const result = await callEvaluateFdia({ data_quality: 0.9, action_name: "read_report", problem_statement: "   " });
  assert.equal(result.rct7_synthesis, undefined);
  assert.equal(result.intent_precision, 1);
});

test("fdia worker evaluate_fdia: no Durable Object binding present (fresh deployment) does not crash — try/catch fallback is exercised for real, not just in principle", async () => {
  // FAKE_ENV deliberately has no FDIA_SESSION_DO — proves the worker's own
  // graceful-fallback code path around the audit-log Durable Object.
  const result = await callEvaluateFdia({ data_quality: 0.9, action_name: "read_report" });
  assert.equal(result.verdict, "AUTHORIZED");
});
