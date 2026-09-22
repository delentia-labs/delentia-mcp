/**
 * Real regression coverage for MEEGrowthGatedDO (packages/shared/src/mee-growth-gated-do.ts),
 * the new opt-in/additive, hash-chained, FDIA-gated, Ed25519-verified MEE
 * growth Durable Object added this round. MEEGrowthSessionDO (the existing,
 * simpler DO) is untouched — this is a genuinely separate, new class.
 *
 * These tests call the REAL MEEGrowthGatedDO class's own fetch() handler
 * (via the same createFakeDurableObjectNamespace harness already used by
 * tests/session_scoping_do_isolation.test.mjs, tests/rctdb_log.test.mjs,
 * etc.) against real, isolated in-memory storage — no mocking of the class
 * under test itself, only the underlying Cloudflare storage layer.
 *
 * A HARD RULE followed throughout this file: a JS object literal must never
 * declare an optional field with an explicit `undefined` value (e.g.
 * `{ target_payload: undefined }`). `JSON.stringify` drops such keys
 * entirely on the real request body this DO receives over `fetch()`, so a
 * signature computed over an object that explicitly lists the key (even as
 * undefined) will NOT canonically match what the DO reconstructs after its
 * own `request.json()` parse. Every payload built below therefore simply
 * OMITS fields it doesn't need, exactly like a real caller would.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  MEEGrowthGatedDO,
  generateSigningKeypair,
  signPayload,
  confidenceToGrowthDelta,
  MEEGrowthTracker,
} from "../packages/shared/dist/index.js";
import fdiaWorker from "../packages/fdia/dist/worker.js";
import { createFakeDurableObjectNamespace } from "./helpers/fake-durable-object.mjs";

const NOOP_CTX = { waitUntil: () => {} };

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Signs `payloadCore` (a GatedTransitionPayload with NO jitnaSignature key
 *  yet) and returns the full payload with a real signature attached. */
async function buildSignedPayload(privateKey, payloadCore) {
  const signature = await signPayload(privateKey, payloadCore);
  return { ...payloadCore, jitnaSignature: signature };
}

async function mutateState(doStub, payload, trustedJitnaPublicKeyJwk) {
  const resp = await doStub.fetch("http://do/mutate_state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ payload, trustedJitnaPublicKeyJwk }),
  });
  return { status: resp.status, body: await resp.json() };
}

async function getState(doStub) {
  const resp = await doStub.fetch("http://do/get_state");
  return resp.json();
}

function freshDoStub() {
  const ns = createFakeDurableObjectNamespace(MEEGrowthGatedDO);
  return ns.get(ns.idFromName("test-agent"));
}

// ===========================================================================
// Growth math fidelity — confirms real MEEGrowthTracker/confidenceToGrowthDelta
// reuse, not a toy/ad-hoc formula.
// ===========================================================================

test("confidenceToGrowthDelta: the exact confidence tiers this DO documents map to the documented deltas", () => {
  assert.equal(confidenceToGrowthDelta(1.0), 1.0); // fresh, valid consensus
  assert.equal(confidenceToGrowthDelta(0.75), 0.5); // cache hit (weaker, reused evidence)
  assert.equal(confidenceToGrowthDelta(0.0), -1.0); // invalid/malicious consensus
});

test("MEEGrowthGatedDO: an accepted fresh-consensus transition's growthFactor matches a real, independently-computed MEEGrowthTracker.step() to the exact float value", async () => {
  const keypair = await generateSigningKeypair();
  const publicJwk = await crypto.subtle.exportKey("jwk", keypair.publicKey);
  const doStub = freshDoStub();

  const payloadCore = {
    data_quality: 0.9,
    intent_precision: 1.0,
    action_name: "read_report",
    consensusResult: { isConsensusValid: true },
    intentId: "intent-growth-fidelity",
  };
  const payload = await buildSignedPayload(keypair.privateKey, payloadCore);

  const { body } = await mutateState(doStub, payload, publicJwk);
  assert.equal(body.accepted, true, JSON.stringify(body));

  // Independently reproduce the exact real growth math this call should
  // have performed: a fresh MEEGrowthTracker stepped once with
  // confidenceToGrowthDelta(1.0) and no governance violation.
  const referenceTracker = new MEEGrowthTracker();
  const referenceStep = referenceTracker.step(confidenceToGrowthDelta(1.0), false);

  assert.equal(body.state.growthFactor, referenceStep.g_after);
  assert.equal(body.growth_delta_applied, 1.0);
  assert.equal(body.governance_violation, false);
});

