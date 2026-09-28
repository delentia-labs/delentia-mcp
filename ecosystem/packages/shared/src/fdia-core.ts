/**
 * DELENTIA SOVEREIGN AI OS — FDIA SECURITY CORE & ENTERPRISE POLICY ENGINE
 * Mathematical Safe-State Preemption Engine: F = (D^I) * A
 * 
 * Chief Architect: อิทธิฤทธิ์ แซ่โง้ว (Ittirit Saengow) — Delentia Labs
 * 
 * Invariants:
 * 1. Physical Cutoff: When A = 0, F unconditionally collapses to 0.0000.
 * 2. Zero Probabilistic Hallucination: Mathematical certainty over probabilistic LLM guardrails.
 * 3. Dynamic User Governance: Organizations can define custom security policies via JSON,
 *    environment variables, or runtime API without code modification.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { bundledPolicyConfig } from "./default-policy.js";
import {
  type ArchitectTokenCheck,
  type PreverifiedArchitect,
  type TrustedArchitectKey,
  getConfiguredTrustedArchitectKeys,
  verifiedArchitectSigners,
} from "./architect-token.js";

/**
 * Round 48: the exact string an Architect token's payload hash covers for a
 * request. Workers that pre-verify tokens must use this, so both sides hash
 * the same bytes.
 */
export function architectPayloadFor(request: { target_payload?: string; caller_context?: string }): string {
  return request.target_payload || request.caller_context || "";
}

/** Round 48: options that must come from trusted Worker code, never from a tool call's arguments. */
export interface FDIAEvaluateOptions {
  /** Architect tokens already verified with WebCrypto (see preverifyArchitectTokens). */
  preverifiedArchitect?: PreverifiedArchitect;
}

/**
 * Individual Policy Rule Schema
 * Dictates dynamic evaluation of parameter A based on intent patterns and risk classification
 */
export const FDIARuleSchema = z.object({
  rule_id: z.string().describe("Unique identifier for the governance rule"),
  description: z.string().optional().describe("Human-readable rule explanation"),
  intent_patterns: z
    .array(z.string())
    .describe("Action / intent patterns matching this rule (supports wildcards *)"),
  action_type: z
    .enum(["ALLOW", "CONDITIONAL", "REQUIRE_HUMAN_SIGNATURE"])
    .describe("Classification of action risk level"),
  assigned_A: z
    .number()
    .min(0)
    .max(1)
    .default(1)
    .describe("Baseline value of parameter A (1 or 0)"),
  require_human_confirmation: z
    .boolean()
    .default(false)
    .describe("Whether cryptographic human architect approval is required"),
  denied_paths: z
    .array(z.string())
    .optional()
    .describe("Sensitive paths or payloads forbidden under CONDITIONAL checks"),
  allowed_roles: z
    .array(z.string())
    .optional()
    .describe("Caller roles permitted to invoke this action"),
  human_approver_role: z
    .array(z.string())
    .optional()
    .describe("Roles permitted to sign off for human confirmation"),
}).passthrough();

export type FDIARule = z.infer<typeof FDIARuleSchema>;

/**
 * Enterprise Custom Policy Schema
 * Enables organizations and developers to establish custom governance rules for parameter A
 */
export const FDIAPolicySchema = z.object({
  version: z.string().default("1.0.0"),
  organization_id: z.string().default("enterprise_default"),
  policy_id: z.string().optional().default("enterprise-sovereign-policy"),
  policy_name: z.string().optional().default("Delentia Enterprise Safety Policy"),
  default_fallback_A: z
    .number()
    .min(0)
    .max(1)
    .default(0)
    .describe("Fallback A value when no rule matches (0 = Zero-Trust)"),
  custom_safety_threshold: z
    .number()
    .min(0.0)
    .max(1.0)
    .default(0.5)
    .describe("Threshold override: Minimum F score required to authorize (default: 0.5000)"),
  rules: z.array(FDIARuleSchema).default([]),
  // Backward compatibility fields:
  blocked_action_patterns: z.array(z.string()).optional(),
  allowed_roles: z.record(z.array(z.string())).optional(),
  require_human_dual_signoff: z.array(z.string()).optional(),
}).passthrough();

export type FDIAPolicy = z.infer<typeof FDIAPolicySchema>;

// Backward-compatible alias
export const ArchitectCustomPolicySchema = FDIAPolicySchema;
export type ArchitectCustomPolicy = FDIAPolicy;

/**
 * ZK-FDIA Safety Request Schema with Dynamic Policy Context
 */
/** Round 48: the numeric domain evaluate() enforces (same as FDIARequestSchema). */
export const FDIA_MAX_DATA_QUALITY = 1.0;
export const FDIA_MIN_INTENT_PRECISION = 0.5;

