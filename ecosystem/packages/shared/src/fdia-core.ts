import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Enterprise Custom Policy Schema
 * Enables organizations and developers to establish custom governance rules for parameter A
 */
export const ArchitectCustomPolicySchema = z.object({
  policy_id: z.string().default("enterprise_default"),
  policy_name: z.string().default("Standard Enterprise Policy"),
  blocked_action_patterns: z
    .array(z.string())
    .default(["*drop*", "*truncate*", "*wipe*", "*export_credentials*"])
    .describe("Action name patterns (with wildcards *) strictly forbidden (forces A = 0 immediately)"),
  allowed_roles: z
    .record(z.array(z.string()))
    .optional()
    .describe("Role-Based Access Control: Mapping of role name to allowed action patterns"),
  custom_safety_threshold: z
    .number()
    .min(0.0)
    .max(1.0)
    .default(0.5)
    .describe("Threshold override: Minimum F score required to authorize (default: 0.5000)"),
  require_human_dual_signoff: z
    .array(z.string())
    .default([])
    .describe("Critical operations requiring explicit dual human sign-off"),
});

export type ArchitectCustomPolicy = z.infer<typeof ArchitectCustomPolicySchema>;

/**
 * ZK-FDIA Safety Request Schema with Policy Context
 */
export const FDIARequestSchema = z.object({
  data_quality: z
    .number()
    .min(0.0)
    .max(1.0)
    .describe("D (Data Quality Context): Value between 0.0 and 1.0 representing raw data sufficiency and integrity"),
  intent_precision: z
    .number()
    .min(1.0)
    .default(1.0)
    .describe("I (Intent Precision): Exponent parameter (>= 1.0) amplifying data in alignment with user goal"),
  authorized: z
    .boolean()
    .default(true)
    .describe("A (Architect Gate): Initial authorization state (true = 1, false = 0)"),
  action_name: z
    .string()
    .min(1)
    .describe("Target tool or operation requested for safety verification"),
  caller_role: z
    .string()
    .default("developer")
    .describe("Role identifier of the caller (e.g. admin, developer, junior_dev, automated_subagent)"),
  caller_context: z
    .string()
    .optional()
    .describe("Metadata or contextual signals surrounding the request"),
  dual_signoff_confirmed: z
    .boolean()
    .default(false)
    .describe("Flag confirming dual human architect sign-off for critical operations"),
  custom_policy: ArchitectCustomPolicySchema.optional().describe("Custom enterprise policy override"),
});

export type FDIARequest = z.infer<typeof FDIARequestSchema>;

export type FDIASecurityVerdict =
  | "AUTHORIZED"
  | "BLOCKED_PREEMPTION"
  | "SECURITY_AUTH_DENIED"
  | "SECURITY_POLICY_VIOLATION"
  | "SECURITY_RBAC_DENIED"
  | "SECURITY_DUAL_SIGNOFF_REQUIRED";

export interface FDIAEvaluationResult {
  future_score: number;
  verdict: FDIASecurityVerdict;
  authorized: boolean;
  data_quality: number;
  intent_precision: number;
  action_name: string;
  caller_role: string;
  applied_policy_id: string;
  safety_threshold: number;
  audit_digest: string;
  timestamp: string;
  reason: string;
  violations: string[];
}

/**
 * Helper to match wildcard strings (e.g. "*drop*", "delete_*")
 */
export function matchesWildcard(text: string, pattern: string): boolean {
  if (pattern === "*" || pattern === text) return true;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(text);
}

/**
 * Evaluates the deterministic FDIA Safety Equation with Enterprise Custom Policy Engine
 * Formula: F = (D^I) * A
 */
