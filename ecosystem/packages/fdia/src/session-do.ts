import type { FDIAEvaluationResult } from "@delentia/shared";

/**
 * FDIASessionDO: Cloudflare Durable Object
 * Preserves user security session state, audit logs, and preemption counters across requests.
 */
export class FDIASessionDO {
  private state: DurableObjectState;
  private history: FDIAEvaluationResult[] = [];

  constructor(state: DurableObjectState) {
    this.state = state;
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<FDIAEvaluationResult[]>("history");
      if (stored) {
        this.history = stored;
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/record") {
      const result: FDIAEvaluationResult = await request.json();
      this.history.push(result);
      // Keep last 100 audit events in durable storage
      if (this.history.length > 100) {
        this.history = this.history.slice(-100);
      }
      await this.state.storage.put("history", this.history);
      return new Response(JSON.stringify({ recorded: true, totalEvents: this.history.length }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (request.method === "GET" && url.pathname === "/history") {
      return new Response(JSON.stringify(this.history), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Not Found", { status: 404 });
  }
}
