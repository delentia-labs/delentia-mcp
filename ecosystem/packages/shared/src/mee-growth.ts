/**
 * MEE Growth Tracker — TS port of Delentia-OS/rct_control_plane/mee_engine.py's
 * real, tested growth formula: G(t+1) = G(t) x (1+MΔ) x R_t.
 *
 * Moved here (2026-09-12, originally added to packages/intent-loop) so every
 * TS package that wants a real, persistent growth signal can share ONE
 * canonical implementation instead of re-deriving the formula a third time —
 * the same anti-duplication reasoning already applied to FDIA itself.
 *
 * Verified numerical parity against the actual Python module: an identical
 * 8-step delta/violation sequence matched the real MEESession.step() output
 * to 6 decimal places on every step's g_after and resilience, not just the
 * final value (see delentia-mcp-ecosystem/tests/intent_loop.test.mjs).
 *
 * This engine cannot call Python directly (Cloudflare Workers has no Python
 * runtime), which is why this is a from-scratch port rather than an FFI call.
 */

const MEE_META_RATE = 0.1; // M — matches mee_engine.py's DEFAULT_META_RATE
const MEE_RESILIENCE_PENALTY = 0.02; // matches mee_engine.py's RESILIENCE_PENALTY
const MEE_RESILIENCE_RECOVERY = 0.005; // matches mee_engine.py's RESILIENCE_RECOVERY
const MEE_G_FLOOR = 0.1; // matches mee_engine.py's G_FLOOR
const MEE_G_CAP = 1000.0; // matches mee_engine.py's G_CAP

export interface MEEStepRecord {
  step: number;
  g_before: number;
  g_after: number;
  delta: number;
  meta_rate: number;
  resilience: number;
  governance_violation: boolean;
  growth_ratio: number;
  timestamp: string;
}

export interface MEEGrowthSummary {
  g_initial: number;
  g_current: number;
  total_growth_ratio: number;
  steps: number;
  resilience: number;
}

/** Plain serializable snapshot of a tracker's internal state, for Durable Object persistence. */
export interface MEEGrowthState {
  g: number;
  g_initial: number;
  resilience: number;
  step_count: number;
  meta_rate: number;
}

export class MEEGrowthTracker {
  private g: number;
  private resilience: number;
  private stepCount: number;
  private readonly gInitial: number;
  private readonly metaRate: number;

  constructor(gInitial = 1.0, metaRate = MEE_META_RATE) {
    this.g = Math.max(gInitial, MEE_G_FLOOR);
    this.gInitial = this.g;
    this.metaRate = metaRate;
    this.resilience = 1.0;
    this.stepCount = 0;
  }

  /** Advances one real step: G(t+1) = max(G_FLOOR, min(G_CAP, G(t) x (1+MΔ) x R_t)) — same formula as mee_engine.py's MEESession.step(). */
  step(delta: number, governanceViolation = false): MEEStepRecord {
    this.resilience = governanceViolation
      ? Math.max(0.5, this.resilience - MEE_RESILIENCE_PENALTY)
      : Math.min(1.0, this.resilience + MEE_RESILIENCE_RECOVERY);

    const g_before = this.g;
    let g_after = g_before * (1 + this.metaRate * delta) * this.resilience;
    g_after = Math.max(MEE_G_FLOOR, Math.min(MEE_G_CAP, g_after));
    this.g = g_after;
    this.stepCount += 1;

    return {
      step: this.stepCount,
      g_before,
      g_after,
      delta,
      meta_rate: this.metaRate,
      resilience: this.resilience,
      governance_violation: governanceViolation,
      growth_ratio: g_before !== 0 ? g_after / g_before : 1,
      timestamp: new Date().toISOString(),
    };
  }

  get value(): number {
    return this.g;
  }

  get currentResilience(): number {
    return this.resilience;
  }

  get steps(): number {
    return this.stepCount;
  }

  summary(): MEEGrowthSummary {
    return {
      g_initial: this.gInitial,
      g_current: this.g,
      total_growth_ratio: this.gInitial !== 0 ? this.g / this.gInitial : 1,
      steps: this.stepCount,
      resilience: this.resilience,
    };
  }

  /** Serializes internal state for storage (e.g. a Durable Object). */
  toState(): MEEGrowthState {
    return { g: this.g, g_initial: this.gInitial, resilience: this.resilience, step_count: this.stepCount, meta_rate: this.metaRate };
  }

  /** Directly overwrites internal state from a previously-serialized snapshot (e.g. loaded from Durable Object storage). Bypasses the constructor's G_FLOOR clamp on gInitial since a persisted state is, by construction, already a valid prior output of this same class. */
  restoreState(state: MEEGrowthState): void {
    this.g = state.g;
    this.resilience = state.resilience;
    this.stepCount = state.step_count;
  }

  /** Constructs a tracker whose current state is restored from a previously-serialized snapshot. */
  static fromState(state: MEEGrowthState): MEEGrowthTracker {
    const tracker = new MEEGrowthTracker(state.g_initial, state.meta_rate);
    tracker.restoreState(state);
    return tracker;
  }
}

/**
 * Maps a real ConsensusVerifier confidence (0-1, fraction of models that
 * voted YES) to a signed MEE delta in roughly [-1, 1]: confidence=1.0 (full
 * agreement) -> delta=+1 (strong growth signal); confidence=0.0 (full
 * disagreement) -> delta=-1 (strong decline signal); confidence=0.5 (a
 * coin-flip split) -> delta=0 (neutral, no real signal either way).
 */
export function confidenceToGrowthDelta(confidence: number): number {
  return (confidence - 0.5) * 2;
}
