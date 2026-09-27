/**
 * Budget-capped cloud benchmark through OpenRouter: several model families, same contexts and
 * questions as the local run (results/variants.json), billed numbers from the provider.
 *
 * Modes per question:
 *   full         whole corpus
 *   full_cached  whole corpus as a cache-marked content part, questions of a corpus back-to-back
 *                (Anthropic/Gemini honour cache_control; OpenAI/DeepSeek cache repeated prefixes
 *                automatically) — the baseline compression has to beat
 *   v2           current compress_context aggressive output
 *   v2+expand    only for questions the model got wrong on v2: the model picks search terms,
 *                queryLines() (the function behind expand_context) fetches lines from the
 *                original, and the model answers again. Cost of both steps is counted.
 *
 * Safety/budget:
 *   - reads OPENROUTER_API_KEY from the environment only; never prints or stores it
 *   - dry run by default (prints the plan + estimated cost, sends nothing); --run to spend
 *   - stops as soon as the provider-reported spend reaches --budget (default $1.30)
 *
 * Usage:
 *   node benchmarks/compression-real/cloud_openrouter.mjs            # dry run
 *   node benchmarks/compression-real/cloud_openrouter.mjs --run      # real run, capped
 *   ... --models anthropic/claude-haiku-4.5,deepseek/deepseek-v4-flash --budget 0.5
 *   ... --models qwen/qwen3.7-flash --redo   # discard that model's earlier results and run it again
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { queryLines } from "../../packages/shared/dist/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (f, d) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : d);
const RUN = argv.includes("--run");
const REDO = argv.includes("--redo");
// full | full_cached | v2 | v2_outline (v2 + outline of left-out headings with line numbers)
const RUN_MODES = opt("--modes", "full,full_cached,v2,v2_outline").split(",");
const BUDGET = Number(opt("--budget", "1.30"));
const MODELS = opt(
  "--models",
  "deepseek/deepseek-v4-flash,qwen/qwen3.7-flash,google/gemini-3.1-flash-lite,openai/gpt-5-mini,anthropic/claude-haiku-4.5"
).split(",");
const OUT = path.join(here, "results", "cloud_openrouter.json");

const SYSTEM =
  "Answer the question using ONLY the provided context. If the context does not contain the answer, reply exactly: NOT FOUND. Reply in one short sentence.";
const SEARCH_SYSTEM =
  "You are given a COMPRESSED excerpt of a longer document. The full document can be searched. Reply ONLY with 2-5 search terms (space-separated) most likely to find lines that answer the question. No other text.";
const SEARCH_SYSTEM_OUTLINE =
  "You are given a COMPRESSED excerpt of a longer document, ending with an outline of left-out sections and their line numbers. Reply ONLY with either a line range from that outline such as L120-L140 (preferred when a listed section looks relevant), or 2-5 search terms (space-separated). No other text.";

const spec = JSON.parse(readFileSync(path.join(here, "questions.json"), "utf8"));
const Q = {};
for (const [corpusId, c] of Object.entries(spec.corpora)) for (const q of c.questions) Q[q.id] = { ...q, corpusId, file: c.file };
const { rows } = JSON.parse(readFileSync(path.join(here, "results", "variants.json"), "utf8"));
const real = rows.filter((r) => r.corpus !== "synthetic");
const ctx = (qid, mode) => real.find((r) => r.question_id === qid && r.mode === mode);
const qids = [...new Set(real.map((r) => r.question_id))].sort((a, b) => Q[a].corpusId.localeCompare(Q[b].corpusId));

// ---------- pricing (public endpoint, no key needed) ----------
const catalog = await (await fetch("https://openrouter.ai/api/v1/models")).json();
const price = {};
for (const m of catalog.data) price[m.id] = { in: +m.pricing.prompt, out: +m.pricing.completion };
for (const m of MODELS) if (!price[m]) throw new Error(`unknown OpenRouter model ${m}`);

// Estimate: o200k tokens x1.3 (other tokenizers count more), ~150 output tokens per call
// (reasoning models more), cached mode priced as uncached (upper bound).
let estimate = 0;
for (const m of MODELS) {
  const outPer = 800; // many "flash" models reason before answering
  const source = { full: "full", full_cached: "full", v2: "v2_aggressive", v2_outline: "v2_outline" };
  for (const id of qids) {
    for (const mode of RUN_MODES) {
      estimate += (ctx(id, source[mode]).tokens * 1.3 + 60) * price[m].in + outPer * price[m].out;
    }
  }
}
console.log(`${MODELS.length} models x ${qids.length} questions x ${RUN_MODES.length} modes [${RUN_MODES.join(", ")}] (+ expand step on compressed misses).`);
console.log(`Estimated upper-bound cost: $${estimate.toFixed(2)} (budget cap $${BUDGET.toFixed(2)}).`);
await main();

async function main() {
if (!RUN) {
  console.log("Dry run: nothing sent. Add --run to execute (requires OPENROUTER_API_KEY in the environment).");
  return;
}
const KEY = (process.env.OPENROUTER_API_KEY ?? "").trim();
if (!KEY) {
  console.error("OPENROUTER_API_KEY is not set in this shell. Set it yourself, then rerun. Nothing was sent.");
  process.exitCode = 1;
  return;
}
if (!/^sk-or-v1-[0-9a-f]{64}$/.test(KEY)) {
  console.error(
    "OPENROUTER_API_KEY does not look like an OpenRouter key (expected sk-or-v1- followed by 64 hex characters, " +
      "no quotes or <> inside the value). Nothing was sent."
  );
  process.exitCode = 1;
  return;
}

let spent = 0;
async function chat(model, messages) {
  // Many current "flash" models reason before answering; a small max_tokens is spent on hidden
  // reasoning and the visible answer comes back empty (first run: qwen3.7-flash 82/96 empty,
  // deepseek-v4-flash cut off at 300). Output is billed per token generated, not per cap.
  const body = { model, messages, temperature: 0, max_tokens: 4000, reasoning: { effort: "low" }, usage: { include: true } };
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", "X-Title": "delentia-compression-benchmark" },
      body: JSON.stringify(body),
    });
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    const j = await res.json();
    if (res.status === 401 || res.status === 402 || res.status === 403) {
      // Wrong key, no credit, or forbidden: every later call would fail the same way.
      throw Object.assign(new Error(`${res.status} ${JSON.stringify(j.error ?? j).slice(0, 200)}`), { fatal: true });
    }
    if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(j.error ?? j).slice(0, 200)}`);
    const u = j.usage ?? {};
    spent += u.cost ?? 0;
    return {
      text: j.choices?.[0]?.message?.content ?? "",
      truncated: j.choices?.[0]?.finish_reason === "length",
      prompt_tokens: u.prompt_tokens ?? 0,
      cached_tokens: u.prompt_tokens_details?.cached_tokens ?? 0,
      completion_tokens: u.completion_tokens ?? 0,
      cost: u.cost ?? 0,
    };
  }
  throw new Error("retries exhausted");
}
const grade = (qid, text) => new RegExp(Q[qid].answer, "is").test(text) && !/NOT FOUND/i.test(text);

// Resume: keep successful results only, so failed calls (e.g. a run with a bad key) are retried.
const results = existsSync(OUT)
  ? JSON.parse(readFileSync(OUT, "utf8")).results.filter((r) => !r.error && !(REDO && MODELS.includes(r.model)))
  : [];
const done = new Set(results.map((r) => `${r.model}|${r.question_id}|${r.mode}`));
const save = () => writeFileSync(OUT, JSON.stringify({ generated_at: new Date().toISOString(), models: MODELS, results }, null, 1));

outer: for (const model of MODELS) {
  for (const mode of RUN_MODES) {
    for (const id of qids) {
      if (done.has(`${model}|${id}|${mode}`)) continue;
      if (spent >= BUDGET) break outer;
      const q = Q[id];
      const c = mode === "v2" ? ctx(id, "v2_aggressive").context : mode === "v2_outline" ? ctx(id, "v2_outline").context : ctx(id, "full").context;
      const user =
        // Explicit cache_control only where the provider needs it (Anthropic, Gemini). Others
        // (OpenAI, DeepSeek, Qwen...) cache repeated prefixes automatically, and the content-part
        // form broke that on Qwen (first rerun: 0 cached tokens, 236% of full). For them
        // full_cached is the same request as full.
        mode === "full_cached" && /^(anthropic|google)\//.test(model)
          ? [
              { type: "text", text: `Context:\n${c}`, cache_control: { type: "ephemeral" } },
              { type: "text", text: `Question: ${q.q}` },
            ]
          : `Context:\n${c}\n\nQuestion: ${q.q}`;
      try {
        const r = await chat(model, [{ role: "system", content: SYSTEM }, { role: "user", content: user }]);
        const entry = { model, question_id: id, corpus: q.corpusId, paraphrase: Boolean(q.paraphrase), mode, correct: grade(id, r.text), reply: r.text.slice(0, 300), ...r };
        results.push(entry);

        if ((mode === "v2" || mode === "v2_outline") && !entry.correct && spent < BUDGET) {
          const system = mode === "v2_outline" ? SEARCH_SYSTEM_OUTLINE : SEARCH_SYSTEM;
          const s1 = await chat(model, [{ role: "system", content: system }, { role: "user", content: `Compressed excerpt:\n${c}\n\nQuestion: ${q.q}` }]);
          const range = mode === "v2_outline" ? s1.text.match(/L?(\d+)\s*[-–]\s*L?(\d+)/) : null;
          const terms = range ? `lines ${range[1]}-${range[2]}` : s1.text.replace(/[^\p{L}\p{N}@./_ -]+/gu, " ").trim();
          const original = readFileSync(path.join(here, q.file), "utf8");
          const found = range
            ? queryLines(original, { start_line: Number(range[1]), end_line: Math.min(Number(range[2]), Number(range[1]) + 40) })
            : queryLines(original, { pattern: terms, context_lines: 1, max_lines: 40 });
          const retrieved = found.lines.map((l) => `${l.n}: ${l.text}`).join("\n");
          const s2 = await chat(model, [
            { role: "system", content: SYSTEM },
            { role: "user", content: `Context:\n${c}\n\nLines retrieved from the full document:\n${retrieved}\n\nQuestion: ${q.q}` },
          ]);
          results.push({
            model, question_id: id, corpus: q.corpusId, paraphrase: Boolean(q.paraphrase), mode: `${mode}+expand`,
            correct: grade(id, s2.text), reply: s2.text.slice(0, 300), search_terms: terms,
            evidence_retrieved: new RegExp(q.evidence).test(retrieved),
            prompt_tokens: r.prompt_tokens + s1.prompt_tokens + s2.prompt_tokens,
            cached_tokens: r.cached_tokens + s1.cached_tokens + s2.cached_tokens,
            completion_tokens: r.completion_tokens + s1.completion_tokens + s2.completion_tokens,
            cost: r.cost + s1.cost + s2.cost,
          });
        }
        process.stdout.write(`\r${model.padEnd(34)} ${mode.padEnd(11)} ${id.padEnd(8)} spent $${spent.toFixed(4)}   `);
      } catch (err) {
        if (err.fatal) {
          console.log(`
Stopping: ${String(err.message).slice(0, 160)}`);
          save();
          break outer;
        }
        results.push({ model, question_id: id, mode, error: String(err.message ?? err).slice(0, 200) });
        console.log(`\n${model} ${mode} ${id}: ${String(err.message ?? err).slice(0, 160)}`);
      }
      save();
    }
  }
}
save();
console.log(`\n\nTotal provider-reported spend: $${spent.toFixed(4)}${spent >= BUDGET ? " (budget cap reached; rerun with a higher --budget to resume)" : ""}`);

// ---------- summary ----------
const table = [];
for (const model of MODELS) {
  const byMode = (m) => results.filter((r) => r.model === model && r.mode === m && !r.error);
  const full = byMode("full"), cached = byMode("full_cached"), v2 = byMode("v2"), v2o = byMode("v2_outline");
  const expandById = Object.fromEntries(byMode("v2+expand").map((r) => [r.question_id, r]));
  const expandOById = Object.fromEntries(byMode("v2_outline+expand").map((r) => [r.question_id, r]));
  const v2ox = v2o.map((r) => expandOById[r.question_id] ?? r);
  // "v2 with expand": v2 answer, replaced by the expand attempt where one was made.
  const v2x = v2.map((r) => expandById[r.question_id] ?? r);
  const sum = (a, k) => a.reduce((s, r) => s + (r[k] ?? 0), 0);
  for (const [label, set] of [["full", full], ["full_cached", cached], ["v2", v2], ["v2 + expand on miss", v2x], ["v2_outline", v2o], ["v2_outline + expand", v2ox]]) {
    if (!set.length) continue;
    table.push({
      model, mode: label,
      correct_literal: `${set.filter((r) => !r.paraphrase && r.correct).length}/${set.filter((r) => !r.paraphrase).length}`,
      correct_paraphrased: `${set.filter((r) => r.paraphrase && r.correct).length}/${set.filter((r) => r.paraphrase).length}`,
      prompt_tokens: sum(set, "prompt_tokens"),
      cached_tokens: sum(set, "cached_tokens"),
      usd: sum(set, "cost").toFixed(5),
      usd_vs_full: full.length ? `${Math.round((sum(set, "cost") / sum(full, "cost")) * 100)}%` : "-",
      truncated: set.filter((r) => r.truncated).length,
    });
  }
}
console.table(table);
}
