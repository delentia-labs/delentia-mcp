/**
 * Round 49: the fdia worker's /auth endpoints no longer pretend to sign people in.
 * /auth/github/callback used to sign a session token for ANY `code` (no exchange with
 * GitHub) with a key hardcoded in this public source. They now answer 501 unless
 * configured, and there is no fallback secret.
 */
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../packages/fdia/dist/worker.js";

const get = (path, env = {}) => worker.fetch(new Request(`http://worker.test${path}`), { ENVIRONMENT: "test", ...env }, {});

test("callback never issues a token for an arbitrary code", async () => {
  const res = await get("/auth/github/callback?code=anything");
  assert.equal(res.status, 501);
  const body = await res.json();
  assert.equal(body.session_token, undefined);
  assert.equal(body.authenticated, undefined);
});

test("login and verify are off without real configuration (no hardcoded secret)", async () => {
  assert.equal((await get("/auth/github/login")).status, 501);
  const verify = await worker.fetch(new Request("http://worker.test/auth/verify", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: "x.y.z" }),
  }), { ENVIRONMENT: "test" }, {});
  assert.equal(verify.status, 501);
});

test("health still works", async () => {
  assert.equal((await get("/health")).status, 200);
});
