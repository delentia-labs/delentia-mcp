/**
 * Prompt caching vs. Delta compression: cost simulation across workload shapes.
 *
 * Prices: Claude Sonnet 5 first-party list price ($2 / $10 per 1M input / output tokens);
 * prompt caching: cache write (5-min TTL) = 1.25x input, cache read = 0.1x input.
 * Compression numbers are the ones measured in this folder (REPORT.md):
 *   aggressive mode removes 73% of tokens; answer-line retention 100% for literal
 *   questions, 62.5% for paraphrased ones (v2). A lost answer is modelled as one retry
 *   with the full, uncompressed context (the realistic fallback).
 * Cache hits require an identical prefix: Delta's per-question output changes the prefix,
 * so "compress per question" can't be cached; "compress once at ingestion" can.
 *
 * Usage: node benchmarks/compression-real/caching_vs_compression_sim.mjs
 */
const PRICE_IN = 2 / 1e6, PRICE_OUT = 10 / 1e6, WRITE = 1.25, READ = 0.1;
const R = 0.73; // measured aggressive-mode reduction
const RETAIN_LITERAL = 1.0, RETAIN_PARA = 0.625;

const usd = (x) => `$${x.toFixed(4)}`;

/** Cost of one request. `cached`: tokens read from cache, `written`: tokens written to cache, `fresh`: uncached input. */
const req = ({ cached = 0, written = 0, fresh = 0, out }) =>
  cached * READ * PRICE_IN + written * WRITE * PRICE_IN + fresh * PRICE_IN + out * PRICE_OUT;

// ---------------------------------------------------------------------------
// Workload 1-4: "N questions about one context", varying repetition and timing
// ---------------------------------------------------------------------------
function questionsOverContext({ ctx, sys = 1500, q = 40, out = 250, n, withinTtl, paraShare }) {
  const retain = (1 - paraShare) * RETAIN_LITERAL + paraShare * RETAIN_PARA;
  const full = n * req({ fresh: sys + ctx + q, out });
  // caching: first request writes sys+ctx; later ones read it if within TTL, else re-write each time
  const cache = req({ written: sys + ctx, fresh: q, out }) +
    (n - 1) * (withinTtl ? req({ cached: sys + ctx, fresh: q, out }) : req({ written: sys + ctx, fresh: q, out }));
  // Delta per question: system prompt can still be cached, compressed context is fresh every time
  const deltaOne = req({ cached: sys, fresh: ctx * (1 - R) + q, out });
  const retry = req({ cached: sys, fresh: ctx + q, out });
  const delta = req({ written: sys, fresh: ctx * (1 - R) + q, out }) + (n - 1) * deltaOne + n * (1 - retain) * retry;
  return { full, cache, delta, retain };
}

// ---------------------------------------------------------------------------
// Workload 5: agent loop. Each turn appends one tool output (logs/test output) + the assistant reply.
// History is append-only, so caching works on everything already sent.
// ---------------------------------------------------------------------------
function agentLoop({ turns, sys = 6000, tool, out = 400, compress, cache }) {
  let prefix = sys, total = 0;
  for (let t = 0; t < turns; t++) {
    const added = (compress ? tool * (1 - R) : tool) + (t > 0 ? out : 0);
    total += cache
      ? req({ cached: t === 0 ? 0 : prefix, written: t === 0 ? prefix + added : added, out })
      : req({ fresh: prefix + added, out });
    prefix += added;
  }
  return { total, finalContext: prefix };
}

console.log("Prices: Sonnet 5 $2/$10 per MTok, cache write 1.25x, cache read 0.1x. Delta aggressive -73% (measured).\n");

const cases = [
  { name: "W1 same 8k doc, 10 questions, within 5-min TTL, literal questions", ctx: 8000, n: 10, withinTtl: true, paraShare: 0 },
  { name: "W2 same as W1 but half the questions paraphrased", ctx: 8000, n: 10, withinTtl: true, paraShare: 0.5 },
  { name: "W3 one-shot: fresh 20k-token CI log, 1 question", ctx: 20000, n: 1, withinTtl: true, paraShare: 0 },
  { name: "W4 same 8k doc, 10 questions spread over a day (TTL expires)", ctx: 8000, n: 10, withinTtl: false, paraShare: 0.5 },
];
for (const c of cases) {
  const r = questionsOverContext(c);
  const best = Object.entries({ "no optimisation": r.full, "prompt caching": r.cache, "Delta per question": r.delta }).sort((a, b) => a[1] - b[1])[0][0];
  console.log(`${c.name}\n  no optimisation ${usd(r.full)} | prompt caching ${usd(r.cache)} (${(100 * (1 - r.cache / r.full)).toFixed(0)}% off) | Delta ${usd(r.delta)} (${(100 * (1 - r.delta / r.full)).toFixed(0)}% off, answer kept ${(r.retain * 100).toFixed(0)}%)  -> cheapest: ${best}\n`);
}

console.log("W5 agent loop: 20 turns, each turn appends a 3,000-token tool output (logs/test output)");
const base = agentLoop({ turns: 20, tool: 3000, compress: false, cache: false });
for (const [label, o] of [
  ["no optimisation", { compress: false, cache: false }],
  ["prompt caching only", { compress: false, cache: true }],
  ["Delta at ingestion only", { compress: true, cache: false }],
  ["Delta at ingestion + prompt caching", { compress: true, cache: true }],
]) {
  const r = agentLoop({ turns: 20, tool: 3000, ...o });
  console.log(`  ${label.padEnd(36)} ${usd(r.total)}  (${(100 * (1 - r.total / base.total)).toFixed(0)}% off)  final context ${Math.round(r.finalContext).toLocaleString("en-US")} tokens`);
}
