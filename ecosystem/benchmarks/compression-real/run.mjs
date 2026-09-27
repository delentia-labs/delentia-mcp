/**
 * Real, reproducible benchmark of `compress_context` (packages/delta).
 *
 * Measures, per (corpus, question, mode):
 *   - real token counts with a standard BPE tokenizer (tiktoken o200k_base, via count_tokens.py)
 *   - whether the evidence needed to answer the question survives compression (deterministic)
 *   - for the code corpus: whether the compressed text still parses as TypeScript
 *
 * Modes:
 *   full              the whole corpus, untouched (baseline)
 *   delta_dedup       compressContext() with no intent_focus (dedup only)
 *   delta_default     compressContext() with intent_focus = the question (aggressive_mode=false, the tool default)
 *   delta_aggressive  compressContext() with intent_focus = the question, aggressive_mode=true
 *   (delta_* modes use the frozen v1 logic in delta_v1_reference.mjs)
 *   v2_dedup / v2_aggressive  the current packages/delta compressContext (v2), same inputs
 *   tail_matched      naive baseline: the LAST lines of the corpus, cut to the same token budget as delta_aggressive
 *
 * Usage: node benchmarks/compression-real/run.mjs   (after `npm run build`)
 * Output: benchmarks/compression-real/results/variants.json
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { compressContext } from "../../packages/delta/dist/index.js";
import { compressContextV1 } from "./delta_v1_reference.mjs";
import { generateVerboseEnterpriseHaystack } from "../../tests/benchmark_delta_vs.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(readFileSync(path.join(here, "questions.json"), "utf8"));

function countTokens(texts) {
  const r = spawnSync("python", [path.join(here, "count_tokens.py")], {
    input: JSON.stringify(texts),
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`count_tokens.py failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

function tsSyntaxErrors(text) {
  const sf = ts.createSourceFile("x.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return sf.parseDiagnostics.length;
}

/** Keep whole lines from the end of `text` until the token budget is reached. */
function tailToBudget(text, budget) {
  const lines = text.split("\n");
  const kept = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const candidate = [lines[i], ...kept].join("\n");
    if (countTokensCached(candidate) > budget) break;
    kept.unshift(lines[i]);
  }
  return kept.join("\n");
}
// tail search needs many counts; approximate per-candidate with a char ratio calibrated on the corpus,
// then the final chosen text is re-counted exactly below.
let charsPerToken = 3.5;
function countTokensCached(t) { return Math.ceil(t.length / charsPerToken); }

const rows = [];
for (const [corpusId, corpus] of Object.entries(spec.corpora)) {
  const raw = corpus.file.startsWith("@generated")
    ? generateVerboseEnterpriseHaystack().rawContext
    : readFileSync(path.join(here, corpus.file), "utf8");
  const [rawTokens] = countTokens([raw]);
  charsPerToken = raw.length / rawTokens;

  for (const q of corpus.questions) {
    const variants = {
      full: raw,
      delta_dedup: compressContextV1({ raw_context: raw, aggressive_mode: false }).compressed_delta_text,
      delta_default: compressContextV1({ raw_context: raw, intent_focus: q.q, aggressive_mode: false }).compressed_delta_text,
      delta_aggressive: compressContextV1({ raw_context: raw, intent_focus: q.q, aggressive_mode: true }).compressed_delta_text,
    };
    variants.v2_dedup = compressContext({ raw_context: raw, aggressive_mode: false }).compressed_delta_text;
    variants.v2_aggressive = compressContext({ raw_context: raw, intent_focus: q.q, aggressive_mode: true }).compressed_delta_text;
    const [aggTokens] = countTokens([variants.delta_aggressive]);
    variants.tail_matched = tailToBudget(raw, aggTokens);

    const names = Object.keys(variants);
    const tokens = countTokens(names.map((n) => variants[n]));
    const evidence = new RegExp(q.evidence);
    names.forEach((mode, i) => {
      rows.push({
        corpus: corpusId,
        question_id: q.id,
        question: q.q,
        paraphrase: Boolean(q.paraphrase),
        mode,
        tokens: tokens[i],
        full_tokens: rawTokens,
        reduction_pct: Math.round((1 - tokens[i] / rawTokens) * 1000) / 10,
        evidence_retained: evidence.test(variants[mode]),
        ts_syntax_errors: corpusId === "code" ? tsSyntaxErrors(mode === "full" ? raw : variants[mode].replace(/^\[DELENTIA-DELTA-STREAM\][^\n]*\n/, "")) : null,
        context: variants[mode],
      });
    });
  }
}

mkdirSync(path.join(here, "results"), { recursive: true });
writeFileSync(path.join(here, "results", "variants.json"), JSON.stringify({ generated_at: new Date().toISOString(), tokenizer: "tiktoken o200k_base", rows }, null, 1));

// Console summary: mean reduction and retention per corpus x mode
const summary = {};
for (const r of rows) {
  const k = `${r.corpus}|${r.mode}`;
  summary[k] ??= { corpus: r.corpus, mode: r.mode, n: 0, red: 0, kept: 0, tsErr: 0 };
  summary[k].n++; summary[k].red += r.reduction_pct; summary[k].kept += r.evidence_retained ? 1 : 0; summary[k].tsErr += r.ts_syntax_errors ?? 0;
}
console.table(Object.values(summary).map((s) => ({
  corpus: s.corpus, mode: s.mode,
  mean_token_reduction_pct: Math.round((s.red / s.n) * 10) / 10,
  evidence_retained: `${s.kept}/${s.n}`,
  mean_ts_syntax_errors: s.corpus === "code" ? Math.round(s.tsErr / s.n) : "-",
})));