export const FDIARequestSchema = z.object({
  data_quality: z
    .number()
    .min(0.0)
    .max(1.0)
    .describe("D (Data Quality Context): Value between 0.0 and 1.0 representing raw data sufficiency and integrity"),
  intent_precision: z
    .number()
    .min(0.5)
    .default(1.0)
    .describe("I (Intent Precision): Exponent parameter (>= 0.5) amplifying data in alignment with user goal"),
  authorized: z
    .boolean()
    .optional()
    .default(true)
    .describe("Legacy boolean flag for parameter A (true = 1, false = 0)"),
  action_name: z
    .string()
    .min(1)
    .describe("Target tool or operation requested for safety verification"),
  target_payload: z
    .string()
    .optional()
    .describe("Optional target payload, file path, or parameters for conditional security checks"),
  architect_token: z
    .string()
    .optional()
    .describe("Cryptographic Architect Token required for high-risk actions"),
  caller_role: z
    .string()
    .default("developer")
    .describe("Role of the calling agent/user"),
  caller_context: z
    .string()
    .optional()
    .describe("Metadata or contextual signals surrounding the request"),
  dual_signoff_confirmed: z
    .boolean()
    .default(false)
    .describe("Legacy dual-signature signoff flag"),
  custom_policy: FDIAPolicySchema.optional().describe("Optional inline custom policy passed with this specific request"),
});

export type FDIARequest = z.infer<typeof FDIARequestSchema>;

/**
 * ZK-FDIA Safety Audit Evaluation Result
 */
export type FDIASecurityVerdict =
  | "AUTHORIZED"
  | "BLOCKED_PREEMPTION"
  | "SECURITY_AUTH_DENIED"
  | "SECURITY_POLICY_VIOLATION"
  | "SECURITY_RBAC_DENIED"
  | "SECURITY_DUAL_SIGNOFF_REQUIRED"
  | "PERMITTED"
  | "RESTRICTED"
  | "BLOCKED";

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
  effective_A: number;
  rule_triggered: string;
}

export type FDIAResult = FDIAEvaluationResult;

/**
 * Helper to match wildcard strings (e.g. "*drop*", "delete_*", "read_*")
 * Implemented cleanly without regex dollar signs
 */
export function matchesWildcard(text: string, pattern: string): boolean {
  if (!pattern || !text) return false;
  if (pattern === "*") return true;

  // Trim before matching: found via adversarial testing 2026-09-11 that
  // leading/trailing whitespace on the caller-supplied action name breaks
  // an ANCHORED pattern's start-of-string check (e.g. "purge_*" no longer
  // matches "  purge_telemetry_cache  " because the string now starts with
  // whitespace, not "purge_") while leaving UNANCHORED patterns like
  // "*telemetry*" unaffected — letting a padded destructive action name
  // fall through the specific block rule and land on a broad allow-list
  // match instead of the safe zero-trust fallback. Trimming both sides
  // closes this without changing behavior for any already-untrimmed input.
  const lowerText = text.trim().toLowerCase();
  const lowerPat = pattern.trim().toLowerCase();
  if (lowerPat === lowerText) return true;
  
  if (!lowerPat.includes("*")) {
    return lowerText === lowerPat;
  }
  
  const parts = lowerPat.split("*");
  const startsWithStar = lowerPat.startsWith("*");
  const endsWithStar = lowerPat.endsWith("*");
  
  let searchIdx = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.length === 0) continue;
    
    const found = lowerText.indexOf(part, searchIdx);
    if (found === -1) return false;
    if (i === 0 && !startsWithStar && found !== 0) return false;
    searchIdx = found + part.length;
  }
  
  if (!endsWithStar && parts[parts.length - 1].length > 0) {
    if (!lowerText.endsWith(parts[parts.length - 1])) return false;
  }
  
  return true;
}

/**
 * Structured validation result interface with error diagnostics
 */
export interface FDIAPolicyValidationResult {
  valid: boolean;
  policy?: FDIAPolicy;
  errors?: string[];
  warnings?: string[];
  schema_version?: string;
}

/**
 * Validates raw JSON policy object against FDIAPolicySchema using Zod
 * Detects syntax errors, missing fields, invalid risk action types, or threshold bounds
 */
export function validatePolicy(rawPolicy: unknown): FDIAPolicyValidationResult {
  const result = FDIAPolicySchema.safeParse(rawPolicy);
  if (!result.success) {
    const errors = result.error.errors.map((e) => {
      const fieldPath = e.path.length > 0 ? e.path.join(".") : "root";
      return `[Validation Error at ${fieldPath}]: ${e.message} (code: ${e.code})`;
    });
    return {
      valid: false,
      errors,
    };
  }

  const warnings: string[] = [];
  const policy = result.data;

  if (policy.default_fallback_A === 1) {
    warnings.push("Notice: default_fallback_A is set to 1 (Permissive Mode). Strict Zero-Trust recommends 0.");
  }
  if (!policy.rules || policy.rules.length === 0) {
    warnings.push("Notice: No explicit rules defined in policy. Relying entirely on fallback or legacy patterns.");
  }

  return {
    valid: true,
    policy,
    warnings,
    schema_version: policy.version,
  };
}