test("MEEGrowthGatedDO: a cache-hit consensus produces a genuinely SMALLER growth increase than a fresh consensus under identical conditions", async () => {
  const keypair = await generateSigningKeypair();
  const publicJwk = await crypto.subtle.exportKey("jwk", keypair.publicKey);

  const freshStub = freshDoStub();
  const cacheStub = createFakeDurableObjectNamespace(MEEGrowthGatedDO).get("cache-hit-agent");

  const basePayload = {
    data_quality: 0.9,
    intent_precision: 1.0,
    action_name: "read_report",
  };

  const freshPayload = await buildSignedPayload(keypair.privateKey, {
    ...basePayload,
    consensusResult: { isConsensusValid: true },
    intentId: "intent-fresh",
  });
  const cachePayload = await buildSignedPayload(keypair.privateKey, {
    ...basePayload,
    consensusResult: { isConsensusValid: true, isCacheHit: true },
    intentId: "intent-cache",
  });

  const freshResult = await mutateState(freshStub, freshPayload, publicJwk);
  const cacheResult = await mutateState(cacheStub, cachePayload, publicJwk);

  assert.equal(freshResult.body.accepted, true);
  assert.equal(cacheResult.body.accepted, true);
  assert.equal(freshResult.body.growth_delta_applied, 1.0);
  assert.equal(cacheResult.body.growth_delta_applied, 0.5);
  assert.ok(
    cacheResult.body.state.growthFactor < freshResult.body.state.growthFactor,
    "a cache-hit's growthFactor increase must be strictly smaller than a fresh consensus's, starting from the same G_initial"
  );
  assert.equal(cacheResult.body.state.cacheHitCount, 1);
  assert.equal(freshResult.body.state.cacheHitCount, 0);
});

test("MEEGrowthGatedDO: invalid/malicious consensus is accepted (FDIA + signature both passed) but is a real governance violation with negative growth", async () => {
  const keypair = await generateSigningKeypair();
  const publicJwk = await crypto.subtle.exportKey("jwk", keypair.publicKey);
  const doStub = freshDoStub();

  const payload = await buildSignedPayload(keypair.privateKey, {
    data_quality: 0.9,
    intent_precision: 1.0,
    action_name: "read_report",
    consensusResult: { isConsensusValid: false },
    intentId: "intent-invalid-consensus",
  });

  const { body } = await mutateState(doStub, payload, publicJwk);
  assert.equal(body.accepted, true, "FDIA authorized + signature valid => still an accepted transition");
  assert.equal(body.governance_violation, true);
  assert.equal(body.growth_delta_applied, -1.0);
  assert.ok(body.state.growthFactor < 1.0, "growthFactor must have genuinely decreased below the G_initial default");

  const doStub2 = createFakeDurableObjectNamespace(MEEGrowthGatedDO).get("malicious-agent");
  const maliciousPayload = await buildSignedPayload(keypair.privateKey, {
    data_quality: 0.9,
    intent_precision: 1.0,
    action_name: "read_report",
    consensusResult: { isConsensusValid: true, isMalicious: true },
    intentId: "intent-malicious",
  });
  const maliciousResult = await mutateState(doStub2, maliciousPayload, publicJwk);
  assert.equal(maliciousResult.body.accepted, true);
  assert.equal(maliciousResult.body.governance_violation, true);
  assert.equal(maliciousResult.body.growth_delta_applied, -1.0);
});

// ===========================================================================
// Hash chain — genuine sequential chaining, and rejection never advances it.
// ===========================================================================

