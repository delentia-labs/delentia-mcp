/**
 * "Compress, but keep it retrievable": compress_context(retain_original) + expand_context.
 *
 * The end-to-end case uses a question from benchmarks/compression-real where aggressive
 * compression really did drop the answer line (paraphrased question docs-p1), and shows the
 * answer is recoverable through expand_context without re-sending the original.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import worker, { MEEGrowthSessionDO } from "../packages/sovereign/dist/worker.js";
import { queryLines } from "../packages/shared/dist/index.js";
import { compressContext as deltaCompress } from "../packages/delta/dist/index.js";
import { createFakeDurableObjectNamespace } from "./helpers/fake-durable-object.mjs";

const CODE = readFileSync(new URL("../benchmarks/compression-real/corpora/intent_loop_index.ts.txt", import.meta.url), "utf8");
const README = readFileSync(new URL("../benchmarks/compression-real/corpora/readme_snapshot.md", import.meta.url), "utf8");

async function call(env, name, args) {
  const request = new Request("http://worker.test/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = await (await worker.fetch(request, env, {})).json();
  return { isError: Boolean(body.result?.isError), payload: JSON.parse(body.result.content[0].text) };
}
const env = () => ({ ENVIRONMENT: "test", MEE_SESSION_DO: createFakeDurableObjectNamespace(MEEGrowthSessionDO) });

test("queryLines: term search returns numbered matches with context", () => {
  const r = queryLines("alpha\nbeta\nGamma ray\ndelta\nepsilon", { pattern: "gamma", context_lines: 1 });
  assert.deepEqual(r.lines, [{ n: 2, text: "beta" }, { n: 3, text: "Gamma ray" }, { n: 4, text: "delta" }]);
  assert.equal(r.total_lines, 5);
  assert.equal(r.truncated, false);
});

test("queryLines: line range without a pattern, and max_lines truncation", () => {
  const text = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
  assert.deepEqual(queryLines(text, { start_line: 3, end_line: 4 }).lines.map((l) => l.n), [3, 4]);
  const capped = queryLines(text, { max_lines: 5 });
  assert.equal(capped.lines.length, 5);
  assert.equal(capped.truncated, true);
});

test("queryLines: the pattern is plain text, not a regex", () => {
  const r = queryLines("a+b=c\nabbbc", { pattern: "a+b", context_lines: 0 });
  assert.deepEqual(r.lines.map((l) => l.text), ["a+b=c"]);
});

test("end to end: an answer dropped by aggressive compression is recovered with expand_context", async () => {
  const e = env();
  const question = "How much does the paid subscription cost each month?"; // benchmark docs-p1
  const compressed = await call(e, "compress_context", { raw_context: README, intent_focus: question, aggressive_mode: true, retain_original: true });
  assert.equal(compressed.isError, false);
  assert.ok(compressed.payload.reduction_percentage > 50);
  assert.ok(!compressed.payload.compressed_delta_text.includes("29 USD"), "precondition: compression dropped the answer");
  assert.match(compressed.payload.context_ref, /^[0-9a-f-]{36}$/);

  // The agent searches the retained original with terms of its own choosing.
  const expanded = await call(e, "expand_context", { context_ref: compressed.payload.context_ref, pattern: "USD price tier", context_lines: 0 });
  assert.equal(expanded.isError, false);
  assert.ok(expanded.payload.lines.some((l) => l.text.includes("29 USD")));
  assert.ok(expanded.payload.lines.length < 15, "returns a few lines, not the whole file");
});

test("expand_context rejects unknown or malformed refs", async () => {
  const e = env();
  assert.equal((await call(e, "expand_context", { context_ref: "not-a-ref" })).isError, true);
  assert.equal((await call(e, "expand_context", { context_ref: "00000000-0000-4000-8000-000000000000" })).isError, true);
});

test("without retain_original nothing is stored and no context_ref is returned", async () => {
  const r = await call(env(), "compress_context", { raw_context: CODE, intent_focus: "fdiaThreshold", aggressive_mode: true });
  assert.equal(r.payload.context_ref, undefined);
});

test("compression is deterministic, so compressing a tool output once at ingestion keeps prompt-cache prefixes stable", () => {
  const args = { raw_context: CODE, intent_focus: "verification consensus threshold", aggressive_mode: true };
  assert.equal(deltaCompress(args).compressed_delta_text, deltaCompress(args).compressed_delta_text);
});
