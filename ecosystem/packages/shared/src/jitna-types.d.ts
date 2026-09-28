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
export declare const JITNAPacketSchema: z.ZodObject<{
    I: z.ZodString;
    D: z.ZodNumber;
    delta: z.ZodNumber;
    A: z.ZodEnum<["router", "guardian", "executor", "scribe"]>;
    R: z.ZodString;
    M: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, "strip", z.ZodTypeAny, {
    I: string;
    D: number;
    delta: number;
    A: "router" | "guardian" | "executor" | "scribe";
    R: string;
    M: Record<string, unknown>;
}, {
    I: string;
    D: number;
    delta: number;
    A: "router" | "guardian" | "executor" | "scribe";
    R: string;
    M?: Record<string, unknown> | undefined;
}>;
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
export declare const LORA_PILLARS: Record<LoRAPillarRole, LoRAPillarSpec>;
//# sourceMappingURL=jitna-types.d.ts.map