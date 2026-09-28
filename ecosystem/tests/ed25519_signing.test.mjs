import test from "node:test";
import assert from "node:assert/strict";

// Regression coverage for real Ed25519 JITNA packet signing, added
// 2026-09-14 to close a gap found by architecture audit: the deployed
// packages/jitna had zero cryptography, and the Python side's own attempt
// (jitna-gateway/main.py) is explicitly commented "(mock)" — a SHA-256
// string prefix, not real asymmetric signing, with unsigned packets only
// warned about, never rejected.
import {
  orchestrateSwarm,
  signJitnaPacket,
  verifyJitnaPacket,
  getOrCreateJitnaSigningKeypair,
} from "../packages/jitna/dist/index.js";
import {
  generateSigningKeypair,
  computeKeyFingerprint,
  canonicalJson,
  signPayload,
  verifyPayloadSignature,
} from "../packages/shared/dist/index.js";

test("Ed25519 - signJitnaPacket produces a real signature and 64-char fingerprint", async () => {
  const { jitna_packet } = orchestrateSwarm({ objective: "deploy the new pricing page", data_readiness: 75, target_pillar: "auto" });
  const signed = await signJitnaPacket(jitna_packet);

  assert.equal(signed.algorithm, "Ed25519");
  assert.equal(signed.public_key_fingerprint.length, 64);
  assert.match(signed.public_key_fingerprint, /^[0-9a-f]{64}$/);
  assert.ok(signed.signature.length > 0);
  assert.deepEqual(signed.packet, jitna_packet);
});

test("Ed25519 - a genuinely signed packet verifies true against the matching public key", async () => {
  const { jitna_packet } = orchestrateSwarm({ objective: "rotate the api credentials", data_readiness: 90, target_pillar: "guardian" });
  const { publicKey } = await getOrCreateJitnaSigningKeypair();
  const signed = await signJitnaPacket(jitna_packet);

  const publicKeyJwk = await crypto.subtle.exportKey("jwk", publicKey);
  const ok = await verifyJitnaPacket(signed, publicKeyJwk);
  assert.equal(ok, true);
});

test("Ed25519 - a tampered packet (payload mutated after signing) fails verification", async () => {
  const { jitna_packet } = orchestrateSwarm({ objective: "summarize the quarterly report", data_readiness: 60, target_pillar: "scribe" });
  const { publicKey } = await getOrCreateJitnaSigningKeypair();
  const publicKeyJwk = await crypto.subtle.exportKey("jwk", publicKey);
  const signed = await signJitnaPacket(jitna_packet);

  const tampered = { ...signed, packet: { ...signed.packet, D: 100, R: "attacker-modified rationale" } };
  const ok = await verifyJitnaPacket(tampered, publicKeyJwk);
  assert.equal(ok, false);
});

test("Ed25519 - a signature verified against the WRONG public key fails", async () => {
  const { jitna_packet } = orchestrateSwarm({ objective: "build a login form", data_readiness: 55, target_pillar: "executor" });
  const signed = await signJitnaPacket(jitna_packet);

  const otherKeypair = await generateSigningKeypair();
  const wrongPublicJwk = otherKeypair.jwk.publicKeyJwk;
  const ok = await verifyJitnaPacket(signed, wrongPublicJwk);
  assert.equal(ok, false);
});

test("Ed25519 - verifyJitnaPacket never throws on a malformed signature, just returns false", async () => {
  const { jitna_packet } = orchestrateSwarm({ objective: "clean up logs", data_readiness: 40, target_pillar: "scribe" });
  const { publicKey } = await getOrCreateJitnaSigningKeypair();
  const publicKeyJwk = await crypto.subtle.exportKey("jwk", publicKey);

  const garbled = { packet: jitna_packet, signature: "not-valid-base64!!!", public_key_fingerprint: "x", algorithm: "Ed25519", signed_at: new Date().toISOString(), key_source: "ephemeral_isolate" };
  const ok = await verifyJitnaPacket(garbled, publicKeyJwk);
  assert.equal(ok, false);
});

test("Ed25519 - two calls within the same isolate reuse the cached ephemeral keypair (stable fingerprint)", async () => {
  const { jitna_packet: p1 } = orchestrateSwarm({ objective: "task one", data_readiness: 50, target_pillar: "router" });
  const { jitna_packet: p2 } = orchestrateSwarm({ objective: "task two", data_readiness: 50, target_pillar: "router" });
  const signed1 = await signJitnaPacket(p1);
  const signed2 = await signJitnaPacket(p2);
  assert.equal(signed1.public_key_fingerprint, signed2.public_key_fingerprint);
  assert.equal(signed1.key_source, "ephemeral_isolate");
  assert.equal(signed2.key_source, "ephemeral_isolate");
});

test("Ed25519 - a configured JWK secret pair yields key_source configured_secret and a real signature", async () => {
  const keypair = await generateSigningKeypair();
  const env = {
    JITNA_SIGNING_PRIVATE_KEY_JWK: JSON.stringify(keypair.jwk.privateKeyJwk),
    JITNA_SIGNING_PUBLIC_KEY_JWK: JSON.stringify(keypair.jwk.publicKeyJwk),
  };
  const { jitna_packet } = orchestrateSwarm({ objective: "provision a new tenant", data_readiness: 80, target_pillar: "router" });
  const signed = await signJitnaPacket(jitna_packet, env);

  assert.equal(signed.key_source, "configured_secret");
  const expectedFingerprint = await computeKeyFingerprint(keypair.publicKey);
  assert.equal(signed.public_key_fingerprint, expectedFingerprint);
  const ok = await verifyJitnaPacket(signed, keypair.jwk.publicKeyJwk);
  assert.equal(ok, true);
});

test("Ed25519 - malformed configured secrets fall back to ephemeral generation rather than crashing", async () => {
  const env = { JITNA_SIGNING_PRIVATE_KEY_JWK: "not json", JITNA_SIGNING_PUBLIC_KEY_JWK: "also not json" };
  const { jitna_packet } = orchestrateSwarm({ objective: "recover gracefully", data_readiness: 70, target_pillar: "guardian" });
  const signed = await signJitnaPacket(jitna_packet, env);
  assert.equal(signed.key_source, "ephemeral_isolate");
  assert.equal(signed.public_key_fingerprint.length, 64);
});

test("canonicalJson - key order does not affect the serialized form (stable signing input)", () => {
  const a = canonicalJson({ z: 1, a: 2, m: { y: 1, b: 2 } });
  const b = canonicalJson({ a: 2, m: { b: 2, y: 1 }, z: 1 });
  assert.equal(a, b);
});

test("signPayload / verifyPayloadSignature - generic round trip works independent of the JITNA-specific wrapper", async () => {
  const keypair = await generateSigningKeypair();
  const payload = { hello: "world", n: 42, nested: { thai: "สวัสดี" } };
  const signature = await signPayload(keypair.privateKey, payload);
  const ok = await verifyPayloadSignature(keypair.publicKey, payload, signature);
  assert.equal(ok, true);

  const wrongPayload = { ...payload, n: 43 };
  const okWrong = await verifyPayloadSignature(keypair.publicKey, wrongPayload, signature);
  assert.equal(okWrong, false);
});

console.log("Ed25519 JITNA packet signing tests completed.");
