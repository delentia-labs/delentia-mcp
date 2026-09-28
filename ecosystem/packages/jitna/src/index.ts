import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  type JITNAPacket,
  type LoRAPillarRole,
  LORA_PILLARS,
  generateSigningKeypair,
  importSigningKeypairFromJwk,
  importPublicKeyFromJwk,
  computeKeyFingerprint,
  signPayload,
  verifyPayloadSignature,
  type Ed25519KeypairJwk,
} from "@delentia/shared";

export const OrchestrateSwarmInputSchema = z.object({
  objective: z
    .string()
    .min(1)
    .describe("The overarching task, user prompt, or workflow to orchestrate"),
  data_readiness: z
    .number()
    .min(0)
    .max(100)
    .default(80)
    .describe("Data sufficiency score (0-100%) available for this mission"),
  target_pillar: z
    .enum(["auto", "router", "guardian", "executor", "scribe"])
    .default("auto")
    .describe("Designated 1+4 LoRA pillar adapter, or 'auto' for dynamic routing"),
  context_params: z
    .record(z.unknown())
    .optional()
    .describe("Optional key-value attributes for long-term memory persistence"),
});

export type OrchestrateSwarmInput = z.infer<typeof OrchestrateSwarmInputSchema>;

export interface PillarTaskAssignment {
  pillar: LoRAPillarRole;
  displayName: string;
  mission: string;
  /** "primary" = the pillar the routing decision actually selected for this
   * objective; "support" = the other 3 pillars, listed for the standing
   * 1+4 architecture but NOT claimed to be actively working this objective. */
  role: "primary" | "support";
  assigned_subtask: string;
  /** Target latency for this pillar's adapter hot-swap. This is a design
   * target, not a measurement — no LoRA runtime executes in this Worker. */
  expected_vram_switch_ms: number;
}

export interface SwarmOrchestrationResult {
  objective: string;
  jitna_packet: JITNAPacket;
  assigned_pillars: PillarTaskAssignment[];
  swarm_strategy: string;
  timestamp: string;
}

export function orchestrateSwarm(input: OrchestrateSwarmInput): SwarmOrchestrationResult {
  const { objective, data_readiness, target_pillar, context_params } = input;

  const intentCode = objective
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40) || "default_mission";

  const delta = Math.max(0, Math.min(100, 100 - data_readiness));

  let primaryPillar: LoRAPillarRole = "router";
  if (target_pillar !== "auto") {
    primaryPillar = target_pillar;
  } else {
    const lowerObj = objective.toLowerCase();
    if (lowerObj.includes("security") || lowerObj.includes("auth") || lowerObj.includes("guard")) {
      primaryPillar = "guardian";
    } else if (lowerObj.includes("compress") || lowerObj.includes("summary") || lowerObj.includes("diff")) {
      primaryPillar = "scribe";
    } else if (lowerObj.includes("run") || lowerObj.includes("execute") || lowerObj.includes("build") || lowerObj.includes("code")) {
      primaryPillar = "executor";
    } else {
      primaryPillar = "router";
    }
  }

  const jitna_packet: JITNAPacket = {
    I: intentCode,
    D: data_readiness,
    delta,
    A: primaryPillar,
    R: `Intent decomposed into JITNA v3 execution packet. Primary anchor: ${LORA_PILLARS[primaryPillar].displayName}.`,
    M: context_params || {},
  };

  // Primary-pillar-specific subtask text — only used for the pillar the
  // routing decision above actually selected.
  const primarySubtasks: Record<LoRAPillarRole, string> = {
    router: `Parse intent "${intentCode}" and route dependency parameters for "${objective}".`,
    guardian: `Enforce FDIA gate F = (D^I) * A against "${objective}". Verify caller authorization before executor handoff.`,
    executor: `Generate tool payload and compile executable output for "${objective}".`,
    scribe: `Crystallize runtime state deltas from "${objective}" and save warm cache to memory.`,
  };

  const assigned_pillars: PillarTaskAssignment[] = (["router", "guardian", "executor", "scribe"] as LoRAPillarRole[]).map(
    (pillar) => {
      const isPrimary = pillar === primaryPillar;
      return {
        pillar,
        displayName: LORA_PILLARS[pillar].displayName,
        mission: LORA_PILLARS[pillar].mission,
        role: isPrimary ? "primary" : "support",
        assigned_subtask: isPrimary
          ? primarySubtasks[pillar]
          : `Standing role only — not actively engaged for "${objective}" (routed to ${LORA_PILLARS[primaryPillar].displayName}).`,
        expected_vram_switch_ms: LORA_PILLARS[pillar].latencyTargetMs,
      };
    }
  );

  return {
    objective,
    jitna_packet,
    assigned_pillars,
    swarm_strategy: `Routed to ${LORA_PILLARS[primaryPillar].displayName} as primary handler (1+4 pillar architecture; the other 3 pillars remain on standby for this objective). expected_vram_switch_ms values are design targets, not measurements — no LoRA runtime executes in this deployment.`,
    timestamp: new Date().toISOString(),
  };
}

