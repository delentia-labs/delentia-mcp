import { MEEGrowthTracker, confidenceToGrowthDelta, type MEEGrowthState } from "./mee-growth.js";
import { architectPayloadFor, evaluateFDIA, type FDIARequest, type FDIAEvaluationResult, type ArchitectCustomPolicy } from "./fdia-core.js";
import { importPublicKeyFromJwk, verifyPayloadSignature } from "./ed25519.js";
import { configureTrustedArchitectKeys, getConfiguredTrustedArchitectKeys, parseTrustedArchitectKeys, preverifyArchitectTokens } from "./architect-token.js";

/**
 * MEEGrowthGatedDO — a real, hash-chained, FDIA-gated, Ed25519-verified
 * upgrade path for MEE growth tracking. This is an ADDITIVE new Durable
 * Object (Zero-Delete-consistent) — `MEEGrowthSessionDO` (mee-session-do.ts)
 * is left completely unchanged and keeps serving every existing caller
 * exactly as before. Use this class only where a caller genuinely wants the
 * stronger guarantees below; nothing in the codebase is forced onto it.
 *
 * Three deliberate anti-rubber-stamp design decisions, each closing the
 * same class of bug already self-documented elsewhere in this ecosystem
 * (Delentia-OS's zk_fdia.py docstring: "prover=verifier means the ZK layer
 * adds no real trust boundary here" — i.e. a component that both proposes
 * AND certifies its own claim provides no real verification):
 *
 * 1. GatedTransitionPayload has NO `isAuthorized`/`authorized` field. A
 *    caller cannot assert authorization directly. Instead it supplies the
 *    raw inputs evaluateFDIA() itself needs (data_quality, intent_precision,
 *    action_name, ...) and this DO's fetch() handler always re-runs the
 *    real evaluateFDIA() server-side with `authorized` HARDCODED to `true`
 *    (a literal, never read from the payload) so FDIAEngine.evaluate()'s
 *    own `authorized === false` unconditional-deny shortcut can never be
 *    triggered by a caller — the transition is gated purely on evaluateA()'s
 *    real policy-rule logic (RBAC, action-pattern matching, dual signoff,
 *    architect signature checks), never on anything the caller merely claims.
 *
 * 2. `jitnaSignature` is verified with real Ed25519 (crypto.subtle.verify,
 *    via ed25519.ts's own verifyPayloadSignature/importPublicKeyFromJwk —
 *    no new crypto primitive invented here). The verifying public key
 *    (`trustedJitnaPublicKeyJwk`) is read ONLY from a sibling field of the
 *    request body — i.e. supplied by the calling WORKER from its own
 *    trusted key source (e.g. getOrCreateJitnaSigningKeypair()'s public
 *    key), never from inside the caller-controlled `payload` object. Even
 *    if a caller smuggles a same-named field into `payload`, it is never
 *    read — `GatedTransitionPayload` doesn't declare that field, and the
 *    verification code below only ever looks at the top-level sibling.
 *    A missing, malformed, or wrong-key signature is ALWAYS a hard
 *    rejection; there is no code path that treats a non-empty string as
 *    "signed".
 *
 * 3. Growth math is the codebase's own real, already-shared formula:
 *    MEEGrowthTracker (mee-growth.ts, itself a verified TS port of
 *    Delentia-OS's mee_engine.py) stepped via confidenceToGrowthDelta —
 *    the SAME helper packages/intent-loop's ConsensusVerifier already
 *    uses to turn a consensus confidence into a signed delta. No new,
 *    ad-hoc growth formula is introduced here.
 *
 * Hash chain: on a genuinely ACCEPTED transition (FDIA-authorized AND
 * signature-verified — see `evaluateTransition` below), and ONLY then:
 *   stateHash = SHA-256(prevHash:sequenceNumber:growthFactor:intentId:jitnaSignature)
 * A rejected transition (bad signature, or FDIA denies the action) leaves
 * growthFactor, sequenceNumber, and stateHash completely untouched — it is
 * recorded only via `rejectedCount`, so it can never silently advance the
 * chain as if it had succeeded, and the hash always stays a genuine
 * reflection of the growthFactor it was computed over.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Shape of a real multi-model consensus outcome (matches the fields
 * packages/intent-loop's ConsensusVerifier already produces/consumes).
 * This DO does not run consensus itself — it only maps an already-computed
 * result to a growth signal, same division of responsibility as
 * `confidenceToGrowthDelta`'s existing caller.
 */
