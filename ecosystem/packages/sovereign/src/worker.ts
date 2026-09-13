import { evaluateFDIA, FDIAEngine, validatePolicy, type ArchitectCustomPolicy } from "@delentia/shared";
export { MEEGrowthSessionDO } from "@delentia/shared";
import { executeRCT7, type RCT7Input } from "../../rct7/dist/index.js";
import { compressContext, type CompressContextInput } from "../../delta/dist/index.js";
import { orchestrateSwarm, type OrchestrateSwarmInput } from "../../jitna/dist/index.js";

interface Env {
  ENVIRONMENT?: string;
  SERVER_NAME?: string;
  FDIA_POLICY_KV?: KVNamespace;
  POLICY_KV?: KVNamespace;
  FDIA_POLICY_RULES_JSON?: string;
  FDIA_POLICY_JSON?: string;
  DELENTIA_GATEWAY_SECRET?: string;
  ZUPLO_SHARED_SECRET?: string;
  ENTERPRISE_API_KEYS?: string;
  MEE_SESSION_DO?: DurableObjectNamespace;
}

/**
 * Steps the MEE growth Durable Object for `sessionId` (defaults to "default",
 * a single shared aggregate representing the deployment's overall growth —
 * a deliberate, documented choice, not the silent global-DO pattern flagged
 * as a real bug elsewhere in ROADMAP.md; pass an explicit session_id in the
 * request to get an isolated per-caller trajectory instead). Best-effort:
 * a missing binding or a DO error never blocks the evaluate_fdia response —
 * growth tracking is an observability signal, not a security gate.
 */
async function stepMeeGrowth(
  env: Env,
  sessionId: string,
  delta: number,
  governanceViolation: boolean
): Promise<{ step: unknown; summary: unknown } | undefined> {
  if (!env.MEE_SESSION_DO) return undefined;
  try {
    const doId = env.MEE_SESSION_DO.idFromName(sessionId);
    const stub = env.MEE_SESSION_DO.get(doId);
    const resp = await stub.fetch("http://mee/step", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ delta, governance_violation: governanceViolation, session_id: sessionId }),
    });
    if (!resp.ok) return undefined;
    return (await resp.json()) as { step: unknown; summary: unknown };
  } catch {
    return undefined;
  }
}

// In-memory policy fallback
let activePolicy: ArchitectCustomPolicy | undefined;

