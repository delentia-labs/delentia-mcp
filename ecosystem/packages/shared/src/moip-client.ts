/**
 * Real HTTP client for the Python MOIP Planner service
 * (<private>/microservices/moip-planner — ALGO-02, audited real
 * earlier this session: genuine Pareto-dominance checking and
 * multi-objective trade-off analysis). Every call here is a real
 * fetch() against MOIP's real, already-tested HTTP API
 * (POST /moip/analyze) — see moip-planner/app/api/routes.py.
 */

export interface MoipObjective {
  id: string;
  name: string;
  description: string;
  weight: number;
  maximize: boolean;
  target_value: number;
}

export interface MoipSolution {
  id: string;
  name: string;
  description: string;
  objective_values: Record<string, number>;
}

export interface MoipAnalyzeResult {
  solution_id: string;
  solution_name: string;
  total_score: number;
  is_pareto_optimal: boolean;
  trade_offs: string[];
  objective_scores: Record<string, { value: number; target: number; achievement_percent?: number; status?: string }>;
  recommendation: string;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/**
 * Runs a real multi-objective trade-off analysis of one solution against
 * a set of weighted objectives via MOIP's real Pareto-dominance logic.
 */
export async function analyzeTradeoffs(
  baseUrl: string,
  intentDescription: string,
  objectives: MoipObjective[],
  solution: MoipSolution
): Promise<MoipAnalyzeResult> {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/moip/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ intent_description: intentDescription, objectives, solution }),
  });
  if (!response.ok) {
    throw new Error(`MOIP analyze failed: HTTP ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as MoipAnalyzeResult;
}