test("MEEGrowthGatedDO: sequential accepted transitions genuinely chain — sequenceNumber increments and each stateHash incorporates the PRIOR stateHash", async () => {
  const keypair = await generateSigningKeypair();
  const publicJwk = await crypto.subtle.exportKey("jwk", keypair.publicKey);
  const doStub = freshDoStub();

  const initial = await getState(doStub);
  assert.equal(initial.sequenceNumber, 0);
  const genesisHash = initial.stateHash;
  assert.match(genesisHash, /^0{64}$/);

  const payload1 = await buildSignedPayload(keypair.privateKey, {
    data_quality: 0.9,
    intent_precision: 1.0,
    action_name: "read_report",
    consensusResult: { isConsensusValid: true },
    intentId: "intent-chain-1",
  });
  const step1 = await mutateState(doStub, payload1, publicJwk);
  assert.equal(step1.body.accepted, true);
  assert.equal(step1.body.state.sequenceNumber, 1);
  assert.match(step1.body.state.stateHash, /^[0-9a-f]{64}$/);
  assert.notEqual(step1.body.state.stateHash, genesisHash);

  const payload2 = await buildSignedPayload(keypair.privateKey, {
    data_quality: 0.9,
    intent_precision: 1.0,
    action_name: "read_report",
    consensusResult: { isConsensusValid: true },
    intentId: "intent-chain-2",
  });
  const step2 = await mutateState(doStub, payload2, publicJwk);
  assert.equal(step2.body.accepted, true);
  assert.equal(step2.body.state.sequenceNumber, 2);
  assert.notEqual(step2.body.state.stateHash, step1.body.state.stateHash);

  // Independently recompute what the 2nd hash SHOULD be from the 1st
  // hash, proving real chaining (not e.g. a hash of only the latest step).
  const crypto_ = globalThis.crypto;
  const expectedInput = `${step1.body.state.stateHash}:2:${step2.body.state.growthFactor}:intent-chain-2:${payload2.jitnaSignature}`;
  const digest = await crypto_.subtle.digest("SHA-256", new TextEncoder().encode(expectedInput));
  const expectedHash = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  assert.equal(step2.body.state.stateHash, expectedHash);

  const finalState = await getState(doStub);
  assert.equal(finalState.sequenceNumber, 2);
  assert.equal(finalState.stateHash, step2.body.state.stateHash);
  assert.equal(finalState.consensusCount, 2);
});

test("MEEGrowthGatedDO: a REJECTED transition (FDIA denies) leaves growthFactor/sequenceNumber/stateHash completely untouched — only rejectedCount moves", async () => {
  const keypair = await generateSigningKeypair();
  const publicJwk = await crypto.subtle.exportKey("jwk", keypair.publicKey);
  const doStub = freshDoStub();

  // Establish one real accepted transition first so there is real
  // non-genesis state to prove stays frozen across the rejection.
  const acceptedPayload = await buildSignedPayload(keypair.privateKey, {
    data_quality: 0.9,
    intent_precision: 1.0,
    action_name: "read_report",
    consensusResult: { isConsensusValid: true },
    intentId: "intent-pre-reject",
  });
  const accepted = await mutateState(doStub, acceptedPayload, publicJwk);
  assert.equal(accepted.body.accepted, true);
  const stateBeforeRejection = accepted.body.state;

  // "drop_production_table" matches the bundled default policy's
  // RULE-DATABASE-DESTRUCTIVE-BLOCK (REQUIRE_HUMAN_SIGNATURE) with no
  // architect_token supplied -> real evaluateFDIA() denies it.
  const rejectedPayload = await buildSignedPayload(keypair.privateKey, {
    data_quality: 0.99,
    intent_precision: 1.0,
    action_name: "drop_production_table",
    consensusResult: { isConsensusValid: true },
    intentId: "intent-should-be-rejected",
  });
  const rejected = await mutateState(doStub, rejectedPayload, publicJwk);

  assert.equal(rejected.body.accepted, false);
  assert.equal(rejected.body.rejection_reason, "fdia_not_authorized");
  assert.equal(rejected.body.fdia_result.authorized, false);
  assert.equal(rejected.body.growth_delta_applied, 0);

  assert.equal(rejected.body.state.growthFactor, stateBeforeRejection.growthFactor);
  assert.equal(rejected.body.state.sequenceNumber, stateBeforeRejection.sequenceNumber);
  assert.equal(rejected.body.state.stateHash, stateBeforeRejection.stateHash);
  assert.equal(rejected.body.state.consensusCount, stateBeforeRejection.consensusCount);
  assert.equal(rejected.body.state.rejectedCount, stateBeforeRejection.rejectedCount + 1);

  const finalState = await getState(doStub);
  assert.equal(finalState.sequenceNumber, 1, "the chain must not have silently advanced on a rejected transition");
  assert.equal(finalState.rejectedCount, 1);
});

