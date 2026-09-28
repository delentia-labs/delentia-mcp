/**
 * Architect tokens: the A in F = (D^I) x A, made verifiable (Round 48).
 *
 * FDIA's A is the human Architect's approval. Before this module,
 * FDIAEngine.verifyArchitectSignature accepted any caller-supplied string of
 * 32+ characters, or anything starting with "valid_architect_sig_", as a
 * "cryptographic" approval - so the agent being governed could approve its
 * own `delete_*` actions. Now an approval is an Ed25519 signature:
 *
 *   token   = "dat1.<key_id>.<expires_unix_seconds>.<signature_base64url>"
 *   message = "delentia-architect-token:v1|<key_id>|<action_name>|<sha256(target_payload)>|<expires>"
 *
 * - bound to one action and one payload (hash) - it cannot be reused for a
 *   different action or different arguments;
 * - short-lived: must not be expired and may not be valid for more than
 *   MAX_TOKEN_TTL_SECONDS ahead;
 * - verified ONLY against trusted keys configured by the deployment
 *   (Worker env FDIA_ARCHITECT_KEYS_JSON, or an engine created by trusted
 *   code). Keys are never read from a policy object, because callers can set
 *   per-session policies with configure_policy;
 * - no trusted keys configured = no token is ever valid (fail-closed).
 *
 * The same Ed25519 key format as Delentia-OS `delentia approvals keygen`
 * (raw 32-byte public key as hex), so one approver key can sign both.
 */
import { createHash, createPrivateKey, createPublicKey, sign as nodeSign, verify as nodeVerify } from "node:crypto";

export const ARCHITECT_TOKEN_VERSION = "dat1";
export const MAX_TOKEN_TTL_SECONDS = 24 * 60 * 60;

export interface TrustedArchitectKey {
  key_id: string;
  /** Approver role granted by this key, e.g. "Chief_Architect". */
  role: string;
  /** Raw 32-byte Ed25519 public key, hex. */
  public_key_hex: string;
}

export interface ArchitectTokenCheck {
  valid: boolean;
  keyId?: string;
  approverRole?: string;
  reason: string;
}

let isolateTrustedKeys: TrustedArchitectKey[] = [];

/** Deployment-wide trusted keys (call from a Worker's fetch with env-derived keys). */
export function configureTrustedArchitectKeys(keys: TrustedArchitectKey[]): void {
  isolateTrustedKeys = keys.slice();
}

export function getConfiguredTrustedArchitectKeys(): TrustedArchitectKey[] {
  return isolateTrustedKeys.slice();
}

/** Parses FDIA_ARCHITECT_KEYS_JSON. Malformed input yields no keys (fail-closed), never an exception. */
export function parseTrustedArchitectKeys(json: string | undefined | null): TrustedArchitectKey[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (k): k is TrustedArchitectKey =>
        k && typeof k.key_id === "string" && k.key_id.length > 0 && !k.key_id.includes(".") &&
        typeof k.role === "string" && typeof k.public_key_hex === "string" && /^[0-9a-fA-F]{64}$/.test(k.public_key_hex)
    );
  } catch {
    return [];
  }
}

export function payloadSha256(targetPayload: string | undefined | null): string {
  return createHash("sha256").update(targetPayload ?? "", "utf8").digest("hex");
}

export function architectTokenMessage(keyId: string, actionName: string, targetPayload: string, expires: number): string {
  return `delentia-architect-token:v1|${keyId}|${actionName}|${payloadSha256(targetPayload)}|${expires}`;
}

const b64url = (buf: Buffer) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

function publicKeyFromHex(hex: string) {
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: b64url(Buffer.from(hex, "hex")) }, format: "jwk" });
}

/** Signs an Architect token with a PEM (PKCS#8) Ed25519 private key. For tools and tests; never runs in a Worker. */
export function signArchitectToken(
  privateKeyPem: string,
  keyId: string,
  actionName: string,
  targetPayload: string,
  ttlSeconds = 15 * 60,
  nowSeconds = Math.floor(Date.now() / 1000)
): string {
  if (keyId.includes(".")) throw new Error("key_id must not contain '.'");
  const expires = nowSeconds + Math.min(Math.max(1, Math.floor(ttlSeconds)), MAX_TOKEN_TTL_SECONDS);
  const message = architectTokenMessage(keyId, actionName, targetPayload, expires);
  const signature = nodeSign(null, Buffer.from(message, "utf8"), createPrivateKey(privateKeyPem));
  return `${ARCHITECT_TOKEN_VERSION}.${keyId}.${expires}.${b64url(signature)}`;
}

/** Splits a field that may carry several tokens (dual sign-off), separated by whitespace or commas. */
export function splitArchitectTokens(field: string | undefined | null): string[] {
  return (field ?? "").split(/[\s,]+/).filter((t) => t.length > 0);
}

