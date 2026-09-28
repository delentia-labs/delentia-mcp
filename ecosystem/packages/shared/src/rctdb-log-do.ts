import { RCTDBLog, type RCTDBLogEntry } from "./rctdb-log.js";

/**
 * RCTDBLogSessionDO — real Cloudflare Durable Object persistence for the
 * RCTDB-inspired 8-dimension log (see rctdb-log.ts for the schema and why
 * this is a Durable Object rather than a separately-hosted database
 * service). Session scoping follows the exact same explicit, documented
 * pattern already established for MEEGrowthSessionDO: the calling worker
 * decides what a given `subject_uuid`/session id maps to via idFromName().
 */

const STORAGE_KEY = "rctdb_log";

export class RCTDBLogSessionDO {
  private state: DurableObjectState;
  private log: RCTDBLog | null = null;
  private loaded = false;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    const stored = await this.state.storage.get<RCTDBLogEntry[]>(STORAGE_KEY);
    this.log = RCTDBLog.fromState(stored ?? []);
    this.loaded = true;
  }

  private getLog(): RCTDBLog {
    if (!this.log) this.log = new RCTDBLog();
    return this.log;
  }

  private async persist(): Promise<void> {
    await this.state.storage.put(STORAGE_KEY, this.getLog().toState());
  }

  async fetch(request: Request): Promise<Response> {
    await this.ensureLoaded();
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/append") {
      const entry = (await request.json()) as RCTDBLogEntry;
      if (!entry || typeof entry.query_hash !== "string" || typeof entry.timestamp !== "string") {
        return new Response(JSON.stringify({ error: "invalid RCTDBLogEntry: missing query_hash or timestamp" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      this.getLog().append(entry);
      await this.persist();
      return new Response(JSON.stringify({ appended: true, total_entries: this.getLog().size }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (request.method === "GET" && url.pathname === "/query") {
      const query_hash = url.searchParams.get("query_hash") ?? undefined;
      const subject_uuid = url.searchParams.get("subject_uuid") ?? undefined;
      const results = this.getLog().query({ query_hash, subject_uuid });
      return new Response(JSON.stringify({ results, total: results.length }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (request.method === "GET" && url.pathname === "/all") {
      return new Response(JSON.stringify({ entries: this.getLog().all(), total: this.getLog().size }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Not Found", { status: 404 });
  }
}
