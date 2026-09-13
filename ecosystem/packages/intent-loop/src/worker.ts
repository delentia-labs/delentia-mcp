import { IntentLoopEngine, type IntentPacket, type IntentResult } from "./index.js";
import {
  captureException,
  buildRctdbEntryFromIntentLoop,
  ingestGraphragDocument,
  indexTextAsVector,
  checkCodeHalts,
} from "@delentia/shared";
export { RCTDBLogSessionDO } from "@delentia/shared";

/** Same code-role detection regex used for specialist routing in index.ts
 * — reused here (not imported, since index.ts doesn't export it) to decide
 * whether a completed run is worth a Halting Detection safety check. */
const CODE_INTENT_RE = /\b(code|program|debug|function|bug|script)\b/i;

interface Env {
  OPENROUTER_API_KEY?: string;
  ENVIRONMENT?: string;
  SERVER_NAME?: string;
  SENTRY_DSN?: string;
  RCTDB_LOG_DO?: DurableObjectNamespace;
  /** Base URL of a running graphrag-complete instance (e.g.
   * http://127.0.0.1:8013 in local dev, or a public URL once deployed).
   * Optional — when unset, syncToGraphRag() is a silent no-op, the same
   * pattern as RCTDB_LOG_DO above. This is the actual network bridge
   * between this TS/Cloudflare-Workers kernel and the Python microservices
   * platform: without it configured, the two stacks never talk to each
   * other (verified by grepping this whole package for any reference to
   * GraphRAG/Vector Search/Halting Detection before this change — there
   * was none). */
  GRAPHRAG_BASE_URL?: string;
  /** Base URL of a running vector-search instance (ALGO-16, real FAISS/
   * Qdrant backend). Optional — unset means syncToVectorSearch() is a
   * silent no-op. A second, complementary real memory backend alongside
   * GraphRAG: same hashing-trick embedding (hashing-embedding.ts,
   * verified byte-for-byte identical to GraphRAG's Python-side
   * embedding), indexed into a real ANN index instead of GraphRAG's
   * in-process linear scan. */
  VECTOR_SEARCH_BASE_URL?: string;
  /** Dimension the target Vector Search instance is configured with (its
   * own DIMENSION env var, default 768 there). Must match exactly — a
   * mismatch is rejected by the real service with a 400. */
  VECTOR_SEARCH_DIMENSION?: string;
  /** Base URL of a running halting-detection instance (ALGO-22, real
   * subprocess-sandboxed timeout+memory-limit enforcement, fixed and
   * verified for real this session). Optional — unset means
   * checkGeneratedCodeHalts() is a silent no-op. */
  HALTING_DETECTION_BASE_URL?: string;
}

/**
 * Best-effort real logging of this run into the RCTDB-inspired 8-dimension
 * log (see @delentia/shared/rctdb-log.ts for why this is a Durable Object
 * rather than the separately-hosted database RCTDB was originally designed
 * to be). Never blocks or fails the actual run_intent_loop response — a
 * missing binding or a DO error is swallowed here, same as MEE growth
 * logging in sovereign/fdia.
 */
export async function logToRctdb(env: Env, sessionId: string, packet: IntentPacket, result: IntentResult): Promise<void> {
  if (!env.RCTDB_LOG_DO) return;
  try {
    const specialistModel = result.output && typeof result.output === "object" ? (result.output as Record<string, unknown>).specialist_model : undefined;
    const entry = buildRctdbEntryFromIntentLoop({
      subjectUuid: sessionId,
      queryText: packet.intent,
      fdiaScore: result.fdia_score,
      verdict: result.fdia_score !== undefined ? result.state : undefined,
      specialistModel: typeof specialistModel === "string" ? specialistModel : undefined,
      verifierModels: result.verification?.votes.map((v) => v.model),
      verification: result.verification ? { passed: result.verification.passed, confidence: result.verification.confidence } : null,
      meeStep: result.mee_step ? { g_before: result.mee_step.g_before, g_after: result.mee_step.g_after, delta: result.mee_step.delta } : null,
      provenance: { source: "run_intent_loop", version: "0.1.0" },
    });

    const doId = env.RCTDB_LOG_DO.idFromName(sessionId);
    const stub = env.RCTDB_LOG_DO.get(doId);
    await stub.fetch("http://rctdb/append", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry),
    });
  } catch {
    // Non-blocking — RCTDB logging must never break the actual response.
  }
}

