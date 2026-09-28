#!/usr/bin/env node
/**
 * Sign an Architect token (the A in FDIA) for one action (Round 48).
 *
 *   node scripts/sign-architect-token.mjs --key ~/.delentia/keys/architect.pem --key-id chief-1 \
 *        --action delete_database [--payload '<exact target_payload>'] [--ttl 900]
 *
 *   node scripts/sign-architect-token.mjs --public-key ~/.delentia/keys/architect.pem --key-id chief-1 --role Chief_Architect
 *     -> prints the JSON entry to put in the Worker's FDIA_ARCHITECT_KEYS_JSON
 *
 * Run it where the private key lives (ideally not on the agent's machine).
 * The key is the same Ed25519 PEM `delentia approvals keygen` creates, so one
 * approver key can sign both Delentia-OS approvals and these tokens.
 * `--payload` must be the exact target_payload string the caller will send
 * (or caller_context when there is no target_payload); the token is bound to
 * its SHA-256.
 */
import { readFileSync } from "node:fs";
import { createPrivateKey, createPublicKey } from "node:crypto";
import os from "node:os";
import { signArchitectToken, MAX_TOKEN_TTL_SECONDS } from "../packages/shared/dist/index.js";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const expand = (p) => (p && p.startsWith("~") ? p.replace(/^~/, os.homedir()) : p);

const pubPath = expand(arg("public-key"));
if (pubPath) {
  const jwk = createPublicKey(createPrivateKey(readFileSync(pubPath, "utf8"))).export({ format: "jwk" });
  const entry = { key_id: arg("key-id", "architect-1"), role: arg("role", "Chief_Architect"),
                  public_key_hex: Buffer.from(jwk.x, "base64url").toString("hex") };
  console.log(JSON.stringify(entry));
  process.exit(0);
}

const keyPath = expand(arg("key"));
const keyId = arg("key-id");
const action = arg("action");
if (!keyPath || !keyId || !action) {
  console.error("usage: --key <pem> --key-id <id> --action <action_name> [--payload <string>] [--ttl <seconds>]");
  process.exit(2);
}
const ttl = Number(arg("ttl", "900"));
if (!Number.isFinite(ttl) || ttl <= 0 || ttl > MAX_TOKEN_TTL_SECONDS) {
  console.error(`--ttl must be between 1 and ${MAX_TOKEN_TTL_SECONDS} seconds`);
  process.exit(2);
}
console.log(signArchitectToken(readFileSync(keyPath, "utf8"), keyId, action, arg("payload", ""), ttl));
