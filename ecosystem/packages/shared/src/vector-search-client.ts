/**
 * Real HTTP client for the Python Vector Search service
 * (ALGO-16, a genuine FAISS/
 * Qdrant-backed vector index, audited real earlier this session), giving
 * TypeScript Workers a second, complementary real memory backend
 * alongside GraphRAG (see graphrag-client.ts): GraphRAG does its own
 * fusion/graph-expansion on top of an in-process linear scan; Vector
 * Search is the lower-level, horizontally-scalable ANN index primitive
 * that GraphRAG itself does not provide. Every call here is a real
 * fetch() against Vector Search's real, already-tested HTTP API
 * (POST /vector/index, POST /vector/search) — see
 * vector-search/app/api/routes.py. Text -> vector conversion is done via
 * hashingEmbedding() (hashing-embedding.ts), the same algorithm already
 * verified byte-for-byte identical to GraphRAG's Python-side embedding.
 */

import { hashingEmbedding } from "./hashing-embedding.js";

export interface VectorIndexResult {
  indexed_count: number;
  total_vectors: number;
  time_ms: number;
}

export interface VectorSearchResultItem {
  id: string;
  score: number;
  metadata?: Record<string, unknown> | null;
}

export interface VectorSearchResult {
  results: VectorSearchResultItem[];
  time_ms: number;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/**
 * Embeds `text` via the shared hashing-trick algorithm and indexes it
 * into the real Vector Search instance at `baseUrl`. `dimension` must
 * match that instance's configured DIMENSION (default 768 — see
 * vector-search/app/main.py); mismatches are rejected by the real service
 * with a 400, not silently truncated.
 */
export async function indexTextAsVector(
  baseUrl: string,
  id: string,
  text: string,
  dimension: number,
  metadata: Record<string, unknown> = {}
): Promise<VectorIndexResult> {
  const vector = hashingEmbedding(text, dimension);
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/vector/index`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ vectors: [vector], ids: [id], metadata: [metadata] }),
  });
  if (!response.ok) {
    throw new Error(`Vector Search index failed: HTTP ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as VectorIndexResult;
}

/**
 * Embeds `queryText` the same way and searches the real Vector Search
 * index for its k nearest neighbors.
 */
export async function searchTextAsVector(
  baseUrl: string,
  queryText: string,
  dimension: number,
  k = 5
): Promise<VectorSearchResult> {
  const queryVector = hashingEmbedding(queryText, dimension);
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/vector/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query_vector: queryVector, k }),
  });
  if (!response.ok) {
    throw new Error(`Vector Search query failed: HTTP ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as VectorSearchResult;
}
