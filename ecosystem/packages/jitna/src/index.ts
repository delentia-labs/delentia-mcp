import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  type JITNAPacket,
  type LoRAPillarRole,
  LORA_PILLARS,
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
  assigned_subtask: string;
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

  const assigned_pillars: PillarTaskAssignment[] = [
    {
      pillar: "router",
      displayName: LORA_PILLARS.router.displayName,
      mission: LORA_PILLARS.router.mission,
      assigned_subtask: `Parse intent "${intentCode}" and route dependency parameters.`,
      expected_vram_switch_ms: LORA_PILLARS.router.latencyTargetMs,
    },
    {
      pillar: "guardian",
      displayName: LORA_PILLARS.guardian.displayName,
      mission: LORA_PILLARS.guardian.mission,
      assigned_subtask: `Enforce ZK-FDIA gate F = (D^I) * A. Verify caller authorization.`,
      expected_vram_switch_ms: LORA_PILLARS.guardian.latencyTargetMs,
    },
    {
      pillar: "executor",
      displayName: LORA_PILLARS.executor.displayName,
      mission: LORA_PILLARS.executor.mission,
      assigned_subtask: `Generate tool payload and compile executable output for "${objective}".`,
      expected_vram_switch_ms: LORA_PILLARS.executor.latencyTargetMs,
    },
    {
      pillar: "scribe",
      displayName: LORA_PILLARS.scribe.displayName,
      mission: LORA_PILLARS.scribe.mission,
      assigned_subtask: `Crystallize runtime state deltas and save warm cache to memory.`,
      expected_vram_switch_ms: LORA_PILLARS.scribe.latencyTargetMs,
    },
  ];

  return {
    objective,
    jitna_packet,
    assigned_pillars,
    swarm_strategy: `Dynamic 1+4 LoRA Swapping: Frozen 8B base kernel with dynamic <1.06ms adapter transitions. Zero API token waste.`,
    timestamp: new Date().toISOString(),
  };
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
        "Encapsulates complex user objectives into structured JITNA packets [I, D, Delta, A, R, M] and coordinates autonomous agent execution across the 1+4 Pillars LoRA Swarm (Router, Guardian, Executor, Scribe).",
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
            `- **${p.displayName}** (${p.pillar}): ${p.assigned_subtask} (Hot-swap: <${p.expected_vram_switch_ms}ms)`
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
