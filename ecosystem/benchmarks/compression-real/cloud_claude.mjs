/**
 * Cloud benchmark on real Claude models: same corpora, questions and compressed contexts as the
 * local run (results/variants.json), measured with the provider's own numbers.
 *
 *   --count      exact Claude token counts per mode via messages.countTokens (no generation)
 *   --run        real answers: accuracy + billed usage (input, output, cache write/read) + USD
 *   (neither)    dry run: prints what would be sent and an upper-bound cost estimate, spends nothing
 *
 * Modes: full, full_cached (full context marked for prompt caching, questions asked back-to-back
 * so every question after the first can read the cache), delta_aggressive (v1), v2_aggressive,
 * tail_matched.
 *
 * Credentials: the SDK resolves ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / an `ant auth login`
 * profile. Set one yourself before --count / --run; this script never asks for or stores a key.
 *
 * Usage:
 *   node benchmarks/compression-real/cloud_claude.mjs                          # dry run
 *   node benchmarks/compression-real/cloud_claude.mjs --count
 *   node benchmarks/compression-real/cloud_claude.mjs --run --models claude-haiku-4-5,claude-sonnet-5
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f, d) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : d);

// First-party list prices, USD per 1M tokens (Anthropic pricing as cached 2026-06-24 in the
// claude-api reference). Cache write (5-min TTL) = 1.25x input, cache read = 0.1x input.
const PRICES = {
  "claude-opus-5": { in: 5, out: 25 },
  "claude-sonnet-5": { in: 2, out: 10 },
  "claude-haiku-4-5": { in: 1, out: 5 },
};
const MODELS = opt("--models", "claude-opus-5,claude-sonnet-5,claude-haiku-4-5").split(",");
const MODES = opt("--modes", "full,full_cached,delta_aggressive,v2_aggressive,tail_matched").split(",");
for (const m of MODELS) if (!PRICES[m]) throw new Error(`no price for ${m}; add it to PRICES`);

const SYSTEM =
  "Answer the question using ONLY the provided context. If the context does not contain the answer, reply exactly: NOT FOUND. Reply in one short sentence.";

const spec = JSON.parse(readFileSync(path.join(here, "questions.json"), "utf8"));
const answerRe = {};
for (const c of Object.values(spec.corpora)) for (const q of c.questions) answerRe[q.id] = new RegExp(q.answer, "is");
const { rows } = JSON.parse(readFileSync(path.join(here, "results", "variants.json"), "utf8"));

/** (corpus, question, mode) items, grouped so a corpus's full_cached questions run back-to-back. */
function items() {
  const out = [];
  for (const mode of MODES) {
    const src = mode === "full_cached" ? "full" : mode;
    for (const r of rows) if (r.corpus !== "synthetic" && r.mode === src) out.push({ ...r, mode });
  }
  return out.sort((a, b) => a.corpus.localeCompare(b.corpus) || MODES.indexOf(a.mode) - MODES.indexOf(b.mode));
}

function request(model, it) {
  const content =
    it.mode === "full_cached"
      ? [
          { type: "text", text: `Context:\n${it.context}`, cache_control: { type: "ephemeral" } },
          { type: "text", text: `Question: ${it.question}` },
        ]
      : `Context:\n${it.context}\n\nQuestion: ${it.question}`;
  const params = { model, max_tokens: 4000, system: SYSTEM, messages: [{ role: "user", content }] };
  // Short factual answers: low effort where supported (Haiku 4.5 rejects the effort parameter).
  if (model !== "claude-haiku-4-5") params.output_config = { effort: "low" };
  return params;
}

function cost(model, u) {
  const p = PRICES[model];
  return (
    ((u.input_tokens ?? 0) * p.in +
      (u.cache_creation_input_tokens ?? 0) * p.in * 1.25 +
      (u.cache_read_input_tokens ?? 0) * p.in * 0.1 +
      (u.output_tokens ?? 0) * p.out) /
    1e6
  );
}

