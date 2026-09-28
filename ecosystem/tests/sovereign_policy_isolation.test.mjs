/**
 * Regression tests for sovereign's policy isolation fix (2026-09-27).
 *
 * Before the fix, sovereign's configure_policy wrote one module-global policy, so any
 * anonymous caller could replace the policy every other caller on the same isolate was
 * evaluated against — e.g. flip the zero-trust default (unregistered action => A = 0) to
 * "allow everything". These tests run the real worker fetch handler against the real
 * MEEGrowthSessionDO class (in-memory fake DO namespace, same harness as the other tests).
 */
import test from "node:test";
import assert from "node:assert/strict";

import worker, { MEEGrowthSessionDO } from "../packages/sovereign/dist/worker.js";
import { createFakeDurableObjectNamespace } from "./helpers/fake-durable-object.mjs";

async function call(env, name, args) {
  const request = new Request("http://worker.test/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const response = await worker.fetch(request, env, {});
  const body = await response.json();
  return { isError: Boolean(body.result?.isError), payload: JSON.parse(body.result.content[0].text) };
}

const env = () => ({ ENVIRONMENT: "test", MEE_SESSION_DO: createFakeDurableObjectNamespace(MEEGrowthSessionDO) });

// A permissive policy an attacker would like everyone else to be evaluated against.
const ALLOW_EVERYTHING = {
  policy_id: "allow-everything",
  policy_name: "Allow everything",
  default_fallback_A: 1,
  custom_safety_threshold: 0.1,
  rules: [],
};
const UNREGISTERED = { action_name: "launch_rockets", data_quality: 0.9, intent_precision: 1.0, caller_role: "developer" };

test("configure_policy without a session_id is refused and changes nothing", async () => {
  const e = env();
  const res = await call(e, "configure_policy", ALLOW_EVERYTHING);
  assert.equal(res.isError, true);
  assert.equal(res.payload.status, "error");
  assert.match(res.payload.message, /requires a session_id/);

  const victim = await call(e, "evaluate_fdia", UNREGISTERED);
  assert.equal(victim.payload.authorized, false);
  assert.equal(victim.payload.verdict, "SECURITY_AUTH_DENIED");
});

test('session_id "default" cannot be used to reach the shared default', async () => {
  const res = await call(env(), "configure_policy", { ...ALLOW_EVERYTHING, session_id: "default" });
  assert.equal(res.isError, true);
});

test("a session's policy applies to that session only — not to callers without a session_id or with another one", async () => {
  const e = env();
  const set = await call(e, "configure_policy", { ...ALLOW_EVERYTHING, session_id: "attacker" });
  assert.equal(set.isError, false, JSON.stringify(set.payload));
  assert.equal(set.payload.session_id, "attacker");

  const own = await call(e, "evaluate_fdia", { ...UNREGISTERED, session_id: "attacker" });
  assert.equal(own.payload.authorized, true, "the session's own policy must actually take effect");

  const noSession = await call(e, "evaluate_fdia", UNREGISTERED);
  assert.equal(noSession.payload.authorized, false);
  assert.equal(noSession.payload.verdict, "SECURITY_AUTH_DENIED");

  const otherSession = await call(e, "evaluate_fdia", { ...UNREGISTERED, session_id: "victim" });
  assert.equal(otherSession.payload.authorized, false);
});

test("an invalid policy is rejected before anything is stored", async () => {
  const e = env();
  const bad = await call(e, "configure_policy", { session_id: "s1", policy_id: "x", policy_name: "x", custom_safety_threshold: "not-a-number" });
  assert.equal(bad.isError, true);
  const after = await call(e, "evaluate_fdia", { ...UNREGISTERED, session_id: "s1" });
  assert.equal(after.payload.authorized, false);
});
