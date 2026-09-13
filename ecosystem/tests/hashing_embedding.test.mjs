/**
 * Tests for hashing-embedding.ts — the TS port of graphrag_engine.py's
 * hashing-trick embedding, used by both graphrag-client.ts (indirectly,
 * via the Python service's own embedding) and vector-search-client.ts
 * (directly, since Vector Search only accepts pre-computed float vectors
 * and has no text-to-vector step of its own).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { hashingEmbedding } from "../packages/shared/dist/index.js";

test("hashingEmbedding: deterministic - same text always produces the same vector", () => {
  const v1 = hashingEmbedding("reflexion agent self-correction", 384);
  const v2 = hashingEmbedding("reflexion agent self-correction", 384);
  assert.deepEqual(v1, v2);
});

test("hashingEmbedding: reflects real content - shared vocabulary scores higher than unrelated text", () => {
  function cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  const sharedA = hashingEmbedding("reflexion agent self-correction feedback loop", 384);
  const sharedB = hashingEmbedding("reflexion agent uses a self-correction feedback loop", 384);
  const unrelated = hashingEmbedding("bayesian belief propagation network", 384);

  const simShared = cosine(sharedA, sharedB);
  const simUnrelated = cosine(sharedA, unrelated);

  assert.ok(simShared > simUnrelated);
  assert.ok(simShared > 0.5);
});

test("hashingEmbedding: whitespace-only text is an honest all-zero vector", () => {
  const v = hashingEmbedding("   ", 384);
  assert.ok(v.every((x) => x === 0));
});

test("hashingEmbedding: normalized to unit length for non-empty text", () => {
  const v = hashingEmbedding("Delta Engine compresses context deltas", 384);
  const normSq = v.reduce((acc, x) => acc + x * x, 0);
  assert.ok(Math.abs(normSq - 1) < 1e-9);
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GRAPHRAG_ENGINE_PY = path.resolve(
  __dirname,
  "../../the private services repo/<private>/microservices/graphrag-complete/app/core/graphrag_engine.py"
);
const PYTHON_AVAILABLE = fs.existsSync(GRAPHRAG_ENGINE_PY);

if (!PYTHON_AVAILABLE) {
  console.log(`SKIPPING cross-language parity test — sibling graphrag_engine.py not found at ${GRAPHRAG_ENGINE_PY}`);
}

test("hashingEmbedding: byte-for-byte identical to the real Python graphrag_engine.py implementation", { skip: !PYTHON_AVAILABLE }, () => {
  const text = "Delta Engine compresses context deltas for JITNA packets";
  const dimension = 384;

  const tsVector = hashingEmbedding(text, dimension);

  const graphragRoot = path.dirname(path.dirname(path.dirname(GRAPHRAG_ENGINE_PY))); // .../graphrag-complete
  const pyScript = `
import asyncio, json, sys
sys.path.insert(0, ${JSON.stringify(graphragRoot)})
from app.core.graphrag_engine import GraphRAGEngine

async def main():
    engine = GraphRAGEngine(embedding_dim=${dimension})
    v = await engine._get_embedding(${JSON.stringify(text)})
    print(json.dumps(v))

asyncio.run(main())
`;
  const pyOutput = execFileSync("python", ["-c", pyScript], {
    cwd: graphragRoot,
    encoding: "utf-8",
  });
  const pyVector = JSON.parse(pyOutput.trim().split("\n").pop());

  assert.equal(tsVector.length, pyVector.length);
  for (let i = 0; i < tsVector.length; i++) {
    assert.equal(tsVector[i], pyVector[i], `mismatch at index ${i}: ts=${tsVector[i]} py=${pyVector[i]}`);
  }
});
