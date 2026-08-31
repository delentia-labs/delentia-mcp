import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { evaluateFDIA, type FDIAEvaluationResult } from "@delentia/shared";

/**
 * Creates and configures the Delentia FDIA Security MCP Server instance
 */
export function createFDIAMcpServer() {
  const server = new McpServer({
    name: "delentia-fdia",
    version: "1.0.0",
  });

  server.registerTool(
    "evaluate_fdia",
    {
      description:
        "Evaluates action requests through the deterministic ZK-FDIA equation F = (D^I) * A to ensure mathematical safety and prevent unauthorized or adversarial tool calls.",
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
          .describe("A (Architect Gate): Human-in-the-loop authorization token. If false, F collapses to 0.0000 immediately"),
        action_name: z
          .string()
          .describe("Identifier of the tool or privileged system operation requested"),
        caller_context: z
          .string()
          .optional()
          .describe("Contextual background or origin of the operation"),
      } as any,
    },
    async (args: any) => {
      const { data_quality, intent_precision, authorized, action_name, caller_context } = args;
      const result: FDIAEvaluationResult = evaluateFDIA({
        data_quality: Number(data_quality ?? 0.85),
        intent_precision: Number(intent_precision ?? 1.0),
        authorized: Boolean(authorized ?? true),
        action_name: String(action_name ?? "unspecified_action"),
        caller_context: caller_context ? String(caller_context) : undefined,
      });

      const responseText = [
        `### Delentia FDIA Security Gate Verdict: ${result.verdict}`,
        `- **Target Action:** ${result.action_name}`,
        `- **Future Safety Score (F):** ${result.future_score.toFixed(4)} (Threshold >= 0.5000)`,
        `- **Data Quality (D):** ${result.data_quality.toFixed(2)}`,
        `- **Intent Precision (I):** ${result.intent_precision.toFixed(2)}`,
        `- **Architect Gate (A):** ${result.authorized ? "OPEN (1)" : "CLOSED (0)"}`,
        `- **Audit Digest (SHA-256):** \`${result.audit_digest}\``,
        `- **Timestamp:** ${result.timestamp}`,
        `- **System Reason:** ${result.reason}`,
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
