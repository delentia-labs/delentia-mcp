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
            version: "2.0.0",
            benchmark: "74.2% - 91.5% token / VRAM reduction",
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
                    description: "Compresses verbose conversation history by extracting state deltas.",
                    inputSchema: {
                      type: "object",
                      properties: {
                        raw_context: { type: "string" },
                        intent_focus: { type: "string" },
                        aggressive_mode: { type: "boolean" },
                      },
                      required: ["raw_context"],
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
