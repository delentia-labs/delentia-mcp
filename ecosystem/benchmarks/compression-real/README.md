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
```
