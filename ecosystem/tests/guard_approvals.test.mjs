/**
 * Human approval for REQUIRE_HUMAN_SIGNATURE rules in Delentia Guard.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Guard } from "../packages/guard/dist/guard.js";
import { ApprovalStore, APPROVAL_TTL_MS } from "../packages/guard/dist/approvals.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const POLICY = path.join(here, "../packages/guard/policies/coding-agent.json");
const call = (id, name, args = {}) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
const tmp = () => mkdtempSync(path.join(tmpdir(), "guard-appr-"));

test("blocked human-signature call -> request id in the message -> approved -> the same call passes once", () => {
  const dir = tmp();
  const g = new Guard({ policy: POLICY, approvalsDir: dir });

  const first = g.inspect(call(1, "git_push", { remote: "origin", branch: "main" }));
  assert.equal(first.forward, false);
  const id = first.response.result.content[0].text.match(/delentia-guard approve ([0-9a-f]{8})/)[1];

  // Retrying before approval: still blocked, same request (no duplicates).
  const again = g.inspect(call(2, "git_push", { remote: "origin", branch: "main" }));
  assert.equal(again.forward, false);
  assert.match(again.response.result.content[0].text, new RegExp(`approve ${id}`));
  assert.equal(new ApprovalStore(dir).list().length, 1);

  new ApprovalStore(dir).approve(id);
  assert.equal(g.inspect(call(3, "git_push", { remote: "origin", branch: "main" })).forward, true, "approved call passes");
  assert.equal(g.inspect(call(4, "git_push", { remote: "origin", branch: "main" })).forward, false, "single use");
  assert.equal(g.stats.human_approved, 1);
});

test("an approval covers only the exact call: different arguments are still blocked", () => {
  const dir = tmp();
  const g = new Guard({ policy: POLICY, approvalsDir: dir });
  const id = g.inspect(call(1, "delete_file", { path: "build/tmp.txt" })).response.result.content[0].text.match(/approve ([0-9a-f]{8})/)[1];
  new ApprovalStore(dir).approve(id);
  assert.equal(g.inspect(call(2, "delete_file", { path: "src/index.ts" })).forward, false);
  assert.equal(g.inspect(call(3, "delete_file", { path: "build/tmp.txt" })).forward, true);
});

test("zero-trust denials (unknown tool) and path violations are never approvable", () => {
  const g = new Guard({ policy: POLICY, approvalsDir: tmp() });
  const unknown = g.inspect(call(1, "launch_rockets"));
  assert.equal(unknown.forward, false);
  assert.doesNotMatch(unknown.response.result.content[0].text, /delentia-guard approve/);
  const secret = g.inspect(call(2, "write_file", { path: ".env" }));
  assert.doesNotMatch(secret.response.result.content[0].text, /delentia-guard approve/);
  assert.equal(g.approvals.list().length, 0);
});

test("approvals expire, and can't be approved after expiry", () => {
  const dir = tmp();
  const store = new ApprovalStore(dir);
  const t0 = Date.parse("2026-09-27T00:00:00Z");
  const r = store.request("abc", { tool: "git_push", rule: "DESTRUCTIVE-BLOCK", reason: "x", arguments_preview: "{}" }, t0);
  assert.throws(() => store.approve(r.id, t0 + APPROVAL_TTL_MS + 1), /expired/);
  const r2 = store.request("def", { tool: "git_push", rule: "DESTRUCTIVE-BLOCK", reason: "x", arguments_preview: "{}" }, t0);
  store.approve(r2.id, t0 + 1000);
  assert.equal(store.consume("def", t0 + APPROVAL_TTL_MS + 1), undefined, "approved but expired is not usable");
});

test("without an approvals dir, human-signature rules simply deny (no request offered)", () => {
  const g = new Guard({ policy: POLICY });
  const r = g.inspect(call(1, "git_push"));
  assert.equal(r.forward, false);
  assert.doesNotMatch(r.response.result.content[0].text, /delentia-guard approve/);
});

test("the approve command refuses to run without an interactive terminal (e.g. from an agent's shell tool)", async () => {
  const dir = tmp();
  const g = new Guard({ policy: POLICY, approvalsDir: dir });
  const id = g.inspect(call(1, "git_push")).response.result.content[0].text.match(/approve ([0-9a-f]{8})/)[1];
  const p = spawn(process.execPath, [path.join(here, "../packages/guard/dist/cli.js"), "approve", id, "--approvals", dir], { stdio: ["pipe", "pipe", "pipe"] });
  let err = "";
  p.stderr.on("data", (d) => (err += d));
  p.stdin.end("git_push\n");
  const code = await new Promise((r) => p.on("close", r));
  assert.equal(code, 3);
  assert.match(err, /interactive terminal/);
  assert.equal(new ApprovalStore(dir).get(id).approved_at, undefined, "nothing was approved");
});
