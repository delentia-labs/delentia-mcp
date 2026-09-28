/**
 * LLM answer-accuracy check on top of run.mjs's variants: does a real model still answer
 * correctly from the compressed context?
 *
 * Model: local Ollama (default qwen2.5:7b, temperature 0, fixed seed). Graded by each
 * question's `answer` regex (questions.json). Synthetic corpus is skipped.
 *
 * Resumable: already-answered (question, mode) pairs in results/qa.json are skipped.
 * Runs every question of a corpus in the same mode back-to-back so Ollama can reuse the
 * KV cache of the shared `full` context prefix (question is placed last in the prompt).
 *
 * Usage: node benchmarks/compression-real/qa_ollama.mjs [model]
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MODEL = process.argv[2] ?? "qwen2.5:7b";
const OLLAMA = process.env.OLLAMA_URL ?? "http://localhost:11434";
const MODES = ["full", "delta_aggressive", "v2_aggressive", "v2_outline", "tail_matched"];

const spec = JSON.parse(readFileSync(path.join(here, "questions.json"), "utf8"));
const answerRe = {};
for (const c of Object.values(spec.corpora)) for (const q of c.questions) answerRe[q.id] = new RegExp(q.answer, "is");

const { rows } = JSON.parse(readFileSync(path.join(here, "results", "variants.json"), "utf8"));
const outPath = path.join(here, "results", "qa.json");
const done = existsSync(outPath) ? JSON.parse(readFileSync(outPath, "utf8")) : { model: MODEL, results: [] };
const key = (r) => `${r.question_id}|${r.mode}`;
const have = new Set(done.results.map(key));

// node:http instead of fetch: undici's 300s headers timeout is shorter than a CPU-only
// prefill of a ~7.5k-token prompt.
function postJson(url, payload) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: "POST", headers: { "content-type": "application/json" }, timeout: 0 }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve(JSON.parse(data)));
    });
    req.on("error", reject);
    req.end(JSON.stringify(payload));
  });
}

const SYSTEM =
  "Answer the question using ONLY the provided context. If the context does not contain the answer, reply exactly: NOT FOUND. Reply in one short sentence.";

const todo = rows
  .filter((r) => r.corpus !== "synthetic" && MODES.includes(r.mode) && !have.has(key(r)))
  .sort((a, b) => a.corpus.localeCompare(b.corpus) || MODES.indexOf(a.mode) - MODES.indexOf(b.mode));

console.log(`${todo.length} (question, mode) pairs to run with ${MODEL}`);
for (const r of todo) {
  const t0 = Date.now();
  const j = await postJson(`${OLLAMA}/api/chat`, {
    model: MODEL,
    stream: false,
    options: { temperature: 0, seed: 42, num_ctx: 16384, num_predict: 80 },
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: `Context:\n${r.context}\n\nQuestion: ${r.question}` },
    ],
  });
  const reply = j.message?.content ?? `(error: ${JSON.stringify(j).slice(0, 200)})`;
  const entry = {
    corpus: r.corpus,
    question_id: r.question_id,
    paraphrase: r.paraphrase,
    mode: r.mode,
    context_tokens_o200k: r.tokens,
    prompt_tokens_model: j.prompt_eval_count ?? null,
    reply,
    correct: answerRe[r.question_id].test(reply) && !/NOT FOUND/i.test(reply),
    seconds: (Date.now() - t0) / 1000,
  };
  done.results.push(entry);
  writeFileSync(outPath, JSON.stringify(done, null, 1));
  console.log(`${entry.question_id.padEnd(8)} ${entry.mode.padEnd(17)} ${entry.correct ? "OK " : "BAD"} ${entry.seconds.toFixed(0)}s  ${reply.replace(/\s+/g, " ").slice(0, 90)}`);
}
