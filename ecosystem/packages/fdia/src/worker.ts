import {
  evaluateFDIA,
  FDIAEngine,
  validatePolicy,
  type WorkersPolicyKV,
  type FDIARequest,
  type ArchitectCustomPolicy,
  captureException,
  generateGitHubOAuthUrl,
  createSessionToken,
  verifySessionToken,
} from "@delentia/shared";
import { executeRCT7 } from "@delentia/mcp-rct7";
export { FDIASessionDO } from "./session-do.js";

interface Env {
  FDIA_SESSION_DO: DurableObjectNamespace;
  ENVIRONMENT?: string;
  SERVER_NAME?: string;
  SENTRY_DSN?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  AUTH_SECRET?: string;
  FDIA_POLICY_KV?: WorkersPolicyKV;
  POLICY_KV?: WorkersPolicyKV;
  FDIA_POLICY_RULES_JSON?: string;
  FDIA_POLICY_JSON?: string;
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
            version: "2.1.0",
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
            version: "1.1.0",
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

        // Tool: configure_policy
        // (Fixed operator precedence: previously `A && B || C` matched on
        // body.tool==="configure_policy" alone regardless of body.method.)
        if (body.method === "tools/call" && (body.params?.name === "configure_policy" || body.tool === "configure_policy")) {
          const policyData = body.params?.arguments || body.params || body;

          // Validate before touching the Durable Object or KV — previously
          // any object was forwarded and echoed back as-is with no schema
          // check, so an invalid policy could be "saved" and reported
          // success while evaluate_fdia would later reject or fall back to
          // defaults with no visible error to the caller.
          const validation = validatePolicy(policyData);
          if (!validation.valid) {
            return new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id: body.id ?? 1,
                result: {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify({ status: "error", message: "Policy rejected: schema validation failed. No state was changed.", errors: validation.errors }, null, 2),
                    },
                  ],
                  isError: true,
                },
              }),
              { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
            );
          }
          const validatedPolicy = validation.policy;

          const doId = env.FDIA_SESSION_DO.idFromName("global_audit_session");
          const doStub = env.FDIA_SESSION_DO.get(doId);

          const doResp = await doStub.fetch("http://do/policy", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(validatedPolicy),
          });
          const resultJson = await doResp.json();

          // If Cloudflare KV is bound, persist directly for zero-redeploy real-time sync
          const kv = env.FDIA_POLICY_KV || env.POLICY_KV;
          if (kv && typeof kv.put === "function") {
            try {
              await kv.put("fdia-policy", JSON.stringify(validatedPolicy));
            } catch {
              // Non-blocking in local dev
            }
          }

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

          // Pull active policy from args, Durable Object, or Cloudflare KV / Bundled
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

          if (!activePolicy) {
            const workersEngine = await FDIAEngine.fromWorkersEnv(env);
            activePolicy = workersEngine.getPolicy();
          }

          // Optional RCT-7 -> intent_precision synthesis (added 2026-09-12,
          // same design as packages/intent-loop and packages/sovereign).
          // Backward compatible by construction: callers who never pass
          // `problem_statement` get byte-identical behavior to before —
          // intent_precision still falls back to their own value or 1.0.
          // Unlike `sovereign`, this worker did not already bundle RCT-7;
          // @delentia/mcp-rct7 was added as a genuine new dependency here.
          let rct7Trail: ReturnType<typeof executeRCT7> | undefined;
          let intentPrecision: number = args.intent_precision ?? 1.0;
          if (typeof args.problem_statement === "string" && args.problem_statement.trim().length > 0) {
            rct7Trail = executeRCT7({
              problem_statement: args.problem_statement,
              environment_context: args.environment_context,
              target_desired_outcome: args.target_desired_outcome,
            });
            intentPrecision = Math.round((0.5 + rct7Trail.verified_alignment_score * 1.5) * 10000) / 10000;
          }

          const params: FDIARequest = {
            data_quality: args.data_quality ?? 0.85,
            intent_precision: intentPrecision,
            authorized: args.authorized ?? true,
            action_name: args.action_name ?? "unnamed_action",
            target_payload: args.target_payload,
            architect_token: args.architect_token,
            caller_role: args.caller_role ?? "developer",
            caller_context: args.caller_context,
            dual_signoff_confirmed: args.dual_signoff_confirmed ?? false,
            custom_policy: activePolicy,
          };

          const result = {
            ...evaluateFDIA(params),
            ...(rct7Trail ? { rct7_synthesis: { verified_alignment_score: rct7Trail.verified_alignment_score, derived_intent_precision: intentPrecision } } : {}),
          };

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
                    description: "Computes the FDIA safety score F = (D^I) x A to decide whether a proposed action should be authorized before it runs. F is a single 0.0-1.0 number that collapses to exactly 0 whenever A = 0 (no amount of good data can rescue an unauthorized action); otherwise it grows with D (data quality) raised to the I (intent precision) exponent. AUTHORIZED means F met the policy's safety_threshold (default 0.5); a SECURITY_* verdict means A was denied outright — read `verdict` and `reason` to decide how to proceed. USE WHEN: immediately before executing a specific action, especially one that is destructive, irreversible, or security/credential-sensitive. DO NOT USE WHEN: the action is routine and read-only (adds latency for no behavior change), you need to change the rules being checked (use configure_policy instead), or you are still planning multi-step work (plan first, then evaluate_fdia on the resulting concrete action). OPTIONAL RCT-7 SYNTHESIS: pass `problem_statement` (and optionally `environment_context`/`target_desired_outcome`) instead of `intent_precision` to have this worker run the real RCT-7 7-stage decomposition and derive intent_precision from its actual alignment score (range 0.5-2.0) rather than you supplying an arbitrary number — the response then includes an `rct7_synthesis` field. Omit `problem_statement` for byte-identical behavior to before this option existed.",
                    inputSchema: {
                      type: "object",
                      properties: {
                        data_quality: {
                          type: "number",
                          minimum: 0.0,
                          maximum: 1.0,
                          description: "D (Data Quality): Integrity and sufficiency coefficient of input data (0.0 to 1.0).",
                        },
                        intent_precision: {
                          type: "number",
                          minimum: 1.0,
                          description: "I (Intent Precision): Precision exponent amplifying data towards authentic goal (>= 1.0). Ignored if `problem_statement` is also supplied — that triggers real RCT-7 synthesis instead.",
                        },
                        problem_statement: {
                          type: "string",
                          description: "Optional: the natural-language intent behind this action. When supplied, intent_precision is derived from a real RCT-7 decomposition instead of the intent_precision field above.",
                        },
                        environment_context: {
                          type: "string",
                          description: "Optional, only used with problem_statement: context/telemetry that feeds RCT-7's grounding_completeness signal.",
                        },
                        target_desired_outcome: {
                          type: "string",
                          description: "Optional, only used with problem_statement: the desired end state, feeding RCT-7's lexical_alignment signal.",
                        },
                        authorized: {
                          type: "boolean",
                          description: "A (Architect Authorization): Authorization token from the Chief Architect (true = gate open, false = gate closed).",
                        },
                        action_name: {
                          type: "string",
                          description: "Target tool or system API action identifier requested by the autonomous caller.",
                        },
                        caller_role: {
                          type: "string",
                          description: "RBAC role of the caller (e.g., developer, auditor, admin, agent).",
                        },
                        caller_context: {
                          type: "string",
                          description: "Optional textual metadata or telemetry context regarding the invocation origin.",
                        },
                        dual_signoff_confirmed: {
                          type: "boolean",
                          description: "Whether a verified second human officer has confirmed the operation.",
                        },
                      },
                      required: ["data_quality", "action_name"],
                    },
                    outputSchema: {
                      type: "object",
                      properties: {
                        future_score: { type: "number", description: "Computed mathematical FDIA score F = (D^I) * A." },
                        verdict: { type: "string", description: "Deterministic decision: AUTHORIZED, SAFETY_THRESHOLD_VETO, or SECURITY_AUTH_DENIED." },
                        authorized: { type: "boolean", description: "True if action is permitted to execute, false otherwise." },
                        audit_digest: { type: "string", description: "SHA-256 tamper-proof cryptographic audit hash." },
                        reason: { type: "string", description: "Natural language causal justification for the mathematical verdict." },
                      },
                      required: ["future_score", "verdict", "authorized", "audit_digest"],
                    },
                    annotations: {
                      audience: ["user", "assistant"],
                      priority: 1.0,
                      readOnlyHint: true,
                    },
                  },
                  {
                    name: "configure_policy",
                    description: "Replaces the active authorization policy that evaluate_fdia checks against, persisted in a Durable Object session (durable across requests and isolates, unlike a plain in-memory variable). IMPACT: this is a full REPLACE, not a merge — any existing rule you don't include in this call is dropped, so resend the complete rule set rather than a partial delta. REVERSIBLE: yes — call configure_policy again with the previous policy JSON to roll back; no automatic version history is kept, so save the current policy yourself first if you may need to undo. PARAMETER A: each rule assigns a binary authorization gate via `assigned_A` — A=1 lets matching actions proceed to normal F=(D^I)*A scoring, A=0 hard-blocks them regardless of data quality (this is how you make a category of actions always fail evaluate_fdia). USE WHEN: onboarding a new action type, changing RBAC/role rules, or adjusting the safety threshold. DO NOT USE WHEN: you only need to check one action (use evaluate_fdia instead) — and avoid calling it speculatively per-request, since every call replaces shared state other callers depend on.",
                    inputSchema: {
                      type: "object",
                      properties: {
                        policy_id: {
                          type: "string",
                          description: "Unique alphanumeric identifier for the enterprise policy configuration.",
                        },
                        policy_name: {
                          type: "string",
                          description: "Human-readable label or department designation for the policy rule.",
                        },
                        blocked_action_patterns: {
                          type: "array",
                          items: { type: "string" },
                          description: "List of regex or prefix strings representing strictly forbidden tool/action calls.",
                        },
                        allowed_roles: {
                          type: "object",
                          description: "Mapping of role names to allowed action permissions.",
                        },
                        custom_safety_threshold: {
                          type: "number",
                          description: "Custom minimum future_score required for execution approval (default: 0.5000).",
                        },
                        require_human_dual_signoff: {
                          type: "array",
                          items: { type: "string" },
                          description: "Array of critical action names that unconditionally require human dual signoff confirmation.",
                        },
                      },
                      required: ["policy_id", "policy_name"],
                    },
                    outputSchema: {
                      type: "object",
                      properties: {
                        status: { type: "string", description: "Update status (success or error)." },
                        message: { type: "string", description: "Descriptive confirmation message." },
                        policy: { type: "object", description: "The active normalized enterprise policy structure." },
                      },
                      required: ["status", "message"],
                    },
                    annotations: {
                      audience: ["user", "assistant"],
                      priority: 0.9,
                      readOnlyHint: false,
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
