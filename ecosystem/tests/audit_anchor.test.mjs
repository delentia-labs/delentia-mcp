/**
 * Round 50: audit tier A3 - an outside witness for audit-log chain heads.
 *
 * The real fdia Worker handler and the real AuditAnchorDO run here; only the
 * Durable Object storage is an in-memory map (helpers/fake-durable-object.mjs).
 * Anchors are signed with real Ed25519 keys by the real Guard code, and the
 * Guard CLI is exercised end to end against a local HTTP server that forwards
 * to the Worker.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import fdiaWorker from "../packages/fdia/dist/worker.js";
import { AuditAnchorDO, anchorMessage } from "../packages/shared/dist/index.js";
import { Guard, auditPublicKeyHex, checkAuditAnchors, sha256, signAnchor } from "../packages/guard/dist/guard.js";
import { createFakeDurableObjectNamespace } from "./helpers/fake-durable-object.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, "..", "packages", "guard", "dist", "cli.js");
const run = promisify(execFile);
const CTX = { waitUntil: () => {} };

function keypair() {
  const pem = generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  return { pem, hex: auditPublicKeyHex(pem) };
}

function env(keys) {
  return {
    AUDIT_ANCHOR_DO: createFakeDurableObjectNamespace(AuditAnchorDO),
    AUDIT_ANCHOR_KEYS_JSON: keys ? JSON.stringify(keys) : undefined,
  };
}

/** A real signed Guard audit log with n entries. */
function guardLog(pem, keyId, n) {
  const lines = [];
  const g = new Guard({ audit: (l) => lines.push(l), auditSigningKey: { keyId, privateKeyPem: pem } });
  for (let i = 0; i < n; i++) {
    g.inspect({ jsonrpc: "2.0", id: i, method: "tools/call", params: { name: "read_file", arguments: { path: `f${i}` } } });
  }
  return lines.join("\n") + "\n";
}

async function post(e, body) {
  const res = await fdiaWorker.fetch(new Request("https://w/v1/audit/anchor", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), e, CTX);
  return { status: res.status, body: await res.json() };
}

async function list(e, keyId) {
  const res = await fdiaWorker.fetch(new Request(`https://w/v1/audit/anchor/${keyId}`), e, CTX);
  return { status: res.status, body: await res.json() };
}

test("without configured keys the witness is off (501) and stores nothing", async () => {
  const { pem } = keypair();
  const r = await post(env(undefined), signAnchor(pem, "g1", guardLog(pem, "g1", 2)));
  assert.equal(r.status, 501);
});

test("a correctly signed head is stored and can be read back", async () => {
  const { pem, hex } = keypair();
  const e = env([{ key_id: "g1", public_key_hex: hex }]);
  const log = guardLog(pem, "g1", 3);
  const sub = signAnchor(pem, "g1", log);
  const r = await post(e, sub);
  assert.equal(r.status, 201);
  assert.equal(r.body.anchor.entries, 3);
  const l = await list(e, "g1");
  assert.equal(l.body.count, 1);
  assert.equal(l.body.anchors[0].head, sub.head);
  assert.ok(l.body.anchors[0].received_at);
  assert.equal(checkAuditAnchors(log, l.body).ok, true);
});

test("unknown keys, wrong keys and edited fields are refused (403)", async () => {
  const good = keypair();
  const intruder = keypair();
  const e = env([{ key_id: "g1", public_key_hex: good.hex }]);
  const log = guardLog(good.pem, "g1", 2);
  assert.equal((await post(e, signAnchor(intruder.pem, "g1", log))).status, 403);      // wrong key for g1
  assert.equal((await post(e, signAnchor(good.pem, "nobody", log))).status, 403);      // key id not configured
  const edited = { ...signAnchor(good.pem, "g1", log), entries: 99 };                    // signature no longer matches
  assert.equal((await post(e, edited)).status, 403);
  assert.equal((await list(e, "g1")).body.count, 0);
});

test("malformed or stale submissions are rejected before any signature check (400)", async () => {
  const { pem, hex } = keypair();
  const e = env([{ key_id: "g1", public_key_hex: hex }]);
  const log = guardLog(pem, "g1", 1);
  const stale = signAnchor(pem, "g1", log, new Date(Date.now() - 25 * 3600 * 1000).toISOString());
  assert.equal((await post(e, stale)).status, 400);
  const future = signAnchor(pem, "g1", log, new Date(Date.now() + 3600 * 1000).toISOString());
  assert.equal((await post(e, future)).status, 400);
  assert.equal((await post(e, { ...signAnchor(pem, "g1", log), head: "XYZ" })).status, 400);
  assert.equal((await post(e, { ...signAnchor(pem, "g1", log), key_id: "../x" })).status, 400);
});

