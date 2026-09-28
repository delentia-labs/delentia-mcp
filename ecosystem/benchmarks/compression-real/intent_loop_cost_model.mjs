/**
 * Token cost model for the Intent Loop (packages/intent-loop), built from its real prompts.
 *
 * Per request the loop does (packages/intent-loop/src/index.ts):
 *   gate (no LLM) -> memory recall (no LLM) -> on a miss: 1 specialist call + 3 verifier calls -> commit
 * A cache hit (exact intent hash, or word-Jaccard > 0.95 on the intent text) costs 0 LLM tokens.
 *
 * Compared against a plain "one LLM call with the context" baseline. All prompt sizes are counted
 * with the same tokenizer as the compression benchmark; the workload parameters (intent, context,
 * answer sizes, hit rate) are scenario inputs, printed with every result.
 *
 * Usage: node benchmarks/compression-real/intent_loop_cost_model.mjs
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, "../../packages/intent-loop/src/index.ts"), "utf8");

const specialistSystem = src.match(/content: "(You are a specialist assistant[^"]+)"/)[1];
const verifierSystem = src.match(/'(You are a strict verifier[^']+)'/)[1];
const verifierMaxOut = 250; // max_tokens passed to each verifier call in index.ts
const VERIFIERS = (src.match(/const VERIFIER_MODELS = \[([^\]]+)\]/)[1].match(/"/g).length) / 2;
// With ConsensusVerifier earlyStop (2026-09-27) only the smallest majority is asked first; the rest
// are called only when their votes could still change the outcome. Assume the common case: the
// first two agree. Pass --all-verifiers to model the old always-ask-everyone behaviour.
const VERIFIERS_CALLED = process.argv.includes("--all-verifiers") ? VERIFIERS : Math.floor(VERIFIERS / 2) + 1;

const r = spawnSync("python", [path.join(here, "count_tokens.py")], {
  input: JSON.stringify([specialistSystem, verifierSystem, "INTENT: \n\nOUTPUT: "]),
  encoding: "utf8",
});
const [SPEC_SYS, VER_SYS, VER_FRAME] = JSON.parse(r.stdout);
const CHAT_OVERHEAD = 8; // per message role/formatting tokens, approximate

/**
 * @param w workload: intent, context, answer tokens per request; verifierOut = visible+reasoning tokens per verifier;
 *          hit = cache hit rate; compression = fraction of context tokens removed (0 = no compression);
 *          outWeight = price of an output token relative to an input token (provider-specific; scenario input)
 */
function costs(w) {
  const verifiers = w.noVerify ? 0 : VERIFIERS_CALLED;
  const baseline = { in: w.intent + w.context + CHAT_OVERHEAD, out: w.answer };
  // NOTE: today's loop forwards only packet.intent to the specialist (no context). Scenarios with
  // context > 0 model the planned loop that also forwards (optionally compressed) context.
  const specialistIn = SPEC_SYS + w.intent + w.context * (1 - w.compression) + 2 * CHAT_OVERHEAD;
  const verifierIn = VER_SYS + VER_FRAME + w.intent + w.answer + 2 * CHAT_OVERHEAD;
  const miss = { in: specialistIn + verifiers * verifierIn, out: w.answer + verifiers * w.verifierOut };
  const loop = { in: (1 - w.hit) * miss.in, out: (1 - w.hit) * miss.out };
  const weigh = (c) => c.in + w.outWeight * c.out;
  return { baseline, miss, loop, saving: 1 - weigh(loop) / weigh(baseline) };
}

const scenarios = [
  { name: "A. short Q&A, no context, no repeats", intent: 40, context: 0, answer: 160, verifierOut: 60, hit: 0, compression: 0 },
  { name: "B. short Q&A, 30% repeated questions", intent: 40, context: 0, answer: 160, verifierOut: 60, hit: 0.3, compression: 0 },
  { name: "C. planned loop: agent step with 8k-token context, no compression, no repeats", intent: 60, context: 8000, answer: 300, verifierOut: 60, hit: 0, compression: 0 },
  { name: "D. same, Delta aggressive (-73% context, measured literal-question avg)", intent: 60, context: 8000, answer: 300, verifierOut: 60, hit: 0, compression: 0.733 },
  { name: "E. same as D + 30% cache hits", intent: 60, context: 8000, answer: 300, verifierOut: 60, hit: 0.3, compression: 0.733 },
  { name: "F. same as D, verifiers skipped (no consensus)", intent: 60, context: 8000, answer: 300, verifierOut: 0, hit: 0, compression: 0.733, noVerify: true },
];

console.log(`Real prompt sizes (tiktoken o200k): specialist system=${SPEC_SYS}, verifier system=${VER_SYS}, verifier frame=${VER_FRAME}, verifiers=${VERIFIERS} (called per miss: ${VERIFIERS_CALLED}), verifier max_tokens=${verifierMaxOut}\n`);
for (const outWeight of [1, 4]) {
  console.log(`--- output token weighted x${outWeight} vs input ---`);
  for (const s of scenarios) {
    const w = { ...s, outWeight };
    const c = costs(w);
    console.log(
      `${s.name.padEnd(72)} baseline in/out=${Math.round(c.baseline.in)}/${Math.round(c.baseline.out)}  loop in/out=${Math.round(c.loop.in)}/${Math.round(c.loop.out)}  saving=${(c.saving * 100).toFixed(1)}%`
    );
  }
  // Break-even cache hit rate for the no-context, no-compression case.
  const m = costs({ intent: 40, context: 0, answer: 160, verifierOut: 60, hit: 0, compression: 0, outWeight });
  const weigh = (x) => x.in + outWeight * x.out;
  console.log(`break-even cache hit rate (short Q&A, verifiers paid): ${((1 - weigh(m.baseline) / weigh(m.miss)) * 100).toFixed(1)}%\n`);
}