/**
 * Safely determines if code is executing in a full Node.js runtime with filesystem access,
 * preventing unhandled runtime exceptions in Serverless / Cloudflare Workers / Edge Isolates.
 */
export function isNodeRuntime(): boolean {
  try {
    return (
      typeof process !== "undefined" &&
      Boolean(process?.versions?.node) &&
      typeof fs?.existsSync === "function" &&
      typeof fs?.readFileSync === "function"
    );
  } catch {
    return false;
  }
}

/**
 * Default Built-in High-Security Enterprise Policy
 * Pre-compiled from bundled fdia-policy.json, enabling instant Serverless execution without fs calls
 */
export function createDefaultPolicy(): FDIAPolicy {
  const parsedBundled = FDIAPolicySchema.safeParse(bundledPolicyConfig);
  if (parsedBundled.success) {
    return parsedBundled.data;
  }

  return {
    version: "1.0.0",
    organization_id: "delentia-sovereign-default",
    policy_id: "default-enterprise-zero-trust",
    policy_name: "Delentia Zero-Trust Default Policy",
    default_fallback_A: 0, // Zero-trust: unknown intents default to A = 0
    custom_safety_threshold: 0.5,
    // Order is documentation only — evaluateA() ranks matches by severity
    // (REQUIRE_HUMAN_SIGNATURE > CONDITIONAL > ALLOW), most-restrictive-wins,
    // regardless of array position. Listed most-restrictive-first anyway.
    rules: [
      {
        rule_id: "RULE-DATABASE-DESTRUCTIVE-BLOCK",
        description: "Destructive database or OS commands require human architect cryptographic signature",
        intent_patterns: [
          "*drop*",
          "*truncate*",
          "*wipe*",
          "*delete_all*",
          "*purge*",
          "*chmod*",
          "*system_exec*",
          "*reverse_shell*",
          "eval",
          "eval_*",
          "*eval_code*",
          "*fork_bomb*"
        ],
        action_type: "REQUIRE_HUMAN_SIGNATURE",
        assigned_A: 0,
        require_human_confirmation: true,
        human_approver_role: ["Chief_Architect", "DevOps_Lead", "Security_Admin"],
      },
      {
        rule_id: "RULE-CREDENTIAL-EXFILTRATION-BLOCK",
        description: "Strictly blocks credential harvesting, private key dump, or DNS tunneling",
        intent_patterns: ["*exfiltrate*", "*export_credentials*", "*dump_s3*", "*drain_*", "*leak_*"],
        action_type: "REQUIRE_HUMAN_SIGNATURE",
        assigned_A: 0,
        require_human_confirmation: true,
        human_approver_role: ["Chief_Architect"],
      },
      {
        rule_id: "RULE-FILE-WRITE-RESTRICTED",
        description: "File write/modify operations conditionally verified against sensitive system paths",
        intent_patterns: ["write_*", "modify_*", "update_code*", "save_*", "*operation*", "*task*"],
        denied_paths: [".env", ".git/*", "production.config.*", "/etc/*", "id_rsa*", "*.pem", "*.key"],
        action_type: "CONDITIONAL",
        assigned_A: 1,
        require_human_confirmation: false,
      },
      {
        rule_id: "RULE-READONLY-ALLOW",
        description: "Permits read-only queries, analysis, and inspection automatically (Zero Friction)",
        intent_patterns: [
          "read_*",
          "query_*",
          "summarize_*",
          "search_*",
          "check_*",
          "inspect_*",
          "evaluate_*",
          "get_*",
          "list_*",
          "quick_*",
          "*telemetry*",
          "*quick_eval*"
        ],
        action_type: "ALLOW",
        assigned_A: 1,
        require_human_confirmation: false,
      }
    ],
    blocked_action_patterns: [],
    require_human_dual_signoff: ["deploy_to_production", "modify_financial_ledger", "grant_admin_privilege", "shutdown_service"]
  };
}

export interface WorkersPolicyKV {
  get: (k: string) => Promise<string | null>;
  put?: (k: string, v: string) => Promise<void>;
}

/**
 * FDIA Dynamic Policy Engine
 * Evaluates parameter A dynamically from user/enterprise configuration
 * Fully compatible with both Node.js and Serverless (Cloudflare Workers / Edge Isolates)
 */
export class FDIAEngine {
  private policy: FDIAPolicy;
  private startupValidationErrors: string[] = [];

  /**
   * Round 48: keys trusted to sign Architect tokens for THIS engine. Set only
   * by trusted code (a Worker from its env, a test); never read from a policy,
   * since callers can supply per-session policies. Unset = the deployment-wide
   * keys from configureTrustedArchitectKeys(); none at all = fail-closed.
   */
  private trustedArchitectKeys?: TrustedArchitectKey[];

  public withTrustedArchitectKeys(keys: TrustedArchitectKey[]): this {
    this.trustedArchitectKeys = keys.slice();
    return this;
  }

