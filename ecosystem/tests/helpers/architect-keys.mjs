/**
 * Round 48 test helper: real Ed25519 Architect keys for tests.
 *
 * Architect tokens are now real signatures verified against deployment-trusted
 * keys (packages/shared/src/architect-token.ts). Importing this module creates
 * one key per approver role used by the tests, registers their public keys as
 * the isolate-wide trusted set, and exposes sign(role, action, payload).
 */
import { generateKeyPairSync } from "node:crypto";
import { configureTrustedArchitectKeys, signArchitectToken } from "../../packages/shared/dist/index.js";

const ROLES = ["Chief_Architect", "Security_Admin", "DevOps_Lead", "Chief_Financial_Architect", "Treasury_Lead"];

const keys = new Map();
for (const [i, role] of ROLES.entries()) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  keys.set(role, {
    key_id: `test-${i}-${role.toLowerCase()}`,
    role,
    public_key_hex: Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("hex"),
    pem: privateKey.export({ format: "pem", type: "pkcs8" }),
  });
}

export const trustedKeys = [...keys.values()].map(({ key_id, role, public_key_hex }) => ({ key_id, role, public_key_hex }));
configureTrustedArchitectKeys(trustedKeys);

/** A real Architect token from the test key holding `role`, for exactly this action and payload. */
export function sign(role, actionName, targetPayload = "", ttlSeconds = 900) {
  const k = keys.get(role);
  if (!k) throw new Error(`no test key for role ${role}`);
  return signArchitectToken(k.pem, k.key_id, actionName, targetPayload, ttlSeconds);
}

/** An Ed25519 token signed by a key nobody trusts. */
export function signUntrusted(actionName, targetPayload = "") {
  const { privateKey } = generateKeyPairSync("ed25519");
  return signArchitectToken(privateKey.export({ format: "pem", type: "pkcs8" }), "intruder", actionName, targetPayload);
}
