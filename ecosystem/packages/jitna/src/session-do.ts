import type { JITNAPacket } from "@delentia/shared";

export class JITNASessionDO {
  private state: DurableObjectState;
  private packets: JITNAPacket[] = [];

  constructor(state: DurableObjectState) {
    this.state = state;
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<JITNAPacket[]>("packets");
      if (stored) {
        this.packets = stored;
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/dispatch") {
      const packet: JITNAPacket = await request.json();
      this.packets.push(packet);
      if (this.packets.length > 50) {
        this.packets = this.packets.slice(-50);
      }
      await this.state.storage.put("packets", this.packets);
      return new Response(JSON.stringify({ dispatched: true, totalPackets: this.packets.length }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (request.method === "GET" && url.pathname === "/packets") {
      return new Response(JSON.stringify(this.packets), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Not Found", { status: 404 });
  }
}
