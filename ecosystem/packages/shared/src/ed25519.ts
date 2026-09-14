/**
 * Real Ed25519 signing primitives for JITNA packets (Layer 1: OS
 * Primitives & Cryptographic Transport).
 *
 * Ported/added 2026-09-14 to close a gap found by architecture audit: the
 * deployed packages/jitna had zero cryptography (grep for Ed25519/
 * fingerprint returned nothing), and the Python side's own attempt
 * (<private>/microservices/jitna-gateway/main.py) is explicitly
 * commented "(mock)" — a SHA-256 string prefix, not asymmetric signing,
 * with unsigned packets only warned about, never rejected.
 *
 * Uses the Workers-native (and, as of Node 20+, Node-native) WebCrypto
 * `crypto.subtle` Ed25519 support — no new dependency.
 */

/** Deterministically stringify a JSON-like value with sorted object keys,
 *  so the same logical packet always produces the same signable bytes
 *  regardless of property insertion order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => canonicalJson(v)).join(",") + "]";
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const entries = keys.map((k) => JSON.stringify(k) + ":" + canonicalJson((value as Record<string, unknown>)[k]));
  return "{" + entries.join(",") + "}";
}

export interface Ed25519KeypairJwk {
  privateKeyJwk: JsonWebKey;
  publicKeyJwk: JsonWebKey;
}

/** Generate a genuine Ed25519 keypair (crypto.subtle, RFC 8032). */
export async function generateSigningKeypair(): Promise<{
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  jwk: Ed25519KeypairJwk;
}> {
  const { privateKey, publicKey } = (await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  const privateKeyJwk = (await crypto.subtle.exportKey("jwk", privateKey)) as JsonWebKey;
  const publicKeyJwk = (await crypto.subtle.exportKey("jwk", publicKey)) as JsonWebKey;
  return { privateKey, publicKey, jwk: { privateKeyJwk, publicKeyJwk } };
}

export async function importSigningKeypairFromJwk(
  jwk: Ed25519KeypairJwk
): Promise<{ privateKey: CryptoKey; publicKey: CryptoKey }> {
  const [privateKey, publicKey] = await Promise.all([
    crypto.subtle.importKey("jwk", jwk.privateKeyJwk, { name: "Ed25519" }, true, ["sign"]),
    crypto.subtle.importKey("jwk", jwk.publicKeyJwk, { name: "Ed25519" }, true, ["verify"]),
  ]);
  return { privateKey, publicKey };
}

export async function importPublicKeyFromJwk(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, true, ["verify"]);
}

/** SHA-256 fingerprint (64 hex chars) of the raw 32-byte Ed25519 public
 *  key — matches the architecture doc's "64-character fingerprint" claim
 *  exactly (a SHA-256 digest is 32 bytes = 64 hex chars). */
export async function computeKeyFingerprint(publicKey: CryptoKey): Promise<string> {
  const raw = (await crypto.subtle.exportKey("raw", publicKey)) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", raw);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Sign an arbitrary JSON-serializable payload with a real Ed25519
 *  signature over its canonical form. Returns base64. */
export async function signPayload(privateKey: CryptoKey, payload: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(payload));
  const signature = await crypto.subtle.sign({ name: "Ed25519" }, privateKey, bytes);
  return bytesToBase64(new Uint8Array(signature));
}

/** Verify a base64 Ed25519 signature against a payload's canonical form.
 *  Never throws — a malformed signature/key verifies as false. */
export async function verifyPayloadSignature(
  publicKey: CryptoKey,
  payload: unknown,
  signatureBase64: string
): Promise<boolean> {
  try {
    const bytes = new TextEncoder().encode(canonicalJson(payload));
    const signature = base64ToBytes(signatureBase64);
    return await crypto.subtle.verify({ name: "Ed25519" }, publicKey, signature, bytes);
  } catch {
    return false;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
