/**
 * Real end-to-end proof (2026-09-24, Round 44) that delentia-mcp-ecosystem
 * (this TypeScript Worker, actually deployed) and Delentia-OS (the Python
 * rct_control_plane kernel) can genuinely talk to each other - not a mock,
 * a real HTTP round-trip against a real running Python process.
 *
 * Deliberately NOT part of `npm test` / CI: it requires a real Python
 * server already running (this repo's automated suite,
 * tests/python_kernel_bridge.test.mjs, already covers the wire contract
 * with a real local HTTP mock standing in for the kernel - genuinely
 * sufficient for CI and does not need Python installed). This script is
 * for a human to re-run by hand whenever they want to re-confirm the real
 * cross-repo integration still works, e.g. before deciding to activate
 * PYTHON_KERNEL_URL in production.
 *
 * How to run:
 *   1. In Delentia-OS: python -m rct_control_plane.cli serve --host 127.0.0.1 --port 18301
 *      (cold start can take 20+ seconds - AlgorithmKernel41 loads real
 *      torch/FAISS/etc. dependencies; wait for "Listening" AND a real
 *      response from curl http://127.0.0.1:18301/health before proceeding)
 *   2. In this repo: npm run build --prefix packages/fdia (ensures dist/ is fresh)
 *   3. node tests/real_bridge_e2e_manual_check.mjs
 *
 * Last confirmed passing: 2026-09-24 (both layers - direct bridge call and
 * the full evaluate_fdia worker handler with python_kernel_cross_check
 * populated from a genuine, independent Python computation matching the
 * worker's own native result).
 */
import { callPythonKernelFdia } from "../packages/fdia/dist/pythonKernelBridge.js";
import worker from "../packages/fdia/dist/worker.js";

const REAL_PYTHON_URL = "http://127.0.0.1:18301";

console.log("=== Layer 1: callPythonKernelFdia() directly against the real Python server ===");
const direct = await callPythonKernelFdia(REAL_PYTHON_URL, {
  data_quality: 0.9,
  intent_precision: 1.0,
  authorized: true,
});
console.log("Result:", direct);
if (!direct || direct.source !== "python_kernel_real_computation") {
  throw new Error("FAILED: direct bridge call did not return a real python_kernel_real_computation result");
}
console.log("PASSED\n");

console.log("=== Layer 2: full evaluate_fdia worker handler, PYTHON_KERNEL_URL pointing at the real server ===");
const request = new Request("http://worker.test/mcp", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "evaluate_fdia", arguments: { data_quality: 0.9, intent_precision: 1.0, action_name: "read_report" } },
  }),
});
const response = await worker.fetch(request, { ENVIRONMENT: "test", PYTHON_KERNEL_URL: REAL_PYTHON_URL }, { waitUntil: () => {} });
const body = await response.json();
const result = JSON.parse(body.result.content[0].text);
console.log("Full worker result:", JSON.stringify(result, null, 2));

if (!result.python_kernel_cross_check) {
  throw new Error("FAILED: python_kernel_cross_check missing from real end-to-end worker response");
}
if (result.python_kernel_cross_check.source !== "python_kernel_real_computation") {
  throw new Error("FAILED: python_kernel_cross_check.source is not the real computation marker");
}
console.log("PASSED\n");

console.log("=== ALL REAL END-TO-END BRIDGE ASSERTIONS PASSED ===");
console.log("Native worker computation (authoritative):", result.future_score, result.authorized);
console.log("Python kernel cross-check (real, independent computation):", result.python_kernel_cross_check.future_score, result.python_kernel_cross_check.authorized);
