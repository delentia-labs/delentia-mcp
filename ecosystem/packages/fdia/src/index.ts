import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  evaluateFDIA,
  type FDIAEvaluationResult,
  type ArchitectCustomPolicy,
  ArchitectCustomPolicySchema,
} from "@delentia/shared";

// In-memory active policy for local/stdio runs
let inMemoryPolicy: ArchitectCustomPolicy | undefined;

/**
 * Creates and configures the Delentia FDIA Security MCP Server instance
 */
export function createFDIAMcpServer() {
  const server = new McpServer({
    name: "delentia-fdia",
    version: "1.1.0",
  });

  // Tool 1: Evaluate FDIA with Enterprise Custom Policy
  server.registerTool(
    "evaluate_fdia",
    {
      description:
        "Evaluates action requests through the deterministic ZK-FDIA equation F = (D^I) * A and enterprise custom policy rules (Action blacklists, RBAC, Dual Sign-off, and Threshold overrides).",
      inputSchema: {
        data_quality: z
          .number()
          .min(0.0)
          .max(1.0)
          .describe("D (Data Quality): Integrity and sufficiency coefficient of input data (0.0 to 1.0)"),
        intent_precision: z
          .number()
          .min(1.0)
          .default(1.0)
          .describe("I (Intent Precision): Precision exponent amplifying data towards the user's authentic goal (>= 1.0)"),
        authorized: z
          .boolean()
          .default(true)
          .describe("A (Architect Gate): Human authorization token. If false, F collapses to 0.0000 immediately"),
        action_name: z
          .string()
          .describe("Identifier of the tool or privileged system operation requested"),
        caller_role: z
          .string()
          .optional()
          .default("developer")
          .describe("Role identifier of the caller (e.g. admin, developer, junior_dev)"),
        caller_context: z
          .string()
          .optional()
          .describe("Contextual background or origin of the operation"),
        dual_signoff_confirmed: z
          .boolean()
          .optional()
          .default(false)
          .describe("Whether dual human architect approval has been confirmed"),
        custom_policy: ArchitectCustomPolicySchema.optional().describe("Ad-hoc enterprise policy rules for this execution"),
      } as any,
    },
    async (args: any) => {
      const {
        data_quality,
        intent_precision,
        authorized,
        action_name,
        caller_role,
        caller_context,
        dual_signoff_confirmed,
        custom_policy,
      } = args;

      const result: FDIAEvaluationResult = evaluateFDIA({
        data_quality: Number(data_quality ?? 0.85),
        intent_precision: Number(intent_precision ?? 1.0),
        authorized: Boolean(authorized ?? true),
        action_name: String(action_name ?? "unspecified_action"),
        caller_role: caller_role ? String(caller_role) : "developer",
        caller_context: caller_context ? String(caller_context) : undefined,
        dual_signoff_confirmed: Boolean(dual_signoff_confirmed ?? false),
        custom_policy: custom_policy || inMemoryPolicy,
      });

      const responseText = [
        `### Delentia FDIA Security Gate Verdict: ${result.verdict}`,
        `- **Target Action:** ${result.action_name}`,
        `- **Caller Role:** ${result.caller_role}`,
        `- **Applied Policy ID:** ${result.applied_policy_id}`,
        `- **Future Safety Score (F):** ${result.future_score.toFixed(4)} (Threshold >= ${result.safety_threshold.toFixed(4)})`,
        `- **Data Quality (D):** ${result.data_quality.toFixed(2)}`,
        `- **Intent Precision (I):** ${result.intent_precision.toFixed(2)}`,
        `- **Architect Gate (A):** ${result.authorized ? "OPEN (1)" : "CLOSED (0)"}`,
        `- **Audit Digest (SHA-256):** \`${result.audit_digest}\``,
        `- **Timestamp:** ${result.timestamp}`,
        `- **System Reason:** ${result.reason}`,
        result.violations.length > 0 ? `\n**Violations Detected:**\n${result.violations.map((v) => `  * ${v}`).join("\n")}` : "",
      ].filter(Boolean).join("\n");

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

  // Tool 2: Configure Enterprise Custom Policy for A
  server.registerTool(
    "configure_policy",
    {
      description:
        "Configures or updates the Enterprise Custom Policy rules for parameter A, including forbidden action patterns, RBAC permissions, safety thresholds, and dual sign-off requirements.",
      inputSchema: {
        policy_id: z.string().describe("Unique identifier for this enterprise policy"),
        policy_name: z.string().describe("Human-readable name of the policy"),
        blocked_action_patterns: z
          .array(z.string())
          .optional()
          .describe("Wildcard patterns of forbidden operations (e.g. ['*drop*', '*wipe*'])"),
        allowed_roles: z
          .record(z.array(z.string()))
          .optional()
          .describe("RBAC mapping: role name to array of permitted action patterns"),
        custom_safety_threshold: z
          .number()
          .min(0.0)
          .max(1.0)
          .optional()
          .describe("Custom threshold override (0.0 to 1.0)"),
        require_human_dual_signoff: z
          .array(z.string())
          .optional()
          .describe("Operations requiring explicit dual sign-off"),
      } as any,
    },
    async (args: any) => {
      inMemoryPolicy = {
        policy_id: String(args.policy_id || "custom_enterprise_policy"),
        policy_name: String(args.policy_name || "Custom Enterprise Policy"),
        blocked_action_patterns: Array.isArray(args.blocked_action_patterns)
          ? args.blocked_action_patterns
          : ["*drop*", "*truncate*", "*wipe*", "*export_credentials*"],
        allowed_roles: args.allowed_roles || undefined,
        custom_safety_threshold: typeof args.custom_safety_threshold === "number" ? args.custom_safety_threshold : 0.5,
        require_human_dual_signoff: Array.isArray(args.require_human_dual_signoff) ? args.require_human_dual_signoff : [],
      };

      const responseText = [
        `# Enterprise Custom Policy Configured Successfully`,
        `- **Policy ID:** ${inMemoryPolicy.policy_id}`,
        `- **Policy Name:** ${inMemoryPolicy.policy_name}`,
        `- **Blocked Patterns:** ${inMemoryPolicy.blocked_action_patterns?.join(", ") || "None"}`,
        `- **Safety Threshold:** ${inMemoryPolicy.custom_safety_threshold}`,
        `- **RBAC Roles Configured:** ${Object.keys(inMemoryPolicy.allowed_roles || {}).join(", ") || "Default"}`,
        `- **Dual Sign-off Required For:** ${inMemoryPolicy.require_human_dual_signoff?.join(", ") || "None"}`,
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
  const server = createFDIAMcpServer();
  const transport = new StdioServerTransport();
  server.connect(transport).catch((err) => {
    console.error("Failed to start Delentia FDIA MCP Server:", err);
    process.exit(1);
  });
}
