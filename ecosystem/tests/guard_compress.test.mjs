/**
 * Delentia Guard --compress (Round 47 / P2): large tool results are compressed before they
 * reach the agent, and delentia_expand_context recovers anything left out.
 * Uses this repo's real build+test log (benchmarks/compression-real corpus) with one failing
 * test line inserted in the middle, the way a real failing run looks.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Guard } from "../packages/guard/dist/guard.js";
import { OutputCompressor, EXPAND_TOOL_NAME } from "../packages/guard/dist/compress.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REAL_LOG = readFileSync(path.join(here, "../benchmarks/compression-real/corpora/build_and_test_run.log"), "utf8");
const FAILURE = "✖ IntentLoopEngine: consensus rejects an empty specialist output (12.3ms)";
const lines = REAL_LOG.split("\n");
const LOG = [...lines.slice(0, 180), FAILURE, "  AssertionError [ERR_ASSERTION]: expected passed=false, got true", ...lines.slice(180)].join("\n");

test("compressor: real log with a failure -> much smaller, failure and assertion kept, deterministic", () => {
  const c = new OutputCompressor();
  const r = c.compress(LOG);
  assert.ok(r, "log is over the threshold");
  assert.ok(r.text.length < LOG.length * 0.5, `compressed to ${r.text.length} of ${LOG.length} chars`);
  assert.ok(r.text.includes(FAILURE));
  assert.ok(r.text.includes("AssertionError"));
  assert.ok(r.text.startsWith("[delentia-guard: output compressed"));
  assert.ok(r.text.includes(lines[lines.length - 2] || lines[lines.length - 1]), "tail kept");
  const again = new OutputCompressor().compress(LOG);
  assert.equal(again.text.replace(/context_ref "[^"]+"/, ""), r.text.replace(/context_ref "[^"]+"/, ""), "same input -> same view (apart from the ref)");
});

test("compressor: small outputs pass through untouched, and a view is never bigger than the original", () => {
  const c = new OutputCompressor();
  assert.equal(c.compress("short output\nok", {}), null);
  const oneHugeLine = "x".repeat(20000);
  assert.equal(c.compress(oneHugeLine), null);
});

test("guard: tools/list gets the expand tool, a big result is compressed, expand works locally", () => {
  const g = new Guard({ policy: path.join(here, "../packages/guard/policies/coding-agent.json"), compress: {} });
  assert.equal(g.inspect({ jsonrpc: "2.0", id: 1, method: "tools/list" }).forward, true);
  const list = g.inspectServer({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "read_file" }] } });
  assert.deepEqual(list.result.tools.map((t) => t.name), ["read_file", EXPAND_TOOL_NAME]);

  assert.equal(g.inspect({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_build_log", arguments: { path: "test.log" } } }).forward, true);
  const res = g.inspectServer({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: LOG }] } });
  const view = res.result.content[0].text;
  assert.ok(view.length < LOG.length * 0.5);
  const ref = view.match(/context_ref "([^"]+)"/)[1];

  // A line that the view dropped, fetched back without the server being involved.
  const dropped = lines.find((l) => l.includes("duration_ms") && !view.includes(l));
  assert.ok(dropped, "precondition: some duration_ms line was dropped");
  const exp = g.inspect({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: EXPAND_TOOL_NAME, arguments: { context_ref: ref, pattern: "duration_ms", context_lines: 0 } } });
  assert.equal(exp.forward, false, "expand is answered by the guard, never forwarded");
  assert.ok(exp.response.result.content[0].text.includes(dropped.trim()));

  const bad = g.inspect({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: EXPAND_TOOL_NAME, arguments: { context_ref: "nope" } } });
  assert.equal(bad.response.result.isError, true);
  assert.equal(g.compressor.stats.results_compressed, 1);
});

test("guard: plain file reads are never compressed by default (an agent editing a file needs all of it)", () => {
  const g = new Guard({ compress: {} });
  assert.equal(g.inspect({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "read_file", arguments: { path: "big.ts" } } }).forward, true);
  const msg = { jsonrpc: "2.0", id: 7, result: { content: [{ type: "text", text: LOG }] } };
  assert.equal(g.inspectServer(msg), msg);
  const custom = new Guard({ compress: { tools: ["read_*"] } });
  custom.inspect({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "read_file", arguments: { path: "big.ts" } } });
  assert.notEqual(custom.inspectServer({ jsonrpc: "2.0", id: 8, result: { content: [{ type: "text", text: LOG }] } }).result.content[0].text, LOG, "--compress-tools can opt reads in");
});

test("guard: without --compress nothing is rewritten", () => {
  const g = new Guard();
  g.inspect({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const msg = { jsonrpc: "2.0", id: 1, result: { tools: [] } };
  assert.equal(g.inspectServer(msg), msg);
});

test("end to end through processes: --compress shrinks the real log and expand recovers a dropped line", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "guard-c-"));
  writeFileSync(path.join(dir, "test.log"), LOG);
  const executed = path.join(dir, "executed.txt");
  writeFileSync(executed, "");
  const cli = path.join(here, "../packages/guard/dist/cli.js");
  const p = spawn(process.execPath, [cli, "--compress", "--audit", path.join(dir, "a.jsonl"), "--policy", path.join(here, "../packages/guard/policies/coding-agent.json"), "--", process.execPath, path.join(here, "helpers/fake-mcp-server.mjs"), executed], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, FAKE_READ_ROOT: dir },
  });
  let out = "";
  let err = "";
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (err += d));
  const send = (m) => p.stdin.write(JSON.stringify(m) + "\n");
  const waitFor = (id) =>
    new Promise((resolve) => {
      const t = setInterval(() => {
        const m = out.split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((x) => x.id === id);
        if (m) {
          clearInterval(t);
          resolve(m);
        }
      }, 20);
    });

  send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const list = await waitFor(1);
  assert.ok(list.result.tools.some((t) => t.name === EXPAND_TOOL_NAME));

  send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_build_log", arguments: { path: "test.log" } } });
  const read = await waitFor(2);
  const view = read.result.content[0].text;
  assert.ok(view.length < LOG.length * 0.5, `view ${view.length} chars vs ${LOG.length}`);
  assert.ok(view.includes(FAILURE));
  const ref = view.match(/context_ref "([^"]+)"/)[1];

  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: EXPAND_TOOL_NAME, arguments: { context_ref: ref, start_line: 100, end_line: 102 } } });
  const exp = await waitFor(3);
  assert.ok(exp.result.content[0].text.startsWith("100: "));
  p.stdin.end();
  await new Promise((r) => p.on("close", r));
  assert.match(err, /compressed 1\/1 results/);
  assert.equal(readFileSync(executed, "utf8").trim(), "get_build_log", "expand never reached the server");
});
