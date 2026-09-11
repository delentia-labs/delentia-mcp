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
 * Splits text into non-empty sentence/clause units on ., !, ?, ;, newlines.
 * Only splits on "." when followed by whitespace/end-of-string, so common
 * mid-word periods (e.g. "Node.js", "v1.2.3") are not treated as sentence
 * boundaries. This is a regex heuristic, not a real sentence tokenizer —
 * it will still mis-split some abbreviations (e.g. "e.g. foo").
 */
function splitSentences(text: string): string[] {
  return text
    .split(/(?:[!?;\n]+|\.(?=\s|$))+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Splits a problem statement into candidate atomic sub-tasks by breaking on
 * coordinating conjunctions and separators. This is a syntactic heuristic
 * (regex-based), not real semantic task decomposition.
 */
export function extractSubtasks(problemStatement: string): string[] {
  const parts = problemStatement
    .split(/\s*(?:,|;|\band then\b|\bthen\b|\band\b|\bwhile\b|\bafter\b|\bbefore\b|\bso that\b)\s*/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length > 0 ? parts : [problemStatement.trim()];
}

/**
 * Small fixed taxonomy of failure categories, matched against problem +
 * target text by keyword presence. Detects only categories with an actual
 * keyword hit — does not assert a fixed number of failure paths regardless
 * of input, unlike the previous hardcoded "3 critical failure paths" text.
 */
const FAILURE_TAXONOMY: Record<string, string[]> = {
  security: ["auth", "credential", "inject", "exploit", "leak", "privilege", "secret", "token", "attack"],
  resource: ["timeout", "memory", "cpu", "rate limit", "quota", "exhaust", "overload", "scale", "cost"],
  state: ["race", "concurren", "desync", "stale", "cache", "consisten", "rollback", "migrat"],
  data_quality: ["missing", "invalid", "malformed", "null", "corrupt", "incomplete", "ambiguous"],
};

export function detectFailureCategories(problemStatement: string, targetText: string): string[] {
  const haystack = `${problemStatement} ${targetText}`.toLowerCase();
  const hits: string[] = [];
  for (const [category, keywords] of Object.entries(FAILURE_TAXONOMY)) {
    if (keywords.some((k) => haystack.includes(k))) hits.push(category);
  }
  return hits;
}

/** English + Thai stopwords excluded from keyword extraction. Small and deliberately incomplete. */
const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "your", "which", "will",
  "have", "has", "are", "was", "were", "can", "should", "would", "must", "not",
]);

/**
 * Extracts candidate "core intent" keywords: content words (tokenize()
 * already strips stopword-length noise) from problem_statement that also
 * appear in target_desired_outcome, if one was supplied — the words that
 * survive into both are the strongest available signal of what the caller
 * actually cares about. Falls back to the first content words of
 * problem_statement when no target is supplied.
 */
export function extractCoreIntentTerms(problemStatement: string, targetDesiredOutcome?: string): string[] {
  const problemTokens = Array.from(tokenize(problemStatement)).filter((t) => !STOPWORDS.has(t));
  if (targetDesiredOutcome) {
    const targetTokens = tokenize(targetDesiredOutcome);
    const shared = problemTokens.filter((t) => targetTokens.has(t));
    if (shared.length > 0) return shared.slice(0, 6);
  }
  return problemTokens.slice(0, 4);
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
  const targetText = target_desired_outcome || `Successful resolution of: ${problem_statement}`;
  const { score: alignmentScore, breakdown } = computeAlignmentScore(input);

  // Stage 1 signal: actual sentence/clause units captured from the inputs.
  const observedSignals = [...splitSentences(problem_statement), ...(environment_context ? splitSentences(environment_context) : [])];

  // Stage 2 signal: real lexical overlap between environment_context and
  // problem_statement — how much the supplied context actually relates to
  // the stated problem, not a canned "dependencies identified" claim.
  const contextProblemOverlap = environment_context
    ? Math.round(jaccardSimilarity(tokenize(environment_context), tokenize(problem_statement)) * 10000) / 10000
    : null;

  // Stage 3 signal: real syntactic sub-task split.
  const subtasks = extractSubtasks(problem_statement);

  // Stage 4 signal: real keyword-taxonomy failure-category detection.
  const failureCategories = detectFailureCategories(problem_statement, targetText);

  // Stage 5 signal: real extracted core-intent terms.
  const coreTerms = extractCoreIntentTerms(problem_statement, target_desired_outcome);

  const stages: RCT7StageOutput[] = [
    {
      stage: 1,
      name: "OBSERVE",
      thai_name: "สังเกต",
      cognitive_action: "Capture environment telemetry and raw signals without premature judgment",
      output:
        observedSignals.length > 0
          ? `Captured ${observedSignals.length} raw signal(s): ${observedSignals.map((s) => `"${s}"`).join("; ")}.${environment_context ? "" : " No environment_context was supplied — analysis is based on problem_statement alone."}`
          : `No parseable signals captured from the input.`,
    },
    {
      stage: 2,
      name: "ANALYZE",
      thai_name: "วิเคราะห์",
      cognitive_action: "Assess dependency parameters, structural patterns, and component relationships",
      output:
        contextProblemOverlap === null
          ? `No environment_context supplied — dependency analysis has nothing to relate the problem statement to. Provide environment_context for a real relational signal here.`
          : `Lexical overlap between environment_context and problem_statement = ${contextProblemOverlap} (Jaccard). ${contextProblemOverlap > 0 ? "The supplied context shares vocabulary with the stated problem, a structural (not semantic) signal of relevance." : "The supplied context shares no vocabulary with the stated problem — it may be unrelated or use different terminology."}`,
    },
    {
      stage: 3,
      name: "DECONSTRUCT",
      thai_name: "แยกส่วน",
      cognitive_action: "Break down into primitive components and isolate subsystem dependencies",
      output: `Split into ${subtasks.length} candidate sub-task(s) by syntactic separators: ${subtasks.map((s, i) => `(${i + 1}) "${s}"`).join(", ")}.`,
    },
    {
      stage: 4,
      name: "REVERSE REASONING",
      thai_name: "คิดย้อนกลับ",
      cognitive_action: "Work backwards from emergent outcome, challenge assumptions, and map potential failure states",
      output:
        failureCategories.length > 0
          ? `Working backward from target state "${targetText}": keyword-taxonomy match detected ${failureCategories.length} candidate failure categor${failureCategories.length === 1 ? "y" : "ies"}: ${failureCategories.join(", ")}. This is a keyword match against a fixed taxonomy, not a learned risk model — absence of a match does not mean absence of risk.`
          : `Working backward from target state "${targetText}": no failure category from the fixed taxonomy (security, resource, state, data_quality) matched by keyword. This does not mean the plan is risk-free — only that no keyword-level signal was found; a hardcoded "3 failure paths" figure was previously shown here regardless of input.`,
    },
    {
      stage: 5,
      name: "IDENTIFY CORE INTENT",
      thai_name: "ระบุเจตนาหลัก",
      cognitive_action: "Extract authentic objective (I) distinct from superficial queries",
      output:
        coreTerms.length > 0
          ? `Core intent terms extracted: ${coreTerms.join(", ")}.${target_desired_outcome ? " (terms shared between problem_statement and target_desired_outcome — the strongest available signal of what actually matters)" : " (most prominent content words in problem_statement; supply target_desired_outcome for a stronger signal)"}`
          : `No content terms could be extracted from problem_statement (too short or all stopwords).`,
    },
    {
      stage: 6,
      name: "RECONSTRUCT",
      thai_name: "สร้างใหม่",
      cognitive_action: "Synthesize targeted solution respecting architectural constraints and intent",
      output: `Blueprint ordering the ${subtasks.length} sub-task(s) from Stage 3 against the core intent terms from Stage 5 [${coreTerms.join(", ") || "none extracted"}]: ${subtasks.map((s, i) => `Step ${i + 1}: ${s}`).join(" -> ")}.${failureCategories.length > 0 ? ` Mitigations should address: ${failureCategories.join(", ")}.` : ""}`,
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
    synthesized_solution: `[RCT-7 Reasoning Trail] ${subtasks.length}-step plan generated for "${problem_statement}" (core terms: ${coreTerms.join(", ") || "none"}) with heuristic alignment score ${alignmentScore.toFixed(4)}.`,
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
