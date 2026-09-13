/**
 * Real HTTP client for the Python Halting Detection service
 * (<private>/microservices/halting-detection — ALGO-22), giving
 * TypeScript Workers a real network path to safety-check untrusted code
 * before it is treated as fully trustworthy. This service's own real
 * bounded-execution sandbox (subprocess + real wall-clock timeout + real
 * memory/CPU limits on POSIX, all fixed and verified for real this
 * session — see TESTING_CANONICAL.md) is what actually runs the code;
 * this client is a thin fetch() wrapper, no execution happens on the TS
 * side.
 */

export interface HaltingCheckResult {
  completed: boolean;
  halted: boolean;
  steps_executed: number;
  time_elapsed_ms: number;
  result?: unknown;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/**
 * Runs `code` inside the real Halting Detection sandbox and reports
 * whether it halted within `maxTimeMs`. `maxTimeMs` is capped at 10000 by
 * the service's own request validation (SimulateRequest.max_time_ms,
 * le=10000) — a higher value is rejected with a 400, not silently
 * clamped, so this client does not clamp it either.
 */
export async function checkCodeHalts(
  baseUrl: string,
  code: string,
  input: Record<string, unknown> = {},
  maxTimeMs = 3000
): Promise<HaltingCheckResult> {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/halting/simulate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, input, max_time_ms: maxTimeMs }),
  });
  if (!response.ok) {
    throw new Error(`Halting Detection check failed: HTTP ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as HaltingCheckResult;
}