  private architectKeys(): TrustedArchitectKey[] {
    return this.trustedArchitectKeys ?? getConfiguredTrustedArchitectKeys();
  }

  /**
   * Distinct trusted signers of `token` for exactly this action and payload.
   * Uses WebCrypto results a Worker verified up front when they are for the
   * same token/action/payload; otherwise verifies synchronously (node:crypto,
   * available in Node but not in workerd - there it simply finds nothing,
   * which fails closed).
   */
  private architectSigners(
    token: string | undefined,
    actionName: string,
    targetPayload: string,
    allowedRoles: string[] | undefined,
    preverified?: PreverifiedArchitect
  ): ArchitectTokenCheck[] {
    if (!token) return [];
    if (preverified && preverified.token === token && preverified.actionName === actionName &&
        preverified.targetPayload === targetPayload) {
      const trustedIds = new Set(this.architectKeys().map((k) => k.key_id));
      return preverified.signers.filter((s) =>
        s.valid && s.keyId !== undefined && trustedIds.has(s.keyId) &&
        (!allowedRoles || allowedRoles.length === 0 || (s.approverRole !== undefined && allowedRoles.includes(s.approverRole)))
      );
    }
    return verifiedArchitectSigners(token, { actionName, targetPayload, allowedRoles, trustedKeys: this.architectKeys() });
  }

  constructor(policyConfig?: Partial<FDIAPolicy> | string) {
    if (typeof policyConfig === "string") {
      // Path to policy file or raw JSON string
      this.policy = this.loadPolicyFromStringOrPath(policyConfig);
    } else if (policyConfig && typeof policyConfig === "object") {
      const base = createDefaultPolicy();
      const hasCustomRules = Array.isArray((policyConfig as any).rules);
      const merged = {
        ...base,
        rules: hasCustomRules ? (policyConfig as any).rules : [],
        ...policyConfig,
      };

      // Zod validation on startup
      const validation = validatePolicy(merged);
      if (validation.valid && validation.policy) {
        this.policy = validation.policy;
      } else {
        this.startupValidationErrors = validation.errors || ["Schema validation failed"];
        this.policy = createDefaultPolicy();
      }
    } else {
      this.policy = this.autoDiscoverPolicy();
    }
  }

  /**
   * Factory method: Asynchronously loads and validates policy in Cloudflare Workers / Serverless
   * Checks Cloudflare KV namespace (FDIA_POLICY_KV or POLICY_KV) for real-time dashboard updates,
   * then checks Environment Variables, before falling back to bundled validated policy.
   */
  public static async fromWorkersEnv(
    env: {
      FDIA_POLICY_KV?: { get: (k: string) => Promise<string | null> };
      POLICY_KV?: { get: (k: string) => Promise<string | null> };
      FDIA_POLICY_RULES_JSON?: string;
      FDIA_POLICY_JSON?: string;
    },
    kvKey: string = "fdia-policy"
  ): Promise<FDIAEngine> {
    if (!env || typeof env !== "object") {
      return new FDIAEngine();
    }

    // 1. Check Cloudflare KV namespace (Real-time dashboard updates without redeploy)
    const kv = env.FDIA_POLICY_KV || env.POLICY_KV;
    if (kv && typeof kv.get === "function") {
      try {
        const rawJson = await kv.get(kvKey);
        if (rawJson) {
          const parsed = JSON.parse(rawJson);
          const validation = validatePolicy(parsed);
          if (validation.valid && validation.policy) {
            return new FDIAEngine(validation.policy);
          }
        }
      } catch {
        // Fallback to environment variables
      }
    }

    // 2. Check Environment Variable
    const envJson = env.FDIA_POLICY_RULES_JSON || env.FDIA_POLICY_JSON;
    if (envJson && typeof envJson === "string") {
      try {
        const parsed = JSON.parse(envJson);
        const validation = validatePolicy(parsed);
        if (validation.valid && validation.policy) {
          return new FDIAEngine(validation.policy);
        }
      } catch {
        // Fallback to bundled policy
      }
    }

    // 3. Bundled Default Policy
    return new FDIAEngine();
  }

