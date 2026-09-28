/**
 * RCTDB-inspired 8-dimension log entry — adopted as a SCHEMA/DATA MODEL
 * only, not as the separately-hosted database service RCTDB was originally
 * designed to be.
 *
 * Background (2026-09-13 audit): "RCTDB" (Reverse Component Thinking
 * Database), as originally designed, was meant to be a standalone hosted
 * database service with an 8-dimensional schema (query_hash, fdia_scores,
 * subject_uuid, model_chain, consensus_result, delta_chain, timestamp,
 * provenance). Investigation found real client code calling a server that
 * doesn't exist anywhere, a schema file with a real shipped bug (a
 * trailing comma silently turning a field default into a 1-tuple), and
 * integration tests that mock the very thing they claim to test — closer
 * to a stub than a working database.
 *
 * The 8-dimension SCHEMA itself is a reasonable, well-thought-out design
 * for an audit/provenance log — the recommendation was to keep the schema
 * but reject the separate-hosted-service architecture, since a standalone
 * database this ecosystem would have to host and operate contradicts the
 * actual, proven architectural strength demonstrated everywhere else this
 * session: FDIA, RCT-7, and now MEE (via Durable Objects) all run fully
 * edge-native with zero external services to host. This file folds the
 * 8-dimension schema into that same Durable-Object-backed pattern instead
 * — see rctdb-log-do.ts.
 */

import { createHash } from "node:crypto";

export interface RCTDBLogEntry {
  /** Dimension 1: a stable hash identifying the query/intent/context this entry is about — lets a caller find every entry related to the same input across tools and time. */
  query_hash: string;
  /** Dimension 2: the FDIA verdict this entry is associated with, if any (null for entries from tools that don't gate through FDIA, e.g. a bare compress_context call). */
  fdia_scores: { future_score: number; verdict: string; effective_A: number } | null;
  /** Dimension 3: who/what this entry is about — a caller, session, or agent identifier. */
  subject_uuid: string;
  /** Dimension 4: which model(s) (if any) were actually involved in producing this entry's result — e.g. specialist + verifier model ids for intent-loop, empty for pure math tools like FDIA/Delta that never call a model. */
  model_chain: string[];
  /** Dimension 5: the real multi-model consensus result, if this entry came from a step that ran one (null otherwise — never fabricated). */
  consensus_result: { passed: boolean; confidence: number } | null;
  /** Dimension 6: whatever real "delta"/compression/growth signal this entry's source tool produced — shape varies by source (see build* helpers below), always real numbers from that tool's own output, never invented here. */
  delta_chain: Record<string, number> | null;
  /** Dimension 7: when this entry was recorded. */
  timestamp: string;
  /** Dimension 8: where this entry came from — which tool/worker/version produced it. */
  provenance: { source: string; version: string };
}

/** Real SHA-256 hash for the query_hash dimension — deterministic, same input always produces the same hash. */
export function computeQueryHash(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

const DEFAULT_MAX_ENTRIES = 200;

/**
 * A bounded, in-memory rolling log — the same shape whether it's backing a
 * Durable Object (persisted) or used directly in a test. Bounded so a
 * long-lived DO's storage doesn't grow without limit; oldest entries are
 * dropped first (a real retention policy, not silently unbounded growth).
 */
export class RCTDBLog {
  private entries: RCTDBLogEntry[];
  private readonly maxEntries: number;

  constructor(initial: RCTDBLogEntry[] = [], maxEntries = DEFAULT_MAX_ENTRIES) {
    this.entries = initial;
    this.maxEntries = maxEntries;
  }

  append(entry: RCTDBLogEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(this.entries.length - this.maxEntries);
    }
  }

  all(): RCTDBLogEntry[] {
    return [...this.entries];
  }

  query(filter: { query_hash?: string; subject_uuid?: string }): RCTDBLogEntry[] {
    return this.entries.filter(
      (e) =>
        (filter.query_hash === undefined || e.query_hash === filter.query_hash) &&
        (filter.subject_uuid === undefined || e.subject_uuid === filter.subject_uuid)
    );
  }

  get size(): number {
    return this.entries.length;
  }

  toState(): RCTDBLogEntry[] {
    return this.entries;
  }

  static fromState(state: RCTDBLogEntry[], maxEntries = DEFAULT_MAX_ENTRIES): RCTDBLog {
    return new RCTDBLog(state, maxEntries);
  }
}

// ============================================================================
// Builders: construct a real RCTDBLogEntry from each real tool's actual
// output. None of these invent data — every field either comes straight
// from the source tool's real result or is explicitly null/empty when that
// tool genuinely has no signal for that dimension (e.g. Delta Engine never
// runs a model, so model_chain is always [] for it, not a fabricated value).
// ============================================================================

