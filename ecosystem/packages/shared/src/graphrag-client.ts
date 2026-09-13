/**
 * Real HTTP client for the Python GraphRAG service
 * (<private>/microservices/graphrag-complete), giving TypeScript
 * Workers a genuine network path into that service's real (hashing-trick)
 * embeddings + semantic search, instead of the two stacks (this
 * TS/Cloudflare-Workers kernel and the Python microservices platform)
 * running as two completely unconnected systems.
 *
 * This is deliberately a thin client, not a re-implementation: every call
 * here is a real fetch() against GraphRAG's real, already-tested HTTP API
 * (POST /graphrag/documents, POST /graphrag/search, GET
 * /graphrag/session/{id}) — see graphrag-complete/app/api/routes.py. No
 * business logic about ranking or embeddings lives on this side.
 */

export interface GraphRagIngestResult {
  doc_id: string;
}

export interface GraphRagSearchResultItem {
  doc_id: string;
  content: string;
  score: number;
  vector_score: number;
  keyword_score: number;
  graph_score: number;
  fusion_score: number;
}

export interface GraphRagSearchSession {
  session_id: string;
  query: string;
  mode: string;
  results: GraphRagSearchResultItem[];
  execution_time: number;
}

export type GraphRagSearchMode = "keyword" | "vector" | "graph" | "hybrid" | "graphrag";

/**
 * Strips any trailing slash(es) from a configured base URL. Found for
 * real (2026-09-13): a base URL configured with a trailing slash (an easy
 * mistake — e.g. pasted from a browser address bar, which often appends
 * one) silently produced a double-slash path like
 * `http://host//graphrag/documents`, which FastAPI/uvicorn 404s on rather
 * than normalizing — and since callers of this client (syncToGraphRag)
 * deliberately swallow all errors as best-effort, that 404 would never
 * surface anywhere. Every request path in this file goes through this
 * normalization so a trailing slash in configuration can never cause a
 * silent, permanent failure.
 */
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/**
 * Ingests one document into GraphRAG's real, runtime-searchable document
 * store (see graphrag_engine.py's add_document()). Throws on any non-200
 * response or network failure — callers that want "best effort, never
 * throw" (e.g. background sync from a Worker request handler) should
 * catch at the call site, the same pattern already used for RCTDB logging
 * and MEE growth, rather than this client silently swallowing errors.
 */
export async function ingestGraphragDocument(
  baseUrl: string,
  content: string,
  metadata: Record<string, unknown> = {}
): Promise<GraphRagIngestResult> {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/graphrag/documents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, metadata }),
  });
  if (!response.ok) {
    throw new Error(`GraphRAG ingest failed: HTTP ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as GraphRagIngestResult;
}

/**
 * Runs a real search against GraphRAG and returns the full session
 * (query, mode, and every ranked result with its real per-source scores) —
 * two HTTP calls under the hood (POST /graphrag/search to start the
 * search, GET /graphrag/session/{id} to retrieve its results), mirroring
 * GraphRAG's own async session-based API design rather than inventing a
 * combined endpoint that doesn't exist on the Python side.
 */
export async function searchGraphragDocuments(
  baseUrl: string,
  query: string,
  mode: GraphRagSearchMode = "vector",
  topK = 5
): Promise<GraphRagSearchSession> {
  const base = normalizeBaseUrl(baseUrl);
  const searchResponse = await fetch(`${base}/graphrag/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, mode, top_k: topK }),
  });
  if (!searchResponse.ok) {
    throw new Error(`GraphRAG search failed: HTTP ${searchResponse.status} ${await searchResponse.text()}`);
  }
  const { session_id: sessionId } = (await searchResponse.json()) as { session_id: string };

  const sessionResponse = await fetch(`${base}/graphrag/session/${sessionId}`);
  if (!sessionResponse.ok) {
    throw new Error(`GraphRAG session fetch failed: HTTP ${sessionResponse.status} ${await sessionResponse.text()}`);
  }
  return (await sessionResponse.json()) as GraphRagSearchSession;
}
