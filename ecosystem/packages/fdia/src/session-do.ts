import type { FDIAEvaluationResult, ArchitectCustomPolicy } from "@delentia/shared";

export class FDIASessionDO {
  private state: DurableObjectState;
  private auditLogs: FDIAEvaluationResult[] = [];
  private activePolicy: ArchitectCustomPolicy | null = null;

  constructor(state: DurableObjectState) {
    this.state = state;
    this.state.blockConcurrencyWhile(async () => {
      const storedLogs = await this.state.storage.get<FDIAEvaluationResult[]>("auditLogs");
      if (storedLogs) {
        this.auditLogs = storedLogs;
      }
      const storedPolicy = await this.state.storage.get<ArchitectCustomPolicy>("activePolicy");
      if (storedPolicy) {
        this.activePolicy = storedPolicy;
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Record an audit log
    if (request.method === "POST" && url.pathname === "/record") {
      const result: FDIAEvaluationResult = await request.json();
      this.auditLogs.push(result);
      if (this.auditLogs.length > 100) {
        this.auditLogs = this.auditLogs.slice(-100);
      }
      await this.state.storage.put("auditLogs", this.auditLogs);
      return new Response(JSON.stringify({ recorded: true, count: this.auditLogs.length }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Set or update custom enterprise policy
    if (request.method === "POST" && url.pathname === "/policy") {
      const policy: ArchitectCustomPolicy = await request.json();
      this.activePolicy = policy;
      await this.state.storage.put("activePolicy", this.activePolicy);
      return new Response(
        JSON.stringify({ success: true, message: "Custom enterprise policy updated", policy: this.activePolicy }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    // Retrieve active policy
    if (request.method === "GET" && url.pathname === "/policy") {
      return new Response(JSON.stringify(this.activePolicy || { status: "using_system_defaults" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Retrieve audit history
    if (request.method === "GET" && url.pathname === "/history") {
      return new Response(JSON.stringify(this.auditLogs), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Not Found", { status: 404 });
  }
}
