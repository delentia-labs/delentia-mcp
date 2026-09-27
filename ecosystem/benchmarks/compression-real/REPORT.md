# Context-compression benchmark (real data, reproducible)

Generated 2026-09-27T03:56:33.587Z by `benchmarks/compression-real/report.mjs`. Tokenizer: tiktoken o200k_base.

## What is measured

- **Corpora** (all in `corpora/` except the synthetic one):
  - `code` — TypeScript source (packages/intent-loop/src/index.ts snapshot)
  - `log` — Real build + test log (npm run build && npm run test:all output, this repo)
  - `docs` — Project README (Thai/English mixed Markdown snapshot)
  - `synthetic` — SYNTHETIC best case: the pre-existing tests/benchmark_delta_vs.mjs haystack (10 repeating log lines + 5 needles). Included only to show where the old 99% figure came from.
- **Questions**: 26 total, each answerable from the full corpus. *Literal* questions reuse words from the answer line; *paraphrased* ones deliberately don't (see `questions.json`).
- **Token reduction**: real token counts of each context vs. the full corpus.
- **Evidence retained**: does the line needed to answer survive compression? (deterministic regex, no model involved)
- **LLM accuracy** (if run): a local model answers from each context, graded by regex.

## 1. Token reduction vs. evidence retained

| Data | Mode | Mean token reduction | Evidence retained |
|---|---|---:|---:|
| real, literal | full context (baseline) | 0.0% | 16/16 (100%) |
| real, literal | v1 dedup only (no intent_focus) | 9.9% | 16/16 (100%) |
| real, literal | v1 default (intent_focus, aggressive=false) | 9.7% | 16/16 (100%) |
| real, literal | v1 aggressive (intent_focus, aggressive=true) | 73.3% | 16/16 (100%) |
| real, literal | v2 dedup only | 6.2% | 16/16 (100%) |
| real, literal | v2 aggressive | 69.5% | 16/16 (100%) |
| real, literal | naive tail, same token budget as v1 aggressive | 73.7% | 4/16 (25%) |
| real, paraphrased | full context (baseline) | 0.0% | 8/8 (100%) |
| real, paraphrased | v1 dedup only (no intent_focus) | 10.5% | 8/8 (100%) |
| real, paraphrased | v1 default (intent_focus, aggressive=false) | 10.2% | 8/8 (100%) |
| real, paraphrased | v1 aggressive (intent_focus, aggressive=true) | 74.4% | 3/8 (37.5%) |
| real, paraphrased | v2 dedup only | 7.0% | 8/8 (100%) |
| real, paraphrased | v2 aggressive | 73.4% | 5/8 (62.5%) |
| real, paraphrased | naive tail, same token budget as v1 aggressive | 74.8% | 2/8 (25%) |
| synthetic | full context (baseline) | 0.0% | 2/2 (100%) |
| synthetic | v1 dedup only (no intent_focus) | 99.2% | 2/2 (100%) |
| synthetic | v1 default (intent_focus, aggressive=false) | 99.2% | 2/2 (100%) |
| synthetic | v1 aggressive (intent_focus, aggressive=true) | 99.8% | 2/2 (100%) |
| synthetic | v2 dedup only | 99.2% | 2/2 (100%) |
| synthetic | v2 aggressive | 99.8% | 2/2 (100%) |
| synthetic | naive tail, same token budget as v1 aggressive | 99.8% | 0/2 (0%) |

### Per corpus (literal + paraphrased)

| Corpus | Full tokens | v1 default | v1 aggressive | v2 aggressive | v1 aggr. evidence kept | v2 aggr. evidence kept |
|---|---:|---:|---:|---:|---:|---:|
| code | 7,500 | 12.4% | 71.4% | 74.6% | 8/10 | 10/10 |
| log | 6,979 | 6.8% | 71.9% | 74.7% | 6/7 | 6/7 |
| docs | 2,203 | 9.3% | 78.6% | 61.5% | 5/7 | 5/7 |
| synthetic | 61,122 | 99.2% | 99.8% | 99.8% | 2/2 | 2/2 |

### Does compressed code still parse? (TypeScript syntax errors, code corpus)

| Mode | Mean syntax errors |
|---|---:|
| full context (baseline) | 0 |
| v1 dedup only (no intent_focus) | 438 |
| v1 default (intent_focus, aggressive=false) | 438 |
| v1 aggressive (intent_focus, aggressive=true) | 260 |
| v2 dedup only | 7 |
| v2 aggressive | 167 |
| naive tail, same token budget as v1 aggressive | 10 |

## 2. LLM answer accuracy (qwen2.5:7b, local Ollama, temperature 0)

96 answered (question, mode) pairs.

| Data | Mode | Correct | Mean prompt tokens (model tokenizer) |
|---|---|---:|---:|
| real, literal | full context (baseline) | 16/16 (100%) | 5,996 |
| real, literal | v1 aggressive (intent_focus, aggressive=true) | 16/16 (100%) | 1,703 |
| real, literal | v2 aggressive | 16/16 (100%) | 1,707 |
| real, literal | naive tail, same token budget as v1 aggressive | 3/16 (18.8%) | 1,664 |
| real, paraphrased | full context (baseline) | 7/8 (87.5%) | 6,325 |
| real, paraphrased | v1 aggressive (intent_focus, aggressive=true) | 3/8 (37.5%) | 1,818 |
| real, paraphrased | v2 aggressive | 4/8 (50%) | 1,680 |
| real, paraphrased | naive tail, same token budget as v1 aggressive | 2/8 (25%) | 1,776 |

Raw replies: `results/qa.json`.

## Reproduce

```bash
npm run build
pip install tiktoken
npm run bench:compression        # section 1
npm run bench:compression:qa     # section 2 (local Ollama, slow on CPU)
node benchmarks/compression-real/report.mjs
```