// ===========================================================================
// Signature verification — missing / tampered / wrong-key must always be a
// hard rejection, never a rubber stamp.
// ===========================================================================

test("MEEGrowthGatedDO: a MISSING signature is a hard rejection, never treated as signed", async () => {
  const keypair = await generateSigningKeypair();
  const publicJwk = await crypto.subtle.exportKey("jwk", keypair.publicKey);
  const doStub = freshDoStub();

  const payload = {
    data_quality: 0.9,
    intent_precision: 1.0,
    action_name: "read_report",
    consensusResult: { isConsensusValid: true },
    intentId: "intent-no-sig",
    jitnaSignature: "",
  };
  const { body } = await mutateState(doStub, payload, publicJwk);
  assert.equal(body.accepted, false);
  assert.equal(body.signature_valid, false);
  assert.equal(body.rejection_reason, "signature_invalid");
  const state = await getState(doStub);
  assert.equal(state.sequenceNumber, 0, "chain must not advance on a missing signature");
});

test("MEEGrowthGatedDO: a NON-EMPTY but bogus/garbage string is NOT accepted as a valid signature (no 'any non-empty string passes' rubber stamp)", async () => {
  const keypair = await generateSigningKeypair();
  const publicJwk = await crypto.subtle.exportKey("jwk", keypair.publicKey);
  const doStub = freshDoStub();

  const payload = {
    data_quality: 0.9,
    intent_precision: 1.0,
    action_name: "read_report",
    consensusResult: { isConsensusValid: true },
    intentId: "intent-garbage-sig",
    jitnaSignature: "this-is-definitely-not-a-real-signature",
  };
  const { body } = await mutateState(doStub, payload, publicJwk);
  assert.equal(body.accepted, false);
  assert.equal(body.signature_valid, false);
});

test("MEEGrowthGatedDO: a TAMPERED payload (mutated after signing) fails verification and is rejected", async () => {
  const keypair = await generateSigningKeypair();
  const publicJwk = await crypto.subtle.exportKey("jwk", keypair.publicKey);
  const doStub = freshDoStub();

  const payload = await buildSignedPayload(keypair.privateKey, {
    data_quality: 0.9,
    intent_precision: 1.0,
    action_name: "read_report",
    consensusResult: { isConsensusValid: true },
    intentId: "intent-tamper",
  });

  // Attacker raises data_quality after the fact, keeping the OLD signature.
  const tampered = { ...payload, data_quality: 0.99 };
  const { body } = await mutateState(doStub, tampered, publicJwk);
  assert.equal(body.accepted, false);
  assert.equal(body.signature_valid, false);
  assert.equal(body.rejection_reason, "signature_invalid");
});

test("MEEGrowthGatedDO: a signature verified against the WRONG trusted public key is rejected", async () => {
  const signerKeypair = await generateSigningKeypair();
  const wrongKeypair = await generateSigningKeypair();
  const wrongPublicJwk = await crypto.subtle.exportKey("jwk", wrongKeypair.publicKey);
  const doStub = freshDoStub();

  const payload = await buildSignedPayload(signerKeypair.privateKey, {
    data_quality: 0.9,
    intent_precision: 1.0,
    action_name: "read_report",
    consensusResult: { isConsensusValid: true },
    intentId: "intent-wrong-key",
  });

  const { body } = await mutateState(doStub, payload, wrongPublicJwk);
  assert.equal(body.accepted, false);
  assert.equal(body.signature_valid, false);
});

test("MEEGrowthGatedDO: a MALFORMED trustedJitnaPublicKeyJwk (missing entirely) never crashes and never verifies", async () => {
  const keypair = await generateSigningKeypair();
  const doStub = freshDoStub();
  const payload = await buildSignedPayload(keypair.privateKey, {
    data_quality: 0.9,
    intent_precision: 1.0,
    action_name: "read_report",
    consensusResult: { isConsensusValid: true },
    intentId: "intent-no-trusted-key",
  });

  const resp = await doStub.fetch("http://do/mutate_state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ payload }), // trustedJitnaPublicKeyJwk omitted entirely
  });
  const body = await resp.json();
  assert.equal(body.accepted, false);
  assert.equal(body.signature_valid, false);
});

