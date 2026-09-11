import { compressContext, type CompressContextInput } from "./index.js";
import { captureException } from "@delentia/shared";
export { DeltaSessionDO } from "./session-do.js";

interface Env {
  DELTA_SESSION_DO: DurableObjectNamespace;
  ENVIRONMENT?: string;
  SERVER_NAME?: string;
  SENTRY_DSN?: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const serverName = env.SERVER_NAME || "Delentia Delta Engine MCP";

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
            server: "delentia-delta",
            name: serverName,
            version: "2.1.0",
            note: "reduction_percentage is computed per-request from actual input (dedup + optional keyword filter); it is not a guaranteed range and can be negative on already-short/unique input.",
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
            name: "Delentia Delta Context Compressor",
            version: "2.1.0",
            description: "Context window optimizer that deduplicates and (with an intent focus) keyword-filters verbose text. Token reduction is computed per-request from actual input, not a fixed guarantee.",
            vendor: {
              name: "Delentia Labs",
              url: "https://delentia.com",
              portalUrl: "https://delentia-gateway-main-c7624a5.zuplo.site",
              contactEmail: "founder@delentia.com"
            },
            servers: [
              {
                id: "delentia-delta",
                name: "Delentia Delta Context Compressor",
                transport: { type: "streamable-http", url: `${url.origin}/mcp` },
                tools: ["compress_context"]
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
                  name: "delentia-delta",
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

        if (body.method === "tools/call" || body.tool === "compress_context" || body.raw_context) {
          const args = body.params?.arguments || body.params || body;
          const params: CompressContextInput = {
            raw_context: args.raw_context ?? "",
            intent_focus: args.intent_focus,
            aggressive_mode: args.aggressive_mode ?? false,
          };

          const result = compressContext(params);

          try {
            const doId = env.DELTA_SESSION_DO.idFromName("global_delta_session");
            const doStub = env.DELTA_SESSION_DO.get(doId);
            ctx.waitUntil(
              doStub.fetch("http://do/update", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  baseContextHash: result.context_hash,
                  totalOriginalTokens: result.estimated_original_tokens,
                  totalCompressedTokens: result.estimated_compressed_tokens,
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
                    name: "compress_context",
                    description: "Compresses verbose conversation history, logs, or codebase context by deduplicating repeated lines and, when `intent_focus` is provided, filtering to lines relevant to that intent. Token reduction is computed fresh per request from the actual input (highly variable — near-zero or even negative on already-short/unique input, higher on repetitive logs) — it is not a fixed guaranteed range. USE WHEN: context is large or repetitive and approaching a token budget; supply `intent_focus` for meaningfully better filtering — without it, only deduplication is applied. DO NOT USE WHEN: you need the content reasoned about (use rct_think) or expect true semantic summarization — this is line-level filtering, not an LLM rewrite, so it can drop details a summarizer would keep.",
                    inputSchema: {
                      type: "object",
                      properties: {
                        raw_context: {
                          type: "string",
                          description: "Full unstructured text, dialogue transcript, or JSON context requiring state compression.",
                        },
                        intent_focus: {
                          type: "string",
                          description: "Target focus anchor preserving only causal facts relevant to this objective.",
                        },
                        aggressive_mode: {
                          type: "boolean",
                          description: "Whether to strip all decorative conversational markers and preserve solely mathematical and functional deltas.",
                        },
                      },
                      required: ["raw_context"],
                    },
                    outputSchema: {
                      type: "object",
                      properties: {
                        original_char_count: { type: "number", description: "Character length of input context." },
                        compressed_char_count: { type: "number", description: "Character length of compressed delta representation." },
                        estimated_original_tokens: { type: "number", description: "Estimated token count of original context." },
                        estimated_compressed_tokens: { type: "number", description: "Estimated token count of compressed state." },
                        reduction_percentage: { type: "number", description: "Real computed token-saving percentage for this request (not clamped to a fixed range). Can be negative if the compression header overhead outweighs savings on already-short/unique input." },
                        compressed_delta_text: { type: "string", description: "Causally compressed state delta text." },
                        context_hash: { type: "string", description: "Cryptographic hash of the state transition." },
                      },
                      required: ["compressed_delta_text", "reduction_percentage", "context_hash"],
                    },
                    annotations: {
                      audience: ["user", "assistant"],
                      priority: 0.85,
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
