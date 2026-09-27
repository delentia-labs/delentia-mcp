# Real-data benchmark: `compress_context`, prompt caching and the Intent Loop

Everything here is reproducible from this folder. Numbers are in [REPORT.md](REPORT.md) (generated, not hand-typed).

## Findings (2026-09-27)

**Compression on real data (code, build/test log, README; tiktoken o200k):**

| Mode | Token reduction | Answer line kept | Local LLM answered correctly (qwen2.5:7b) |
|---|---:|---:|---:|
| full context | 0% | 100% | literal 16/16, paraphrased 7/8 |
| default (dedup only) | ~6–12% | 100% | – |
| aggressive v1 | ~73% | literal 100%, paraphrased 37.5% | literal 16/16, paraphrased 3/8 |
| **aggressive v2 (current)** | ~70–73% | literal 100%, paraphrased 62.5% | literal 16/16, paraphrased 4/8 |
| naive tail, same budget | ~74% | ~25% | literal 3/16, paraphrased 2/8 |
| synthetic haystack (source of the old "99%") | 99.8% | 100% | – |

- Aggressive filtering is far better than truncation at the same budget, and loses nothing when the
  question uses the source's own words. It **does** lose answers for paraphrased questions: put exact
  identifiers/terms in `intent_focus`.
- The published "91.5%–99.4%" figure only holds for highly repetitive synthetic input.

**Compress + retrieve (`retain_original` + `expand_context`, `qa_expand_ollama.mjs`):** for the 4
questions v2 aggressive got wrong, the local model chose its own search terms and `expand_context`'s
line search ran them on the retained original. The answer line was retrieved for 3/4, but qwen2.5:7b
then answered correctly for only 1/4 (twice it replied NOT FOUND with the answer line in front of it),
at 35–52% of the full-context tokens. Paraphrased accuracy: 4/8 → 5/8 (full context: 7/8). Retrieval
works; turning it into correct answers needs a stronger model than 7B — which is what a cloud run measures.

**Prompt caching vs. compression** (`caching_vs_compression_sim.mjs`, Claude Sonnet 5 list prices):

| Workload | Winner |
|---|---|
| Many questions about the same document within the cache TTL | prompt caching (−69%, lossless) |
| One-shot fresh log / tool output | compression (−62%; caching costs +24%) |
| Same document, requests spread beyond the TTL | compression (−49%; caching costs +22%) |
| Agent loop, 20 turns of 3k-token tool outputs | **both**: compress each tool output once at ingestion, then cache the append-only history: −87% vs −76% caching alone, context 29.8k vs 73.6k tokens |

Compressing *per question* changes the prompt prefix every time and defeats caching; compress **once, at
ingestion**, so the history stays append-only.

**Intent Loop token cost** (`intent_loop_cost_model.mjs`, real prompts from `packages/intent-loop`):
today each cache miss costs 1 specialist + 3 verifier calls and no context is forwarded, so the loop
uses *more* tokens than a single call unless ~70–83% of requests are cache hits (with paid verifiers).
Forwarding Delta-compressed context in the planned loop brings a context-heavy step to roughly −41% to −67%.

## Cloud run via OpenRouter (2026-09-27, $0.45 spent)

Same 24 real-data questions (16 literal, 8 paraphrased), four modes, provider-billed cost
(`cloud_openrouter.mjs`, raw data in `results/cloud_openrouter.json`). Questions about each document
were asked back-to-back, which is the **best case for prompt caching** (workload W1/W2 above).

| Model | Mode | Literal | Paraphrased | Cost vs full |
|---|---|---:|---:|---:|
| Claude Haiku 4.5 | full | 16/16 | 8/8 | 100% ($0.182) |
| | full + prompt caching | 16/16 | 6/8 | 35% |
| | Delta v2 | 16/16 | 5/8 | **29%** |
| | v2 + expand on miss | 16/16 | 5/8 | 36% |
| Gemini 3.1 Flash-Lite | full | 16/16 | 7/8 | 100% ($0.040) |
| | full + prompt caching | 16/16 | 7/8 | 37% |
| | Delta v2 | 16/16 | 5/8 | **29%** |
| | v2 + expand on miss | 16/16 | 5/8 | 35% |
| GPT-5 mini | full | 16/16 | 8/8 | 100% ($0.013) |
| | full + prompt caching | 16/16 | 8/8 | 75% |
| | Delta v2 | 16/16 | 4/8 | 115% |
| | v2 + expand on miss | 16/16 | **8/8** | 151% |

What this shows:
- **Delta v2 kept every literal-question answer on every model** (48/48), at 29% of the full-context
  cost on the input-priced models — the local result holds on real cloud models.
- In this caching-friendly workload, **prompt caching costs about the same (35–37%) and loses less**
  on paraphrased questions. Compression's advantage is for context that isn't re-sent (fresh tool
  output, sparse traffic), as the simulation above predicts.
- On GPT-5 mini, compression **cost more** (115%): its bill is dominated by reasoning output tokens,
  and the compressed context made it reason longer. Compression pays off on input-dominated bills.
- `expand_context` recovers answers only when the model picks search terms that occur in the text.
  GPT-5 mini searched the Thai README with Thai terms and recovered 4/4; Haiku and Gemini searched in
  English and recovered 0/2 on the Thai document.
- **Not valid yet**: DeepSeek V4 Flash and Qwen 3.7 Flash reason before answering, and the first run
  capped output at 300 tokens (Qwen: 82/96 empty answers; DeepSeek: full-context answers cut off).
  The harness now allows 4,000 tokens and records truncation; rerun with
  `--models deepseek/deepseek-v4-flash,qwen/qwen3.7-flash --redo`.

Claude direct (`cloud_claude.mjs`, needs `ANTHROPIC_API_KEY`) is also available and adds exact
`countTokens` numbers.

## Caveats

- tiktoken `o200k_base` is OpenAI's tokenizer; Claude counts ~15–20% more tokens on typical text. Ratios
  are comparable, absolute counts are not — use the provider's own token-count endpoint for billing numbers.
- 32 questions over 3 corpora is a small set; paraphrase results in particular have wide error bars.
- The local-model latencies in `results/qa.json` are **not** a speed benchmark: Ollama reuses the KV cache of a
  repeated prompt prefix (local prompt caching), and another process shared the model during the run.

## Reproduce

```bash
npm run build && pip install tiktoken
npm run bench:compression            # token reduction + evidence retention -> results/variants.json
npm run bench:compression:qa         # local Ollama answers -> results/qa.json (slow on CPU)
node benchmarks/compression-real/report.mjs
node benchmarks/compression-real/caching_vs_compression_sim.mjs
npm run bench:intent-loop-cost
node benchmarks/compression-real/qa_expand_ollama.mjs   # needs results/qa.json
```