// In-memory quota and rate-limit cache for Free Community Tier (50 calls/day per IP)
const freeUsageCache = new Map<string, number>();

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const serverName = env.SERVER_NAME || "Delentia Sovereign AI Ecosystem All-in-One MCP";

    try {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization, x-session-id, X-Delentia-Internal-Secret",
          },
        });
      }

      // Health Check and Discovery
      if ((url.pathname === "/health" || url.pathname === "/" || url.pathname === "/mcp") && request.method === "GET" && !request.headers.get("Accept")?.includes("text/event-stream")) {
        return new Response(
          JSON.stringify({
            status: "healthy",
            server: "delentia-sovereign",
            name: serverName,
            version: "2.1.0",
            ecosystem: "Unified 4-Pillar Architecture",
            pillars: ["FDIA Security Gate", "RCT-7 Reasoning Engine", "Delta Context Compressor", "JITNA Swarm Orchestrator"],
            tools_count: 5,
            tools: ["evaluate_fdia", "configure_policy", "rct_think", "compress_context", "orchestrate_swarm"],
            transports: {
              streamable_http: "/mcp",
              server_sent_events: "/sse",
              sse_messages: "/messages",
            },
            instructions: "To connect this MCP server to your IDE or Agent, use either Stdio Bridge via node delentia-mcp/bin/cli.js or direct Streamable HTTP POST to /mcp.",
          }),
          { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
        );
      }

      // Server-Sent Events (SSE) Transport (/sse or GET /mcp with Accept: text/event-stream)
      if ((url.pathname === "/sse" || (url.pathname === "/mcp" && request.headers.get("Accept")?.includes("text/event-stream"))) && request.method === "GET") {
        const sessionId = crypto.randomUUID();
        const postMessagesEndpoint = url.origin + "/messages?sessionId=" + sessionId;

        const stream = new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(
              encoder.encode("event: endpoint\ndata: " + postMessagesEndpoint + "\n\n")
            );
            controller.enqueue(
              encoder.encode("event: message\ndata: " + JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n\n")
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

      // 1.1 MCP Server Card Discovery
      if (url.pathname === "/.well-known/mcp/server-card.json") {
        return new Response(
          JSON.stringify({
            name: "Delentia Sovereign AI Ecosystem",
            version: "2.1.0",
            description: "Unified All-in-One Sovereign AI Operating System MCP Server bundling all 4 Core Pillars: FDIA Security, RCT-7 Reasoning, Delta Compression, and JITNA Swarm Orchestration.",
            vendor: {
              name: "Delentia Labs",
              url: "https://delentia.com",
              portalUrl: "https://delentia-gateway-main-c7624a5.zuplo.site",
              contactEmail: "founder@delentia.com"
            },
            servers: [
              {
                id: "delentia-sovereign",
                name: "Delentia Sovereign AI Ecosystem (All-in-One)",
                transport: { type: "streamable-http", url: url.origin + "/mcp" },
                tools: ["evaluate_fdia", "configure_policy", "rct_think", "compress_context", "orchestrate_swarm"]
              }
            ]
          }),
          { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
        );
      }

      // Unified Streamable HTTP RPC Endpoint (/mcp, /, /messages, /rpc)
      const isPostRpc = request.method === "POST" && (
        url.pathname === "/mcp" ||
        url.pathname === "/" ||
        url.pathname === "/rpc" ||
        url.pathname === "/messages"
      );

      if (isPostRpc) {
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
                  name: "delentia-sovereign",
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

        // Optional MCP capabilities: return empty arrays
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

        // ==========================================
        // HYBRID MONETIZATION & QUOTA GATEWAY
        // Discovery (initialize/tools/list) is open; tool execution is metered/paywalled
        // ==========================================
        let tierMeta = {
          tier: "free_sandbox",
          quota: "50 daily free calls active",
          portal: "https://delentia-gateway-main-c7624a5.zuplo.site",
          pricing: "https://delentia-gateway-main-c7624a5.zuplo.site/pricing",
        };

        if (body.method === "tools/call") {
          const authHeader = request.headers.get("Authorization") || "";
          const internalSecret = request.headers.get("X-Delentia-Internal-Secret") || request.headers.get("x-delentia-internal-secret") || "";
          const expectedSecret = env.ZUPLO_SHARED_SECRET || env.DELENTIA_GATEWAY_SECRET || "delentia_secret_gateway_token_2026_live";
          const clientIp = request.headers.get("x-caller-id") || request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "community_user";

          const isEnterprise = Boolean(
            (internalSecret && internalSecret === expectedSecret) ||
            authHeader.startsWith("Bearer zpka_") ||
            (env.ENTERPRISE_API_KEYS && env.ENTERPRISE_API_KEYS.split(",").includes(authHeader.replace("Bearer ", "")))
          );

          if (isEnterprise) {
            tierMeta = {
              tier: "enterprise_unlimited",
              quota: "unlimited_active (Enterprise Zuplo SLA 99.99%)",
              portal: "https://delentia-gateway-main-c7624a5.zuplo.site",
              pricing: "https://delentia-gateway-main-c7624a5.zuplo.site/pricing",
            };
          } else {
            const today = new Date().toISOString().slice(0, 10);
            const quotaKey = "quota:" + today + ":" + clientIp;
            let currentUsage = freeUsageCache.get(quotaKey) || 0;

            if (currentUsage >= 50) {
              return new Response(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: body.id ?? null,
                  error: {
                    code: -32002,
                    message: "Free Developer Sandbox quota exceeded (50/50 calls reached). To unlock unlimited enterprise access and sub-millisecond SLA, subscribe at: https://delentia-gateway-main-c7624a5.zuplo.site/pricing",
                    data: {
                      tier: "free_sandbox_expired",
                      limit: 50,
                      reset_at_utc: today + "T23:59:59Z",
                      commercial_portal: "https://delentia-gateway-main-c7624a5.zuplo.site/pricing",
                    },
                  },
                }),
                {
                  status: 429,
                  headers: {
                    "Content-Type": "application/json",
                    "Access-Control-Allow-Origin": "*",
                    "Retry-After": "86400",
                  },
                }
              );
            }

            currentUsage++;
            freeUsageCache.set(quotaKey, currentUsage);

            tierMeta = {
              tier: "free_sandbox",
              quota: currentUsage + "/50 daily calls used (" + (50 - currentUsage) + " remaining)",
              portal: "https://delentia-gateway-main-c7624a5.zuplo.site",
              pricing: "https://delentia-gateway-main-c7624a5.zuplo.site/pricing",
            };
          }
        }

        // ==========================================
        // TOOL 1: evaluate_fdia
        // ==========================================
        if (body.method === "tools/call" && (body.params?.name === "evaluate_fdia" || body.tool === "evaluate_fdia")) {
          const args = body.params?.arguments || body.params || body;

          // Load policy from KV or Environment if no inline policy passed
          const engine = activePolicy
            ? new FDIAEngine(activePolicy)
            : await FDIAEngine.fromWorkersEnv(env);

          // Optional RCT-7 -> intent_precision synthesis (added 2026-09-12,
          // same design as packages/intent-loop/src/index.ts). Backward
          // compatible by construction: existing callers who never pass
          // `problem_statement` get byte-identical behavior to before —
          // `intent_precision` still falls back to their own value or 1.0.
          // When `problem_statement` IS supplied, this worker (uniquely
          // among the standalone pillar workers) already has executeRCT7
          // bundled in the same deployment, so the real decomposition ->
          // I synthesis this whole session worked toward is available on
          // the production sovereign endpoint with no new dependency.
          let rct7Trail: ReturnType<typeof executeRCT7> | undefined;
          let intentPrecision = args.intent_precision ?? 1.0;
          if (typeof args.problem_statement === "string" && args.problem_statement.trim().length > 0) {
            rct7Trail = executeRCT7({
              problem_statement: args.problem_statement,
              environment_context: args.environment_context,
              target_desired_outcome: args.target_desired_outcome,
            });
            intentPrecision = Math.round((0.5 + rct7Trail.verified_alignment_score * 1.5) * 10000) / 10000;
          }

          const result = engine.evaluate({
            data_quality: args.data_quality ?? 0.5,
            intent_precision: intentPrecision,
            authorized: args.authorized ?? true,
            action_name: args.action_name ?? "default_action",
            target_payload: args.target_payload,
            architect_token: args.architect_token,
            caller_role: args.caller_role ?? "developer",
            caller_context: args.caller_context,
            dual_signoff_confirmed: args.dual_signoff_confirmed ?? false,
          });

          // Real, persistent MEE growth step (Durable-Object-backed, added
          // 2026-09-13). Unlike intent-loop's confidence-driven growth
          // (a post-execution signal from ConsensusVerifier — this worker
          // has no execution/verification pipeline, only the gate), the
          // growth signal here is the gate's own margin above/below
          // authorization: delta = future_score - 0.5, governance_violation
          // = !authorized. This matches the same design already used in
          // Delentia-OS/rct_control_plane/algorithm_kernel_41.py's ALGO-07
          // wiring for a bare authorization gate with no execution step.
          const meeGrowth = await stepMeeGrowth(
            env,
            typeof args.session_id === "string" && args.session_id.trim().length > 0 ? args.session_id : "default",
            result.future_score - 0.5,
            !result.authorized
          );

          const outputResult = {
            ...result,
            ...(rct7Trail ? { rct7_synthesis: { verified_alignment_score: rct7Trail.verified_alignment_score, derived_intent_precision: intentPrecision } } : {}),
            ...(meeGrowth ? { mee_growth: meeGrowth } : {}),
            _meta: tierMeta,
          };

          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id ?? 1,
              result: {
                content: [{ type: "text", text: JSON.stringify(outputResult, null, 2) }],
                isError: !result.authorized,
              },
            }),
            { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
          );
        }

        // ==========================================
        // TOOL 2: configure_policy
        // ==========================================
        if (body.method === "tools/call" && (body.params?.name === "configure_policy" || body.tool === "configure_policy")) {
          const policyData = body.params?.arguments || body.params || body;

          // Validate BEFORE mutating any state or reporting success. Previously
          // this endpoint accepted any object and echoed back "success" even
          // for schema-invalid policies, which would later be silently
          // rejected (falling back to the default policy) the first time
          // evaluate_fdia tried to use it — with no error surfaced to the
          // caller who thought their policy had taken effect.
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
                      text: JSON.stringify(
                        { status: "error", message: "Policy rejected: schema validation failed. No state was changed.", errors: validation.errors, _meta: tierMeta },
                        null,
                        2
                      ),
                    },
                  ],
                  isError: true,
                },
              }),
              { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
            );
          }

          activePolicy = validation.policy;

          // If Cloudflare KV is bound, persist directly for zero-redeploy real-time sync
          const kv = env.FDIA_POLICY_KV || env.POLICY_KV;
          if (kv && typeof kv.put === "function") {
            try {
              await kv.put("fdia-policy", JSON.stringify(activePolicy));
            } catch {
              // Non-blocking in local dev
            }
          }

          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id ?? 1,
              result: {
                content: [{ type: "text", text: JSON.stringify({ status: "success", message: "Policy validated, updated, and synchronized", policy: activePolicy, warnings: validation.warnings, _meta: tierMeta }, null, 2) }],
              },
            }),
            { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
          );
        }

        // ==========================================
        // TOOL 3: rct_think
        // ==========================================
        if (body.method === "tools/call" && (body.params?.name === "rct_think" || body.tool === "rct_think")) {
          const args = body.params?.arguments || body.params || body;
          const params: RCT7Input = {
            problem_statement: args.problem_statement ?? "System task",
            environment_context: args.environment_context,
            target_desired_outcome: args.target_desired_outcome,
          };
          const result = executeRCT7(params);
          const outputResult = {
            ...result,
            _meta: tierMeta,
          };
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id ?? 1,
              result: {
                content: [{ type: "text", text: JSON.stringify(outputResult, null, 2) }],
              },
            }),
            { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
          );
        }

        // ==========================================
        // TOOL 4: compress_context
        // ==========================================
        if (body.method === "tools/call" && (body.params?.name === "compress_context" || body.tool === "compress_context")) {
          const args = body.params?.arguments || body.params || body;
          const params: CompressContextInput = {
            raw_context: args.raw_context ?? "",
            intent_focus: args.intent_focus,
            aggressive_mode: args.aggressive_mode ?? false,
          };
          const result = compressContext(params);
          const outputResult = {
            ...result,
            _meta: tierMeta,
          };
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id ?? 1,
              result: {
                content: [{ type: "text", text: JSON.stringify(outputResult, null, 2) }],
              },
            }),
            { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
          );
        }

        // ==========================================
        // TOOL 5: orchestrate_swarm
        // ==========================================
        if (body.method === "tools/call" && (body.params?.name === "orchestrate_swarm" || body.tool === "orchestrate_swarm")) {
          const args = body.params?.arguments || body.params || body;
          const params: OrchestrateSwarmInput = {
            objective: args.objective ?? "General system task",
            data_readiness: args.data_readiness ?? 80,
            target_pillar: args.target_pillar ?? "auto",
            context_params: args.context_params,
          };
          const result = orchestrateSwarm(params);
          const outputResult = {
            ...result,
            _meta: tierMeta,
          };
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id ?? 1,
              result: {
                content: [{ type: "text", text: JSON.stringify(outputResult, null, 2) }],
              },
            }),
            { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
          );
        }

        // ==========================================
        // tools/list: Returns all 5 Tools (Full Quality Score: Descriptions + outputSchema + Annotations)
        // ==========================================
        if (body.method === "tools/list") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id ?? 1,
              result: {
                tools: [
                  {
                    name: "evaluate_fdia",
                    description: "Computes the FDIA safety score F = (D^I) x A to decide whether a proposed action should be authorized before it runs. F is a single 0.0-1.0 number that collapses to exactly 0 whenever A = 0 (no amount of good data can rescue an unauthorized action); otherwise it grows with D (data quality) raised to the I (intent precision) exponent. AUTHORIZED means F met the policy's safety_threshold (default 0.5); BLOCKED_PREEMPTION or a SECURITY_* verdict means it did not, or A was denied outright — read `verdict` and `reason` to decide how to proceed. USE WHEN: immediately before executing a specific action, especially one that is destructive, irreversible, or security/credential-sensitive. DO NOT USE WHEN: the action is routine and read-only (adds latency for no behavior change), you need to change the rules being checked (use configure_policy instead), or you are still planning multi-step work (use rct_think or orchestrate_swarm first, then evaluate_fdia on the resulting concrete action). OPTIONAL RCT-7 SYNTHESIS: pass `problem_statement` (and optionally `environment_context`/`target_desired_outcome`) instead of `intent_precision` to have this worker run the real RCT-7 7-stage decomposition and derive intent_precision from its actual alignment score (range 0.5-2.0) rather than you supplying an arbitrary number — the response then includes an `rct7_synthesis` field. Omit `problem_statement` for byte-identical behavior to before this option existed. Every call also steps a real, Durable-Object-persisted MEE growth tracker (delta = future_score - 0.5, a governance violation when unauthorized) and returns it as `mee_growth` — see `session_id` below to scope it per-caller instead of the shared deployment-wide default.",
                    inputSchema: {
                      type: "object",
                      properties: {
                        data_quality: {
                          type: "number",
                          minimum: 0.0,
                          maximum: 1.0,
                          description: "D (Data Quality): Metric representing sufficiency and integrity of input data (0.0 to 1.0).",
                        },
                        intent_precision: {
                          type: "number",
                          minimum: 1.0,
                          description: "I (Intent Precision): Precision factor representing goal alignment (>= 1.0). Ignored if `problem_statement` is also supplied — that triggers real RCT-7 synthesis instead.",
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
                        session_id: {
                          type: "string",
                          description: "Optional: scopes the real, Durable-Object-persisted MEE growth tracker this call steps. Omit for the shared \"default\" aggregate (the whole deployment's overall growth trend); pass your own caller/agent id for an isolated growth trajectory. The response's mee_growth field reflects whichever session this resolves to.",
                        },
                        authorized: {
                          type: "boolean",
                          description: "A (Authorization Status): Verified system authorization flag (true = allowed, false = rejected).",
                        },
                        action_name: {
                          type: "string",
                          description: "Name of the target tool or operation to evaluate.",
                        },
                        caller_role: {
                          type: "string",
                          description: "Role of the requesting entity (e.g. developer, auditor, admin).",
                        },
                        caller_context: {
                          type: "string",
                          description: "Context or metadata regarding the operation.",
                        },
                        dual_signoff_confirmed: {
                          type: "boolean",
                          description: "Whether secondary human verification has been completed.",
                        },
                      },
                      required: ["data_quality", "action_name"],
                    },
                    outputSchema: {
                      type: "object",
                      properties: {
                        future_score: { type: "number", description: "Computed mathematical score F = (D^I) * A." },
                        verdict: { type: "string", description: "Decision verdict: AUTHORIZED, SAFETY_THRESHOLD_VETO, or SECURITY_AUTH_DENIED." },
                        authorized: { type: "boolean", description: "True if action is permitted to execute, false otherwise." },
                        audit_digest: { type: "string", description: "SHA-256 tamper-proof cryptographic audit hash." },
                        reason: { type: "string", description: "Causal justification for the verification verdict." },
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
                    description: "Replaces the active authorization policy that evaluate_fdia checks against. IMPACT: this is a full REPLACE, not a merge — any existing rule you don't include in this call is dropped, so resend the complete rule set rather than a partial delta. Propagation is eventually consistent, not atomic: this worker's in-memory policy updates immediately, and is best-effort persisted to KV for other edge instances to pick up, so a request routed to a different isolate may briefly see the old policy. REVERSIBLE: yes — call configure_policy again with the previous policy JSON to roll back; no automatic version history is kept, so save the current policy yourself before changing it if you may need to undo. PARAMETER A: each rule assigns a binary authorization gate via `assigned_A` — A=1 lets matching actions proceed to normal F=(D^I)*A scoring, A=0 hard-blocks them regardless of data quality (this is how you make a category of actions always fail evaluate_fdia). USE WHEN: onboarding a new action type, changing RBAC/role rules, or adjusting the safety threshold. DO NOT USE WHEN: you only need to check one action (use evaluate_fdia) or reason about a task (use rct_think) — and avoid calling it speculatively per-request, since every call replaces shared state other callers depend on.",
                    inputSchema: {
                      type: "object",
                      properties: {
                        policy_id: {
                          type: "string",
                          description: "Unique alphanumeric identifier for the policy configuration.",
                        },
                        policy_name: {
                          type: "string",
                          description: "Descriptive name for the policy rule.",
                        },
                        blocked_action_patterns: {
                          type: "array",
                          items: { type: "string" },
                          description: "List of forbidden action patterns or prefixes.",
                        },
                        allowed_roles: {
                          type: "object",
                          description: "Mapping of role names to permitted actions.",
                        },
                        custom_safety_threshold: {
                          type: "number",
                          description: "Minimum safety score threshold for approval (default: 0.5000).",
                        },
                        require_human_dual_signoff: {
                          type: "array",
                          items: { type: "string" },
                          description: "List of critical actions requiring secondary verification.",
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
                  {
                    name: "rct_think",
                    description: "Performs a structured 7-stage causal reasoning walkthrough (Observe, Analyze, Deconstruct, Reverse Reasoning, Identify Core Intent, Reconstruct, Compare with Intent) to produce an explicit, auditable reasoning trail before acting on a complex or ambiguous task. USE WHEN: a task has multiple plausible approaches or unclear scope and you want a documented plan before execution. DO NOT USE WHEN: the task is simple and unambiguous — this tool only produces a reasoning report, it does not check authorization (pair it with evaluate_fdia before acting) or execute anything itself (pair it with orchestrate_swarm or your own tooling to carry out the plan).",
                    inputSchema: {
                      type: "object",
                      properties: {
                        problem_statement: {
                          type: "string",
                          description: "The technical challenge, complex query, or dilemma requiring reverse causal deconstruction.",
                        },
                        environment_context: {
                          type: "string",
                          description: "Optional operational constraints or target ecosystem parameters.",
                        },
                        target_desired_outcome: {
                          type: "string",
                          description: "Optional explicit definition of the end-state success criteria.",
                        },
                      },
                      required: ["problem_statement"],
                    },
                    outputSchema: {
                      type: "object",
                      properties: {
                        problem_statement: { type: "string", description: "Original problem statement received." },
                        stages: { type: "array", description: "Detailed 7-Stage cognitive outputs (Observe, Analyze, Deconstruct, Reverse Reasoning, Identify Core Intent, Reconstruct, Compare with Intent)." },
                        synthesized_solution: { type: "string", description: "Synthesized executive blueprint causally aligned with core intent." },
                        verified_alignment_score: { type: "number", description: "Causal alignment index (1.0000 = 100% verified)." },
                      },
                      required: ["problem_statement", "stages", "synthesized_solution", "verified_alignment_score"],
                    },
                    annotations: {
                      audience: ["user", "assistant"],
                      priority: 0.95,
                      readOnlyHint: true,
                    },
                  },
                  {
                    name: "compress_context",
                    description: "Compresses verbose conversation history, logs, or codebase context by deduplicating repeated lines and, when `intent_focus` is provided, filtering to lines relevant to that intent. Token reduction is computed fresh per request from the actual input (highly variable — near-zero or even negative on already-short/unique input, higher on repetitive logs) — it is not a fixed guaranteed range. USE WHEN: context is large or repetitive and approaching a token budget; supply `intent_focus` for meaningfully better filtering — without it, only deduplication is applied. DO NOT USE WHEN: you need the content reasoned about (use rct_think) or expect true semantic summarization — this is line-level filtering, not an LLM rewrite, so it can drop details a summarizer would keep.",
                    inputSchema: {
                      type: "object",
                      properties: {
                        raw_context: {
                          type: "string",
                          description: "Context text, dialogue transcript, or JSON context requiring compression.",
                        },
                        intent_focus: {
                          type: "string",
                          description: "Specific objective determining which state facts to preserve.",
                        },
                        aggressive_mode: {
                          type: "boolean",
                          description: "When true, strips conversational markers to retain only state changes.",
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
                  {
                    name: "orchestrate_swarm",
                    description: "Decomposes a high-level objective into a JITNA packet — a 6-field record: I (Intent: a normalized action code derived from your objective), D (Data readiness, 0-100%), delta (gap remaining to completion = 100-D), A (which of the 4 pillars — Router, Guardian, Executor, or Scribe — is assigned as primary handler), R (a short rationale string), and M (a key-value memory/context map) — then returns a dispatch roster describing what each of the 4 pillars would handle. USE WHEN: you need to break a broad objective into role-based subtasks or want a standardized packet format for downstream coordination. DO NOT USE WHEN: you need to authorize or execute something — it does not call evaluate_fdia itself, so run evaluate_fdia separately on any subtask (especially ones routed to Executor) before acting on it.",
                    inputSchema: {
                      type: "object",
                      properties: {
                        objective: {
                          type: "string",
                          description: "High-level mission or task directive to be decomposed and assigned.",
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
                          description: "Optional specific role designation, or 'auto' for dynamic routing.",
                        },
                        context_params: {
                          type: "object",
                          description: "Key-value dictionary containing runtime state or parameters.",
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
                        swarm_strategy: { type: "string", description: "Dynamic switching execution strategy." },
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
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: err?.message || "Internal server error" } }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  },
};