export function verifyArchitectToken(
  token: string,
  ctx: {
    actionName: string;
    targetPayload: string;
    allowedRoles?: string[];
    trustedKeys: TrustedArchitectKey[];
    nowSeconds?: number;
  }
): ArchitectTokenCheck {
  const now = ctx.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (ctx.trustedKeys.length === 0) {
    return { valid: false, reason: "no trusted Architect keys are configured for this deployment (fail-closed)" };
  }
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== ARCHITECT_TOKEN_VERSION) {
    return { valid: false, reason: `not a ${ARCHITECT_TOKEN_VERSION} Architect token` };
  }
  const [, keyId, expRaw, sigRaw] = parts;
  const expires = Number(expRaw);
  if (!Number.isInteger(expires)) return { valid: false, reason: "malformed expiry" };
  if (expires <= now) return { valid: false, reason: "Architect token has expired" };
  if (expires > now + MAX_TOKEN_TTL_SECONDS) return { valid: false, reason: "Architect token lifetime exceeds the 24 h maximum" };
  const key = ctx.trustedKeys.find((k) => k.key_id === keyId);
  if (!key) return { valid: false, reason: `key "${keyId}" is not a trusted Architect key` };
  if (ctx.allowedRoles && ctx.allowedRoles.length > 0 && !ctx.allowedRoles.includes(key.role)) {
    return { valid: false, reason: `key "${keyId}" has role "${key.role}", not one of ${ctx.allowedRoles.join(", ")}` };
  }
  let ok = false;
  try {
    const message = architectTokenMessage(keyId, ctx.actionName, ctx.targetPayload, expires);
    ok = nodeVerify(null, Buffer.from(message, "utf8"), publicKeyFromHex(key.public_key_hex), fromB64url(sigRaw));
  } catch {
    ok = false;
  }
  if (!ok) return { valid: false, reason: "signature does not verify for this action and payload" };
  return { valid: true, keyId, approverRole: key.role, reason: `signed by ${key.role} (${keyId})` };
}

/** Distinct trusted signers among the tokens in `field` that verify for this action. */
export function verifiedArchitectSigners(
  field: string | undefined | null,
  ctx: { actionName: string; targetPayload: string; allowedRoles?: string[]; trustedKeys: TrustedArchitectKey[]; nowSeconds?: number }
): ArchitectTokenCheck[] {
  const seen = new Set<string>();
  const out: ArchitectTokenCheck[] = [];
  for (const token of splitArchitectTokens(field)) {
    const check = verifyArchitectToken(token, ctx);
    if (check.valid && check.keyId && !seen.has(check.keyId)) {
      seen.add(check.keyId);
      out.push(check);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Async verification for Cloudflare Workers (Round 48).
//
// workerd does not support Ed25519 through node:crypto verify(), which the
// synchronous path above uses (it works in Node: Guard, the stdio server,
// tests). WebCrypto does support it, but is async while FDIAEngine.evaluate()
// is sync. So a Worker verifies up front and passes the result to evaluate()
// as a separate argument - never inside the request object, so it can never
// come from a tool call's JSON arguments. The engine only uses it when the
// token, action and payload match exactly what it is evaluating.
// ---------------------------------------------------------------------------

export interface PreverifiedArchitect {
  token: string;
  actionName: string;
  targetPayload: string;
  /** Distinct trusted signers whose tokens verified (all roles; role rules are applied later). */
  signers: ArchitectTokenCheck[];
}

async function verifyEd25519WebCrypto(publicKeyHex: string, message: string, signature: Uint8Array): Promise<boolean> {
  const subtle = typeof crypto !== "undefined" ? crypto.subtle : undefined;
  if (!subtle) return false;
  try {
    const key = await subtle.importKey("raw", Buffer.from(publicKeyHex, "hex"), { name: "Ed25519" }, false, ["verify"]);
    return await subtle.verify({ name: "Ed25519" }, key, signature, new TextEncoder().encode(message));
  } catch {
    return false;
  }
}

export async function preverifyArchitectTokens(
  field: string | undefined | null,
  ctx: { actionName: string; targetPayload: string; trustedKeys: TrustedArchitectKey[]; nowSeconds?: number }
): Promise<PreverifiedArchitect> {
  const now = ctx.nowSeconds ?? Math.floor(Date.now() / 1000);
  const seen = new Set<string>();
  const signers: ArchitectTokenCheck[] = [];
  for (const token of splitArchitectTokens(field)) {
    const parts = token.split(".");
    if (parts.length !== 4 || parts[0] !== ARCHITECT_TOKEN_VERSION) continue;
    const [, keyId, expRaw, sigRaw] = parts;
    const expires = Number(expRaw);
    if (!Number.isInteger(expires) || expires <= now || expires > now + MAX_TOKEN_TTL_SECONDS) continue;
    const key = ctx.trustedKeys.find((k) => k.key_id === keyId);
    if (!key || seen.has(keyId)) continue;
    const message = architectTokenMessage(keyId, ctx.actionName, ctx.targetPayload, expires);
    if (await verifyEd25519WebCrypto(key.public_key_hex, message, fromB64url(sigRaw))) {
      seen.add(keyId);
      signers.push({ valid: true, keyId, approverRole: key.role, reason: `signed by ${key.role} (${keyId})` });
    }
  }
  return { token: field ?? "", actionName: ctx.actionName, targetPayload: ctx.targetPayload, signers };
}
