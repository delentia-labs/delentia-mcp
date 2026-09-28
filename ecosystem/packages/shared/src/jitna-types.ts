import { z } from "zod";

/**
 * JITNA Packet Schema (RFC-001 / JITNA Protocol v3)
 * Structured intent communication between Human and AI
 * 
 * I (Intent): What the user ultimately wants (action code)
 * D (Data): Data sufficiency measure (0 - 100%)
 * Delta: Logical gap distance from current state to desired outcome (0 - 100%)
 * A (Algorithm / Agent): Selected execution plan and designated LoRA pillar
 * R (Reflection): Learning richness and post-mortem score (0 - 100%)
 * M (Memory): Persistent context key-value mapping
 */
export const JITNAPacketSchema = z.object({
  I: z.string().min(1).describe("Intent: Action code or authentic goal"),
  D: z.number().min(0).max(100).describe("Data Sufficiency (0-100%): Quality and readiness of input context"),
  delta: z.number().min(0).max(100).describe("Delta Gap (0-100%): Distance to target completion (0 = completed, 100 = start)"),
  A: z.enum(["router", "guardian", "executor", "scribe"]).describe("Designated LoRA Pillar agent"),
  R: z.string().describe("Reflection: Synthesis notes, learning points, or post-mortem critique"),
  M: z.record(z.unknown()).default({}).describe("Memory: Key-value attributes for persistent context cache"),
});

export type JITNAPacket = z.infer<typeof JITNAPacketSchema>;

/**
 * 1+4 Pillars LoRA Swarm Roster
 */
export type LoRAPillarRole = "router" | "guardian" | "executor" | "scribe";

export interface LoRAPillarSpec {
  role: LoRAPillarRole;
  displayName: string;
  mission: string;
  latencyTargetMs: number;
}

export const LORA_PILLARS: Record<LoRAPillarRole, LoRAPillarSpec> = {
  router: {
    role: "router",
    displayName: "The Router",
    mission: "Intention parser and high-speed node routing",
    latencyTargetMs: 1.06,
  },
  guardian: {
    role: "guardian",
    displayName: "The Guardian",
    mission: "Zero-trust constitutional safety and FDIA gatekeeper",
    latencyTargetMs: 1.06,
  },
  executor: {
    role: "executor",
    displayName: "The Executor",
    mission: "Autonomous JSON tool payload generation and execution",
    latencyTargetMs: 1.06,
  },
  scribe: {
    role: "scribe",
    displayName: "The Scribe",
    mission: "State differential context compression and memory crystallization",
    latencyTargetMs: 1.06,
  },
};
