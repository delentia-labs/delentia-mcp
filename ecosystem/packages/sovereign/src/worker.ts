import { evaluateFDIA, FDIAEngine, type ArchitectCustomPolicy } from "@delentia/shared";
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
            version: "2.0.0",
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
            version: "2.0.0",
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

          const result = engine.evaluate({
            data_quality: args.data_quality ?? 0.5,
            intent_precision: args.intent_precision ?? 1.0,
            authorized: args.authorized ?? true,
            action_name: args.action_name ?? "default_action",
            target_payload: args.target_payload,
            architect_token: args.architect_token,
            caller_role: args.caller_role ?? "developer",
            caller_context: args.caller_context,
            dual_signoff_confirmed: args.dual_signoff_confirmed ?? false,
          });

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
          activePolicy = policyData;

          // If Cloudflare KV is bound, persist directly for zero-redeploy real-time sync
          const kv = env.FDIA_POLICY_KV || env.POLICY_KV;
          if (kv && typeof kv.put === "function") {
            try {
              await kv.put("fdia-policy", JSON.stringify(policyData));
            } catch {
              // Non-blocking in local dev
            }
          }

          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id ?? 1,
              result: {
                content: [{ type: "text", text: JSON.stringify({ status: "success", message: "Policy updated and synchronized", policy: activePolicy, _meta: tierMeta }, null, 2) }],
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
                    description: "Evaluates action requests through deterministic ZK-FDIA equation F = (D^I) * A and enterprise custom policy rules.",
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
                          description: "I (Intent Precision): Precision exponent amplifying data towards authentic goal (>= 1.0).",
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
                    description: "Configures or updates Enterprise Custom Policy rules for parameter A.",
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
                  {
                    name: "rct_think",
                    description: "Executes authentic Delentia 7-Stage Reverse Component Thinking mental OS to eliminate hallucination.",
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
                        verified_alignment_score: { type: "number", description: "Causal alignment index (1.0000 = 100% verified, 0% hallucination risk)." },
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
                    description: "Compresses verbose conversation history by extracting state deltas (74.2% - 91.5% token reduction).",
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
                        reduction_percentage: { type: "number", description: "Net token saving percentage achieved." },
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
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: err?.message || "Internal server error" } }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  },
};