// ============================================================================
// Ed25519 packet signing (Layer 1: OS Primitives & Cryptographic Transport)
//
// Added 2026-09-14 — see packages/shared/src/ed25519.ts for the primitives
// and their header comment for why this exists (the deployed Worker had
// zero cryptography before this; the Python side's own attempt was a
// documented "(mock)" SHA-256 prefix, not real asymmetric signing).
//
// orchestrateSwarm() itself is intentionally left pure/sync/unchanged
// (existing callers, including this package's own test suite, keep
// working unmodified) — signing is a separate wrapping step applied to
// its output, exercised live by worker.ts's orchestrate_swarm tool
// handler.
// ============================================================================

export interface SignedJITNAPacket {
  packet: JITNAPacket;
  signature: string;
  public_key_fingerprint: string;
  algorithm: "Ed25519";
  signed_at: string;
  /** "configured_secret" = a stable keypair loaded from env secrets,
   *  persists across deploys and isolates. "ephemeral_isolate" = no
   *  secret was configured, so a fresh keypair was generated and cached
   *  for the lifetime of this Worker isolate only — real Ed25519
   *  signing either way, but the fingerprint is not a durable network
   *  identity in the ephemeral case. Disclosed rather than silently
   *  implied to be stable. */
  key_source: "configured_secret" | "ephemeral_isolate";
}

interface JitnaSigningEnv {
  JITNA_SIGNING_PRIVATE_KEY_JWK?: string;
  JITNA_SIGNING_PUBLIC_KEY_JWK?: string;
}

let _cachedKeypair: { privateKey: CryptoKey; publicKey: CryptoKey; keySource: SignedJITNAPacket["key_source"] } | undefined;

/**
 * Loads a configured signing keypair from env secrets if present (stable
 * across deploys/isolates); otherwise generates a real Ed25519 keypair
 * once and caches it at module scope for this isolate's lifetime — the
 * same warm-isolate-caching pattern worker.ts already uses for
 * `activePolicy`/`freeUsageCache`.
 */
export async function getOrCreateJitnaSigningKeypair(
  env?: JitnaSigningEnv
): Promise<{ privateKey: CryptoKey; publicKey: CryptoKey; keySource: SignedJITNAPacket["key_source"] }> {
  if (env?.JITNA_SIGNING_PRIVATE_KEY_JWK && env?.JITNA_SIGNING_PUBLIC_KEY_JWK) {
    try {
      const jwk: Ed25519KeypairJwk = {
        privateKeyJwk: JSON.parse(env.JITNA_SIGNING_PRIVATE_KEY_JWK),
        publicKeyJwk: JSON.parse(env.JITNA_SIGNING_PUBLIC_KEY_JWK),
      };
      const { privateKey, publicKey } = await importSigningKeypairFromJwk(jwk);
      return { privateKey, publicKey, keySource: "configured_secret" };
    } catch {
      // Fall through to ephemeral generation on malformed secrets rather
      // than crash packet signing entirely.
    }
  }

  if (_cachedKeypair) return _cachedKeypair;
  const { privateKey, publicKey } = await generateSigningKeypair();
  _cachedKeypair = { privateKey, publicKey, keySource: "ephemeral_isolate" };
  return _cachedKeypair;
}

/** Sign a JITNA packet with a real Ed25519 signature over its canonical
 *  form. Every packet the live Worker emits is signed this way. */
