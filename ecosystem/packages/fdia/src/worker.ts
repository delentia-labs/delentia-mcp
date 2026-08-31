import { evaluateFDIA, type FDIARequest, type ArchitectCustomPolicy } from "@delentia/shared";
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
          description: "Delentia FDIA Security MCP Server with Enterprise Custom Policy Engine",
          version: "1.1.0",
          equation: "F = (D^I) * A",
          features: [
            "Zero-Auth Preemption Cutoff",
            "Enterprise Policy Blacklist Patterns",
            "Role-Based Access Control (RBAC)",
            "Dual Human Sign-off Verification",
            "Custom Threshold Overrides",
            "Cloudflare Durable Objects Policy Persistence",
          ],
          endpoints: {
            mcp_rpc: "/mcp",
            policy_management: "/policy",
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

    // Direct Policy Management Endpoint (/policy)
    if (url.pathname === "/policy") {
      const doId = env.FDIA_SESSION_DO.idFromName("global_audit_session");
      const doStub = env.FDIA_SESSION_DO.get(doId);
      return doStub.fetch(request);
    }

    // Streamable HTTP / Tool RPC endpoint
    if (url.pathname === "/mcp" && request.method === "POST") {
      try {
        const body: any = await request.json();
        const authHeader = request.headers.get("Authorization");
        const hasValidAuth = Boolean(authHeader && authHeader.startsWith("Bearer "));

        // Case 1: configure_policy tool
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
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(resultJson, null, 2),
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

        // Case 2: evaluate_fdia tool
        if (body.method === "tools/call" || body.tool === "evaluate_fdia" || body.action_name) {
          const args = body.params?.arguments || body.params || body;

          // Retrieve active policy from Durable Object if not provided in args
          let activePolicy: ArchitectCustomPolicy | undefined = args.custom_policy;
          if (!activePolicy) {
            try {
              const doId = env.FDIA_SESSION_DO.idFromName("global_audit_session");
              const doStub = env.FDIA_SESSION_DO.get(doId);
              const policyResp = await doStub.fetch("http://do/policy");
              const stored = await policyResp.json() as any;
              if (stored && stored.policy_id) {
                activePolicy = stored;
              }
            } catch {
              // fallback to defaults
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

          // Asynchronously record session log in Durable Object
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
                      "Evaluates action requests through the deterministic ZK-FDIA equation F = (D^I) * A and enterprise custom policy rules (Action blacklists, RBAC, Dual Sign-off, and Threshold overrides).",
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
                    description:
                      "Configures or updates the Enterprise Custom Policy rules for parameter A (Action blacklists, RBAC permissions, safety thresholds, and dual sign-off requirements).",
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
          { status: 404, headers: { "Content-Type": "application/json" } }
        );
      } catch (err: any) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: err?.message || "Internal server error" },
          }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    return new Response("Endpoint Not Found", { status: 404 });
  },
};
