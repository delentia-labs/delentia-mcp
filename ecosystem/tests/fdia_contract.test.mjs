/**
 * FDIA CONTRACT TEST — TS vs. Python, the same formula implemented twice
 *
 * The FDIA core equation (F = D^I * A) is implemented independently in at
 * least two places: this repo's packages/shared/src/fdia-core.ts
 * (FDIAEngine.calculateF) and Delentia-OS/rct_control_plane/
 * algorithm_kernel_41.py (AlgorithmKernel41.algo_01_fdia). Flagged as a
 * known issue in CHANGELOG.md since 2026-09-13: "no contract test exists
 * yet ... to catch silent divergence." This is that contract test.
 *
 * Method: compute both implementations' real output for the same inputs
 * (shelling out to real Python, not re-deriving the formula in JS) and
 * compare. Two real, load-bearing divergences were found while building
 * this test - documented and asserted precisely below, not silently
 * ignored (an initial hypothesis about *why* they diverge on extreme
 * inputs was wrong on the first attempt - corrected after actually
 * running both sides, not assumed):
 *
 * 1. Clamping produces a SECURITY-RELEVANT divergence on extreme inputs.
 *    Python clamps D to [0.01,100] and I to [0.01,10] before computing;
 *    TS does not clamp at all (it only rejects non-finite/negative D or I
 *    by returning 0). For D=1000, I=1000, A=1.0: TS computes
 *    Math.pow(1000,1000) = Infinity, which fails its finite-check and
 *    correctly fails closed to 0 (denied). Python clamps down to D=100,
 *    I=10 first, then computes 100**10 * 1.0 = 1e20 - a huge but
 *    perfectly finite float, which Python happily returns as the
 *    future_score. Since any real authorization threshold is O(1), a
 *    1e20 score would trivially clear ANY threshold check - meaning
 *    Python's clamping, intended as a safety measure, actually makes
 *    absurd/out-of-domain inputs MORE likely to be approved, not less,
 *    while TS's no-clamping-but-fail-closed-on-overflow approach denies
 *    the same nonsensical input. This is the opposite of what "clamping
 *    for safety" should achieve.
 * 2. Corollary finding: Python's own log-based overflow guard
 *    (`if I*log(D) > 700: return 1.0*A`) is UNREACHABLE DEAD CODE given
 *    its own clamping bounds - the maximum possible value of I*log(D)
 *    once D<=100 and I<=10 have already been clamped is
 *    10*ln(100)=46.05, which can never exceed 700. The same class of bug
 *    as Halting Detection's dead `except TimeoutError` clause found
 *    earlier this session: a safety branch that looks like it handles a
 *    real case but structurally never can.
 * 3. Negative A: TS's finite/negative check covers D and I but not A
 *    itself - a finite negative A is never rejected, so calculateF can
 *    return a genuine negative future_score. Python clamps A into [0,1],
 *    so a negative A always yields A=0 -> F=0. Documented, not fixed.
 *
 * None of these are fixed in this pass - the two implementations are
 * genuinely different systems with different callers and deployment
 * targets, and picking a single correct behavior (and applying it to
 * both) is a real design decision for whoever owns FDIA's security
 * semantics, not something to decide unilaterally while writing a
 * contract test. This test's job is to make the divergence visible and
 * permanent, not to resolve it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FDIAEngine } from "../packages/shared/dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Delentia-OS checkout: DELENTIA_OS_DIR, else a sibling of this repo (ecosystem/ sits one level down).
const KERNEL_REL = "rct_control_plane/algorithm_kernel_41.py";
const ALGO_KERNEL_PY = [
  process.env.DELENTIA_OS_DIR && path.resolve(process.env.DELENTIA_OS_DIR, KERNEL_REL),
  path.resolve(__dirname, "../../Delentia-OS", KERNEL_REL),
  path.resolve(__dirname, "../../../Delentia-OS", KERNEL_REL),
].filter(Boolean).find((p) => fs.existsSync(p)) ?? path.resolve(__dirname, "../../../Delentia-OS", KERNEL_REL);
const PYTHON_AVAILABLE = fs.existsSync(ALGO_KERNEL_PY);

if (!PYTHON_AVAILABLE) {
  console.log(`SKIPPING fdia_contract.test.mjs — sibling Delentia-OS/rct_control_plane/algorithm_kernel_41.py not found at ${ALGO_KERNEL_PY}`);
}

function pythonAlgo01Fdia(D, I, A) {
  const kernelRoot = path.dirname(path.dirname(ALGO_KERNEL_PY)); // .../Delentia-OS
  const script = `
import sys
sys.path.insert(0, ${JSON.stringify(kernelRoot)})
from rct_control_plane.algorithm_kernel_41 import AlgorithmKernel41
k = AlgorithmKernel41()
print(k.algo_01_fdia(${D}, ${I}, ${A}))
`;
  const output = execFileSync("python", ["-c", script], { cwd: kernelRoot, encoding: "utf-8" });
  return parseFloat(output.trim().split("\n").pop());
}

const engine = new FDIAEngine();
function tsCalculateF(D, I, A) {
  return engine.calculateF(D, I, A);
}

test("FDIA contract: TS and Python agree for realistic, in-range inputs", { skip: !PYTHON_AVAILABLE }, () => {
  const cases = [
    [0.98, 0.96, 1.0],
    [0.5, 2.0, 1.0],
    [1.0, 1.0, 1.0],
    [0.1, 5.0, 1.0],
    [0.9, 0.5, 1.0],
    [0.75, 3.0, 0.0], // A=0 -> both must collapse to 0
  ];
  for (const [D, I, A] of cases) {
    const tsResult = tsCalculateF(D, I, A);
    const pyResult = pythonAlgo01Fdia(D, I, A);
    assert.equal(tsResult, pyResult, `D=${D} I=${I} A=${A}: ts=${tsResult} py=${pyResult}`);
  }
});

test("FDIA contract: KNOWN DIVERGENCE — extreme inputs get opposite verdicts because only one side clamps", { skip: !PYTHON_AVAILABLE }, () => {
  const D = 1000, I = 1000, A = 1.0;
  const tsResult = tsCalculateF(D, I, A);
  const pyResult = pythonAlgo01Fdia(D, I, A);

  // TS: no clamping. Math.pow(1000,1000) is Infinity, so calculateF's
  // finite-check fails and it fails closed to 0 (denied) - the safe
  // outcome for a nonsensical input.
  assert.equal(tsResult, 0);
  // Python: clamps D to 100 and I to 10 BEFORE computing, then computes
  // 100**10 * 1.0 = 1e20 - a huge but perfectly finite float. Python's
  // own overflow guard never fires here (or for ANY input, given its
  // clamp bounds - see this file's header comment): 10*ln(100)=46.05,
  // nowhere near the 700 threshold. The clamped computation itself
  // overflows the MEANING of the score even though it doesn't overflow
  // the float.
  assert.equal(pyResult, 1e20);
  assert.notEqual(tsResult, pyResult, "this divergence is real and expected - if it ever passes, the implementations converged and this test should be revisited");
  // The real-world consequence: pyResult (1e20) would trivially clear any
  // realistic authorization threshold (e.g. 0.5-1.0), meaning Python's
  // clamping makes this absurd input MORE likely to be approved, while
  // TS's fail-closed behavior denies it. Opposite safety outcomes from
  // the same nonsensical input.
  assert.ok(pyResult > 1.0, "the clamped-and-overflowed Python result trivially exceeds any real authorization threshold");
});

test("FDIA contract: KNOWN DIVERGENCE — a negative but finite A is handled differently", { skip: !PYTHON_AVAILABLE }, () => {
  const D = 0.9, I = 1.0, A = -0.5;
  const tsResult = tsCalculateF(D, I, A);
  const pyResult = pythonAlgo01Fdia(D, I, A);

  // TS never explicitly checks A for negativity (only finiteness) - a
  // finite negative A flows straight into `Math.pow(D,I) * A`, producing
  // a genuine negative future_score.
  assert.ok(tsResult < 0, `expected TS to produce a negative score for negative A, got ${tsResult}`);
  // Python clamps A into [0,1] before computing, so negative A becomes 0.
  assert.equal(pyResult, 0);
});
