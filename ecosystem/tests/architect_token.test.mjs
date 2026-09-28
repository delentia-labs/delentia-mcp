/**
 * Round 48: the Architect gate (A in F = (D^I) x A) is now a real signature.
 *
 * Before: FDIAEngine.verifyArchitectSignature accepted any caller-supplied
 * architect_token of 32+ characters, or "valid_architect_sig_<role>", so the
 * agent being governed could approve its own destructive actions. Verified
 * against the built sovereign worker: delete_database went from A = 0 to
 * AUTHORIZED with "a" x 40. These tests pin the fix, including the
 * production worker path and fail-closed behaviour with no keys configured.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";

import {
  FDIAEngine,
  MAX_TOKEN_TTL_SECONDS,
  configureTrustedArchitectKeys,
  getConfiguredTrustedArchitectKeys,
  parseTrustedArchitectKeys,
  signArchitectToken,
  verifyArchitectToken,
} from "../packages/shared/dist/index.js";
import sovereign from "../packages/sovereign/dist/worker.js";

function newKey(keyId, role) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    trusted: { key_id: keyId, role, public_key_hex: Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("hex") },
    pem: privateKey.export({ format: "pem", type: "pkcs8" }),
  };
}

const chief = newKey("chief-1", "Chief_Architect");
const intruder = newKey("intruder", "Chief_Architect");
const NOW = 1_800_000_000;

test("a token verifies only for its own action and payload", () => {
  const token = signArchitectToken(chief.pem, "chief-1", "delete_repo", '{"repo":"a"}', 600, NOW);
  const ctx = { trustedKeys: [chief.trusted], nowSeconds: NOW };
  assert.equal(verifyArchitectToken(token, { ...ctx, actionName: "delete_repo", targetPayload: '{"repo":"a"}' }).valid, true);
  assert.equal(verifyArchitectToken(token, { ...ctx, actionName: "delete_repo", targetPayload: '{"repo":"b"}' }).valid, false);
  assert.equal(verifyArchitectToken(token, { ...ctx, actionName: "drop_table", targetPayload: '{"repo":"a"}' }).valid, false);
});

test("expired, over-long, tampered and untrusted tokens are rejected", () => {
  const ctx = { trustedKeys: [chief.trusted], actionName: "delete_repo", targetPayload: "" };
  const t = signArchitectToken(chief.pem, "chief-1", "delete_repo", "", 600, NOW);
  assert.match(verifyArchitectToken(t, { ...ctx, nowSeconds: NOW + 601 }).reason, /expired/);

  const [v, k, exp, sig] = t.split(".");
  const tooLong = `${v}.${k}.${NOW + MAX_TOKEN_TTL_SECONDS + 60}.${sig}`;
  assert.match(verifyArchitectToken(tooLong, { ...ctx, nowSeconds: NOW }).reason, /24 h/);
  const bumped = `${v}.${k}.${Number(exp) + 1}.${sig}`; // extend the expiry without re-signing
  assert.equal(verifyArchitectToken(bumped, { ...ctx, nowSeconds: NOW }).valid, false);

  const foreign = signArchitectToken(intruder.pem, "chief-1", "delete_repo", "", 600, NOW); // claims a trusted key id
  assert.match(verifyArchitectToken(foreign, { ...ctx, nowSeconds: NOW }).reason, /does not verify/);
});

test("no trusted keys configured = nothing is ever valid (fail-closed)", () => {
  const t = signArchitectToken(chief.pem, "chief-1", "delete_repo", "", 600, NOW);
  assert.match(verifyArchitectToken(t, { trustedKeys: [], actionName: "delete_repo", targetPayload: "", nowSeconds: NOW }).reason,
    /fail-closed/);
});

test("key config parsing drops anything malformed instead of throwing", () => {
  assert.deepEqual(parseTrustedArchitectKeys("not json"), []);
  assert.deepEqual(parseTrustedArchitectKeys('{"key_id":"x"}'), []);
  const parsed = parseTrustedArchitectKeys(JSON.stringify([
    chief.trusted,
    { ...chief.trusted, key_id: "bad.id" },
    { ...chief.trusted, key_id: "short", public_key_hex: "abcd" },
  ]));
  assert.deepEqual(parsed, [chief.trusted]);
});

test("a caller-supplied policy cannot smuggle in its own trusted key", () => {
  const saved = getConfiguredTrustedArchitectKeys();
  configureTrustedArchitectKeys([chief.trusted]);
  try {
    const engine = new FDIAEngine({
      rules: [{ rule_id: "R", intent_patterns: ["delete_*"], action_type: "REQUIRE_HUMAN_SIGNATURE", assigned_A: 0 }],
      trusted_architect_keys: [intruder.trusted],
      trustedArchitectKeys: [intruder.trusted],
    });
    const forged = signArchitectToken(intruder.pem, "intruder", "delete_repo", "");
    assert.equal(engine.evaluateA("delete_repo", "", forged).A, 0);
    const real = signArchitectToken(chief.pem, "chief-1", "delete_repo", "");
    assert.equal(engine.evaluateA("delete_repo", "", real).A, 1);
  } finally {
    configureTrustedArchitectKeys(saved);
  }
});

async function callSovereign(env, args, ip) {
  const req = new Request("http://worker.test/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "evaluate_fdia", arguments: args } }),
  });
  return JSON.parse((await (await sovereign.fetch(req, env, {})).json()).result.content[0].text);
}

test("production worker: forged tokens that used to pass are now blocked", async () => {
  const env = { ENVIRONMENT: "test", FDIA_ARCHITECT_KEYS_JSON: JSON.stringify([chief.trusted]) };
  for (const [i, forged] of ["a".repeat(40), "valid_architect_sig_chief_architect", "delentia_auth_token_Chief_Architect"].entries()) {
    const r = await callSovereign(env, { action_name: "delete_database", data_quality: 0.9, architect_token: forged }, `203.0.113.${40 + i}`);
    assert.equal(r.verdict, "SECURITY_POLICY_VIOLATION", forged);
    assert.equal(r.future_score, 0);
  }
});

test("production worker: a real signature from a configured key authorizes, only when keys are configured", async () => {
  const token = signArchitectToken(chief.pem, "chief-1", "delete_database", "");
  const withKeys = { ENVIRONMENT: "test", FDIA_ARCHITECT_KEYS_JSON: JSON.stringify([chief.trusted]) };
  const ok = await callSovereign(withKeys, { action_name: "delete_database", data_quality: 0.9, architect_token: token }, "203.0.113.50");
  assert.equal(ok.verdict, "AUTHORIZED");
  const noKeys = await callSovereign({ ENVIRONMENT: "test" }, { action_name: "delete_database", data_quality: 0.9, architect_token: token }, "203.0.113.51");
  assert.equal(noKeys.verdict, "SECURITY_POLICY_VIOLATION");
});

test("deterministic cross-language vector (Delentia-OS signs the same bytes)", () => {
  // Ed25519 signatures are deterministic, so this fixed key + input must give
  // exactly this token in both repos (see Delentia-OS test_architect_token_real.py).
  const FIXED_PEM = "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIAABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4f\n-----END PRIVATE KEY-----\n";
  const token = signArchitectToken(FIXED_PEM, "k1", "delete_repo", '{"repo":"a"}', 600, NOW);
  assert.equal(token, CROSS_LANGUAGE_VECTOR);
});

const CROSS_LANGUAGE_VECTOR = "dat1.k1.1800000600.5u3u69tP7CeFJkU_MLNUU0fzDg0blNyNeBhPEbq7naqbw_BimKQXgUDa7rTvGI13QVWtZh26Y9dpxIsp0RB6CA";
