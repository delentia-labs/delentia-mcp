import { compressContext, type CompressContextInput } from "./index.js";
export { DeltaSessionDO } from "./session-do.js";

interface Env {
  DELTA_SESSION_DO: DurableObjectNamespace;
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
          server: "delentia-delta",
          description: "Delentia Delta Engine Context Compressor MCP Server",
          version: "1.0.0",
          benchmark: "74.2% - 91.5% token / VRAM reduction",
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

        if (body.method === "tools/call" || body.tool === "compress_context" || body.raw_context) {
          const params: CompressContextInput = {
            raw_context: body.params?.raw_context ?? body.raw_context ?? "",
            intent_focus: body.params?.intent_focus ?? body.intent_focus,
            aggressive_mode: body.params?.aggressive_mode ?? body.aggressive_mode ?? false,
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
                    name: "compress_context",
                    description:
                      "Compresses verbose conversation history, logs, or codebase context by extracting State Deltas based on the user's authentic intent. Reduces context window token and VRAM usage by up to 74.2% - 91.5%.",
                    inputSchema: {
                      type: "object",
                      properties: {
                        raw_context: {
                          type: "string",
                          description: "The verbose conversation history, documents, or logs to compress",
                        },
                        intent_focus: {
                          type: "string",
                          description: "The specific goal or task that determines which details to retain",
                        },
                        aggressive_mode: {
                          type: "boolean",
                          description: "When true, strips boilerplate and retains only high-entropy semantic delta diffs",
                        },
                      },
                      required: ["raw_context"],
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
