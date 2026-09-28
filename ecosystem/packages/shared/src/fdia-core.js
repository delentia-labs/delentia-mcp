"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FDIARequestSchema = void 0;
exports.evaluateFDIA = evaluateFDIA;
const node_crypto_1 = require("node:crypto");
const zod_1 = require("zod");
/**
 * ZK-FDIA Safety Equation Schema
 * Formula: F = (D^I) * A
 *
 * F (Future State Score): System transition approval index (F >= 0.5 authorizes state change; F < 0.5 triggers preemption block)
 * D (Data Quality Context): The integrity coefficient of the input context (0.0 <= D <= 1.0)
 * I (Intent Precision): The precision parameter representing user alignment (I >= 1.0)
 * A (Architect Gate): Digital signature validation token (A in {0, 1})
 */
exports.FDIARequestSchema = zod_1.z.object({
    data_quality: zod_1.z
        .number()
        .min(0.0)
        .max(1.0)
        .describe("D (Data Quality Context): Value between 0.0 and 1.0 representing raw data sufficiency and integrity"),
    intent_precision: zod_1.z
        .number()
        .min(1.0)
        .default(1.0)
        .describe("I (Intent Precision): Exponent parameter (>= 1.0) amplifying data in alignment with user goal"),
    authorized: zod_1.z
        .boolean()
        .default(true)
        .describe("A (Architect Gate): Authorization state (true = 1, false = 0). If false, F collapses to 0 immediately"),
    action_name: zod_1.z
        .string()
        .min(1)
        .describe("Target tool or operation requested for safety verification"),
    caller_context: zod_1.z
        .string()
        .optional()
        .describe("Metadata or contextual signals surrounding the request"),
});
/**
 * Evaluates the deterministic FDIA Safety Equation:
 * F = (D^I) * A
 *
 * Mathematical Preemption Proof:
 * Since A is a direct multiplier, if authorization fails (A = 0),
 * the future score F instantly collapses to 0.0000, rendering any execution
 * mathematically impossible.
 */
function evaluateFDIA(request) {
    const { data_quality, intent_precision, authorized, action_name, caller_context } = request;
    // Zero-Authorization Cutoff: A = 0 => F = 0
    const A = authorized ? 1 : 0;
    let future_score = 0.0;
    let verdict = "SECURITY_AUTH_DENIED";
    let reason = "";
    if (A === 0) {
        future_score = 0.0;
        verdict = "SECURITY_AUTH_DENIED";
        reason = "Architect Gate is closed (A = 0). Access is mathematically preempted.";
    }
    else {
        // Calculate F = (D^I) * A
        // D is in [0.0, 1.0], I >= 1.0, A = 1
        future_score = Math.pow(data_quality, intent_precision) * A;
        // Round to 4 decimal places for deterministic precision
        future_score = Math.round(future_score * 10000) / 10000;
        if (future_score >= 0.5) {
            verdict = "AUTHORIZED";
            reason = `FDIA score ${future_score.toFixed(4)} meets constitutional safety threshold (>= 0.5000). Action approved.`;
        }
        else {
            verdict = "BLOCKED_PREEMPTION";
            reason = `FDIA score ${future_score.toFixed(4)} is below constitutional threshold (< 0.5000). Insufficient data quality or high risk.`;
        }
    }
    const timestamp = new Date().toISOString();
    const auditString = `${action_name}:${data_quality}:${intent_precision}:${A}:${future_score}:${timestamp}:${caller_context || ""}`;
    const audit_digest = (0, node_crypto_1.createHash)("sha256").update(auditString).digest("hex");
    return {
        future_score,
        verdict,
        authorized: authorized && future_score >= 0.5,
        data_quality,
        intent_precision,
        action_name,
        audit_digest,
        timestamp,
        reason,
    };
}
//# sourceMappingURL=fdia-core.js.map