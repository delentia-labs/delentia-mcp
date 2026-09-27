/**
 * Builds REPORT.md from results/variants.json (+ results/qa.json if present).
 * Every number in the report is computed here from those files — nothing is typed in by hand.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const v = JSON.parse(readFileSync(path.join(here, "results", "variants.json"), "utf8"));
const qaPath = path.join(here, "results", "qa.json");
const qa = existsSync(qaPath) ? JSON.parse(readFileSync(qaPath, "utf8")) : null;
const spec = JSON.parse(readFileSync(path.join(here, "questions.json"), "utf8"));

const MODES = ["full", "delta_dedup", "delta_default", "delta_aggressive", "v2_dedup", "v2_aggressive", "v2_outline", "tail_matched"];
const MODE_LABEL = {
  full: "full context (baseline)",
  delta_dedup: "v1 dedup only (no intent_focus)",
  delta_default: "v1 default (intent_focus, aggressive=false)",
  delta_aggressive: "v1 aggressive (intent_focus, aggressive=true)",
  v2_dedup: "v2 dedup only",
  v2_aggressive: "v2 aggressive",
  v2_outline: "v2 aggressive + omitted-sections outline",
  tail_matched: "naive tail, same token budget as v1 aggressive",
};
const group = (r) => (r.corpus === "synthetic" ? "synthetic" : r.paraphrase ? "real, paraphrased" : "real, literal");
const pct = (a, b) => (b ? `${Math.round((a / b) * 1000) / 10}%` : "-");

function agg(rows, keyFn) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

let out = `# Context-compression benchmark (real data, reproducible)

Generated ${v.generated_at} by \`benchmarks/compression-real/report.mjs\`. Tokenizer: ${v.tokenizer}.

## What is measured

- **Corpora** (all in \`corpora/\` except the synthetic one):
${Object.entries(spec.corpora).map(([id, c]) => `  - \`${id}\` — ${c.kind}`).join("\n")}
- **Questions**: ${Object.values(spec.corpora).reduce((n, c) => n + c.questions.length, 0)} total, each answerable from the full corpus. *Literal* questions reuse words from the answer line; *paraphrased* ones deliberately don't (see \`questions.json\`).
- **Token reduction**: real token counts of each context vs. the full corpus.
- **Evidence retained**: does the line needed to answer survive compression? (deterministic regex, no model involved)
- **LLM accuracy** (if run): a local model answers from each context, graded by regex.

## 1. Token reduction vs. evidence retained

| Data | Mode | Mean token reduction | Evidence retained |
|---|---|---:|---:|
`;
for (const [g, rows] of agg(v.rows, group)) {
  for (const mode of MODES) {
    const rs = rows.filter((r) => r.mode === mode);
    if (!rs.length) continue;
    const red = rs.reduce((s, r) => s + r.reduction_pct, 0) / rs.length;
    const kept = rs.filter((r) => r.evidence_retained).length;
    out += `| ${g} | ${MODE_LABEL[mode]} | ${red.toFixed(1)}% | ${kept}/${rs.length} (${pct(kept, rs.length)}) |\n`;
  }
}

out += `\n### Per corpus (literal + paraphrased)\n\n| Corpus | Full tokens | v1 default | v1 aggressive | v2 aggressive | v1 aggr. evidence kept | v2 aggr. evidence kept |\n|---|---:|---:|---:|---:|---:|---:|\n`;
for (const [corpus, rows] of agg(v.rows, (r) => r.corpus)) {
  const m = (mode) => rows.filter((r) => r.mode === mode);
  const meanRed = (mode) => (m(mode).reduce((s, r) => s + r.reduction_pct, 0) / m(mode).length).toFixed(1) + "%";
  const kept = (mode) => `${m(mode).filter((r) => r.evidence_retained).length}/${m(mode).length}`;
  out += `| ${corpus} | ${rows[0].full_tokens.toLocaleString("en-US")} | ${meanRed("delta_default")} | ${meanRed("delta_aggressive")} | ${meanRed("v2_aggressive")} | ${kept("delta_aggressive")} | ${kept("v2_aggressive")} |\n`;
}

const code = v.rows.filter((r) => r.corpus === "code");
if (code.length) {
  out += `\n### Does compressed code still parse? (TypeScript syntax errors, code corpus)\n\n| Mode | Mean syntax errors |\n|---|---:|\n`;
  for (const mode of MODES) {
    const rs = code.filter((r) => r.mode === mode);
    if (rs.length) out += `| ${MODE_LABEL[mode]} | ${Math.round(rs.reduce((s, r) => s + r.ts_syntax_errors, 0) / rs.length)} |\n`;
  }
}

if (qa && qa.results.length) {
  out += `\n## 2. LLM answer accuracy (${qa.model}, local Ollama, temperature 0)\n\n${qa.results.length} answered (question, mode) pairs.\n\n| Data | Mode | Correct | Mean prompt tokens (model tokenizer) |\n|---|---|---:|---:|\n`;
  for (const [g, rows] of agg(qa.results, (r) => (r.paraphrase ? "real, paraphrased" : "real, literal"))) {
    for (const mode of MODES) {
      const rs = rows.filter((r) => r.mode === mode);
      if (!rs.length) continue;
      const ok = rs.filter((r) => r.correct).length;
      const tok = rs.filter((r) => r.prompt_tokens_model).map((r) => r.prompt_tokens_model);
      out += `| ${g} | ${MODE_LABEL[mode]} | ${ok}/${rs.length} (${pct(ok, rs.length)}) | ${tok.length ? Math.round(tok.reduce((a, b) => a + b, 0) / tok.length).toLocaleString("en-US") : "-"} |\n`;
    }
  }
  out += `\nRaw replies: \`results/qa.json\`.\n`;
} else {
  out += `\n## 2. LLM answer accuracy\n\nNot run yet — \`npm run bench:compression:qa\` (needs a local Ollama).\n`;
}

out += `\n## Reproduce\n\n\`\`\`bash\nnpm run build\npip install tiktoken\nnpm run bench:compression        # section 1\nnpm run bench:compression:qa     # section 2 (local Ollama, slow on CPU)\nnode benchmarks/compression-real/report.mjs\n\`\`\`\n`;

writeFileSync(path.join(here, "REPORT.md"), out);
console.log("wrote REPORT.md");
