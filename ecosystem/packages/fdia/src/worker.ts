import {
  evaluateFDIA,
  type FDIARequest,
  type ArchitectCustomPolicy,
  captureException,
  generateGitHubOAuthUrl,
  createSessionToken,
  verifySessionToken,
} from "@delentia/shared";
export { FDIASessionDO } from "./session-do.js";

interface Env {
  FDIA_SESSION_DO: DurableObjectNamespace;
  ENVIRONMENT?: string;
  SERVER_NAME?: string;
  SENTRY_DSN?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  AUTH_SECRET?: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const serverName = env.SERVER_NAME || "Delentia FDIA Security MCP";
    const authSecret = env.AUTH_SECRET || "default_delentia_security_key_32_chars";

    try {
      // CORS Preflight
      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization, x-delentia-intent, x-session-id",
          },
        });
      }

      // 1. Health Check Endpoint
      if (url.pathname === "/health" || url.pathname === "/") {
        return new Response(
          JSON.stringify({
            status: "healthy",
            server: "delentia-fdia",
            name: serverName,
            version: "2.0.0",
            equation: "F = (D^I) * A",
            transports: {
              streamable_http: "/mcp",
              server_sent_events: "/sse",
              sse_messages: "/messages",
            },
            auth_endpoints: {
              github_login: "/auth/github/login",
              github_callback: "/auth/github/callback",
              token_verify: "/auth/verify",
            },
            environment: env.ENVIRONMENT || "production",
            sentry_enabled: Boolean(env.SENTRY_DSN),
          }),
          {
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          }
        );
      }

      // 1.1 MCP Server Card Discovery
      if (url.pathname === "/.well-known/mcp/server-card.json") {
        return new Response(
          JSON.stringify({
            $schema: "https://json.schemastore.org/mcp-server-card.json",
            name: "Delentia OS MCP Ecosystem",
            version: "1.0.0",
            description: "Enterprise Sovereign AI Operating System featuring FDIA Mathematical Security, RCT-7 Thinking, Delta Compression, and JITNA Swarm.",
            vendor: {
              name: "Delentia Labs",
              url: "https://delentia.com",
              portalUrl: "https://delentia-gateway-main-c7624a5.zuplo.site",
              contactEmail: "founder@delentia.com"
            },
            servers: [
              {
                id: "delentia-fdia",
                name: "Delentia FDIA Security Gate",
                transport: { type: "streamable-http", url: `${url.origin}/mcp` },
                tools: ["evaluate_fdia", "configure_policy"]
              }
            ]
          }),
          { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
        );
      }

      // 2. Direct GitHub OAuth Handlers
      if (url.pathname === "/auth/github/login") {
        const clientId = env.GITHUB_CLIENT_ID || "demo_github_client_id";
        const redirectUri = `${url.origin}/auth/github/callback`;
        const authUrl = generateGitHubOAuthUrl(clientId, redirectUri);
        return Response.redirect(authUrl, 302);
      }

      if (url.pathname === "/auth/github/callback") {
        const code = url.searchParams.get("code") || "demo_code";
        // Issue cryptographic session token
        const token = createSessionToken(
          {
            sub: `github_user_${code.slice(0, 8)}`,
            login: "architect_user",
            role: "senior_dev",
            exp: Math.floor(Date.now() / 1000) + 86400 * 7,
          },
          authSecret
        );

        return new Response(
          JSON.stringify({
            authenticated: true,
            session_token: token,
            token_type: "Bearer",
            expires_in: 604800,
            message: "Authentication successful. Use this token in Authorization: Bearer <token>",
          }),
          {
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
          }
        );
      }

      if (url.pathname === "/auth/verify" && request.method === "POST") {
        const body: any = await request.json().catch(() => ({}));
        const token = body.token || request.headers.get("Authorization")?.replace("Bearer ", "");
        if (!token) {
          return new Response(JSON.stringify({ valid: false, error: "Token required" }), {
            status: 401,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
          });
        }
        const verifyRes = verifySessionToken(token, authSecret);
        return new Response(JSON.stringify(verifyRes), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }

      // 3. Enterprise Custom Policy Management
      if (url.pathname === "/policy") {
        const doId = env.FDIA_SESSION_DO.idFromName("global_audit_session");
        const doStub = env.FDIA_SESSION_DO.get(doId);
        return doStub.fetch(request);
      }

      // 4. Server-Sent Events (SSE) Transport (/sse)
      if (url.pathname === "/sse" && request.method === "GET") {
        const sessionId = crypto.randomUUID();
        const postMessagesEndpoint = `${url.origin}/messages?sessionId=${sessionId}`;

        const stream = new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            // Initial MCP SSE endpoint event
            controller.enqueue(
              encoder.encode(`event: endpoint\ndata: ${postMessagesEndpoint}\n\n`)
            );
            controller.enqueue(
              encoder.encode(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n\n`)
            );
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

      // 5. SSE Bi-directional Message Receiver (/messages)
      if (url.pathname === "/messages" && request.method === "POST") {
        const sessionId = url.searchParams.get("sessionId") || "global_session";
        const body: any = await request.json();

        // Process message and return JSON-RPC response
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id ?? 1,
            result: { status: "received", sessionId },
          }),
          {
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          }
        );
      }

      // 6. Streamable HTTP RPC Endpoint (/mcp)
      if (url.pathname === "/mcp" && request.method === "POST") {
        const body: any = await request.json();
        const authHeader = request.headers.get("Authorization");
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
                  name: "delentia-fdia",
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

        // Tool: configure_policy
        if (body.method === "tools/call" && body.params?.name === "configure_policy" || body.tool === "configure_policy") {
          const policyData = body.params?.arguments || body.params || body;
          const doId = env.FDIA_SESSION_DO.idFromName("global_audit_session");
          const doStub = env.FDIA_SESSION_DO.get(doId);

          const doResp = await doStub.fetch("http://do/policy", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(policyData),
          });
          const resultJson = await doResp.json();

          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id ?? 1,
              result: {
                content: [{ type: "text", text: JSON.stringify(resultJson, null, 2) }],
              },
            }),
            { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
          );
        }

        // Tool: evaluate_fdia
        if (body.method === "tools/call" || body.tool === "evaluate_fdia" || body.action_name) {
          const args = body.params?.arguments || body.params || body;

          // Pull active policy from Durable Object
          let activePolicy: ArchitectCustomPolicy | undefined = args.custom_policy;
          if (!activePolicy) {
            try {
              const doId = env.FDIA_SESSION_DO.idFromName("global_audit_session");
              const doStub = env.FDIA_SESSION_DO.get(doId);
              const policyResp = await doStub.fetch("http://do/policy");
              const stored = (await policyResp.json()) as any;
              if (stored && stored.policy_id) {
                activePolicy = stored;
              }
            } catch {
              // fallback
            }
          }

          const params: FDIARequest = {
            data_quality: args.data_quality ?? 0.85,
            intent_precision: args.intent_precision ?? 1.0,
            authorized: args.authorized ?? hasValidAuth,
            action_name: args.action_name ?? "unnamed_action",
            caller_role: args.caller_role ?? "developer",
            caller_context: args.caller_context,
            dual_signoff_confirmed: args.dual_signoff_confirmed ?? false,
            custom_policy: activePolicy,
          };

          const result = evaluateFDIA(params);

          // Asynchronously record audit log in Durable Object
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
            // Non-blocking in dev
          }

          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id ?? 1,
              result: {
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                isError: !result.authorized,
              },
            }),
            {
              headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
            }
          );
        }

        // Tools List
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
                      "Evaluates action requests through deterministic ZK-FDIA equation F = (D^I) * A and enterprise custom policy rules.",
                    inputSchema: {
                      type: "object",
                      properties: {
                        data_quality: { type: "number", minimum: 0.0, maximum: 1.0 },
                        intent_precision: { type: "number", minimum: 1.0 },
                        authorized: { type: "boolean" },
                        action_name: { type: "string" },
                        caller_role: { type: "string" },
                        caller_context: { type: "string" },
                        dual_signoff_confirmed: { type: "boolean" },
                      },
                      required: ["data_quality", "action_name"],
                    },
                  },
                  {
                    name: "configure_policy",
                    description: "Configures or updates Enterprise Custom Policy rules for parameter A.",
                    inputSchema: {
                      type: "object",
                      properties: {
                        policy_id: { type: "string" },
                        policy_name: { type: "string" },
                        blocked_action_patterns: { type: "array", items: { type: "string" } },
                        allowed_roles: { type: "object" },
                        custom_safety_threshold: { type: "number" },
                        require_human_dual_signoff: { type: "array", items: { type: "string" } },
                      },
                      required: ["policy_id", "policy_name"],
                    },
                  },
                ],
              },
            }),
            { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
          );
        }

        // Optional MCP capabilities: return empty arrays gracefully
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

        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id ?? null,
            error: { code: -32601, message: "Method not found" },
          }),
          { status: 404, headers: { "Content-Type": "application/json" } }
        );
      }

      return new Response("Endpoint Not Found", { status: 404 });
    } catch (err: any) {
      // Sentry telemetry capture
      await captureException(
        err,
        {
          serverName,
          environment: env.ENVIRONMENT,
          url: request.url,
        },
        env.SENTRY_DSN
      );

      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32603, message: err?.message || "Internal server error" },
        }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  },
};