  /**
   * Auto-discovers policy from environment or project root fdia-policy.json
   * Safe for both Node.js and Serverless runtimes
   */
  private autoDiscoverPolicy(): FDIAPolicy {
    // 1. Check environment variable FDIA_POLICY_RULES_JSON
    if (typeof process !== "undefined" && process.env?.FDIA_POLICY_RULES_JSON) {
      try {
        const parsed = JSON.parse(process.env.FDIA_POLICY_RULES_JSON);
        const validation = validatePolicy(parsed);
        if (validation.valid && validation.policy) {
          return validation.policy;
        }
        this.startupValidationErrors = validation.errors || [];
      } catch {
        this.startupValidationErrors = ["Invalid JSON in FDIA_POLICY_RULES_JSON"];
      }
    }

    // 2. Check environment variable FDIA_POLICY_PATH (only in Node.js runtime)
    if (isNodeRuntime() && process.env?.FDIA_POLICY_PATH) {
      const p = process.env.FDIA_POLICY_PATH;
      try {
        if (fs.existsSync(p)) {
          const raw = fs.readFileSync(p, "utf-8");
          const parsed = JSON.parse(raw);
          const validation = validatePolicy(parsed);
          if (validation.valid && validation.policy) {
            return validation.policy;
          }
          this.startupValidationErrors = validation.errors || [];
        }
      } catch {
        // Continue fallback
      }
    }

    // 3. Check for fdia-policy.json in cwd or parent folders (only in Node.js runtime)
    if (isNodeRuntime()) {
      const potentialPaths = [
        path.resolve(process.cwd(), "fdia-policy.json"),
        path.resolve(process.cwd(), "packages", "shared", "src", "fdia-policy.json"),
        path.resolve(process.cwd(), "..", "fdia-policy.json"),
      ];

      for (const p of potentialPaths) {
        try {
          if (fs.existsSync(p)) {
            const raw = fs.readFileSync(p, "utf-8");
            const parsed = JSON.parse(raw);
            const validation = validatePolicy(parsed);
            if (validation.valid && validation.policy) {
              return validation.policy;
            }
            this.startupValidationErrors = validation.errors || [];
          }
        } catch {
          // Continue fallback
        }
      }
    }

    // 4. Default high-security zero-trust policy from pre-compiled bundled JSON
    return createDefaultPolicy();
  }

  private loadPolicyFromStringOrPath(source: string): FDIAPolicy {
    // 1. Check if source is an existing file path in Node.js runtime
    if (isNodeRuntime()) {
      try {
        if (fs.existsSync(source)) {
          const raw = fs.readFileSync(source, "utf-8");
          const parsed = JSON.parse(raw);
          const validation = validatePolicy(parsed);
          if (validation.valid && validation.policy) {
            return validation.policy;
          }
          this.startupValidationErrors = validation.errors || [];
          return createDefaultPolicy();
        }
      } catch {
        // Continue to parse as raw JSON
      }
    }

    // 2. Parse as raw JSON string
    try {
      const parsed = JSON.parse(source);
      const validation = validatePolicy(parsed);
      if (validation.valid && validation.policy) {
        return validation.policy;
      }
      this.startupValidationErrors = validation.errors || [];
      return createDefaultPolicy();
    } catch {
      this.startupValidationErrors = ["Invalid JSON syntax in policy configuration source."];
      return createDefaultPolicy();
    }
  }

  /**
   * Retrieves startup validation diagnostics for health checks and telemetry
   */
  public getValidationStatus(): FDIAPolicyValidationResult {
    return {
      valid: this.startupValidationErrors.length === 0,
      policy: this.policy,
      errors: this.startupValidationErrors.length > 0 ? this.startupValidationErrors : undefined,
      schema_version: this.policy.version,
    };
  }