export interface ConsensusResult {
  /** Did the consensus process itself judge this a valid, agreed outcome? */
  isConsensusValid: boolean;
  /** Was this result served from a cache instead of a fresh consensus run?
   *  Weaker evidence than a fresh run — it reflects a PRIOR verification,
   *  not this call's own. */
  isCacheHit?: boolean;
  /** Did the consensus process flag this outcome as actively malicious
   *  (e.g. a model colluding / adversarial output), not just "invalid"? */
  isMalicious?: boolean;
}

/**
 * The caller-controlled request body. Deliberately has NO `isAuthorized` /
 * `authorized` field — see the module docstring's point 1. Every field here
 * is a raw input the DO itself re-verifies (via evaluateFDIA and Ed25519),
 * never a pre-computed verdict the caller hands over.
 */
export interface GatedTransitionPayload {
  // Raw FDIA inputs — see FDIARequest in fdia-core.ts for the authoritative
  // shape. `authorized` is intentionally NOT part of this type.
  data_quality: number;
  intent_precision?: number;
  action_name: string;
  target_payload?: string;
  architect_token?: string;
  caller_role?: string;
  caller_context?: string;
  dual_signoff_confirmed?: boolean;
  custom_policy?: ArchitectCustomPolicy;

  /** Real, already-computed consensus outcome this transition is reporting. */
  consensusResult: ConsensusResult;

  /** Identifier of the intent/transition being certified — part of the
   *  signed content and part of the hash chain input. */
  intentId: string;

  /** Base64 Ed25519 signature over this payload's own canonical form
   *  (every field EXCEPT this signature field itself — see
   *  `signableView` below), produced by the calling worker's real JITNA
   *  signing key (see packages/jitna/src/index.ts's signJitnaPacket /
   *  getOrCreateJitnaSigningKeypair for the established pattern). */
  jitnaSignature: string;

  /** Optional label for which agent/session this transition belongs to.
   *  Purely descriptive state — DO instance selection/isolation itself is
   *  the calling worker's job via resolveSessionDOName (session-scoping.ts),
   *  same as every other pillar worker's DO usage. */
  agentId?: string;
}

/** The full request body this DO's /mutate_state route accepts.
 *  `trustedJitnaPublicKeyJwk` is a SIBLING of `payload`, not nested inside
 *  it — see the module docstring's point 2 for why that separation is the
 *  whole point. */
export interface MutateStateRequest {
  payload: GatedTransitionPayload;
  trustedJitnaPublicKeyJwk: JsonWebKey;
}

export interface GatedState {
  growthFactor: number;
  consensusCount: number;
  rejectedCount: number;
  cacheHitCount: number;
  lastUpdated: string;
  sequenceNumber: number;
  stateHash: string;
  agentId: string;
  version: number;
}

export interface MutateStateResponse {
  accepted: boolean;
  state: GatedState;
  fdia_result: FDIAEvaluationResult;
  signature_valid: boolean;
  growth_delta_applied: number;
  governance_violation?: boolean;
  rejection_reason?: "signature_invalid" | "fdia_not_authorized" | "malformed_request";
}

// ---------------------------------------------------------------------------
// Constants / helpers
// ---------------------------------------------------------------------------

const STATE_VERSION = 1;
/** Sentinel prevHash chained into the very first accepted transition
 *  (sequenceNumber 0 -> 1) — analogous to a genesis block hash. */
const GENESIS_PREV_HASH = "0".repeat(64);

const STORAGE_KEY = "mee_gated_state";

interface StoredGatedData {
  state: GatedState;
  tracker: MEEGrowthState;
}

function freshState(agentId: string): GatedState {
  return {
    growthFactor: 1.0, // matches MEEGrowthTracker's default gInitial
    consensusCount: 0,
    rejectedCount: 0,
    cacheHitCount: 0,
    lastUpdated: new Date(0).toISOString(),
    sequenceNumber: 0,
    stateHash: GENESIS_PREV_HASH,
    agentId,
    version: STATE_VERSION,
  };
}

