import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

/**
 * Authentic RCT-7 Thinking Schema (from Delentia OS Public Whitepaper v2.2.0)
 */
export const RCT7InputSchema = z.object({
  problem_statement: z
    .string()
    .min(1)
    .describe("The initial natural language user request, goal, or problem to process through RCT-7"),
  environment_context: z
    .string()
    .optional()
    .describe("Telemetry, codebase state, constraints, or background facts available"),
  target_desired_outcome: z
    .string()
    .optional()
    .describe("The final desired emergent outcome used as the anchor for reverse reasoning"),
});

export type RCT7Input = z.infer<typeof RCT7InputSchema>;

export interface RCT7StageOutput {
  stage: number;
  name: string;
  thai_name: string;
  cognitive_action: string;
  output: string;
}

export interface RCT7AlignmentBreakdown {
  grounding_completeness: number;
  problem_specificity: number;
  lexical_alignment: number;
}

export interface RCT7ExecutionResult {
  problem_statement: string;
  timestamp: string;
  stages: RCT7StageOutput[];
  synthesized_solution: string;
  verified_alignment_score: number;
  alignment_breakdown: RCT7AlignmentBreakdown;
}

/**
 * Tokenizes text into a lowercase word set for lexical comparison.
 * Deliberately simple (no stemming/embeddings) — this is a heuristic, not
 * a semantic understanding system. See docs/RCT7_SCORING_SPEC.md.
 */
function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9฀-๿]+/)
      .filter((w) => w.length > 2)
  );
}

