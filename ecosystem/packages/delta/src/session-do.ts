export interface DeltaSessionState {
  sessionId: string;
  baseContextHash: string;
  accumulatedDeltas: string[];
  totalOriginalTokens: number;
  totalCompressedTokens: number;
}

export class DeltaSessionDO {
  private state: DurableObjectState;
  private sessionData: DeltaSessionState = {
    sessionId: "default",
    baseContextHash: "",
    accumulatedDeltas: [],
    totalOriginalTokens: 0,
    totalCompressedTokens: 0,
  };

  constructor(state: DurableObjectState) {
    this.state = state;
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<DeltaSessionState>("session");
      if (stored) {
        this.sessionData = stored;
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/update") {
      const update: Partial<DeltaSessionState> = await request.json();
      this.sessionData = { ...this.sessionData, ...update };
      await this.state.storage.put("session", this.sessionData);
      return new Response(JSON.stringify({ updated: true, stats: this.sessionData }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (request.method === "GET" && url.pathname === "/stats") {
      return new Response(JSON.stringify(this.sessionData), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Not Found", { status: 404 });
  }
}
