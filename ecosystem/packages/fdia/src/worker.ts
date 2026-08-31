import { evaluateFDIA, type FDIARequest } from "@delentia/shared";
export { FDIASessionDO } from "./session-do.js";

interface Env {
  FDIA_SESSION_DO: DurableObjectNamespace;
  ENVIRONMENT?: string;
  SERVER_NAME?: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, x-delentia-intent",
        },
      });
    }

    // Health check endpoint
    if (url.pathname === "/health" || url.pathname === "/") {
      return new Response(
        JSON.stringify({
          status: "healthy",
          server: "delentia-fdia",
          description: "Delentia FDIA Security MCP Server",
          version: "1.0.0",
          equation: "F = (D^I) * A",
          endpoints: {
            mcp_rpc: "/mcp",
            sse_legacy: "/sse",
            health: "/health",
          },
          environment: env.ENVIRONMENT || "production",
        }),
        {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }

    // Streamable HTTP / Tool RPC endpoint
    if (url.pathname === "/mcp" && request.method === "POST") {
      try {
        const body: any = await request.json();

        // Extract auth state from header or body
        const authHeader = request.headers.get("Authorization");
        const hasValidAuth = Boolean(authHeader && authHeader.startsWith("Bearer "));

        // If direct tool evaluation
        if (body.method === "tools/call" || body.tool === "evaluate_fdia" || body.action_name) {
          const params: FDIARequest = {
            data_quality: body.params?.data_quality ?? body.data_quality ?? 0.85,
            intent_precision: body.params?.intent_precision ?? body.intent_precision ?? 1.2,
            authorized: body.params?.authorized ?? body.authorized ?? hasValidAuth,
            action_name: body.params?.action_name ?? body.action_name ?? "unnamed_action",
            caller_context: body.params?.caller_context ?? body.caller_context,
          };

          const result = evaluateFDIA(params);

          // Record session in Durable Object asynchronously
          try {
            const doId = env.FDIA_SESSION_DO.idFromName("global_audit_session");
            const doStub = env.FDIA_SESSION_DO.get(doId);
            ctx.waitUntil(
              doStub.fetch("http://do/record", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(result),
              })
            );
          } catch {
            // Non-blocking in dev mode
          }

          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id ?? 1,
              result: {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(result, null, 2),
                  },
                ],
                isError: !result.authorized,
              },
            }),
            {
              headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
              },
            }
          );
        }

        // Standard MCP Tools List
        if (body.method === "tools/list") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id ?? 1,
              result: {
                tools: [
                  {
                    name: "evaluate_fdia",
                    description:
                      "Evaluates action requests through the deterministic ZK-FDIA equation F = (D^I) * A to ensure mathematical safety and prevent unauthorized or adversarial tool calls.",
                    inputSchema: {
                      type: "object",
                      properties: {
                        data_quality: {
                          type: "number",
                          minimum: 0.0,
                          maximum: 1.0,
                          description: "D (Data Quality): Integrity and sufficiency coefficient of input data (0.0 to 1.0)",
                        },
                        intent_precision: {
                          type: "number",
                          minimum: 1.0,
                          description: "I (Intent Precision): Precision exponent amplifying data towards user goal (>= 1.0)",
                        },
                        authorized: {
                          type: "boolean",
                          description: "A (Architect Gate): Authorization state. If false, F collapses to 0 immediately",
                        },
                        action_name: {
                          type: "string",
                          description: "Identifier of the tool or privileged system operation requested",
                        },
                        caller_context: {
                          type: "string",
                          description: "Contextual background or origin of the operation",
                        },
                      },
                      required: ["data_quality", "action_name"],
                    },
                  },
                ],
              },
            }),
            {
              headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
              },
            }
          );
        }

        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id ?? null,
            error: { code: -32601, message: "Method not found" },
          }),
          {
            status: 404,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          }
        );
      } catch (err: any) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: err?.message || "Internal server error" },
          }),
          {
            status: 500,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          }
        );
      }
    }

    return new Response("Endpoint Not Found", { status: 404 });
  },
};