/**
 * Best-effort real sync of a completed run into GraphRAG's semantic
 * memory. This is the actual TS<->Python bridge: RCTDB (above) records a
 * structured 8-dimension audit trail of what happened, but audit-log
 * entries are not semantically searchable — GraphRAG is. Only completed
 * runs with real output are worth ingesting; a gate rejection or failure
 * has no useful content for future semantic recall. Never blocks or
 * fails the actual response — same non-blocking contract as
 * logToRctdb().
 */
export async function syncToGraphRag(env: Env, sessionId: string, packet: IntentPacket, result: IntentResult): Promise<void> {
  if (!env.GRAPHRAG_BASE_URL) return;
  if (result.state !== "completed" || !result.output) return;
  try {
    await ingestGraphragDocument(env.GRAPHRAG_BASE_URL, `Intent: ${packet.intent}\nOutcome: ${JSON.stringify(result.output)}`, {
      source: "intent-loop",
      session_id: sessionId,
      fdia_score: result.fdia_score,
      cache_hit: result.cache_hit,
    });
  } catch {
    // Non-blocking — same contract as logToRctdb: GraphRAG being
    // unreachable must never break the actual run_intent_loop response.
  }
}

/**
 * Best-effort real sync of a completed run's intent+outcome into Vector
 * Search — a second, complementary real memory backend alongside
 * GraphRAG (both may be configured at once; each is independent and
 * best-effort). Uses the same hashing-trick embedding as GraphRAG
 * (verified byte-for-byte identical to its Python-side implementation),
 * so text embedded here and text embedded by GraphRAG/graphrag-complete
 * are directly comparable.
 */
export async function syncToVectorSearch(env: Env, sessionId: string, packet: IntentPacket, result: IntentResult): Promise<void> {
  if (!env.VECTOR_SEARCH_BASE_URL) return;
  if (result.state !== "completed" || !result.output) return;
  try {
    const dimension = env.VECTOR_SEARCH_DIMENSION ? parseInt(env.VECTOR_SEARCH_DIMENSION, 10) : 768;
    await indexTextAsVector(
      env.VECTOR_SEARCH_BASE_URL,
      `intent-loop-${sessionId}-${result.intent_hash}`,
      `Intent: ${packet.intent}\nOutcome: ${JSON.stringify(result.output)}`,
      dimension,
      { source: "intent-loop", session_id: sessionId }
    );
  } catch {
    // Non-blocking — same contract as syncToGraphRag.
  }
}

/** Matches SpecialistResult.output's raw text (index.ts) for a fenced
 * ```code``` block. Halting Detection executes real code in a real
 * sandbox — it makes no sense to feed it free-form prose, so this only
 * fires when a genuine code block is present, not on every code-related
 * intent. */
function extractCodeBlock(text: string): string | null {
  const match = text.match(/```(?:python)?\n([\s\S]*?)```/);
  return match ? match[1] : null;
}

/**
 * Best-effort real safety check of generated code via Halting Detection's
 * real sandboxed timeout+memory-limit enforcement (fixed and verified for
 * real this session — see TESTING_CANONICAL.md). Only runs for intents
 * that were routed to the "code" specialist role (same detection regex
 * used for that routing in index.ts) and whose output actually contains a
 * fenced code block. If GraphRAG is also configured, the finding is
 * remembered as real semantic memory — the identical Halting Detection ->
 * GraphRAG pattern already proven end-to-end on the Python side
 * (integration-tests/test_graphrag_halting_e2e.py), now also reachable
 * from the TS side.
 */
