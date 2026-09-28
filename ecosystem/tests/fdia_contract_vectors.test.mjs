/**
 * FDIA contract via shared golden vectors (Round 48 R3.3).
 *
 * tests/fdia_contract.test.mjs compares TS against the real Python kernel,
 * but it needs a sibling Delentia-OS checkout, so it only runs on a
 * developer machine. contracts/fdia_vectors.v1.json is committed
 * byte-identically in BOTH repositories (same SHA-256, asserted here and in
 * Delentia-OS's test_fdia_contract_vectors_real.py). Each repo's own CI
 * checks its own implementation against it, so changing the formula on one
 * side breaks that side's build until the contract is regenerated for both.
 *
 * Also pins the Round 48 fix: evaluate() used to AUTHORIZE any action when
 * intent_precision was 0 (F = D^0 = 1, and 0^0 = 1 in JS).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { FDIAEngine } from "../packages/shared/dist/fdia-core.js";
import sovereign from "../packages/sovereign/dist/worker.js";

const FDIA_VECTORS_SHA256 = "9bf3a660b5cfc8546cc329bd48c4660312fc636920763bc591033aa10700a496";
const here = path.dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(path.resolve(here, "../contracts/fdia_vectors.v1.json"), "utf-8").replace(/\r\n/g, "\n");
const vectors = JSON.parse(raw);
const engine = new FDIAEngine();

test("the contract file is the exact version both repositories agreed on", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), FDIA_VECTORS_SHA256);
});

test(`TS calculateF matches all ${vectors.agreed.length} agreed vectors`, () => {
  assert.ok(vectors.agreed.length > 400);
  for (const { D, I, A, F } of vectors.agreed) {
    const got = engine.calculateF(D, I, A);
    assert.ok(Math.abs(got - F) <= vectors.tolerance + 1e-12, `D=${D} I=${I} A=${A}: TS=${got} contract=${F}`);
  }
});

test("known divergences still behave exactly as documented on the TS side", () => {
  for (const { D, I, A, ts, why } of vectors.known_divergences) {
    assert.equal(engine.calculateF(D, I, A), ts, why);
  }
});

test("evaluate() fails closed outside the published domain (Round 48 bypass fix)", () => {
  for (const [dq, ip] of [[0, 0], [0.01, 0], [1, 0.49], [1.5, 1], [0.9, -1]]) {
    // A benign action on purpose: the default policy already blocks delete_*,
    // which would hide the bug this test exists to catch.
    const r = engine.evaluate({ action_name: "read_logs", data_quality: dq, intent_precision: ip, authorized: true });
    assert.equal(r.future_score, 0, `D=${dq} I=${ip}`);
    assert.notEqual(r.verdict, "AUTHORIZED", `D=${dq} I=${ip}`);
  }
  const ok = engine.evaluate({ action_name: "read_logs", data_quality: 0.9, intent_precision: 0.5, authorized: true });
  assert.equal(ok.verdict, "AUTHORIZED");
});

test("the deployed evaluate_fdia tool no longer authorizes intent_precision=0", async () => {
  const req = new Request("http://worker.test/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", "cf-connecting-ip": "203.0.113.77" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "evaluate_fdia", arguments: { action_name: "read_logs", data_quality: 0.01, intent_precision: 0 } },
    }),
  });
  const body = await (await sovereign.fetch(req, { ENVIRONMENT: "test" }, {})).json();
  const result = JSON.parse(body.result.content[0].text);
  assert.equal(result.future_score, 0);
  assert.notEqual(result.verdict, "AUTHORIZED");
});
