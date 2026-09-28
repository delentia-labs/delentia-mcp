/**
 * ConsensusVerifier earlyStop (2026-09-27): asking the smallest majority first and skipping
 * verifiers whose votes can no longer change the outcome must never change `passed`.
 * Checked exhaustively: every combination of yes / no / error for 3 verifiers, at several
 * thresholds, against the same verifier with earlyStop disabled.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ConsensusVerifier, consensusDecided } from "../packages/intent-loop/dist/index.js";

const MODELS = ["m1", "m2", "m3"];

/** fetch that answers per model: "YES", "NO", or an HTTP error. Counts calls. */
function scriptedFetch(answers) {
  const calls = [];
  const fetchImpl = async (_url, opts) => {
    const model = JSON.parse(opts.body).model;
    calls.push(model);
    const a = answers[MODELS.indexOf(model)];
    if (a === "ERR") return { ok: false, status: 502, json: async () => ({ error: { message: "down" } }) };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: a }, finish_reason: "stop" }] }) };
  };
  return { fetchImpl, calls };
}

const OUTCOMES = ["YES", "NO", "ERR"];
const combos = [];
for (const a of OUTCOMES) for (const b of OUTCOMES) for (const c of OUTCOMES) combos.push([a, b, c]);

for (const threshold of [0.5, 0.6, 2 / 3, 1]) {
  test(`earlyStop never changes pass/fail (threshold ${threshold.toFixed(2)}, all 27 vote combinations)`, async () => {
    let saved = 0;
    for (const answers of combos) {
      const early = scriptedFetch(answers);
      const full = scriptedFetch(answers);
      const r1 = await new ConsensusVerifier({ apiKey: "k", fetchImpl: early.fetchImpl }, threshold, MODELS, true).verify("intent", "output");
      const r2 = await new ConsensusVerifier({ apiKey: "k", fetchImpl: full.fetchImpl }, threshold, MODELS, false).verify("intent", "output");
      assert.equal(r1.passed, r2.passed, `answers ${answers.join(",")}`);
      assert.equal(full.calls.length, 3);
      assert.ok(early.calls.length <= 3);
      saved += 3 - early.calls.length;
    }
    // At 0.5 the third call is skipped after YES+YES, NO+NO, YES+error and error+YES (a later
    // NO still leaves 1/2 = 0.5): 4 openings x 3 possible third answers = 12 of 81 calls.
    if (threshold === 0.5) assert.equal(saved, 12);
  });
}

test("consensusDecided: a split or an error keeps the vote open; agreement closes it", () => {
  assert.equal(consensusDecided(2, 2, 1, 0.5), true);
  assert.equal(consensusDecided(0, 2, 1, 0.5), true);
  assert.equal(consensusDecided(1, 2, 1, 0.5), false);
  assert.equal(consensusDecided(1, 1, 1, 0.5), true, "one YES and one error: a NO would make 1/2 = 0.5, still passing");
  assert.equal(consensusDecided(0, 0, 1, 0.5), false);
});