// ===========================================================================
// Malformed request handling
// ===========================================================================

test("MEEGrowthGatedDO: a malformed payload (missing required fields) is rejected with 400, not a crash", async () => {
  const doStub = freshDoStub();
  const resp = await doStub.fetch("http://do/mutate_state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ payload: { action_name: "read_report" } }), // no data_quality, no intentId, no consensusResult
  });
  assert.equal(resp.status, 400);
  const body = await resp.json();
  assert.ok(body.error);
});

// ===========================================================================
// Isolation between agents/sessions
// ===========================================================================

test("MEEGrowthGatedDO: two different agent/session DO instances are genuinely isolated (separate chains, separate counts)", async () => {
  const keypair = await generateSigningKeypair();
  const publicJwk = await crypto.subtle.exportKey("jwk", keypair.publicKey);
  const ns = createFakeDurableObjectNamespace(MEEGrowthGatedDO);

  const stubA = ns.get(ns.idFromName("agent-alpha"));
  const stubB = ns.get(ns.idFromName("agent-beta"));

  const payloadA = await buildSignedPayload(keypair.privateKey, {
    data_quality: 0.9,
    intent_precision: 1.0,
    action_name: "read_report",
    consensusResult: { isConsensusValid: true },
    intentId: "intent-alpha-1",
  });
  await mutateState(stubA, payloadA, publicJwk);

  const stateA = await getState(stubA);
  const stateB = await getState(stubB);

  assert.equal(stateA.sequenceNumber, 1, "agent-alpha's own DO instance must have advanced");
  assert.equal(stateB.sequenceNumber, 0, "agent-beta's DO instance must be completely untouched by agent-alpha's transition");
  assert.notEqual(stateA.stateHash, stateB.stateHash);

  // Same idFromName resolves to the SAME instance (real DO semantics) —
  // proves this isn't accidental isolation from creating two namespaces.
  const stubAAgain = ns.get(ns.idFromName("agent-alpha"));
  const stateAAgain = await getState(stubAAgain);
  assert.equal(stateAAgain.sequenceNumber, 1);
  assert.equal(stateAAgain.stateHash, stateA.stateHash);
});

// ===========================================================================
// Worker-level wiring — the real `mee_gated_transition` tool end to end,
// through packages/fdia/src/worker.ts, using a CONFIGURED secret keypair
// (the realistic production setup for cross-worker signature verification).
// ===========================================================================

import { MEEGrowthGatedDO as WorkerExportedGatedDO } from "../packages/fdia/dist/worker.js";

test("fdia worker: mee_gated_transition is wired to the real DO end-to-end and accepts a genuinely valid, correctly-signed transition", async () => {
  const { FDIASessionDO } = await import("../packages/fdia/dist/session-do.js");
  const keypair = await generateSigningKeypair();
  const publicJwk = await crypto.subtle.exportKey("jwk", keypair.publicKey);
  const privateJwk = await crypto.subtle.exportKey("jwk", keypair.privateKey);

  const env = {
    ENVIRONMENT: "test",
    FDIA_SESSION_DO: createFakeDurableObjectNamespace(FDIASessionDO),
    MEE_GATED_DO: createFakeDurableObjectNamespace(WorkerExportedGatedDO),
    // Configured secret: the SAME public key the worker will use to verify
    // is the one whose matching private key this test signs with below —
    // exactly the realistic production configuration for a real external
    // trusted signer.
    JITNA_SIGNING_PUBLIC_KEY_JWK: JSON.stringify(publicJwk),
  };

  const sessionId = "worker-e2e-session";

  // Must mirror worker.ts's own GatedTransitionPayload construction
  // EXACTLY (field renames: consensus_result -> consensusResult, intent_id
  // -> intentId; agentId is auto-injected as the resolved session id) so
  // the signature verifies against what the DO actually reconstructs.
  const payloadCore = {
    data_quality: 0.9,
    intent_precision: 1.0,
    action_name: "read_report",
    consensusResult: { isConsensusValid: true },
    intentId: "intent-worker-e2e",
    agentId: sessionId,
  };
  const signature = await signPayload(keypair.privateKey, payloadCore);

  const request = new Request("http://worker.test/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "mee_gated_transition",
        arguments: {
          data_quality: 0.9,
          intent_precision: 1.0,
          action_name: "read_report",
          consensus_result: { isConsensusValid: true },
          intent_id: "intent-worker-e2e",
          jitna_signature: signature,
          session_id: sessionId,
        },
      },
    }),
  });

  const response = await fdiaWorker.fetch(request, env, NOOP_CTX);
  const rpcBody = await response.json();
  const result = JSON.parse(rpcBody.result.content[0].text);

  assert.equal(result.accepted, true, JSON.stringify(result));
  assert.equal(result.signature_valid, true);
  assert.equal(result.state.sequenceNumber, 1);
  assert.equal(rpcBody.result.isError, false);
  assert.notEqual(privateJwk, undefined); // sanity: the private key really was generated/used above
});