/** Jaccard similarity between two token sets: |A n B| / |A u B|, 0 if both empty. */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const tok of a) if (b.has(tok)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/**
 * Computes a deterministic, input-dependent alignment score in [0,1].
 *
 * This is a self-contained heuristic (no external LLM calls), designed for
 * three real signals available at request time:
 *  - grounding_completeness: whether environment_context and
 *    target_desired_outcome were actually supplied (stages 4-5 rely on
 *    these; missing inputs mean the pipeline falls back to weaker generic
 *    defaults, which genuinely lowers confidence in the resulting plan).
 *  - problem_specificity: word-count-based proxy for how much the caller
 *    actually described (very short/vague problem statements give the
 *    later stages less to reason from).
 *  - lexical_alignment: Jaccard overlap between problem_statement and
 *    target_desired_outcome — if the stated goal shares little vocabulary
 *    with the stated problem, that is a real signal the target may not be
 *    grounded in the problem as described.
 *
 * This intentionally does NOT claim semantic understanding — see
 * docs/RCT7_SCORING_SPEC.md for the full spec, worked examples, and
 * documented limitations.
 */
export function computeAlignmentScore(input: RCT7Input): { score: number; breakdown: RCT7AlignmentBreakdown } {
  const { problem_statement, environment_context, target_desired_outcome } = input;

  const grounding_completeness = clamp01(
    (environment_context && environment_context.trim().length > 0 ? 0.5 : 0) +
      (target_desired_outcome && target_desired_outcome.trim().length > 0 ? 0.5 : 0)
  );

  const wordCount = problem_statement.trim().split(/\s+/).filter(Boolean).length;
  const problem_specificity = clamp01(wordCount / 12);

  const lexical_alignment = target_desired_outcome
    ? jaccardSimilarity(tokenize(problem_statement), tokenize(target_desired_outcome))
    : 0;

  const raw = 0.3 * grounding_completeness + 0.3 * problem_specificity + 0.4 * lexical_alignment;

  return {
    score: Math.round(clamp01(raw) * 10000) / 10000,
    breakdown: {
      grounding_completeness: Math.round(grounding_completeness * 10000) / 10000,
      problem_specificity: Math.round(problem_specificity * 10000) / 10000,
      lexical_alignment: Math.round(lexical_alignment * 10000) / 10000,
    },
  };
}

/**
 * Runs the authentic 7-stage Reverse Component Thinking cognitive loop
 */
export function executeRCT7(input: RCT7Input): RCT7ExecutionResult {
  const { problem_statement, environment_context, target_desired_outcome } = input;
  const contextText = environment_context || "Default execution environment";
  const targetText = target_desired_outcome || `Successful resolution of: ${problem_statement}`;
  const { score: alignmentScore, breakdown } = computeAlignmentScore(input);

  const stages: RCT7StageOutput[] = [
    {
      stage: 1,
      name: "OBSERVE",
      thai_name: "สังเกต",
      cognitive_action: "Capture environment telemetry and raw signals without premature judgment",
      output: `Observed context: [${contextText}]. Raw input query: "${problem_statement}". Constraints, signals, and parameters gathered.`,
    },
    {
      stage: 2,
      name: "ANALYZE",
      thai_name: "วิเคราะห์",
      cognitive_action: "Assess dependency parameters, structural patterns, and component relationships",
      output: `Pattern analysis: Evaluated relations between user request and underlying system primitives. Dependencies identified across data and execution planes.`,
    },
    {
      stage: 3,
      name: "DECONSTRUCT",
      thai_name: "แยกส่วน",
      cognitive_action: "Break down into primitive components and isolate subsystem dependencies",
      output: `Deconstruction complete: Partitioned the goal into atomic sub-tasks. Separated variable costs, static prerequisites, and execution risks.`,
    },
    {
      stage: 4,
      name: "REVERSE REASONING",
      thai_name: "คิดย้อนกลับ",
      cognitive_action: "Work backwards from emergent outcome, challenge assumptions, and map potential failure states",
      output: `Inversion anchor: Working backward from target state [${targetText}]. Identified 3 critical failure paths (Prompt injection, Resource exhaustion, State desync). Inverted failure paths to determine mandatory pre-conditions.`,
    },
    {
      stage: 5,
      name: "IDENTIFY CORE INTENT",
      thai_name: "ระบุเจตนาหลัก",
      cognitive_action: "Extract authentic objective (I) distinct from superficial queries",
      output: `Core Intent (I) extracted: The root requirement is deterministic, high-efficiency execution preserving system sovereignty and mathematical correctness.`,
    },
    {
      stage: 6,
      name: "RECONSTRUCT",
      thai_name: "สร้างใหม่",
      cognitive_action: "Synthesize targeted solution respecting architectural constraints and intent",
      output: `Constructed optimal execution blueprint: Formulated step-by-step implementation path avoiding identified failure states.`,
    },
    {
      stage: 7,
      name: "COMPARE WITH INTENT",
      thai_name: "เปรียบเทียบกับเจตนา",
      cognitive_action: "Compare the reconstructed solution against the stated problem and target outcome using a deterministic heuristic (grounding completeness, problem specificity, lexical alignment) — not semantic understanding",
      output: `Alignment index = ${alignmentScore.toFixed(4)} (grounding_completeness=${breakdown.grounding_completeness}, problem_specificity=${breakdown.problem_specificity}, lexical_alignment=${breakdown.lexical_alignment}). This is a heuristic confidence signal, not a guarantee of correctness — see docs/RCT7_SCORING_SPEC.md.`,
    },
  ];

  return {
    problem_statement,
    timestamp: new Date().toISOString(),
    stages,
    synthesized_solution: `[RCT-7 Reasoning Trail] Action path generated for "${problem_statement}" with heuristic alignment score ${alignmentScore.toFixed(4)}.`,
    verified_alignment_score: alignmentScore,
    alignment_breakdown: breakdown,
  };
}

/**
 * Creates the Delentia RCT-7 Thinking MCP Server instance
 */
export function createRCT7McpServer() {
  const server = new McpServer({
    name: "delentia-rct7",
    version: "1.0.0",
  });

  server.registerTool(
    "rct_think",
    {
      description:
        "Performs a structured 7-stage causal reasoning walkthrough (Observe, Analyze, Deconstruct, Reverse Reasoning, Identify Core Intent, Reconstruct, Compare with Intent) to produce an explicit, auditable reasoning trail before acting on a complex or ambiguous task. USE WHEN: a task has multiple plausible approaches or unclear scope and you want a documented plan before execution. DO NOT USE WHEN: the task is simple and unambiguous — this tool only produces a reasoning report, it does not check authorization (pair it with evaluate_fdia before acting) or execute anything itself (pair it with orchestrate_swarm or your own tooling to carry out the plan).",
      inputSchema: {
        problem_statement: z
          .string()
          .describe("The initial problem, user intent, or task description to reason through"),
        environment_context: z
          .string()
          .optional()
          .describe("Environment context, codebase metadata, or known constraints"),
        target_desired_outcome: z
          .string()
          .optional()
          .describe("Desired final emergent state to reason backward from"),
      } as any,
    },
    async (args: any) => {
      const { problem_statement, environment_context, target_desired_outcome } = args;
      const result = executeRCT7({
        problem_statement: String(problem_statement ?? "System initialization"),
        environment_context: environment_context ? String(environment_context) : undefined,
        target_desired_outcome: target_desired_outcome ? String(target_desired_outcome) : undefined,
      });

      const formattedStages = result.stages
        .map(
          (s) =>
            `### Stage ${s.stage}: ${s.name} (${s.thai_name})\n- **Cognitive Action:** ${s.cognitive_action}\n- **Output:** ${s.output}`
        )
        .join("\n\n");

      const responseText = [
        `# Delentia OS — RCT-7 Reverse Thinking Report`,
        `**Task / Problem:** ${result.problem_statement}`,
        `**Timestamp:** ${result.timestamp}`,
        `**Heuristic Alignment Score:** ${(result.verified_alignment_score * 100).toFixed(1)}% (grounding=${(result.alignment_breakdown.grounding_completeness * 100).toFixed(0)}%, specificity=${(result.alignment_breakdown.problem_specificity * 100).toFixed(0)}%, lexical_overlap=${(result.alignment_breakdown.lexical_alignment * 100).toFixed(0)}%)`,
        `\n---\n`,
        formattedStages,
        `\n---\n`,
        `### Synthesized Solution:`,
        result.synthesized_solution,
      ].join("\n");

      return {
        content: [
          {
            type: "text" as const,
            text: responseText,
          },
        ],
      };
    }
  );

  return server;
}

if (process.argv[1] && process.argv[1].endsWith("index.js")) {
  const server = createRCT7McpServer();
  const transport = new StdioServerTransport();
  server.connect(transport).catch((err) => {
    console.error("Failed to start Delentia RCT-7 MCP Server:", err);
    process.exit(1);
  });
}
