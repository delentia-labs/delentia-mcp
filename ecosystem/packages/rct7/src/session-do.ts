export interface RCT7SessionRecord {
  timestamp: string;
  problem_statement: string;
  core_intent: string;
  solution_summary: string;
}

export class RCT7SessionDO {
  private state: DurableObjectState;
  private records: RCT7SessionRecord[] = [];

  constructor(state: DurableObjectState) {
    this.state = state;
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<RCT7SessionRecord[]>("records");
      if (stored) {
        this.records = stored;
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/record") {
      const record: RCT7SessionRecord = await request.json();
      this.records.push(record);
      if (this.records.length > 50) {
        this.records = this.records.slice(-50);
      }
      await this.state.storage.put("records", this.records);
      return new Response(JSON.stringify({ recorded: true, count: this.records.length }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (request.method === "GET" && url.pathname === "/history") {
      return new Response(JSON.stringify(this.records), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Not Found", { status: 404 });
  }
}
