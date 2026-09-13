import { MEEGrowthTracker, type MEEStepRecord, type MEEGrowthSummary, type MEEGrowthState } from "./mee-growth.js";

/**
 * MEEGrowthSessionDO — Cloudflare Durable Object providing REAL persistent
 * storage for MEEGrowthTracker state, shared by any worker that binds it
 * (currently: sovereign, fdia).
 *
 * Session scoping is a deliberate, documented decision — not the silent
 * "one hardcoded global name for every caller" pattern already flagged as a
 * real bug in ROADMAP.md for the other 4 pillar workers' Durable Objects
 * (idFromName("global_X_session") for ALL callers, which for fdia meant one
 * caller's configure_policy could affect another caller's evaluate_fdia).
 * This DO itself is agnostic to naming — the calling worker decides what
 * `session_id` maps to which DO instance via idFromName(). The documented,
 * intentional default (see worker.ts callers) is: omit `session_id` and get
 * ONE shared "default" growth trajectory representing the deployment's
 * overall aggregate growth (matching mee_engine.py's original single-session
 * design intent — "the system getting smarter over time" as a whole); pass
 * an explicit `session_id` to get an isolated, per-caller/per-agent
 * trajectory instead. Unlike the FDIA policy-sharing bug, sharing growth
 * state by default carries no security consequence (it's a read-mostly,
 * additive metric, not an authorization decision) — but the choice is
 * explicit and documented here rather than accidental.
 */

interface MEESessionData {
  session_id: string;
  tracker: MEEGrowthState;
  last_step?: MEEStepRecord;
}

const STORAGE_KEY = "mee_session";

export class MEEGrowthSessionDO {
  private state: DurableObjectState;
  private tracker: MEEGrowthTracker | null = null;
  private sessionId = "default";
  private lastStep: MEEStepRecord | undefined;
  private loaded = false;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    const stored = await this.state.storage.get<MEESessionData>(STORAGE_KEY);
    if (stored) {
      this.tracker = MEEGrowthTracker.fromState(stored.tracker);
      this.sessionId = stored.session_id;
      this.lastStep = stored.last_step;
    }
    this.loaded = true;
  }

  private getTracker(): MEEGrowthTracker {
    if (!this.tracker) this.tracker = new MEEGrowthTracker();
    return this.tracker;
  }

  private async persist(): Promise<void> {
    await this.state.storage.put(STORAGE_KEY, {
      session_id: this.sessionId,
      tracker: this.getTracker().toState(),
      last_step: this.lastStep,
    } satisfies MEESessionData);
  }

  async fetch(request: Request): Promise<Response> {
    await this.ensureLoaded();
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/step") {
      const body: { delta: number; governance_violation?: boolean; session_id?: string } = await request.json();
      if (typeof body.delta !== "number" || !Number.isFinite(body.delta)) {
        return new Response(JSON.stringify({ error: "delta must be a finite number" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (body.session_id) this.sessionId = body.session_id;

      const tracker = this.getTracker();
      const record = tracker.step(body.delta, body.governance_violation ?? false);
      this.lastStep = record;
      await this.persist();

      return new Response(JSON.stringify({ step: record, summary: tracker.summary() }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (request.method === "GET" && url.pathname === "/summary") {
      const tracker = this.getTracker();
      const body: { summary: MEEGrowthSummary; last_step: MEEStepRecord | null; session_id: string } = {
        summary: tracker.summary(),
        last_step: this.lastStep ?? null,
        session_id: this.sessionId,
      };
      return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
    }

    if (request.method === "POST" && url.pathname === "/reset") {
      this.tracker = new MEEGrowthTracker();
      this.lastStep = undefined;
      await this.persist();
      return new Response(JSON.stringify({ reset: true, summary: this.tracker.summary() }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Not Found", { status: 404 });
  }
}