/** Real SHA-256 hex digest via Workers/Node-native crypto.subtle — same
 *  primitive ed25519.ts's computeKeyFingerprint already uses, just over an
 *  arbitrary string instead of a raw key. */
export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** The exact object whose canonical form the signature was computed over:
 *  every payload field EXCEPT the signature itself (a signature obviously
 *  cannot cover its own bytes). */
function signableView(payload: GatedTransitionPayload): Omit<GatedTransitionPayload, "jitnaSignature"> {
  const { jitnaSignature: _jitnaSignature, ...rest } = payload;
  return rest;
}

/**
 * Real Ed25519 verification. Never throws — a missing key, missing
 * signature, malformed JWK, or genuinely wrong/tampered signature all
 * resolve to `false`, which the caller MUST treat as a hard rejection.
 */
async function verifyTransitionSignature(
  payload: GatedTransitionPayload,
  trustedPublicKeyJwk: JsonWebKey | undefined
): Promise<boolean> {
  if (!trustedPublicKeyJwk || typeof trustedPublicKeyJwk !== "object") return false;
  if (typeof payload.jitnaSignature !== "string" || payload.jitnaSignature.trim().length === 0) return false;
  try {
    const publicKey = await importPublicKeyFromJwk(trustedPublicKeyJwk);
    return await verifyPayloadSignature(publicKey, signableView(payload), payload.jitnaSignature);
  } catch {
    return false;
  }
}

/**
 * Maps a real ConsensusResult to (confidence, isGovernanceViolation), then
 * hands the confidence to the codebase's own shared confidenceToGrowthDelta
 * — the same mapping packages/intent-loop's ConsensusVerifier already uses.
 * Fresh, valid consensus (confidence 1.0) is treated as the strongest real
 * evidence; a cache hit (confidence 0.75) reflects a PRIOR fresh
 * verification rather than this call's own, so it is deliberately weaker
 * without being penalized as a violation; invalid or malicious consensus
 * (confidence 0.0) is both a maximal negative growth signal AND a
 * governance violation (applies MEEGrowthTracker's resilience penalty).
 */