const list = items();
if (!flag("--count") && !flag("--run")) {
  const inTok = list.reduce((s, it) => s + it.tokens, 0) * 1.25; // o200k undercounts Claude by ~15-20%; pad
  console.log(`Dry run: ${list.length} requests per model, ~${Math.round(inTok).toLocaleString("en-US")} input tokens per model (upper-bound estimate, before caching).`);
  for (const m of MODELS) console.log(`  ${m}: <= $${((inTok * PRICES[m].in + list.length * 300 * PRICES[m].out) / 1e6).toFixed(2)}`);
  console.log("Nothing was sent. Use --count (token counts only) or --run (real answers).");
  process.exit(0);
}

const client = new Anthropic();
const results = [];
for (const model of MODELS) {
  for (const it of list) {
    const params = request(model, it);
    try {
      if (flag("--count")) {
        const { max_tokens, output_config, ...countParams } = params;
        const c = await client.messages.countTokens(countParams);
        results.push({ model, corpus: it.corpus, question_id: it.question_id, mode: it.mode, claude_input_tokens: c.input_tokens });
      } else {
        const r = await client.messages.create(params);
        if (r.stop_reason === "refusal") {
          results.push({ model, question_id: it.question_id, mode: it.mode, refusal: true });
          continue;
        }
        const text = r.content.filter((b) => b.type === "text").map((b) => b.text).join(" ");
        results.push({
          model,
          corpus: it.corpus,
          question_id: it.question_id,
          paraphrase: it.paraphrase,
          mode: it.mode,
          reply: text,
          correct: answerRe[it.question_id].test(text) && !/NOT FOUND/i.test(text),
          usage: r.usage,
          usd: cost(model, r.usage),
        });
        const last = results.at(-1);
        console.log(`${model} ${it.question_id.padEnd(8)} ${it.mode.padEnd(17)} ${last.correct ? "OK " : "BAD"} in=${r.usage.input_tokens} cw=${r.usage.cache_creation_input_tokens ?? 0} cr=${r.usage.cache_read_input_tokens ?? 0} out=${r.usage.output_tokens} $${last.usd.toFixed(5)}`);
      }
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) {
        console.error("No valid Claude credentials. Set ANTHROPIC_API_KEY (or run `ant auth login`) yourself, then rerun.");
        process.exit(1);
      } else if (err instanceof Anthropic.RateLimitError) {
        console.error(`rate limited on ${model} ${it.question_id}/${it.mode}; stopping so partial results are saved`);
        break;
      } else if (err instanceof Anthropic.APIError) {
        console.error(`API error ${err.status} on ${model} ${it.question_id}/${it.mode}: ${err.message}`);
        results.push({ model, question_id: it.question_id, mode: it.mode, error: `${err.status} ${err.message}` });
      } else if (err instanceof Error && /authentication method/i.test(err.message)) {
        // Raised by the SDK client before any request when no credential source is configured.
        console.error("No Claude credentials found. Set ANTHROPIC_API_KEY (or run `ant auth login`) yourself, then rerun. Nothing was sent.");
        process.exit(1);
      } else throw err;
    }
  }
}

const outFile = path.join(here, "results", flag("--count") ? "cloud_claude_counts.json" : "cloud_claude_qa.json");
writeFileSync(outFile, JSON.stringify({ generated_at: new Date().toISOString(), models: MODELS, results }, null, 1));

// Summary per model x mode
const g = {};
for (const r of results) {
  if (r.error || r.refusal) continue;
  const k = `${r.model}|${r.mode}`;
  g[k] ??= { model: r.model, mode: r.mode, n: 0, ok: 0, tok: 0, usd: 0 };
  g[k].n++;
  g[k].ok += r.correct ? 1 : 0;
  g[k].tok += r.claude_input_tokens ?? (r.usage ? r.usage.input_tokens + (r.usage.cache_creation_input_tokens ?? 0) + (r.usage.cache_read_input_tokens ?? 0) : 0);
  g[k].usd += r.usd ?? 0;
}
console.table(
  Object.values(g).map((s) => ({
    model: s.model,
    mode: s.mode,
    ...(flag("--run") ? { correct: `${s.ok}/${s.n}`, usd: s.usd.toFixed(4) } : {}),
    mean_input_tokens: Math.round(s.tok / s.n),
  }))
);
console.log(`saved ${path.relative(process.cwd(), outFile)}`);
