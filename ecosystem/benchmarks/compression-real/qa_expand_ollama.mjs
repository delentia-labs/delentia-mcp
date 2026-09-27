/**
 * Does "compress + expand_context" recover answers that v2 aggressive compression lost?
 *
 * For every question where the v2_aggressive answer in results/qa.json was wrong, a real model
 * (local Ollama) gets a second step that mirrors how an agent would use expand_context:
 *   1. it sees the compressed text and is told the full original is searchable, and replies with
 *      2-5 search terms of its own choosing (it never sees the evidence regex),
 *   2. queryLines() (the exact function behind expand_context) runs those terms on the original,
 *   3. the model answers from compressed text + retrieved lines.
 * Token cost of the extra step is counted with the same tokenizer as the rest of the benchmark.
 *
 * Usage: node benchmarks/compression-real/qa_expand_ollama.mjs [model]  -> results/qa_expand.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { queryLines } from "../../packages/shared/dist/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const MODEL = process.argv[2] ?? "qwen2.5:7b";
const spec = JSON.parse(readFileSync(path.join(here, "questions.json"), "utf8"));
const qa = JSON.parse(readFileSync(path.join(here, "results", "qa.json"), "utf8")).results;
const { rows } = JSON.parse(readFileSync(path.join(here, "results", "variants.json"), "utf8"));

const questions = {};
for (const [corpusId, c] of Object.entries(spec.corpora)) for (const q of c.questions) questions[q.id] = { ...q, corpusId, file: c.file };

function chat(messages) {
  return new Promise((resolve, reject) => {
    const req = http.request("http://localhost:11434/api/chat", { method: "POST", headers: { "content-type": "application/json" }, timeout: 0 }, (res) => {
      let d = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve(JSON.parse(d)));
    });
    req.on("error", reject);
    req.end(JSON.stringify({ model: MODEL, stream: false, options: { temperature: 0, seed: 42, num_ctx: 16384, num_predict: 80 }, messages }));
  });
}
const countTokens = (texts) =>
  JSON.parse(spawnSync("python", [path.join(here, "count_tokens.py")], { input: JSON.stringify(texts), encoding: "utf8" }).stdout);

const failed = qa.filter((r) => r.mode === "v2_aggressive" && !r.correct);
console.log(`${failed.length} v2_aggressive answers were wrong; running the expand step for each`);
const out = [];
for (const f of failed) {
  const q = questions[f.question_id];
  const compressed = rows.find((r) => r.question_id === f.question_id && r.mode === "v2_aggressive").context;
  const original = readFileSync(path.join(here, q.file), "utf8");

  const step1 = await chat([
    { role: "system", content: "You are given a COMPRESSED excerpt of a longer document. The full document can be searched. Reply ONLY with 2-5 search terms (space-separated) most likely to find lines that answer the question. No other text." },
    { role: "user", content: `Compressed excerpt:\n${compressed}\n\nQuestion: ${q.q}` },
  ]);
  const terms = (step1.message?.content ?? "").replace(/[^\p{L}\p{N}@./_ -]+/gu, " ").trim();
  const found = queryLines(original, { pattern: terms, context_lines: 1, max_lines: 40 });
  const retrieved = found.lines.map((l) => `${l.n}: ${l.text}`).join("\n");

  const step2 = await chat([
    { role: "system", content: "Answer the question using ONLY the provided context. If the context does not contain the answer, reply exactly: NOT FOUND. Reply in one short sentence." },
    { role: "user", content: `Context:\n${compressed}\n\nLines retrieved from the full document:\n${retrieved}\n\nQuestion: ${q.q}` },
  ]);
  const reply = step2.message?.content ?? "";
  const [compTok, retrTok, fullTok] = countTokens([compressed, retrieved, original]);
  const entry = {
    question_id: f.question_id,
    search_terms: terms,
    lines_retrieved: found.lines.length,
    evidence_retrieved: new RegExp(q.evidence).test(retrieved),
    reply,
    correct: new RegExp(q.answer, "is").test(reply) && !/NOT FOUND/i.test(reply),
    tokens_compressed: compTok,
    tokens_retrieved: retrTok,
    tokens_full: fullTok,
    total_vs_full_pct: Math.round(((compTok + retrTok) / fullTok) * 1000) / 10,
  };
  out.push(entry);
  console.log(`${entry.question_id.padEnd(8)} terms="${terms}" lines=${entry.lines_retrieved} evidence=${entry.evidence_retrieved} ${entry.correct ? "OK " : "BAD"} tokens ${entry.total_vs_full_pct}% of full  ${reply.replace(/\s+/g, " ").slice(0, 70)}`);
}
writeFileSync(path.join(here, "results", "qa_expand.json"), JSON.stringify({ model: MODEL, results: out }, null, 1));