test("fdia worker: mee_gated_transition with a TAMPERED argument (after computing the real signature) is rejected end-to-end, not rubber-stamped", async () => {
  const { FDIASessionDO } = await import("../packages/fdia/dist/session-do.js");
  const keypair = await generateSigningKeypair();
  const publicJwk = await crypto.subtle.exportKey("jwk", keypair.publicKey);

  const env = {
    ENVIRONMENT: "test",
    FDIA_SESSION_DO: createFakeDurableObjectNamespace(FDIASessionDO),
    MEE_GATED_DO: createFakeDurableObjectNamespace(WorkerExportedGatedDO),
    JITNA_SIGNING_PUBLIC_KEY_JWK: JSON.stringify(publicJwk),
  };
  const sessionId = "worker-e2e-tamper-session";

  const signature = await signPayload(keypair.privateKey, {
    data_quality: 0.9,
    intent_precision: 1.0,
    action_name: "read_report",
    consensusResult: { isConsensusValid: true },
    intentId: "intent-worker-tamper",
    agentId: sessionId,
  });

  const request = new Request("http://worker.test/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "mee_gated_transition",
        arguments: {
          data_quality: 0.99, // tampered post-signing — attacker raising claimed data quality
          intent_precision: 1.0,
          action_name: "read_report",
          consensus_result: { isConsensusValid: true },
          intent_id: "intent-worker-tamper",
          jitna_signature: signature,
          session_id: sessionId,
        },
      },
    }),
  });

  const response = await fdiaWorker.fetch(request, env, NOOP_CTX);
  const rpcBody = await response.json();
  const result = JSON.parse(rpcBody.result.content[0].text);

  assert.equal(result.accepted, false);
  assert.equal(result.signature_valid, false);
  assert.equal(rpcBody.result.isError, true);
});

test("fdia worker: mee_gated_transition without the MEE_GATED_DO binding returns a clear configuration error, not a crash, and does not affect other tools", async () => {
  const { FDIASessionDO } = await import("../packages/fdia/dist/session-do.js");
  const env = {
    ENVIRONMENT: "test",
    FDIA_SESSION_DO: createFakeDurableObjectNamespace(FDIASessionDO),
    // MEE_GATED_DO deliberately omitted.
  };

  const request = new Request("http://worker.test/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "mee_gated_transition", arguments: { data_quality: 0.9, action_name: "read_report" } },
    }),
  });
  const response = await fdiaWorker.fetch(request, env, NOOP_CTX);
  const rpcBody = await response.json();
  assert.equal(rpcBody.result.isError, true);
  const parsed = JSON.parse(rpcBody.result.content[0].text);
  assert.match(parsed.message, /MEE_GATED_DO binding not configured/);

  // evaluate_fdia (an existing, unrelated tool) must still work completely
  // normally on this exact same env/worker instance.
  const evalRequest = new Request("http://worker.test/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "evaluate_fdia", arguments: { data_quality: 0.9, action_name: "read_report" } },
    }),
  });
  const evalResponse = await fdiaWorker.fetch(evalRequest, env, NOOP_CTX);
  const evalBody = await evalResponse.json();
  const evalResult = JSON.parse(evalBody.result.content[0].text);
  assert.equal(evalResult.authorized, true);
});

console.log("MEEGrowthGatedDO tests completed.");
