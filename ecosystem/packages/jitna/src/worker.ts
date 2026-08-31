import { orchestrateSwarm, type OrchestrateSwarmInput } from "./index.js";
export { JITNASessionDO } from "./session-do.js";

interface Env {
  JITNA_SESSION_DO: DurableObjectNamespace;
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
          server: "delentia-jitna",
          description: "Delentia JITNA Multi-Agent Swarm Orchestrator MCP Server",
          version: "1.0.0",
          pillars: ["The Router", "The Guardian", "The Executor", "The Scribe"],
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

        if (body.method === "tools/call" || body.tool === "orchestrate_swarm" || body.objective) {
          const params: OrchestrateSwarmInput = {
            objective: body.params?.objective ?? body.objective ?? "General system task",
            data_readiness: body.params?.data_readiness ?? body.data_readiness ?? 80,
            target_pillar: body.params?.target_pillar ?? body.target_pillar ?? "auto",
            context_params: body.params?.context_params ?? body.context_params,
          };

          const result = orchestrateSwarm(params);

          try {
            const doId = env.JITNA_SESSION_DO.idFromName("global_jitna_session");
            const doStub = env.JITNA_SESSION_DO.get(doId);
            ctx.waitUntil(
              doStub.fetch("http://do/dispatch", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(result.jitna_packet),
              })
            );
          } catch {
            // Non-blocking in dev
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
                    name: "orchestrate_swarm",
                    description:
                      "Encapsulates complex user objectives into structured JITNA packets [I, D, Delta, A, R, M] and coordinates autonomous agent execution across the 1+4 Pillars LoRA Swarm (Router, Guardian, Executor, Scribe).",
                    inputSchema: {
                      type: "object",
                      properties: {
                        objective: {
                          type: "string",
                          description: "The overarching task, user prompt, or workflow to orchestrate",
                        },
                        data_readiness: {
                          type: "number",
                          minimum: 0,
                          maximum: 100,
                          description: "Data sufficiency score (0-100%) available for this mission",
                        },
                        target_pillar: {
                          type: "string",
                          enum: ["auto", "router", "guardian", "executor", "scribe"],
                          description: "Designated 1+4 LoRA pillar adapter, or 'auto' for dynamic routing",
                        },
                        context_params: {
                          type: "object",
                          description: "Optional key-value attributes for long-term memory persistence",
                        },
                      },
                      required: ["objective"],
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
