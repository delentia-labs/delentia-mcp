/**
 * Delentia Guard: enforcing proxy for MCP tool calls (packages/guard).
 * Unit tests on the decision core, plus end-to-end runs through real processes:
 * client -> delentia-guard (dist/cli.js) -> fake stdio MCP server.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Guard, verifyAuditLog, lastAuditHash } from "../packages/guard/dist/guard.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const call = (id, name, args = {}) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

test("non-tool-call messages pass through untouched", () => {
  const g = new Guard();
  assert.equal(g.inspect({ jsonrpc: "2.0", id: 1, method: "tools/list" }).forward, true);
  assert.equal(g.inspect({ jsonrpc: "2.0", method: "notifications/initialized" }).forward, true);
});

test("default policy: reads allowed; writes to secrets, destructive and unregistered tools blocked", () => {
  const g = new Guard();
  assert.equal(g.inspect(call(1, "read_file", { path: "src/app.ts" })).forward, true);
  assert.equal(g.inspect(call(2, "write_file", { path: "src/app.ts", content: "x" })).forward, true);

  const env = g.inspect(call(3, "write_file", { path: ".env", content: "KEY=1" }));
  assert.equal(env.forward, false);
  assert.equal(env.response.id, 3);
  assert.equal(env.response.result.isError, true);
  assert.match(env.response.result.content[0].text, /Blocked by Delentia Guard/);

  assert.equal(g.inspect(call(4, "delete_file", { path: "README.md" })).forward, false);
  assert.equal(g.inspect(call(5, "launch_rockets", {})).forward, false, "unregistered tool -> zero-trust deny");
  assert.deepEqual(g.stats, { calls: 5, allowed: 2, blocked: 3, would_block: 0 });
});

test("monitor mode forwards everything but records what it would have blocked", () => {
  const g = new Guard({ mode: "monitor" });
  assert.equal(g.inspect(call(1, "delete_file", { path: "x" })).forward, true);
  assert.equal(g.stats.would_block, 1);
  assert.equal(g.stats.blocked, 0);
});

test("--map lets an upstream tool name reuse a policy action", () => {
  const g = new Guard({ actionMap: { remove_everything: "delete_all" } });
  assert.equal(g.inspect(call(1, "remove_everything")).forward, false);
  const reads = new Guard({ actionMap: { cat: "read_file" } });
  assert.equal(reads.inspect(call(2, "cat", { path: "a.txt" })).forward, true);
});

test("audit log is hash-chained: intact log verifies, an edited or removed entry is detected", () => {
  const lines = [];
  const g = new Guard({ audit: (l) => lines.push(l) });
  g.inspect(call(1, "read_file", { path: "a" }));
  g.inspect(call(2, "delete_file", { path: "b" }));
  g.inspect(call(3, "read_file", { path: "c" }));
  const log = lines.join("\n");
  assert.deepEqual(verifyAuditLog(log), { ok: true, entries: 3 });
  assert.equal(JSON.parse(lines[1]).decision, "blocked");
  assert.ok(!lines[0].includes("path"), "arguments are stored only as a hash");

  const edited = [lines[0], lines[1].replace("\"blocked\"", "\"allowed\""), lines[2]].join("\n");
  assert.equal(verifyAuditLog(edited).ok, false);
  assert.equal(verifyAuditLog(edited).broken_at, 2);
  assert.equal(verifyAuditLog([lines[0], lines[2]].join("\n")).ok, false, "a deleted entry breaks the chain");

  // Continuing after a restart keeps the chain intact.
  const more = [];
  new Guard({ audit: (l) => more.push(l), previousHash: lastAuditHash(log) }).inspect(call(4, "read_file", { path: "d" }));
  assert.equal(verifyAuditLog([log, ...more].join("\n")).ok, true);
});

test("coding-agent starter policy: common filesystem / git / GitHub / shell tool names", () => {
  const g = new Guard({ policy: path.join(here, "../packages/guard/policies/coding-agent.json") });
  const decide = (name, args = {}) => (g.inspect(call(1, name, args)).forward ? "allow" : "block");
  const cases = [
    ["read_text_file", { path: "src/a.ts" }, "allow"],
    ["directory_tree", { path: "." }, "allow"],
    ["search_files", { pattern: "TODO" }, "allow"],
    ["git_status", {}, "allow"],
    ["git_diff", {}, "allow"],
    ["edit_file", { path: "src/a.ts" }, "allow"],
    ["create_directory", { path: "out" }, "allow"],
    ["create_pull_request", { title: "x" }, "allow"],
    ["edit_file", { path: ".env" }, "block"],
    ["write_file", { path: "C:\\Users\\me\\.ssh\\config" }, "block"], // Windows path, regression
    ["write_file", { path: "/home/me/.ssh/authorized_keys" }, "block"],
    ["delete_file", { path: "a" }, "block"],
    ["git_push", {}, "block"],
    ["merge_pull_request", { number: 1 }, "block"],
    ["run_command", { command: "rm -rf /" }, "block"],
    ["unknown_tool", {}, "block"],
  ];
  for (const [name, args, expected] of cases) assert.equal(decide(name, args), expected, `${name} ${JSON.stringify(args)}`);
});

function runGuard(args, messages) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(here, "../packages/guard/dist/cli.js"), ...args], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => resolve({ code, out, err, replies: out.split("\n").filter(Boolean).map((l) => JSON.parse(l)) }));
    for (const m of messages) p.stdin.write(JSON.stringify(m) + "\n");
    p.stdin.end();
  });
}

const FAKE = path.join(here, "helpers/fake-mcp-server.mjs");

test("end to end: a blocked call never reaches the server; allowed calls do; audit log verifies", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "guard-"));
  const executed = path.join(dir, "executed.txt");
  const audit = path.join(dir, "audit.jsonl");
  writeFileSync(executed, "");
  const r = await runGuard(["--audit", audit, "--", process.execPath, FAKE, executed], [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    call(2, "read_file", { path: "README.md" }),
    call(3, "delete_file", { path: "README.md" }),
    call(4, "write_file", { path: "config/.env", content: "SECRET=1" }),
    call(5, "write_file", { path: "notes.md", content: "hello" }),
  ]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(readFileSync(executed, "utf8").trim().split("\n"), ["read_file", "write_file"], "only allowed calls reached the server");
  const byId = Object.fromEntries(r.replies.map((m) => [m.id, m]));
  assert.equal(byId[1].result.serverInfo.name, "fake");
  assert.equal(byId[2].result.content[0].text, "executed read_file");
  assert.equal(byId[3].result.isError, true);
  assert.equal(byId[4].result.isError, true);
  assert.equal(byId[5].result.content[0].text, "executed write_file");
  assert.match(r.err, /blocked: 2/);
  assert.ok(existsSync(audit));
  assert.deepEqual(verifyAuditLog(readFileSync(audit, "utf8")), { ok: true, entries: 4 });
});

test("end to end: --monitor forwards everything, and --verify reports the log", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "guard-"));
  const executed = path.join(dir, "executed.txt");
  const audit = path.join(dir, "audit.jsonl");
  writeFileSync(executed, "");
  const r = await runGuard(["--monitor", "--audit", audit, "--", process.execPath, FAKE, executed], [call(1, "delete_file", { path: "x" })]);
  assert.equal(r.code, 0, r.err);
  assert.equal(readFileSync(executed, "utf8").trim(), "delete_file");
  assert.match(r.err, /would block: 1/);
  const v = await runGuard(["--verify", audit], []);
  assert.deepEqual(JSON.parse(v.out), { ok: true, entries: 1 });
});
