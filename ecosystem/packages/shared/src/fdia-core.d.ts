import { z } from "zod";
/**
 * ZK-FDIA Safety Equation Schema
 * Formula: F = (D^I) * A
 *
 * F (Future State Score): System transition approval index (F >= 0.5 authorizes state change; F < 0.5 triggers preemption block)
 * D (Data Quality Context): The integrity coefficient of the input context (0.0 <= D <= 1.0)
 * I (Intent Precision): The precision parameter representing user alignment (I >= 1.0)
 * A (Architect Gate): Digital signature validation token (A in {0, 1})
 */
export declare const FDIARequestSchema: z.ZodObject<{
    data_quality: z.ZodNumber;
    intent_precision: z.ZodDefault<z.ZodNumber>;
    authorized: z.ZodDefault<z.ZodBoolean>;
    action_name: z.ZodString;
    caller_context: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    data_quality: number;
    intent_precision: number;
    authorized: boolean;
    action_name: string;
    caller_context?: string | undefined;
}, {
    data_quality: number;
    action_name: string;
    intent_precision?: number | undefined;
    authorized?: boolean | undefined;
    caller_context?: string | undefined;
}>;
export type FDIARequest = z.infer<typeof FDIARequestSchema>;
export type FDIASecurityVerdict = "AUTHORIZED" | "BLOCKED_PREEMPTION" | "SECURITY_AUTH_DENIED";
export interface FDIAEvaluationResult {
    future_score: number;
    verdict: FDIASecurityVerdict;
    authorized: boolean;
    data_quality: number;
    intent_precision: number;
    action_name: string;
    audit_digest: string;
    timestamp: string;
    reason: string;
}
/**
 * Evaluates the deterministic FDIA Safety Equation:
 * F = (D^I) * A
 *
 * Mathematical Preemption Proof:
 * Since A is a direct multiplier, if authorization fails (A = 0),
 * the future score F instantly collapses to 0.0000, rendering any execution
 * mathematically impossible.
 */
export declare function evaluateFDIA(request: FDIARequest): FDIAEvaluationResult;
//# sourceMappingURL=fdia-core.d.ts.map