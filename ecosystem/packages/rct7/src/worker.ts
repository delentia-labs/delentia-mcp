import { executeRCT7, type RCT7Input } from "./index.js";
export { RCT7SessionDO } from "./session-do.js";

interface Env {
  RCT7_SESSION_DO: DurableObjectNamespace;
  ENVIRONMENT?: string;
  SERVER_NAME?: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    if (url.pathname === "/health" || url.pathname === "/") {
      return new Response(
        JSON.stringify({
          status: "healthy",
          server: "delentia-rct7",
          description: "Delentia RCT-7 Reverse Component Thinking MCP Server",
          version: "1.0.0",
          stages: [
            "1. OBSERVE (สังเกต)",
            "2. ANALYZE (วิเคราะห์)",
            "3. DECONSTRUCT (แยกส่วน)",
            "4. REVERSE REASONING (คิดย้อนกลับ)",
            "5. IDENTIFY CORE INTENT (ระบุเจตนาหลัก)",
            "6. RECONSTRUCT (สร้างใหม่)",
            "7. COMPARE WITH INTENT (เปรียบเทียบกับเจตนา)",
          ],
          endpoints: {
            mcp_rpc: "/mcp",
            health: "/health",
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

    if (url.pathname === "/mcp" && request.method === "POST") {
      try {
        const body: any = await request.json();

        if (body.method === "tools/call" || body.tool === "rct_think" || body.problem_statement) {
          const params: RCT7Input = {
            problem_statement:
              body.params?.problem_statement ?? body.problem_statement ?? "System initialization",
            environment_context: body.params?.environment_context ?? body.environment_context,
            target_desired_outcome: body.params?.target_desired_outcome ?? body.target_desired_outcome,
          };

          const result = executeRCT7(params);

          try {
            const doId = env.RCT7_SESSION_DO.idFromName("global_rct7_session");
            const doStub = env.RCT7_SESSION_DO.get(doId);
            ctx.waitUntil(
              doStub.fetch("http://do/record", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  timestamp: result.timestamp,
                  problem_statement: result.problem_statement,
                  core_intent: result.stages[4].output,
                  solution_summary: result.synthesized_solution,
                }),
              })
            );
          } catch {
            // Non-blocking in local dev
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

        if (body.method === "tools/list") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id ?? 1,
              result: {
                tools: [
                  {
                    name: "rct_think",
                    description:
                      "Executes the authentic Delentia 7-Stage Reverse Component Thinking mental operating system (Observe, Analyze, Deconstruct, Reverse Reasoning, Identify Core Intent, Reconstruct, Compare with Intent) to enforce strict logical coherence and eliminate AI hallucination.",
                    inputSchema: {
                      type: "object",
                      properties: {
                        problem_statement: {
                          type: "string",
                          description: "The initial problem, user intent, or task description to reason through",
                        },
                        environment_context: {
                          type: "string",
                          description: "Environment context, codebase metadata, or known constraints",
                        },
                        target_desired_outcome: {
                          type: "string",
                          description: "Desired final emergent state to reason backward from",
                        },
                      },
                      required: ["problem_statement"],
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
