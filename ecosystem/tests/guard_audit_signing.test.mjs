/**
 * Round 48: signed Guard audit (tier A2 for the MCP path) and chain-head export (A3 prep).
 *
 * The guard runs in its own process, separate from the agent, and signs each audit entry's hash
 * with Ed25519. Calls naming the key or the audit log are refused, so the agent cannot read the
 * key or rewrite the log through the proxied server. verifyAuditLog checks signatures against
 * published public keys; a chain rebuilt without the key fails.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Guard, auditHead, auditPublicKeyHex, verifyAuditLog, sha256 } from "../packages/guard/dist/guard.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, "..", "packages", "guard", "dist", "cli.js");
const call = (id, name, args = {}) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

function pem() {
  return generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString();
}

function signedGuard(extra = {}) {
  const key = pem();
  const lines = [];
  const g = new Guard({
    audit: (l) => lines.push(l),
    auditSigningKey: { keyId: "guard-1", privateKeyPem: key, protectedPaths: ["C:\\keys\\guard.pem", "/home/me/.delentia/guard-audit.jsonl"] },
    ...extra,
  });
  return { g, lines, pub: auditPublicKeyHex(key) };
}

test("every entry is signed and verifies against the published public key", () => {
  const { g, lines, pub } = signedGuard();
  g.inspect(call(1, "read_file", { path: "src/a.ts" }));
  g.inspect(call(2, "delete_file", { path: "README.md" }));
  const log = lines.join("\n");
  const r = verifyAuditLog(log, { publicKeys: { "guard-1": pub }, requireSigned: true });
  assert.equal(r.ok, true);
  assert.equal(r.signed, 2);
  assert.equal(r.head, JSON.parse(lines[1]).hash);
});

test("a chain rebuilt without the key passes the hash check but fails the signature check", () => {
  const { g, lines, pub } = signedGuard();
  g.inspect(call(1, "delete_file", { path: "README.md" }));
  const entry = JSON.parse(lines[0]);
  // Forge: flip the decision, recompute the hash (anyone can), keep the old signature.
  const { hash, sig, key_id, ...rest } = entry;
  rest.decision = "allowed";
  const forged = { ...rest, hash: sha256(JSON.stringify(rest)), sig, key_id };
  const text = JSON.stringify(forged);
  assert.equal(verifyAuditLog(text).ok, true, "hash-only verification cannot see a full rewrite");
  const r = verifyAuditLog(text, { publicKeys: { "guard-1": pub } });
  assert.equal(r.ok, false);
  assert.match(r.problem, /signature does not verify/);
});

test("unknown key ids, stripped signatures and unsigned logs are caught", () => {
  const { g, lines, pub } = signedGuard();
  g.inspect(call(1, "read_file", { path: "a" }));
  assert.match(verifyAuditLog(lines.join("\n"), { publicKeys: { other: pub } }).problem, /unknown key/);

  const stripped = JSON.parse(lines[0]);
  delete stripped.sig;
  delete stripped.key_id;
  assert.match(verifyAuditLog(JSON.stringify(stripped), { publicKeys: { "guard-1": pub }, requireSigned: true }).problem, /not signed/);
});

test("calls naming the audit key or the audit log never reach the server, even in monitor mode", () => {
  const { g, lines } = signedGuard({ mode: "monitor" });
  for (const [i, args] of [
    [1, { path: "C:\\keys\\guard.pem" }],
    [2, { path: "c:/KEYS/guard.pem" }],
    [3, { command: "cat /home/me/.delentia/guard-audit.jsonl" }],
    [4, { path: "/home/me/.delentia/guard-audit.jsonl", content: "" }],
  ]) {
    const d = g.inspect(call(i, i === 4 ? "write_file" : "read_file", args));
    assert.equal(d.forward, false, JSON.stringify(args));
    assert.match(d.response.result.content[0].text, /audit key or audit log/);
  }
  assert.equal(g.inspect(call(9, "read_file", { path: "src/app.ts" })).forward, true);
  assert.equal(JSON.parse(lines[0]).rule, "GUARD_PROTECTED_PATH");
});

test("relative paths to the key or the log are refused too (the server resolves them itself)", () => {
  const { g } = signedGuard();
  for (const [i, args] of [
    [1, { path: "guard.pem" }],
    [2, { path: "../keys/GUARD.pem" }],
    [3, { command: "tail -n 5 .delentia/guard-audit.jsonl" }],
  ]) {
    assert.equal(g.inspect(call(i, "read_file", args)).forward, false, JSON.stringify(args));
  }
  assert.equal(g.inspect(call(9, "read_file", { path: "src/guard.ts" })).forward, true);
});

test("unsigned guards keep the previous format and still verify", () => {
  const lines = [];
  const g = new Guard({ audit: (l) => lines.push(l) });
  g.inspect(call(1, "read_file", { path: "a" }));
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.sig, undefined);
  assert.equal(verifyAuditLog(lines.join("\n")).ok, true);
});

test("CLI: keygen, --head and --verify --pubkey --require-signed", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "guard-sign-"));
  const keyFile = path.join(dir, "guard.pem");
  const out = JSON.parse(execFileSync(process.execPath, [CLI, "keygen", "--out", keyFile, "--key-id", "g1"], { encoding: "utf8" }));
  assert.equal(out.key_id, "g1");
  assert.equal(out.public_key_hex, auditPublicKeyHex(readFileSync(keyFile, "utf8")));
  assert.throws(() => execFileSync(process.execPath, [CLI, "keygen", "--out", keyFile], { stdio: "pipe" }), "never overwrite a key");

  const lines = [];
  const g = new Guard({ audit: (l) => lines.push(l), auditSigningKey: { keyId: "g1", privateKeyPem: readFileSync(keyFile, "utf8") } });
  g.inspect(call(1, "read_file", { path: "a" }));
  g.inspect(call(2, "read_file", { path: "b" }));
  const logFile = path.join(dir, "audit.jsonl");
  writeFileSync(logFile, lines.join("\n") + "\n");

  const head = JSON.parse(execFileSync(process.execPath, [CLI, "--head", logFile], { encoding: "utf8" }));
  assert.deepEqual(head, auditHead(readFileSync(logFile, "utf8")));
  assert.equal(head.entries, 2);

  const ok = JSON.parse(execFileSync(process.execPath, [CLI, "--verify", logFile, "--pubkey", `g1=${out.public_key_hex}`, "--require-signed"], { encoding: "utf8" }));
  assert.equal(ok.ok, true);
  assert.equal(ok.signed, 2);
});