function consensusToConfidence(consensus: ConsensusResult): { confidence: number; governanceViolation: boolean } {
  if (consensus.isMalicious) return { confidence: 0.0, governanceViolation: true };
  if (!consensus.isConsensusValid) return { confidence: 0.0, governanceViolation: true };
  if (consensus.isCacheHit) return { confidence: 0.75, governanceViolation: false };
  return { confidence: 1.0, governanceViolation: false };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// ---------------------------------------------------------------------------
// Durable Object
// ---------------------------------------------------------------------------

export class MEEGrowthGatedDO {
  private ds: DurableObjectState;
  private gatedState: GatedState | null = null;
  private tracker: MEEGrowthTracker | null = null;
  private loaded = false;

  constructor(state: DurableObjectState, env?: { FDIA_ARCHITECT_KEYS_JSON?: string }) {
    this.ds = state;
    // Round 48: same trusted Architect keys as the Worker (never from the payload).
    configureTrustedArchitectKeys(parseTrustedArchitectKeys(env?.FDIA_ARCHITECT_KEYS_JSON));
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    const stored = await this.ds.storage.get<StoredGatedData>(STORAGE_KEY);
    if (stored) {
      this.gatedState = stored.state;
      this.tracker = MEEGrowthTracker.fromState(stored.tracker);
    }
    this.loaded = true;
  }

  private getState(agentId: string): GatedState {
    if (!this.gatedState) this.gatedState = freshState(agentId);
    return this.gatedState;
  }

  private getTracker(): MEEGrowthTracker {
    if (!this.tracker) this.tracker = new MEEGrowthTracker();
    return this.tracker;
  }

  private async persist(): Promise<void> {
    if (!this.gatedState) return;
    await this.ds.storage.put(STORAGE_KEY, {
      state: this.gatedState,
      tracker: this.getTracker().toState(),
    } satisfies StoredGatedData);
  }

  async fetch(request: Request): Promise<Response> {
    await this.ensureLoaded();
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/get_state") {
      return jsonResponse(this.getState("default"));
    }

    if (request.method === "POST" && url.pathname === "/mutate_state") {
      let body: Partial<MutateStateRequest>;
      try {
        body = (await request.json()) as Partial<MutateStateRequest>;
      } catch {
        return jsonResponse({ error: "invalid JSON body" }, 400);
      }

      const payload = body?.payload;
      if (
        !payload ||
        typeof payload !== "object" ||
        typeof payload.data_quality !== "number" ||
        typeof payload.action_name !== "string" ||
        payload.action_name.trim().length === 0 ||
        typeof payload.intentId !== "string" ||
        payload.intentId.trim().length === 0 ||
        !payload.consensusResult ||
        typeof payload.consensusResult !== "object"
      ) {
        return jsonResponse(
          {
            error:
              "payload.data_quality (number), payload.action_name (non-empty string), payload.intentId (non-empty string), and payload.consensusResult (object) are all required",
          },
          400
        );
      }

      const state = this.getState(payload.agentId?.trim() || "default");
      const signatureValid = await verifyTransitionSignature(payload, body.trustedJitnaPublicKeyJwk);

      // Real, server-side re-evaluation. `authorized` is hardcoded to
      // `true` here — a LITERAL, never read from `payload` (which has no
      // such field to begin with). This is deliberate, not an oversight:
      // FDIAEngine.evaluate() treats `authorized === false` as an
      // UNCONDITIONAL override that short-circuits effectiveA to 0 without
      // even consulting the policy's real rules. Hardcoding `true` means
      // that override path can never be triggered by anything a caller
      // supplies — the ONLY way this evaluation can come back unauthorized
      // is through evaluateA()'s real, policy-rule-based logic (RBAC,
      // wildcard action-pattern matching, dual signoff, architect
      // signature checks), exactly matching this module's docstring point 1.
      const fdiaRequest: FDIARequest = {
        data_quality: payload.data_quality,
        intent_precision: payload.intent_precision ?? 1.0,
        authorized: true,
        action_name: payload.action_name,
        target_payload: payload.target_payload,
        architect_token: payload.architect_token,
        caller_role: payload.caller_role ?? "developer",
        caller_context: payload.caller_context,
        dual_signoff_confirmed: payload.dual_signoff_confirmed ?? false,
        custom_policy: payload.custom_policy,
      };
      const preverifiedArchitect = await preverifyArchitectTokens(fdiaRequest.architect_token, {
        actionName: fdiaRequest.action_name,
        targetPayload: architectPayloadFor(fdiaRequest),
        trustedKeys: getConfiguredTrustedArchitectKeys(),
      });
      const fdiaResult = evaluateFDIA(fdiaRequest, { preverifiedArchitect });

      if (payload.consensusResult.isCacheHit) state.cacheHitCount += 1;

      const accepted = fdiaResult.authorized && signatureValid;

      if (!accepted) {
        state.rejectedCount += 1;
        await this.persist();
        const response: MutateStateResponse = {
          accepted: false,
          state,
          fdia_result: fdiaResult,
          signature_valid: signatureValid,
          growth_delta_applied: 0,
          rejection_reason: !signatureValid ? "signature_invalid" : "fdia_not_authorized",
        };
        return jsonResponse(response);
      }

      // --- Genuinely accepted: advance real growth math + hash chain. ---
      const { confidence, governanceViolation } = consensusToConfidence(payload.consensusResult);
      const delta = confidenceToGrowthDelta(confidence);
      const tracker = this.getTracker();
      const step = tracker.step(delta, governanceViolation);

      const prevHash = state.stateHash;
      state.growthFactor = step.g_after;
      state.consensusCount += 1;
      state.sequenceNumber += 1;
      state.lastUpdated = step.timestamp;
      state.stateHash = await sha256Hex(
        `${prevHash}:${state.sequenceNumber}:${state.growthFactor}:${payload.intentId}:${payload.jitnaSignature}`
      );

      await this.persist();

      const response: MutateStateResponse = {
        accepted: true,
        state,
        fdia_result: fdiaResult,
        signature_valid: true,
        growth_delta_applied: delta,
        governance_violation: governanceViolation,
      };
      return jsonResponse(response);
    }

    return new Response("Not Found", { status: 404 });
  }
}