  /**
   * Evaluates parameter A (0 or 1) based on intent, payload, and architect token
   */
  public evaluateA(
    intentCode: string,
    targetPayload: string = "",
    providedArchitectToken?: string,
    callerRole: string = "developer",
    dualSignoffConfirmed: boolean = false,
    preverified?: PreverifiedArchitect
  ): { A: number; reason: string; ruleTriggered: string; actionType: string; verifiedApprover?: string } {
    // 1. Evaluate Configured Dynamic Rules first if present
    if (this.policy.rules && this.policy.rules.length > 0) {
      // Most-restrictive-match-wins, not first-match-wins.
      //
      // Rationale (found via adversarial testing 2026-09-11): with plain
      // first-array-match semantics, an action named e.g.
      // "read_drop_table_customers" matched the bundled ALLOW rule
      // (`read_*`, listed first) and returned A=1 *before* the
      // DATABASE-DESTRUCTIVE-BLOCK rule (`drop_*`) was ever evaluated —
      // any action name prefixed with an allowed verb (read_/query_/
      // check_/get_/list_/search_/inspect_/evaluate_/summarize_/quick_)
      // bypassed every REQUIRE_HUMAN_SIGNATURE / CONDITIONAL rule that also
      // matched. That bug lived in this engine, not just the bundled
      // policy's array order — any enterprise customer who authored their
      // own custom_policy with an ALLOW rule before a BLOCK rule would hit
      // the exact same bypass. Ranking by severity instead of array
      // position closes the whole bug class regardless of how a policy
      // author orders their rules.
      const actionSeverity: Record<string, number> = {
        REQUIRE_HUMAN_SIGNATURE: 2,
        CONDITIONAL: 1,
        ALLOW: 0,
      };
      const matchedRules = this.policy.rules.filter((rule) =>
        rule.intent_patterns.some((pattern) => matchesWildcard(intentCode, pattern))
      );

      if (matchedRules.length > 0) {
        const rule = matchedRules.reduce((mostRestrictive, candidate) => {
          const candidateRank = actionSeverity[candidate.action_type] ?? 0;
          const currentRank = actionSeverity[mostRestrictive.action_type] ?? 0;
          return candidateRank > currentRank ? candidate : mostRestrictive;
        });

        {
          // Check role restrictions if defined
          if (rule.allowed_roles && rule.allowed_roles.length > 0) {
            const hasRole = rule.allowed_roles.includes(callerRole) || rule.allowed_roles.includes("*");
            if (!hasRole) {
              return {
                A: 0,
                reason: `Caller role "${callerRole}" is not permitted under rule ${rule.rule_id}.`,
                ruleTriggered: "SECURITY_RBAC_DENIED",
                actionType: rule.action_type,
              };
            }
          }

          // Case 1: REQUIRE_HUMAN_SIGNATURE
          if (rule.action_type === "REQUIRE_HUMAN_SIGNATURE" || rule.require_human_confirmation) {
            const signatureResult = this.verifyArchitectSignature(
              providedArchitectToken, rule.human_approver_role, intentCode, targetPayload, preverified
            );
            if (signatureResult.valid) {
              return {
                A: 1,
                reason: `Architect cryptographic signature verified (${signatureResult.approverRole || "Authorized Approver"}).`,
                ruleTriggered: rule.rule_id,
                actionType: rule.action_type,
                verifiedApprover: signatureResult.approverRole,
              };
            } else {
              return {
                A: 0,
                reason: `Missing or invalid Architect signature under rule ${rule.rule_id} (VETO): ${signatureResult.reason}.`,
                ruleTriggered: rule.rule_id,
                actionType: rule.action_type,
              };
            }
          }

          // Case 2: CONDITIONAL (Path or Payload Constraints)
          if (rule.action_type === "CONDITIONAL" && rule.denied_paths && rule.denied_paths.length > 0) {
            const payload = (targetPayload || "").toLowerCase();
            const violatesPath = rule.denied_paths.some((pathPat) => {
              const cleanPat = pathPat.toLowerCase().replace(/\*/g, "");
              return payload.includes(cleanPat);
            });

            if (violatesPath) {
              return {
                A: 0,
                reason: `Target payload or path violates conditional restricted pattern in rule ${rule.rule_id}.`,
                ruleTriggered: rule.rule_id,
                actionType: rule.action_type,
              };
            }
          }

          // Case 3: ALLOW
          return {
            A: rule.assigned_A ?? 1,
            reason: rule.description || `Permitted under governance rule ${rule.rule_id}.`,
            ruleTriggered: rule.rule_id,
            actionType: rule.action_type,
          };
        }
      }

      // Default Fallback Gate when rules array is configured (Zero-Trust)
      const fallbackA = this.policy.default_fallback_A ?? 0;
      return {
        A: fallbackA,
        reason: fallbackA === 0 
          ? "Action intent not registered in enterprise policy. Zero-trust fallback A = 0 enforced."
          : "Action permitted under default fallback policy.",
        ruleTriggered: "ZERO_TRUST_FALLBACK",
        actionType: fallbackA === 0 ? "REQUIRE_HUMAN_SIGNATURE" : "ALLOW",
      };
    }

    // 2. Check Backward-Compatible blocked_action_patterns
    if (this.policy.blocked_action_patterns?.length) {
      for (const pat of this.policy.blocked_action_patterns) {
        if (matchesWildcard(intentCode, pat)) {
          return {
            A: 0,
            reason: `Action "${intentCode}" matches enterprise forbidden pattern "${pat}".`,
            ruleTriggered: "BLOCKED_ACTION_PATTERN",
            actionType: "REQUIRE_HUMAN_SIGNATURE",
          };
        }
      }
    }

    // 3. Check Backward-Compatible Dual Signoff
    if (this.policy.require_human_dual_signoff?.length) {
      const isDual = this.policy.require_human_dual_signoff.some((p) => matchesWildcard(intentCode, p));
      // Round 48: dual sign-off means two DISTINCT trusted Architect keys
      // signed this exact action. The caller-supplied `dualSignoffConfirmed`
      // boolean is no longer trusted (a caller could simply send `true`).
      void dualSignoffConfirmed;
      const signers = isDual
        ? this.architectSigners(providedArchitectToken, intentCode, targetPayload, undefined, preverified)
        : [];
      if (isDual && signers.length < 2) {
        return {
          A: 0,
          reason: `Action "${intentCode}" requires dual human sign-off: two Architect tokens from distinct trusted keys (got ${signers.length}).`,
          ruleTriggered: "SECURITY_DUAL_SIGNOFF_REQUIRED",
          actionType: "REQUIRE_HUMAN_SIGNATURE",
        };
      }
    }

    // 4. Check Backward-Compatible RBAC (allowed_roles)
    if (this.policy.allowed_roles) {
      const allowedPatterns = this.policy.allowed_roles[callerRole];
      if (!allowedPatterns || allowedPatterns.length === 0) {
        return {
          A: 0,
          reason: `Action "${intentCode}" is not permitted for role "${callerRole}".`,
          ruleTriggered: "SECURITY_RBAC_DENIED",
          actionType: "REQUIRE_HUMAN_SIGNATURE",
        };
      }
      const isPermitted = allowedPatterns.some((pat) => matchesWildcard(intentCode, pat));
      if (!isPermitted) {
        return {
          A: 0,
          reason: `Action "${intentCode}" is not permitted for role "${callerRole}".`,
          ruleTriggered: "SECURITY_RBAC_DENIED",
          actionType: "REQUIRE_HUMAN_SIGNATURE",
        };
      }
    }

    // 5. Legacy policy mode (rules array is empty)
    return {
      A: 1,
      reason: "Action permitted under enterprise policy bounds.",
      ruleTriggered: "POLICY_ALLOW_LEGACY",
      actionType: "ALLOW",
    };
  }