/** From a real FDIA evaluate() result (packages/shared/src/fdia-core.ts's FDIAEvaluationResult). */
export function buildRctdbEntryFromFdia(params: {
  actionName: string;
  fdiaResult: { future_score: number; verdict: string; effective_A: number };
  subjectUuid: string;
  meeStep?: { g_before: number; g_after: number; delta: number } | null;
  provenance: { source: string; version: string };
}): RCTDBLogEntry {
  return {
    query_hash: computeQueryHash(params.actionName),
    // Explicitly trimmed to exactly the 3 documented fields — found via
    // manual testing that passing the real (much larger) FDIAEvaluationResult
    // object here leaked ALL of its fields into fdia_scores at runtime
    // (TS's structural typing doesn't check excess properties on a
    // variable, only on an inline object literal). A log schema whose
    // shape silently depends on whatever the caller happens to pass is not
    // a real schema — trimming explicitly guarantees the stored shape.
    fdia_scores: {
      future_score: params.fdiaResult.future_score,
      verdict: params.fdiaResult.verdict,
      effective_A: params.fdiaResult.effective_A,
    },
    subject_uuid: params.subjectUuid,
    model_chain: [],
    consensus_result: null,
    delta_chain: params.meeStep
      ? { g_before: params.meeStep.g_before, g_after: params.meeStep.g_after, delta: params.meeStep.delta }
      : null,
    timestamp: new Date().toISOString(),
    provenance: params.provenance,
  };
}

/** From a real compress_context() result (packages/delta/src/index.ts's CompressionResult) — Delta Engine never calls a model or runs consensus, so those dimensions are honestly empty/null, not invented. */
export function buildRctdbEntryFromDelta(params: {
  subjectUuid: string;
  compressionResult: { context_hash: string; estimated_original_tokens: number; estimated_compressed_tokens: number; reduction_percentage: number };
  provenance: { source: string; version: string };
}): RCTDBLogEntry {
  return {
    query_hash: params.compressionResult.context_hash,
    fdia_scores: null,
    subject_uuid: params.subjectUuid,
    model_chain: [],
    consensus_result: null,
    delta_chain: {
      estimated_original_tokens: params.compressionResult.estimated_original_tokens,
      estimated_compressed_tokens: params.compressionResult.estimated_compressed_tokens,
      reduction_percentage: params.compressionResult.reduction_percentage,
    },
    timestamp: new Date().toISOString(),
    provenance: params.provenance,
  };
}

/** From a real JITNA packet (packages/shared/src/jitna-types.ts's JITNAPacket, e.g. produced by orchestrateSwarm()) — no FDIA/consensus dimension since routing alone doesn't run either. */
export function buildRctdbEntryFromJitna(params: {
  subjectUuid: string;
  packet: { I: string; D: number; delta: number; A: string };
  provenance: { source: string; version: string };
}): RCTDBLogEntry {
  return {
    query_hash: computeQueryHash(params.packet.I),
    fdia_scores: null,
    subject_uuid: params.subjectUuid,
    model_chain: [params.packet.A],
    consensus_result: null,
    delta_chain: { D: params.packet.D, delta: params.packet.delta },
    timestamp: new Date().toISOString(),
    provenance: params.provenance,
  };
}

/** From a real IntentLoopEngine result — the one pipeline with all 8 real dimensions available (FDIA gate, model execution, consensus verification, MEE growth). */
export function buildRctdbEntryFromIntentLoop(params: {
  subjectUuid: string;
  queryText: string;
  fdiaScore?: number;
  verdict?: string;
  specialistModel?: string;
  verifierModels?: string[];
  verification?: { passed: boolean; confidence: number } | null;
  meeStep?: { g_before: number; g_after: number; delta: number } | null;
  provenance: { source: string; version: string };
}): RCTDBLogEntry {
  return {
    query_hash: computeQueryHash(params.queryText),
    fdia_scores:
      params.fdiaScore !== undefined && params.verdict !== undefined
        ? { future_score: params.fdiaScore, verdict: params.verdict, effective_A: 1 }
        : null,
    subject_uuid: params.subjectUuid,
    model_chain: [...(params.specialistModel ? [params.specialistModel] : []), ...(params.verifierModels ?? [])],
    // Explicitly trimmed to {passed, confidence} — same excess-property leak
    // risk as fdia_scores above: the real VerificationResult also carries a
    // `votes` array, which would otherwise leak through untrimmed since TS
    // doesn't check excess properties on a variable.
    consensus_result: params.verification ? { passed: params.verification.passed, confidence: params.verification.confidence } : null,
    delta_chain: params.meeStep
      ? { g_before: params.meeStep.g_before, g_after: params.meeStep.g_after, delta: params.meeStep.delta }
      : null,
    timestamp: new Date().toISOString(),
    provenance: params.provenance,
  };
}
