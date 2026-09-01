import { orchestrateSwarm, type OrchestrateSwarmInput } from "./index.js";
import { captureException } from "@delentia/shared";
export { JITNASessionDO } from "./session-do.js";

interface Env {
  JITNA_SESSION_DO: DurableObjectNamespace;
  ENVIRONMENT?: string;
  SERVER_NAME?: string;
  SENTRY_DSN?: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const serverName = env.SERVER_NAME || "Delentia JITNA Swarm Orchestrator MCP";

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
            server: "delentia-jitna",
            name: serverName,
            version: "2.0.0",
            architecture: "1+N Multi-Agent Swarm",
            pillars: ["The Router", "The Guardian", "The Executor", "The Scribe"],
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
            name: "Delentia JITNA Swarm Orchestrator",
            version: "2.0.0",
            description: "Intent-driven multi-agent orchestration framework coordinating 1+4 Specialized Pillar Agents (Router, Guardian, Executor, Scribe).",
            vendor: {
              name: "Delentia Labs",
              url: "https://delentia.com",
              portalUrl: "https://delentia-gateway-main-c7624a5.zuplo.site",
              contactEmail: "founder@delentia.com"
            },
            servers: [
              {
                id: "delentia-jitna",
                name: "Delentia JITNA Swarm Orchestrator",
                transport: { type: "streamable-http", url: `${url.origin}/mcp` },
                tools: ["orchestrate_swarm"]
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
                  name: "delentia-jitna",
                  version: "2.0.0",
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

        if (body.method === "tools/call" || body.tool === "orchestrate_swarm" || body.objective) {
          const args = body.params?.arguments || body.params || body;
          const params: OrchestrateSwarmInput = {
            objective: args.objective ?? "General system task",
            data_readiness: args.data_readiness ?? 80,
            target_pillar: args.target_pillar ?? "auto",
            context_params: args.context_params,
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
                    name: "orchestrate_swarm",
                    description: "Encapsulates objectives into JITNA packets and coordinates 1+4 Specialized Pillar Agents (Router, Guardian, Executor, Scribe).",
                    inputSchema: {
                      type: "object",
                      properties: {
                        objective: {
                          type: "string",
                          description: "High-level mission or task directive to be decomposed and orchestrated across agent pillars.",
                        },
                        data_readiness: {
                          type: "number",
                          minimum: 0,
                          maximum: 100,
                          description: "Percentage readiness of input data dependencies (0 to 100).",
                        },
                        target_pillar: {
                          type: "string",
                          enum: ["auto", "router", "guardian", "executor", "scribe"],
                          description: "Optional specific LoRA adapter designation, or 'auto' for dynamic routing.",
                        },
                        context_params: {
                          type: "object",
                          description: "Key-value dictionary containing auxiliary runtime state or environmental variables.",
                        },
                      },
                      required: ["objective"],
                    },
                    outputSchema: {
                      type: "object",
                      properties: {
                        objective: { type: "string", description: "Original mission objective." },
                        jitna_packet: { type: "object", description: "Decomposed JITNA v3 execution packet (I, D, delta, A, R, M)." },
                        assigned_pillars: { type: "array", description: "Specialized pillar agent assignments with expected sub-tasks and switch latencies." },
                        swarm_strategy: { type: "string", description: "Dynamic LoRA switching execution strategy." },
                      },
                      required: ["objective", "jitna_packet", "assigned_pillars"],
                    },
                    annotations: {
                      audience: ["user", "assistant"],
                      priority: 0.9,
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
