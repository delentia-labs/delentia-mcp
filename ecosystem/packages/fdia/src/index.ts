/**
 * DELENTIA SOVEREIGN AI OS — FDIA SECURITY MCP SERVER
 * Dynamic Policy Governance and Parameter A Evaluation Gate
 * 
 * Chief Architect: อิทธิฤทธิ์ แซ่โง้ว (Ittirit Saengow) — Delentia Labs
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  defaultFDIAEngine,
  FDIAEngine,
  type FDIAEvaluationResult,
  type FDIAPolicy,
  type FDIARule,
  FDIAPolicySchema,
  FDIARuleSchema,
  configureTrustedArchitectKeys,
  parseTrustedArchitectKeys,
} from "@delentia/shared";

// Round 48: keys trusted to sign Architect tokens come only from the environment.
configureTrustedArchitectKeys(parseTrustedArchitectKeys(process.env.FDIA_ARCHITECT_KEYS_JSON));

// Active engine instance for the MCP server session
let activeEngine: FDIAEngine = defaultFDIAEngine;

/**
 * Creates and configures the Delentia FDIA Security MCP Server instance
 */
export function createFDIAMcpServer() {
  const server = new McpServer({
    name: "delentia-fdia",
    version: "2.0.0",
  });

  // Tool 1: Evaluate FDIA with Dynamic Policy Evaluation
  server.registerTool(
    "evaluate_fdia",
    {
      description:
        "Evaluates action requests through the deterministic ZK-FDIA equation F = (D^I) * A and enterprise custom policy rules (Action allowlists, Conditional path checks, Human Architect Signatures, RBAC, and Dual Sign-off).",
      inputSchema: {
        data_quality: z
          .number()
          .min(0.0)
          .max(1.0)
          .describe("D (Data Quality): Integrity and sufficiency coefficient of input data (0.0 to 1.0)"),
        intent_precision: z
          .number()
          .min(0.5)
          .default(1.0)
          .describe("I (Intent Precision): Precision exponent amplifying data towards user authentic goal (>= 0.5)"),
        authorized: z
          .boolean()
          .optional()
          .default(true)
          .describe("Legacy boolean flag for parameter A (true = 1, false = 0)"),
        action_name: z
          .string()
          .describe("Identifier of the tool or privileged system operation requested (Intent Code)"),
        target_payload: z
          .string()
          .optional()
          .describe("Target payload, file path, or query arguments for conditional security checks"),
        architect_token: z
          .string()
          .optional()
          .describe("Cryptographic Architect Token or digital signature required for high-risk actions"),
        caller_role: z
          .string()
          .optional()
          .default("developer")
          .describe("Role identifier of the caller (e.g. Chief_Architect, DevOps_Lead, developer, auditor)"),
        caller_context: z
          .string()
          .optional()
          .describe("Contextual background or origin of the operation"),
        dual_signoff_confirmed: z
          .boolean()
          .optional()
          .default(false)
          .describe("Whether dual human architect approval has been confirmed"),
        custom_policy: FDIAPolicySchema
          .optional()
          .describe("Ad-hoc enterprise policy rules override for this specific execution"),
      } as any,
    },
    async (args: any) => {
      const {
        data_quality,
        intent_precision,
        authorized,
        action_name,
        target_payload,
        architect_token,
        caller_role,
        caller_context,
        dual_signoff_confirmed,
        custom_policy,
      } = args;

      const engine = custom_policy ? new FDIAEngine(custom_policy) : activeEngine;

      const result: FDIAEvaluationResult = engine.evaluate({
        data_quality: Number(data_quality ?? 0.85),
        intent_precision: Number(intent_precision ?? 1.0),
        authorized: Boolean(authorized ?? true),
        action_name: String(action_name ?? "unspecified_action"),
        target_payload: target_payload ? String(target_payload) : undefined,
        architect_token: architect_token ? String(architect_token) : undefined,
        caller_role: caller_role ? String(caller_role) : "developer",
        caller_context: caller_context ? String(caller_context) : undefined,
        dual_signoff_confirmed: Boolean(dual_signoff_confirmed ?? false),
        custom_policy,
      });

      const responseText = [
        `### Delentia FDIA Security Gate Verdict: ${result.verdict}`,
        `- **Target Action:** \`${result.action_name}\``,
        `- **Caller Role:** \`${result.caller_role}\``,
        `- **Applied Policy ID:** \`${result.applied_policy_id}\``,
        `- **Future Safety Score (F):** **${result.future_score.toFixed(4)}** (Threshold >= ${result.safety_threshold.toFixed(4)})`,
        `- **Data Quality (D):** ${result.data_quality.toFixed(2)}`,
        `- **Intent Precision (I):** ${result.intent_precision.toFixed(2)}`,
        `- **Architect Gate (A):** **${result.effective_A === 1 ? "OPEN (1)" : "CLOSED (0)"}** (Triggered: \`${result.rule_triggered}\`)`,
        `- **Mathematical Status:** ${result.effective_A === 0 ? "F collapsed unconditionally to 0.0000 via Gate A = 0" : "Authorized under active policy bounds"}`,
        `- **Audit Digest (SHA-256):** \`${result.audit_digest}\``,
        `- **Timestamp:** ${result.timestamp}`,
        `- **Decision Explanation:** ${result.reason}`,
        result.violations.length > 0 ? `\n**Violations & Security Directives:**\n${result.violations.map((v) => `  * ${v}`).join("\n")}` : "",
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

  // Tool 2: Configure Enterprise Custom Policy
  server.registerTool(
    "configure_policy",
    {
      description:
        "Configures or updates the complete Enterprise Custom Policy for parameter A, including dynamic rules array, fallback policy, denied paths, and safety thresholds.",
      inputSchema: {
        policy: FDIAPolicySchema.describe("Full FDIAPolicy JSON configuration object"),
      } as any,
    },
    async (args: any) => {
      const parsedPolicy = FDIAPolicySchema.parse(args.policy);
      activeEngine = new FDIAEngine(parsedPolicy);

      const responseText = [
        `# Enterprise Custom Policy Configured Successfully`,
        `- **Policy ID:** ${parsedPolicy.policy_id || "custom-policy"}`,
        `- **Policy Name:** ${parsedPolicy.policy_name || "Custom Enterprise Policy"}`,
        `- **Organization:** ${parsedPolicy.organization_id || "enterprise"}`,
        `- **Default Fallback A:** ${parsedPolicy.default_fallback_A}`,
        `- **Safety Threshold:** ${parsedPolicy.custom_safety_threshold ?? 0.5}`,
        `- **Total Rules Loaded:** ${parsedPolicy.rules?.length || 0}`,
        parsedPolicy.rules && parsedPolicy.rules.length > 0
          ? `\n**Active Rules:**\n` + parsedPolicy.rules.map((r) => `  * [${r.rule_id}] (${r.action_type}) Assigned A: ${r.assigned_A} -> Patterns: ${r.intent_patterns.join(", ")}`).join("\n")
          : "",
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

  // Tool 3: Add Dynamic Policy Rule
  server.registerTool(
    "add_policy_rule",
    {
      description:
        "Dynamically injects a new security governance rule for parameter A at runtime without restarting the server.",
      inputSchema: {
        rule: FDIARuleSchema.describe("Governance rule object defining intent patterns, action type (ALLOW, CONDITIONAL, REQUIRE_HUMAN_SIGNATURE), and assigned A value"),
      } as any,
    },
    async (args: any) => {
      const validatedRule = FDIARuleSchema.parse(args.rule);
      activeEngine.addRule(validatedRule);

      const responseText = [
        `# Dynamic Rule Injected Successfully into Parameter A Gate`,
        `- **Rule ID:** \`${validatedRule.rule_id}\``,
        `- **Action Type:** \`${validatedRule.action_type}\``,
        `- **Assigned A:** ${validatedRule.assigned_A}`,
        `- **Intent Patterns:** ${validatedRule.intent_patterns.map((p) => `\`${p}\``).join(", ")}`,
        `- **Requires Human Confirmation:** ${validatedRule.require_human_confirmation ? "YES" : "NO"}`,
        validatedRule.denied_paths ? `- **Denied Paths:** ${validatedRule.denied_paths.join(", ")}` : "",
        validatedRule.human_approver_role ? `- **Permitted Signers:** ${validatedRule.human_approver_role.join(", ")}` : "",
        `- **Description:** ${validatedRule.description || "N/A"}`,
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

  // Tool 4: Get Active Policy
  server.registerTool(
    "get_active_policy",
    {
      description:
        "Retrieves the currently loaded Enterprise Security Policy governing parameter A and FDIA evaluation.",
      inputSchema: {} as any,
    },
    async () => {
      const policy = activeEngine.getPolicy();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(policy, null, 2),
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
