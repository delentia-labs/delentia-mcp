/**
 * Real, optional HTTP bridge to Delentia-OS's Python kernel.
 *
 * Round 31 (item 1 of this engagement's Round 30 candidate list): this
 * worker and the Python `rct_control_plane` kernel it was originally
 * modeled after have been two fully disconnected systems for the entire
 * 30-round engagement (confirmed via Round 30's own re-verification - no
 * import, HTTP call, or subprocess link existed either direction). This
 * is a real, minimal prototype proving the two CAN talk to each other -
 * not a replacement for this worker's own real, native `evaluateFDIA`
 * computation (kept exactly as-is, Zero-Delete), just an additive,
 * best-effort cross-check.
 *
 * Same defensive shape as worker.ts's own `stepMeeGrowth`: never throws,
 * never blocks the real response, returns `undefined` on any failure
 * (missing config, network error, non-200, malformed JSON) so a caller
 * who never configures `pythonKernelUrl` sees byte-identical behavior to
 * before this file existed.
 */

export interface PythonKernelFdiaResult {
  future_score: number;
  authorized: boolean;
  D: number;
  I: number;
  A: number;
  formula: string;
  source: string;
}

export async function callPythonKernelFdia(
  pythonKernelUrl: string | undefined,
  params: { data_quality: number; intent_precision: number; authorized: boolean },
  timeoutMs = 3000
): Promise<PythonKernelFdiaResult | undefined> {
  if (!pythonKernelUrl) return undefined;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(`${pythonKernelUrl.replace(/\/$/, "")}/v1/kernel/fdia/evaluate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          data_quality: params.data_quality,
          intent_precision: params.intent_precision,
          authorized: params.authorized ? 1.0 : 0.0,
        }),
        signal: controller.signal,
      });
      if (!resp.ok) return undefined;
      const data = (await resp.json()) as PythonKernelFdiaResult;
      if (typeof data.future_score !== "number") return undefined;
      return data;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return undefined;
  }
}
