/**
 * Behavioral tests for compressContext's filtering rules, each tied to a failure the
 * real-data benchmark (benchmarks/compression-real/REPORT.md) actually showed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import { compressContext, focusKeywords } from "../packages/delta/dist/index.js";

const body = (r) => r.compressed_delta_text.split("\n").slice(1).join("\n");

test("dedup keeps short structural lines, so compressed code still parses", () => {
  const code = [
    "function a(x: number) {",
    "  if (x > 1) {",
    "    return x;",
    "  }",
    "}",
    "function b(y: number) {",
    "  if (y > 2) {",
    "    return y;",
    "  }",
    "}",
  ].join("\n");
  const r = compressContext({ raw_context: code, aggressive_mode: false });
  const sf = ts.createSourceFile("x.ts", body(r), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  assert.equal(sf.parseDiagnostics.length, 0, body(r));
  // v1 kept only the first `}` of the whole input; all four must survive.
  assert.equal(body(r).split("\n").filter((l) => l === "}").length, 4);
});

test("dedup still removes repeated content lines", () => {
  const r = compressContext({ raw_context: "Heartbeat acknowledged OK\n".repeat(50) + "Deadlock detected on row 9401" });
  assert.equal(body(r), "Heartbeat acknowledged OK\nDeadlock detected on row 9401");
});

test("question words are not keywords (they used to match nearly every line)", () => {
  assert.deepEqual(focusKeywords("What is the default maxIntentLength?"), ["default", "maxintentlength"]);
  assert.ok(!focusKeywords("which of these does the gate block").includes("the"));
});

test("aggressive mode keeps a matched line's neighbours and marks skipped gaps", () => {
  const raw = ["noise one alpha", "config section header", "timeout: 30", "noise two beta", "noise three gamma", "noise four delta"].join("\n");
  const r = compressContext({ raw_context: raw, intent_focus: "What is the timeout?", aggressive_mode: true });
  assert.equal(body(r), "…\nconfig section header\ntimeout: 30\nnoise two beta");
});

test("aggressive mode with no match falls back to the last lines instead of returning nothing", () => {
  const raw = Array.from({ length: 30 }, (_, i) => `unrelated line number ${i}`).join("\n");
  const r = compressContext({ raw_context: raw, intent_focus: "kubernetes", aggressive_mode: true });
  assert.equal(body(r).split("\n").length, 10);
  assert.ok(body(r).endsWith("unrelated line number 29"));
});

test("non-aggressive mode with an intent does not filter (dedup only)", () => {
  const raw = "alpha line content\nbeta line content\nalpha line content";
  const r = compressContext({ raw_context: raw, intent_focus: "beta", aggressive_mode: false });
  assert.equal(body(r), "alpha line content\nbeta line content");
});

test("outline (opt-in): left-out headings are listed with their line numbers in the ORIGINAL text", () => {
  const raw = ["# Setup", "", "install things here", "## Pricing", "", "The plan costs 29 USD a month", "## Ports", "server listens on 8787", "## Timeout", "timeout: 30"].join("\n");
  const plain = compressContext({ raw_context: raw, intent_focus: "What is the timeout?", aggressive_mode: true });
  assert.ok(!plain.compressed_delta_text.includes("[Left out"), "off by default");
  const r = compressContext({ raw_context: raw, intent_focus: "What is the timeout?", aggressive_mode: true, outline: true });
  const outline = [...r.compressed_delta_text.matchAll(/^L(\d+): (.*)$/gm)].map((m) => [Number(m[1]), m[2]]);
  // Line numbers count the blank lines too, so they index straight into raw_context.
  for (const [n, text] of outline) assert.equal(raw.split("\n")[n - 1].trim(), text);
  // "## Timeout" and its neighbour "server listens on 8787" are kept; the other headings are listed.
  assert.deepEqual(outline.map(([n]) => n), [1, 4, 7]);
});