test("rollback and fork are refused (409) and kept as evidence; a repeat is idempotent", async () => {
  const { pem, hex } = keypair();
  const e = env([{ key_id: "g1", public_key_hex: hex }]);
  const log5 = guardLog(pem, "g1", 5);
  assert.equal((await post(e, signAnchor(pem, "g1", log5))).status, 201);
  const again = await post(e, signAnchor(pem, "g1", log5));
  assert.equal(again.status, 200);
  assert.equal(again.body.duplicate, true);

  const rollback = await post(e, signAnchor(pem, "g1", guardLog(pem, "g1", 3)));
  assert.equal(rollback.status, 409);
  assert.equal(rollback.body.conflict.kind, "rollback");

  const forkLog = guardLog(pem, "g1", 5).replace(/"f4"/, '"other"');  // different content, same length
  const fork = await post(e, signAnchor(pem, "g1", guardLog(pem, "g1", 4) + forkLog.split("\n")[4] + "\n"));
  assert.equal(fork.status, 409);
  assert.equal(fork.body.conflict.kind, "fork");

  const l = await list(e, "g1");
  assert.equal(l.body.count, 1);
  assert.equal(l.body.conflicts.length, 2);
  assert.equal(checkAuditAnchors(log5, l.body).ok, false, "recorded conflicts make the check fail");
});

test("a log rewritten after anchoring no longer matches the witness", async () => {
  const { pem, hex } = keypair();
  const e = env([{ key_id: "g1", public_key_hex: hex }]);
  const log = guardLog(pem, "g1", 4);
  await post(e, signAnchor(pem, "g1", log));
  const witness = (await list(e, "g1")).body;

  // Rewrite entry 2 and rebuild the whole chain, as someone with the key could.
  const entries = log.trim().split("\n").map((l) => JSON.parse(l));
  entries[1].decision = "blocked";
  let prev = entries[0].hash;
  for (let i = 1; i < entries.length; i++) {
    const { hash, sig, key_id, ...rest } = entries[i];
    rest.prev_hash = prev;
    entries[i] = { ...rest, hash: sha256(JSON.stringify(rest)), sig, key_id };
    prev = entries[i].hash;
  }
  const rewritten = entries.map((x) => JSON.stringify(x)).join("\n") + "\n";
  const report = checkAuditAnchors(rewritten, witness);
  assert.equal(report.ok, false);
  assert.match(report.problems[0], /rewritten/);

  const truncated = log.trim().split("\n").slice(0, 2).join("\n") + "\n";
  assert.match(checkAuditAnchors(truncated, witness).problems[0], /truncated/);
});

test("the message format is the documented one", () => {
  assert.equal(anchorMessage("g1", 7, "ab".repeat(32), "2026-09-29T00:00:00.000Z"),
    `delentia-audit-anchor:v1|g1|7|${"ab".repeat(32)}|2026-09-29T00:00:00.000Z`);
});

test("CLI: anchor, then check-anchors, against a live local witness", async () => {
  const { pem, hex } = keypair();
  const e = env([{ key_id: "g1", public_key_hex: hex }]);
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const r = await fdiaWorker.fetch(new Request(`http://local${req.url}`, {
      method: req.method, headers: { "Content-Type": "application/json" }, body,
    }), e, CTX);
    res.writeHead(r.status, { "Content-Type": "application/json" });
    res.end(await r.text());
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const dir = mkdtempSync(path.join(tmpdir(), "anchor-"));
    const keyFile = path.join(dir, "k.pem");
    const logFile = path.join(dir, "audit.jsonl");
    writeFileSync(keyFile, pem);
    writeFileSync(logFile, guardLog(pem, "g1", 3));

    const a = JSON.parse((await run(process.execPath, [CLI, "anchor", logFile, "--url", url, "--audit-key", keyFile, "--audit-key-id", "g1"])).stdout);
    assert.equal(a.status, 201);
    const c = JSON.parse((await run(process.execPath, [CLI, "check-anchors", logFile, "--url", url, "--audit-key-id", "g1"])).stdout);
    assert.deepEqual([c.ok, c.checked], [true, 1]);

    writeFileSync(logFile, guardLog(pem, "g1", 3));  // a different log (new timestamps, new hashes)
    await assert.rejects(run(process.execPath, [CLI, "check-anchors", logFile, "--url", url, "--audit-key-id", "g1"]),
      (err) => JSON.parse(err.stdout).ok === false);
  } finally {
    server.close();
  }
});