export async function signJitnaPacket(packet: JITNAPacket, env?: JitnaSigningEnv): Promise<SignedJITNAPacket> {
  const { privateKey, publicKey, keySource } = await getOrCreateJitnaSigningKeypair(env);
  const [signature, public_key_fingerprint] = await Promise.all([
    signPayload(privateKey, packet),
    computeKeyFingerprint(publicKey),
  ]);
  return {
    packet,
    signature,
    public_key_fingerprint,
    algorithm: "Ed25519",
    signed_at: new Date().toISOString(),
    key_source: keySource,
  };
}

/**
 * Verify a signed JITNA packet against a known public key JWK. Real
 * verification (crypto.subtle.verify) — a tampered packet or a wrong/
 * mismatched public key returns false, never a silent pass.
 *
 * No live endpoint in this Worker currently ingests externally-submitted
 * signed packets (orchestrate_swarm only produces them), so there is
 * nothing in the deployed request path to enforce rejection on yet —
 * this function is real and tested (see ed25519_signing.test.mjs) and
 * ready for a future packet-ingestion endpoint to call, rather than a
 * decorative stub.
 */
export async function verifyJitnaPacket(signed: SignedJITNAPacket, publicKeyJwk: JsonWebKey): Promise<boolean> {
  const publicKey = await importPublicKeyFromJwk(publicKeyJwk);
  return verifyPayloadSignature(publicKey, signed.packet, signed.signature);
}

export function createJITNAMcpServer() {
  const server = new McpServer({
    name: "delentia-jitna",
    version: "1.0.0",
  });

  server.registerTool(
    "orchestrate_swarm",
    {
      description:
        "Decomposes a high-level objective into a JITNA packet — a 6-field record: I (Intent: a normalized action code derived from your objective), D (Data readiness, 0-100%), delta (gap remaining to completion = 100-D), A (which of the 4 pillars — Router, Guardian, Executor, or Scribe — is assigned as primary handler), R (a short rationale string), and M (a key-value memory/context map) — then returns a dispatch roster describing what each of the 4 pillars would handle. USE WHEN: you need to break a broad objective into role-based subtasks or want a standardized packet format for downstream coordination. DO NOT USE WHEN: you need to authorize or execute something — it does not call evaluate_fdia itself, so run evaluate_fdia separately on any subtask (especially ones routed to Executor) before acting on it.",
      inputSchema: {
        objective: z
          .string()
          .describe("The overarching task, user prompt, or workflow to orchestrate"),
        data_readiness: z
          .number()
          .min(0)
          .max(100)
          .default(80)
          .describe("Data sufficiency score (0-100%) available for this mission"),
        target_pillar: z
          .enum(["auto", "router", "guardian", "executor", "scribe"])
          .default("auto")
          .describe("Designated 1+4 LoRA pillar adapter, or 'auto' for dynamic routing"),
        context_params: z
          .record(z.unknown())
          .optional()
          .describe("Optional key-value attributes for long-term memory persistence"),
      } as any,
    },
    async (args: any) => {
      const { objective, data_readiness, target_pillar, context_params } = args;
      const result = orchestrateSwarm({
        objective: String(objective ?? "General system task"),
        data_readiness: Number(data_readiness ?? 80),
        target_pillar: target_pillar ?? "auto",
        context_params: context_params ?? undefined,
      });

      const pillarList = result.assigned_pillars
        .map(
          (p) =>
            `- **${p.displayName}** (${p.pillar}, ${p.role}): ${p.assigned_subtask} (target hot-swap: <${p.expected_vram_switch_ms}ms)`
        )
        .join("\n");

      const responseText = [
        `# Delentia JITNA Multi-Agent Swarm Report`,
        `**Objective:** ${result.objective}`,
        `**Timestamp:** ${result.timestamp}`,
        `\n### Structured JITNA Packet (RFC-001):`,
        `\`\`\`json\n${JSON.stringify(result.jitna_packet, null, 2)}\n\`\`\``,
        `\n### 1+4 Pillars LoRA Dispatch Roster:`,
        pillarList,
        `\n---\n`,
        `**Swarm Strategy:** ${result.swarm_strategy}`,
      ].join("\n");

      return {
        content: [
          {
            type: "text" as const,
            text: responseText,
          },
        ],
      };
    }
  );

  return server;
}

if (process.argv[1] && process.argv[1].endsWith("index.js")) {
  const server = createJITNAMcpServer();
  const transport = new StdioServerTransport();
  server.connect(transport).catch((err) => {
    console.error("Failed to start Delentia JITNA MCP Server:", err);
    process.exit(1);
  });
}