export async function checkGeneratedCodeHalts(env: Env, sessionId: string, packet: IntentPacket, result: IntentResult): Promise<void> {
  if (!env.HALTING_DETECTION_BASE_URL) return;
  if (result.state !== "completed" || !result.output) return;
  if (!CODE_INTENT_RE.test(packet.intent)) return;
  try {
    const outputRecord = result.output as Record<string, unknown>;
    const rawOutput = typeof outputRecord.output === "string" ? outputRecord.output : "";
    const code = extractCodeBlock(rawOutput);
    if (!code) return; // no actual code block to safety-check

    const check = await checkCodeHalts(env.HALTING_DETECTION_BASE_URL, code, {}, 3000);

    if (env.GRAPHRAG_BASE_URL) {
      const verdict = check.completed && check.halted
        ? "halted safely within the timeout"
        : "did NOT halt within the timeout - potentially unsafe (infinite loop or excessive runtime)";
      await ingestGraphragDocument(
        env.GRAPHRAG_BASE_URL,
        `Halting Detection checked code generated for intent "${packet.intent}" and it ${verdict}.`,
        { source: "intent-loop-halting-check", session_id: sessionId, halted: check.halted, completed: check.completed }
      );
    }
  } catch {
    // Non-blocking — same contract as the other background syncs.
  }
}

