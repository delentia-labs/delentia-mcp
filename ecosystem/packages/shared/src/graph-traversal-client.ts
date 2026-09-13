/**
 * Real HTTP client for the Python Graph Traversal service
 * (<private>/microservices/graph-traversal — ALGO-17, audited real
 * earlier this session: genuine BFS/DFS/Dijkstra/PageRank/Louvain +
 * real Neo4j Cypher queries). A third complementary real memory
 * backend: GraphRAG does content-fusion search, Vector Search does ANN
 * similarity search, Graph Traversal does explicit relationship
 * queries (e.g. "what outcomes resulted from this intent", "what's the
 * shortest path between these two remembered entities") that neither of
 * the other two backends can answer.
 */

export interface GraphNodeResult {
  node_id: string;
  labels: string[];
  created: boolean;
}

export interface GraphRelationshipResult {
  relationship_id: string;
  from_node: string;
  to_node: string;
  type: string;
  created: boolean;
}

export interface ShortestPathResult {
  path_found: boolean;
  length: number;
  path: Array<Record<string, unknown>>;
  time_ms: number;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

export async function createGraphNode(
  baseUrl: string,
  nodeId: string,
  labels: string[],
  properties: Record<string, unknown> = {}
): Promise<GraphNodeResult> {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/graph/nodes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ node_id: nodeId, labels, properties }),
  });
  if (!response.ok) {
    throw new Error(`Graph Traversal node creation failed: HTTP ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as GraphNodeResult;
}

export async function createGraphRelationship(
  baseUrl: string,
  fromNode: string,
  toNode: string,
  relationshipType: string,
  properties: Record<string, unknown> = {}
): Promise<GraphRelationshipResult> {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/graph/relationships`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from_node: fromNode, to_node: toNode, relationship_type: relationshipType, properties }),
  });
  if (!response.ok) {
    throw new Error(`Graph Traversal relationship creation failed: HTTP ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as GraphRelationshipResult;
}

export async function findShortestPath(
  baseUrl: string,
  startNode: string,
  endNode: string,
  maxDepth = 10
): Promise<ShortestPathResult> {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/graph/shortest-path`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ start_node: startNode, end_node: endNode, max_depth: maxDepth }),
  });
  if (!response.ok) {
    throw new Error(`Graph Traversal shortest-path query failed: HTTP ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as ShortestPathResult;
}