  /**
   * Round 48: real verification. The token must be an Ed25519 Architect token
   * (see architect-token.ts) signed by a trusted key for exactly this action
   * and payload, unexpired, and - when the rule names approver roles - from a
   * key holding one of them. The previous implementation accepted any
   * 32+ character string or any "valid_architect_sig_*" prefix.
   */
  public verifyArchitectSignature(
    token?: string,
    allowedApproverRoles?: string[],
    actionName: string = "",
    targetPayload: string = "",
    preverified?: PreverifiedArchitect
  ): { valid: boolean; approverRole?: string; reason: string } {
    if (!token) return { valid: false, reason: "no Architect token supplied" };
    const signers = this.architectSigners(token, actionName, targetPayload, allowedApproverRoles, preverified);
    if (signers.length > 0) return { valid: true, approverRole: signers[0].approverRole, reason: signers[0].reason };
    if (this.architectKeys().length === 0) {
      return { valid: false, reason: "no trusted Architect keys are configured for this deployment (fail-closed)" };
    }
    return { valid: false, reason: "no Architect token verified for this action, payload and approver role" };
  }

  /**
   * Mathematical Safety Core Equation: F = (D^I) * A
   * If A = 0, F unconditionally collapses to 0.0000.
   *
   * Fails closed (returns 0) on non-finite or out-of-domain D/I/A instead of
   * letting Math.pow produce NaN — e.g. Math.pow(-0.5, 1.5) is NaN, and a
   * NaN future_score previously compared false against every threshold
   * check in evaluate(), which fell through to the AUTHORIZED branch. A
   * broken numeric input must never be treated as a passing score.
   */
  public calculateF(D: number, I: number, A: number): number {
    if (A === 0) return 0.0;
    // Round 48 (Architect decision): no data or no intent means no future.
    // D <= 0 or I <= 0 -> 0 (JS would give 0 ** 0 = 1 and D ** 0 = 1, i.e.
    // a full score with no intent). Same rule as Delentia-OS algo_01_fdia.
    if (!Number.isFinite(D) || !Number.isFinite(I) || !Number.isFinite(A) || D <= 0 || I <= 0) {
      return 0.0;
    }
    const raw = Math.pow(D, I) * A;
    if (!Number.isFinite(raw)) return 0.0;
    return Math.round(raw * 10000) / 10000;
  }

