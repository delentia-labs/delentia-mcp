/**
 * sovereign free/enterprise tier checks (2026-09-27): no hardcoded fallback secret, no trust in a
 * bare "Bearer zpka_" prefix, and the free quota keyed on the Cloudflare-set client IP rather than
 * a header the caller controls.
 */
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../packages/sovereign/dist/worker.js";

const OLD_COMMITTED_SECRET = "delentia_secret_gateway_token_2026_live";

async function call(env, headers) {
  const req = new Request("http://worker.test/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "evaluate_fdia", arguments: { action_name: "read_logs", data_quality: 0.9 } } }),
  });
  const res = await worker.fetch(req, env, {});
  const body = await res.json();
  return { status: res.status, body, meta: body.result ? JSON.parse(body.result.content[0].text)._meta : undefined };
}

test("a bare 'Bearer zpka_' header no longer grants the unlimited tier", async () => {
  const r = await call({ ENVIRONMENT: "test" }, { Authorization: "Bearer zpka_anything", "cf-connecting-ip": "203.0.113.1" });
  assert.notEqual(r.meta.tier, "enterprise_unlimited");
});

test("the old committed secret value grants nothing when no secret is configured", async () => {
  const r = await call({ ENVIRONMENT: "test" }, { "X-Delentia-Internal-Secret": OLD_COMMITTED_SECRET, "cf-connecting-ip": "203.0.113.2" });
  assert.notEqual(r.meta.tier, "enterprise_unlimited");
});

test("the configured gateway secret still grants the unlimited tier; a wrong one does not", async () => {
  const env = { ENVIRONMENT: "test", ZUPLO_SHARED_SECRET: "a-new-random-secret" };
  assert.equal((await call(env, { "X-Delentia-Internal-Secret": "a-new-random-secret" })).meta.tier, "enterprise_unlimited");
  assert.notEqual((await call(env, { "X-Delentia-Internal-Secret": "wrong", "cf-connecting-ip": "203.0.113.3" })).meta.tier, "enterprise_unlimited");
});

test("changing x-caller-id does not reset the free quota (it is keyed on cf-connecting-ip)", async () => {
  const env = { ENVIRONMENT: "test" };
  let last;
  for (let i = 0; i < 51; i++) last = await call(env, { "cf-connecting-ip": "203.0.113.4", "x-caller-id": `spoofed-${i}` });
  assert.equal(last.status, 429);
  assert.equal(last.body.error.data.tier, "free_sandbox_expired");
});