export function evaluateFDIA(request: FDIARequest): FDIAEvaluationResult {
  const {
    data_quality,
    intent_precision,
    authorized,
    action_name,
    caller_role = "developer",
    caller_context,
    dual_signoff_confirmed = false,
    custom_policy,
  } = request;

  const policy = custom_policy || ArchitectCustomPolicySchema.parse({});
  const threshold = policy.custom_safety_threshold ?? 0.5;
  const violations: string[] = [];

  let effectiveA = authorized ? 1 : 0;
  let verdict: FDIASecurityVerdict = "AUTHORIZED";
  let reason = "";

  // Step 1: Base Authorization Check
  if (effectiveA === 0) {
    verdict = "SECURITY_AUTH_DENIED";
    violations.push("Base Architect Gate is closed (A = 0) or Authorization token is invalid.");
  }

  // Step 2: Custom Enterprise Blacklist Rule Check
  if (effectiveA === 1 && policy.blocked_action_patterns?.length) {
    for (const pat of policy.blocked_action_patterns) {
      if (matchesWildcard(action_name, pat)) {
        effectiveA = 0;
        verdict = "SECURITY_POLICY_VIOLATION";
        violations.push(`Action "${action_name}" matches enterprise forbidden pattern "${pat}".`);
        break;
      }
    }
  }

  // Step 3: Role-Based Access Control (RBAC) Rule Check
  if (effectiveA === 1 && policy.allowed_roles) {
    const allowedPatternsForRole = policy.allowed_roles[caller_role];
    if (!allowedPatternsForRole) {
      effectiveA = 0;
      verdict = "SECURITY_RBAC_DENIED";
      violations.push(`Role "${caller_role}" is not registered in enterprise access control matrix.`);
    } else {
      const isAllowed = allowedPatternsForRole.some((p) => matchesWildcard(action_name, p));
      if (!isAllowed) {
        effectiveA = 0;
        verdict = "SECURITY_RBAC_DENIED";
        violations.push(`Role "${caller_role}" is not authorized to invoke action "${action_name}".`);
      }
    }
  }

  // Step 4: Dual Human Sign-off Rule Check
  if (effectiveA === 1 && policy.require_human_dual_signoff?.length) {
    const requiresDual = policy.require_human_dual_signoff.some((p) => matchesWildcard(action_name, p));
    if (requiresDual && !dual_signoff_confirmed) {
      effectiveA = 0;
      verdict = "SECURITY_DUAL_SIGNOFF_REQUIRED";
      violations.push(`Action "${action_name}" is classified as critical and requires dual human architect sign-off.`);
    }
  }

  // Step 5: Mathematical Preemption Calculation: F = (D^I) * A
  let future_score = 0.0;
  if (effectiveA === 0) {
    future_score = 0.0;
    reason = violations.join(" ") || "Action mathematically preempted by Architect Gate.";
  } else {
    future_score = Math.pow(data_quality, intent_precision) * effectiveA;
    future_score = Math.round(future_score * 10000) / 10000;

    if (future_score >= threshold) {
      verdict = "AUTHORIZED";
      reason = `FDIA score ${future_score.toFixed(4)} meets enterprise threshold (>= ${threshold.toFixed(4)}). Action approved.`;
    } else {
      verdict = "BLOCKED_PREEMPTION";
      reason = `FDIA score ${future_score.toFixed(4)} is below threshold (< ${threshold.toFixed(4)}). Data quality insufficient or high operational variance.`;
    }
  }

  const isApproved = effectiveA === 1 && future_score >= threshold;
  const timestamp = new Date().toISOString();
  const auditString = `${policy.policy_id}:${action_name}:${caller_role}:${data_quality}:${intent_precision}:${effectiveA}:${future_score}:${timestamp}:${caller_context || ""}`;
  const audit_digest = createHash("sha256").update(auditString).digest("hex");

  return {
    future_score,
    verdict,
    authorized: isApproved,
    data_quality,
    intent_precision,
    action_name,
    caller_role,
    applied_policy_id: policy.policy_id,
    safety_threshold: threshold,
    audit_digest,
    timestamp,
    reason,
    violations,
  };
}