// One engine instance per Worker isolate. Memory (recall/store) is real but
// isolate-scoped — it does NOT survive an isolate recycle or span multiple
// isolates. This is the same known, disclosed limitation already tracked in
// ROADMAP.md for the other 4 pillar workers' global-Durable-Object pattern;
// wiring this to a properly per-caller-scoped Durable Object is real
// follow-up work, not done in this pass.
let engineCache: { key: string; engine: IntentLoopEngine } | null = null;
function getEngine(apiKey: string): IntentLoopEngine {
  if (!engineCache || engineCache.key !== apiKey) {
    engineCache = { key: apiKey, engine: new IntentLoopEngine({ apiKey }) };
  }
  return engineCache.engine;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const serverName = env.SERVER_NAME || "Delentia Intent Loop MCP";
    const corsHeaders = { "Access-Control-Allow-Origin": "*" };

    try {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            ...corsHeaders,
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization, x-session-id",
          },
        });
      }

      if (url.pathname === "/health" || url.pathname === "/") {
        return new Response(
          JSON.stringify({
            status: "healthy",
            server: "delentia-intent-loop",
            name: serverName,
            version: "0.1.0",
            note: "run_intent_loop makes real outbound calls to OpenRouter (free-tier models) for both execution and multi-model verification. Requires OPENROUTER_API_KEY to be configured; without it, every call fails closed with a real error, not a fabricated success.",
            openrouter_configured: Boolean(env.OPENROUTER_API_KEY),
            graphrag_bridge_configured: Boolean(env.GRAPHRAG_BASE_URL),
            vector_search_bridge_configured: Boolean(env.VECTOR_SEARCH_BASE_URL),
            halting_detection_bridge_configured: Boolean(env.HALTING_DETECTION_BASE_URL),
            transports: { streamable_http: "/mcp" },
            environment: env.ENVIRONMENT || "production",
            sentry_enabled: Boolean(env.SENTRY_DSN),
          }),
          { headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      }

      if (url.pathname === "/.well-known/mcp/server-card.json") {
        return new Response(
          JSON.stringify({
            $schema: "https://json.schemastore.org/mcp-server-card.json",
            name: "Delentia Intent Loop",
            version: "0.1.0",
            description: "FDIA-gated agent orchestration loop: every intent is validated by the FDIA gate before it can touch memory or invoke a model, real model execution + real multi-model consensus verification via OpenRouter.",
            vendor: {
              name: "Delentia Labs",
              url: "https://delentia.com",
              portalUrl: "https://delentia-gateway-main-c7624a5.zuplo.site",
              contactEmail: "founder@delentia.com",
            },
            servers: [
              {
                id: "delentia-intent-loop",
                name: "Delentia Intent Loop",
                transport: { type: "streamable-http", url: `${url.origin}/mcp` },
                tools: ["run_intent_loop"],
              },
            ],
          }),
          { headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      }

      if (url.pathname === "/mcp" && request.method === "POST") {
        const body: any = await request.json();

        if (body.method === "initialize") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id ?? 1,
              result: {
                protocolVersion: "2024-11-05",
                capabilities: { tools: { listChanged: false } },
                serverInfo: { name: "delentia-intent-loop", version: "0.1.0" },
              },
            }),
            { headers: { "Content-Type": "application/json", ...corsHeaders } }
          );
        }

        if (body.method === "notifications/initialized") {
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? null, result: {} }), {
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }
        if (body.method === "resources/list" || body.method === "prompts/list" || body.method === "triggers/list") {
          const key = body.method.split("/")[0];
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, result: { [key]: [] } }), {
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }

        if (body.method === "tools/call" || body.tool === "run_intent_loop" || body.intent) {
          if (!env.OPENROUTER_API_KEY) {
            return new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id: body.id ?? 1,
                error: { code: -32000, message: "OPENROUTER_API_KEY is not configured on this Worker — cannot execute or verify (fails closed, no fabricated response)." },
              }),
              { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
            );
          }

          const args = body.params?.arguments || body.params || body;
          const packet: IntentPacket = {
            intent: String(args.intent ?? ""),
            context: args.context ?? {},
            user_id: args.user_id,
            session_id: args.session_id,
            priority: args.priority,
          };

          const engine = getEngine(env.OPENROUTER_API_KEY);
          const result = await engine.process(packet);

          const rctdbSessionId = packet.session_id ?? "default";
          ctx.waitUntil(logToRctdb(env, rctdbSessionId, packet, result));
          ctx.waitUntil(syncToGraphRag(env, rctdbSessionId, packet, result));
          ctx.waitUntil(syncToVectorSearch(env, rctdbSessionId, packet, result));
          ctx.waitUntil(checkGeneratedCodeHalts(env, rctdbSessionId, packet, result));

          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id ?? 1,
              result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] },
            }),
            { headers: { "Content-Type": "application/json", ...corsHeaders } }
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
                    name: "run_intent_loop",
                    description:
                      "Runs a full intent through the Delentia Intent Loop: (1) the real, hardened FDIA gate rejects it before anything else happens if it fails the mathematical authorization check; (2) checks in-memory cache for a near-identical prior intent (Jaccard similarity > 0.95) and returns instantly on a hit; (3) on a miss, routes to a real free-tier model via OpenRouter based on keyword-detected role (code/vision/fast/general) and makes a real API call; (4) asks 3 different real models to independently vote yes/no on whether the output plausibly addresses the intent, and requires a real majority — a model that errors contributes no vote, never counted as agreement; (5) commits verified results back to memory. USE WHEN: you want every model call gated by FDIA and cross-checked by independent models before trusting the result. DO NOT USE WHEN: you need guaranteed low latency (this makes 1-4 real network calls to third-party model providers, each with real network variance) or when OPENROUTER_API_KEY is not configured (this tool fails closed with a real error rather than fabricating a response).",
                    inputSchema: {
                      type: "object",
                      properties: {
                        intent: { type: "string", description: "The natural-language intent/task to process." },
                        context: { type: "object", description: "Optional structured context (raises intent_precision in the FDIA gate check)." },
                        user_id: { type: "string", description: "Optional caller identifier, included in output metadata only (not yet used for per-caller memory scoping — see known limitations)." },
                        session_id: { type: "string", description: "Optional session identifier, included in output metadata only (not yet used for per-caller memory scoping — see known limitations)." },
                      },
                      required: ["intent"],
                    },
                    outputSchema: {
                      type: "object",
                      properties: {
                        state: { type: "string", enum: ["completed", "failed"] },
                        output: { type: "object", description: "Specialist model output, present only on completed state." },
                        error: { type: "string", description: "Present only on failed state — real reason: FDIA rejection, all candidate models failing, or verification consensus failing." },
                        cache_hit: { type: "boolean" },
                        verification: { type: "object", description: "Real per-model vote breakdown, present when the loop reached the verify stage." },
                        fdia_score: { type: "number" },
                        latency_ms: { type: "number" },
                      },
                      required: ["state", "latency_ms", "cache_hit"],
                    },
                    annotations: { audience: ["user", "assistant"], priority: 0.7, readOnlyHint: false },
                  },
                ],
              },
            }),
            { headers: { "Content-Type": "application/json", ...corsHeaders } }
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
