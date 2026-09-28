import { createHash } from "node:crypto";

/**
 * Faithful TypeScript port of graphrag-complete/app/core/graphrag_engine.py's
 * _get_embedding() hashing-trick bag-of-words embedding (SHA-256 feature
 * hashing + signed buckets + L2-normalize) — ported so the TS side can
 * compute vectors compatible with the Python Vector Search service
 * (ALGO-16), which indexes/searches
 * arbitrary float vectors but does not itself turn text into vectors.
 *
 * Not a neural embedding: deterministic and content-derived (same text
 * always produces the same vector, texts sharing vocabulary score higher
 * than unrelated ones), same trade-off already accepted and tested on the
 * Python side. `dimension` must match the target Vector Search instance's
 * configured DIMENSION env var (default 768 — see vector-search/app/main.py).
 */
export function hashingEmbedding(text: string, dimension: number): number[] {
  const vector = new Float64Array(dimension);
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];

  for (const token of tokens) {
    const digest = createHash("sha256").update(token, "utf-8").digest();
    // First 8 bytes as an unsigned 64-bit-ish index (BigInt to avoid
    // JS number precision loss), reduced into [0, dimension).
    let bucketBig = 0n;
    for (let i = 0; i < 8; i++) {
      bucketBig = (bucketBig << 8n) | BigInt(digest[i]);
    }
    const bucket = Number(bucketBig % BigInt(dimension));
    const sign = (digest[8] & 1) === 0 ? 1 : -1;
    vector[bucket] += sign;
  }

  let normSq = 0;
  for (let i = 0; i < dimension; i++) normSq += vector[i] * vector[i];
  const norm = Math.sqrt(normSq);

  if (norm === 0) return Array.from(vector); // honest all-zero vector for empty/whitespace-only text
  const out = new Array(dimension);
  for (let i = 0; i < dimension; i++) out[i] = vector[i] / norm;
  return out;
}
