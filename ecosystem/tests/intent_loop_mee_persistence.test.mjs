/**
 * INTENT-LOOP MEE GROWTH — Durable-Object persistence (2026-09-14)
 *
 * Until this change, IntentLoopEngine's MEE growth tracker
 * (`this.growth`, a MEEGrowthTracker instance) was isolate-scoped only —
 * created fresh per Worker isolate via worker.ts's module-level
 * `engineCache`, with no path to survive an isolate recycle or span
 * multiple isolates. packages/fdia and packages/sovereign already solved
 * this for their own evaluate_fdia growth via a Durable-Object-backed
 * MEEGrowthSessionDO (see tests/fdia_worker_rct7_synthesis.test.mjs and
 * tests/sovereign_rct7_synthesis.test.mjs); intent-loop was the one
 * pillar worker missing it, found and corrected here by threading an
 * optional `ProcessOptions.persistentStep` callback through
 * IntentLoopEngine.process() (index.ts) and wiring worker.ts's
 * stepMeeGrowth() into it, using the exact same real (not mocked)
 * fake-Durable-Object harness as the sibling workers' tests.
 *
 * These tests exercise IntentLoopEngine.process() directly (same
 * deterministic fetchImpl-injection pattern as tests/intent_loop.test.mjs)
 * rather than through worker.ts's fetch handler, because worker.ts always
 * uses real global fetch() for the OpenRouter calls IntentLoopEngine makes
 * internally — there is no fetchImpl injection point at the HTTP layer,
 * so a deterministic, network-free proof has to go through the engine
 * constructor, exactly as the rest of this suite already does.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { IntentLoopEngine } from "../packages/intent-loop/dist/index.js";
import { MEEGrowthSessionDO } from "../packages/shared/dist/index.js";
import { createFakeDurableObjectNamespace } from "./helpers/fake-durable-object.mjs";

function fakeFetchSequence(contents) {
  let i = 0;
  return async () => {
    const content = contents[Math.min(i, contents.length - 1)];
    i++;
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content }, finish_reason: "stop" }] }),
    };
  };
}

/** Mirrors worker.ts's stepMeeGrowth() exactly — same HTTP contract against
 * the DO stub (POST /step, {delta, governance_violation, session_id}) — so
 * these tests prove the real call shape the production worker uses, not a
 * simplified stand-in for it. */
function makePersistentStep(namespace, sessionId) {
  return async (delta, governanceViolation) => {
    const stub = namespace.get(namespace.idFromName(sessionId));
    const resp = await stub.fetch("http://mee/step", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ delta, governance_violation: governanceViolation, session_id: sessionId }),
    });
    if (!resp.ok) return undefined;
    return await resp.json();
  };
}

test("IntentLoopEngine.process: without a persistentStep option, mee_growth is simply absent — backward compatible, mee_step (in-memory) still present", async () => {
  const fetchImpl = fakeFetchSequence(["A correct, on-topic answer.", "YES", "YES", "YES"]);
  const engine = new IntentLoopEngine({ apiKey: "fake-key-for-test", fetchImpl });
  const result = await engine.process({ intent: "explain how photosynthesis works" });
  assert.ok(result.mee_step, "the pre-existing in-memory step must be unaffected by this change");
  assert.equal(result.mee_growth, undefined, "no persistentStep supplied -> no mee_growth field");
});

test("IntentLoopEngine.process: persistentStep's own error handling is entirely the caller's responsibility — process() does not swallow it", async () => {
  // process() intentionally does NOT try/catch persistentStep itself — the
  // real try/catch lives in worker.ts's stepMeeGrowth() (matching
  // fdia/sovereign's identical best-effort contract), so a persistentStep
  // that rejects propagates. This documents that contract precisely,
  // rather than silently assuming it.
  const fetchImpl = fakeFetchSequence(["An answer.", "YES", "YES", "YES"]);
  const engine = new IntentLoopEngine({ apiKey: "fake-key-for-test", fetchImpl });
  await assert.rejects(
    () => engine.process(
      { intent: "what year did the Berlin Wall fall" },
      { persistentStep: async () => { throw new Error("simulated DO outage"); } }
    ),
    /simulated DO outage/
  );
});

test("IntentLoopEngine.process: with a real MEEGrowthSessionDO-backed persistentStep, mee_growth is returned and reflects this call's own step", async () => {
  const namespace = createFakeDurableObjectNamespace(MEEGrowthSessionDO);
  const fetchImpl = fakeFetchSequence(["A correct, on-topic answer.", "YES", "YES", "YES"]);
  const engine = new IntentLoopEngine({ apiKey: "fake-key-for-test", fetchImpl });

  const result = await engine.process(
    { intent: "summarize the quarterly earnings report" },
    { persistentStep: makePersistentStep(namespace, "test-session-a") }
  );

  assert.ok(result.mee_growth, "a real DO-backed step must be returned");
  assert.ok(result.mee_growth.step, "must carry the real MEEGrowthSessionDO step shape");
  assert.ok(result.mee_growth.summary, "must carry the real MEEGrowthSessionDO summary shape");
});

test("IntentLoopEngine.process: growth genuinely PERSISTS across two separate process() calls to the same session — the actual gap this change closes", async () => {
  const namespace = createFakeDurableObjectNamespace(MEEGrowthSessionDO);
  const fetchImpl = fakeFetchSequence(["Answer one.", "YES", "YES", "YES", "Answer two.", "YES", "YES", "YES"]);
  const engine = new IntentLoopEngine({ apiKey: "fake-key-for-test", fetchImpl });
  const persistentStep = makePersistentStep(namespace, "persist-across-calls");

  const first = await engine.process({ intent: "explain quantum entanglement simply" }, { persistentStep });
  const second = await engine.process({ intent: "describe the water cycle" }, { persistentStep });

  assert.ok(first.mee_growth && second.mee_growth);
  // Real, growing G (or at minimum a state that reflects two accumulated
  // steps, not two independent fresh trackers reset to the same start) —
  // this is exactly what was NOT possible before persistentStep existed,
  // since a fresh IntentLoopEngine (a new isolate) would have reset
  // `this.growth` to its initial state every time.
  assert.notDeepEqual(
    first.mee_growth.summary,
    second.mee_growth.summary,
    "the second call's summary must reflect BOTH steps having been applied to the same persisted session, not an independent reset"
  );
});

test("IntentLoopEngine.process: a distinct session id gets a genuinely ISOLATED growth trajectory from another session", async () => {
  const namespace = createFakeDurableObjectNamespace(MEEGrowthSessionDO);
  const fetchImpl = fakeFetchSequence(["A.", "YES", "YES", "YES", "B.", "YES", "YES", "YES"]);
  const engine = new IntentLoopEngine({ apiKey: "fake-key-for-test", fetchImpl });

  const sessionA = await engine.process(
    { intent: "what is the boiling point of water" },
    { persistentStep: makePersistentStep(namespace, "session-alpha") }
  );
  const sessionB = await engine.process(
    { intent: "what is the freezing point of water" },
    { persistentStep: makePersistentStep(namespace, "session-beta") }
  );

  assert.deepEqual(
    sessionA.mee_growth.summary,
    sessionB.mee_growth.summary,
    "two DIFFERENT, freshly-created sessions must start from the same isolated baseline, not share accumulated state"
  );
});
