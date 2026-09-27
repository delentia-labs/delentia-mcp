// Minimal stdio MCP server for tests: answers initialize / tools/list, and "executes" any
// tools/call by recording the tool name in the file given as argv[2].
import { appendFileSync, readFileSync } from "node:fs";

const executedLog = process.argv[2];
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    let result;
    if (msg.method === "initialize") {
      result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "0" } };
    } else if (msg.method === "tools/list") {
      result = { tools: ["read_file", "write_file", "delete_file"].map((name) => ({ name, inputSchema: { type: "object" } })) };
    } else if (msg.method === "tools/call") {
      appendFileSync(executedLog, msg.params.name + "\n");
      // Any call with a `path` argument returns that file's real content when FAKE_READ_ROOT is set (output-compression tests).
      const text = process.env.FAKE_READ_ROOT && msg.params.arguments?.path
        ? readFileSync(process.env.FAKE_READ_ROOT + "/" + msg.params.arguments.path, "utf8")
        : `executed ${msg.params.name}`;
      result = { content: [{ type: "text", text }] };
    }
    if (msg.id !== undefined && result) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
  }
});