  /**
   * Evaluates complete request with audit digest and policy enforcement
   */
  public evaluate(request: FDIARequest, options: FDIAEvaluateOptions = {}): FDIAEvaluationResult {
    const {
      data_quality,
      intent_precision,
      authorized,
      action_name,
      target_payload = "",
      architect_token,
      caller_role = "developer",
      caller_context,
      dual_signoff_confirmed = false,
      custom_policy,
    } = request;

    // Use runtime inline custom policy if provided, otherwise active policy
    // A caller's custom_policy never carries trusted keys; the child engine
    // inherits this engine's (or the deployment's) keys instead.
    const effectiveEngine = custom_policy
      ? (this.trustedArchitectKeys ? new FDIAEngine(custom_policy).withTrustedArchitectKeys(this.trustedArchitectKeys) : new FDIAEngine(custom_policy))
      : this;
    const policy = effectiveEngine.getPolicy();
    const threshold = policy.custom_safety_threshold ?? 0.5;

    // Dynamic evaluation of parameter A
    let effectiveA: number;
    let aEval: { A: number; reason: string; ruleTriggered: string; actionType: string; verifiedApprover?: string };

    if (authorized === false) {
      effectiveA = 0;
      aEval = {
        A: 0,
        reason: "Authorization Gate A = 0 (Explicitly unverified / revoked).",
        ruleTriggered: "MANUAL_AUTH_REVOKED",
        actionType: "REQUIRE_HUMAN_SIGNATURE",
      };
    } else {
      aEval = effectiveEngine.evaluateA(
        action_name,
        architectPayloadFor(request),
        architect_token,
        caller_role,
        dual_signoff_confirmed,
        options.preverifiedArchitect
      );
      effectiveA = aEval.A;
    }

    const violations: string[] = [];
    if (effectiveA === 0) {
      violations.push(aEval.reason);
    }

    // Fail closed on malformed numeric input (non-finite, negative, or
    // otherwise out-of-domain D/I) instead of letting an invalid score slip
    // through as if it were a legitimate low/high value.
    // Round 48: the domain is the one FDIARequestSchema publishes
    // (data_quality in [0, 1], intent_precision >= 0.5). Tool handlers pass
    // raw MCP arguments straight through (a JSON-Schema `minimum` is only a
    // hint), and before this check intent_precision = 0 made F = D^0 = 1, so
    // ANY data quality - even 0, since JS evaluates 0^0 as 1 - was AUTHORIZED.
    const numericInputInvalid =
      !Number.isFinite(data_quality) || data_quality < 0 || data_quality > FDIA_MAX_DATA_QUALITY ||
      !Number.isFinite(intent_precision) || intent_precision < FDIA_MIN_INTENT_PRECISION;
    if (numericInputInvalid) {
      effectiveA = 0;
      violations.push(`Invalid numeric input: data_quality=${data_quality}, intent_precision=${intent_precision}.`);
    }

    // Calculate F = (D^I) * A
    const future_score = effectiveEngine.calculateF(data_quality, intent_precision, effectiveA);

    let verdict: FDIASecurityVerdict = "AUTHORIZED";
    let reason = aEval.reason;

    if (numericInputInvalid) {
      verdict = "SECURITY_POLICY_VIOLATION";
      reason = `Rejected: data_quality and intent_precision must be finite, with data_quality in [0, ${FDIA_MAX_DATA_QUALITY}] and intent_precision >= ${FDIA_MIN_INTENT_PRECISION} (got data_quality=${data_quality}, intent_precision=${intent_precision}). Fail-closed.`;
    } else if (effectiveA === 0) {
      if (aEval.ruleTriggered === "SECURITY_RBAC_DENIED") {
        verdict = "SECURITY_RBAC_DENIED";
      } else if (aEval.ruleTriggered === "SECURITY_DUAL_SIGNOFF_REQUIRED") {
        verdict = "SECURITY_DUAL_SIGNOFF_REQUIRED";
      } else if (authorized === false || aEval.ruleTriggered === "MANUAL_AUTH_REVOKED" || aEval.ruleTriggered === "ZERO_TRUST_FALLBACK") {
        verdict = "SECURITY_AUTH_DENIED";
      } else {
        verdict = "SECURITY_POLICY_VIOLATION";
      }
    } else if (future_score < threshold) {
      verdict = "BLOCKED_PREEMPTION";
      reason = `FDIA score ${future_score.toFixed(4)} is below enterprise threshold (< ${threshold.toFixed(4)}). Data quality insufficient.`;
      violations.push(reason);
    } else {
      verdict = "AUTHORIZED";
      reason = `FDIA score ${future_score.toFixed(4)} meets enterprise threshold (>= ${threshold.toFixed(4)}). Action approved.`;
    }

    const isApproved = effectiveA === 1 && future_score >= threshold;
    const timestamp = new Date().toISOString();
    const auditString = `${policy.policy_id || "policy"}:${action_name}:${caller_role}:${data_quality}:${intent_precision}:${effectiveA}:${future_score}:${timestamp}:${caller_context || ""}`;
    const audit_digest = createHash("sha256").update(auditString).digest("hex");

    return {
      future_score,
      verdict,
      authorized: isApproved,
      data_quality,
      intent_precision,
      action_name,
      caller_role,
      applied_policy_id: policy.policy_id || "enterprise-policy",
      safety_threshold: threshold,
      audit_digest,
      timestamp,
      reason,
      violations,
      effective_A: effectiveA,
      rule_triggered: aEval.ruleTriggered,
    };
  }

  /**
   * Adds a new custom governance rule dynamically to the policy
   */
  public addRule(rule: FDIARule): void {
    const validated = FDIARuleSchema.parse(rule);
    // Remove existing rule with same id if present
    this.policy.rules = this.policy.rules.filter((r) => r.rule_id !== validated.rule_id);
    this.policy.rules.unshift(validated); // prioritize newest rules
  }

  /**
   * Removes a rule by ID
   */
  public removeRule(ruleId: string): boolean {
    const initialLen = this.policy.rules.length;
    this.policy.rules = this.policy.rules.filter((r) => r.rule_id !== ruleId);
    return this.policy.rules.length < initialLen;
  }

  /**
   * Returns current active policy
   */
  public getPolicy(): FDIAPolicy {
    return this.policy;
  }

  /**
   * Replaces current policy
   */
  public setPolicy(newPolicy: FDIAPolicy): void {
    this.policy = FDIAPolicySchema.parse(newPolicy);
  }
}

// Global default engine instance
export const defaultFDIAEngine = new FDIAEngine();

/**
 * Top-level convenience evaluation function backward-compatible with all MCP servers
 */
export function evaluateFDIA(request: FDIARequest, options: FDIAEvaluateOptions = {}): FDIAEvaluationResult {
  return defaultFDIAEngine.evaluate(request, options);
}
