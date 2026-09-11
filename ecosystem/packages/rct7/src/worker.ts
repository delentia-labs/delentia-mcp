import { executeRCT7, type RCT7Input } from "./index.js";
import { captureException } from "@delentia/shared";
export { RCT7SessionDO } from "./session-do.js";

interface Env {
  RCT7_SESSION_DO: DurableObjectNamespace;
  ENVIRONMENT?: string;
  SERVER_NAME?: string;
  SENTRY_DSN?: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const serverName = env.SERVER_NAME || "Delentia RCT-7 Thinking MCP";

    try {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization, x-session-id",
          },
        });
      }

      if (url.pathname === "/health" || url.pathname === "/") {
        return new Response(
          JSON.stringify({
            status: "healthy",
            server: "delentia-rct7",
            name: serverName,
            version: "2.1.0",
            stages: 7,
            transports: {
              streamable_http: "/mcp",
              server_sent_events: "/sse",
              sse_messages: "/messages",
            },
            environment: env.ENVIRONMENT || "production",
            sentry_enabled: Boolean(env.SENTRY_DSN),
          }),
          { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
        );
      }

      // 1.1 MCP Server Card Discovery
      if (url.pathname === "/.well-known/mcp/server-card.json") {
        return new Response(
          JSON.stringify({
            $schema: "https://json.schemastore.org/mcp-server-card.json",
            name: "Delentia RCT-7 Thinking Engine",
            version: "2.1.0",
            description: "Authentic 7-Stage Reverse Component Thinking mental operating system to eliminate LLM hallucination and ensure causal intent alignment.",
            vendor: {
              name: "Delentia Labs",
              url: "https://delentia.com",
              portalUrl: "https://delentia-gateway-main-c7624a5.zuplo.site",
              contactEmail: "founder@delentia.com"
            },
            servers: [
              {
                id: "delentia-rct7",
                name: "Delentia RCT-7 Thinking Engine",
                transport: { type: "streamable-http", url: `${url.origin}/mcp` },
                tools: ["rct_think"]
              }
            ]
          }),
          { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
        );
      }

      // SSE Transport
      if (url.pathname === "/sse" && request.method === "GET") {
        const sessionId = crypto.randomUUID();
        const postMessagesEndpoint = `${url.origin}/messages?sessionId=${sessionId}`;

        const stream = new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode(`event: endpoint\ndata: ${postMessagesEndpoint}\n\n`));
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "Access-Control-Allow-Origin": "*",
            "x-session-id": sessionId,
          },
        });
      }

      if (url.pathname === "/messages" && request.method === "POST") {
        const sessionId = url.searchParams.get("sessionId") || "global_session";
        const body: any = await request.json();
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, result: { status: "received", sessionId } }),
          { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
        );
      }

      // Streamable HTTP RPC Endpoint
      if (url.pathname === "/mcp" && request.method === "POST") {
        const body: any = await request.json();

        // MCP initialize handshake
        if (body.method === "initialize") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id ?? 1,
              result: {
                protocolVersion: "2024-11-05",
                capabilities: {
                  tools: { listChanged: false },
                },
                serverInfo: {
                  name: "delentia-rct7",
                  version: "2.1.0",
                },
              },
            }),
            { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
          );
        }

        // MCP notifications/initialized
        if (body.method === "notifications/initialized") {
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? null, result: {} }), {
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
          });
        }

        // Optional MCP capabilities
        if (body.method === "resources/list") {
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, result: { resources: [] } }), {
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
          });
        }
        if (body.method === "prompts/list") {
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, result: { prompts: [] } }), {
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
          });
        }
        if (body.method === "triggers/list") {
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, result: { triggers: [] } }), {
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
          });
        }

        if (body.method === "tools/call" || body.tool === "rct_think" || body.problem_statement) {
          const args = body.params?.arguments || body.params || body;
          const params: RCT7Input = {
            problem_statement: args.problem_statement ?? "System initialization",
            environment_context: args.environment_context,
            target_desired_outcome: args.target_desired_outcome,
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
            // Non-blocking
          }

          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id ?? 1,
              result: {
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
              },
            }),
            { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
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
                    description: "Performs a structured 7-stage causal reasoning walkthrough (Observe, Analyze, Deconstruct, Reverse Reasoning, Identify Core Intent, Reconstruct, Compare with Intent) to produce an explicit, auditable reasoning trail before acting on a complex or ambiguous task. USE WHEN: a task has multiple plausible approaches or unclear scope and you want a documented plan before execution. DO NOT USE WHEN: the task is simple and unambiguous — this tool only produces a reasoning report, it does not check authorization (pair it with evaluate_fdia before acting) or execute anything itself (pair it with orchestrate_swarm or your own tooling to carry out the plan).",
                    inputSchema: {
                      type: "object",
                      properties: {
                        problem_statement: {
                          type: "string",
                          description: "The core challenge, complex query, or dilemma requiring rigorous reverse deconstruction.",
                        },
                        environment_context: {
                          type: "string",
                          description: "Optional environmental telemetry, operational constraints, or target ecosystem parameters.",
                        },
                        target_desired_outcome: {
                          type: "string",
                          description: "Optional explicit definition of the end-state against which reverse reasoning is anchored.",
                        },
                      },
                      required: ["problem_statement"],
                    },
                    outputSchema: {
                      type: "object",
                      properties: {
                        problem_statement: { type: "string", description: "Original problem statement received." },
                        stages: { type: "array", description: "Detailed 7-Stage cognitive outputs (Observe, Analyze, Deconstruct, Reverse Reasoning, Identify Core Intent, Reconstruct, Compare with Intent)." },
                        synthesized_solution: { type: "string", description: "Synthesized executive blueprint strictly causally aligned with core intent." },
                        verified_alignment_score: { type: "number", description: "Deterministic heuristic alignment score in [0,1], computed from grounding completeness, problem specificity, and lexical overlap between problem_statement and target_desired_outcome. Varies with input — not a constant. Not a semantic correctness guarantee; see docs/RCT7_SCORING_SPEC.md." },
                        alignment_breakdown: { type: "object", description: "Sub-scores behind verified_alignment_score: grounding_completeness, problem_specificity, lexical_alignment (each 0-1)." },
                      },
                      required: ["problem_statement", "stages", "synthesized_solution", "verified_alignment_score"],
                    },
                    annotations: {
                      audience: ["user", "assistant"],
                      priority: 0.95,
                      readOnlyHint: true,
                    },
                  },
                ],
              },
            }),
            { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
          );
        }

        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: body.id ?? null, error: { code: -32601, message: "Method not found" } }),
          { status: 404, headers: { "Content-Type": "application/json" } }
        );
      }

      return new Response("Endpoint Not Found", { status: 404 });
    } catch (err: any) {
      await captureException(err, { serverName, environment: env.ENVIRONMENT, url: request.url }, env.SENTRY_DSN);
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: err?.message || "Internal server error" } }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  },
};
