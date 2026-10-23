#!/usr/bin/env node

/**
 * Delentia MCP bridge: connects a standard MCP stdio client (Claude Desktop, Cursor, VS Code,
 * Windsurf) to Delentia's hosted MCP endpoint (Streamable HTTP), one JSON-RPC message at a time.
 *
 *   npx delentia-mcp [--endpoint <url>] [--key <api-key>]      (or DELENTIA_ENDPOINT / DELENTIA_API_KEY)
 *   npx delentia-mcp --help | --version
 *
 * The tools it exposes are ADVISORY (an agent that does not call them is not stopped). To enforce
 * a policy on every tool call, use Delentia Guard (`npx delentia-guard`).
 *
 * Round 91: a request that gets no answer within DELENTIA_TIMEOUT_MS (default 60000) is answered
 * with a JSON-RPC error instead of hanging the client; a `text/event-stream` reply is read
 * (each `data:` event is one JSON-RPC message) instead of failing as "not JSON"; the server's
 * `Mcp-Session-Id` is sent back on later requests; the User-Agent carries the real package
 * version; `--help` and `--version` answer instead of waiting on stdin.
 *
 * Developed by Delentia Labs. Chief Architect: Ittirit Saengow.
 */

import readline from "readline";
import { readFileSync } from "node:fs";

const DEFAULT_ENDPOINT = "https://delentia-sovereign-mcp.delentia.workers.dev/mcp";

let VERSION = "unknown";
try {
  VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
} catch {
  /* running from a bundle without package.json: keep "unknown" */
}

// Parse CLI flags and environment variables
const args = process.argv.slice(2);

if (args.includes("--version") || args.includes("-v")) {
  process.stdout.write(VERSION + "\n");
  process.exit(0);
}
if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(
    [
      `delentia-mcp ${VERSION}: stdio bridge to Delentia's hosted MCP endpoint`,
      "",
      "usage: delentia-mcp [--endpoint <url>] [--key <api-key>]",
      "  --endpoint, -e <url>   MCP endpoint (default: " + DEFAULT_ENDPOINT + ", or DELENTIA_ENDPOINT)",
      "  --key, -k <api-key>    API key for the paid tier (prefer the DELENTIA_API_KEY environment variable: a key on the command line shows in process lists)",
      "  DELENTIA_TIMEOUT_MS    per-request timeout in milliseconds (default 60000)",
      "",
      "The hosted tools are advisory. To enforce a policy on every tool call use delentia-guard.",
      "",
    ].join("\n")
  );
  process.exit(0);
}

let cliEndpoint = "";
let cliApiKey = "";

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--key" || arg === "--api-key" || arg === "-k") {
    cliApiKey = args[i + 1] || "";
    i++;
  } else if (arg === "--endpoint" || arg === "-e") {
    cliEndpoint = args[i + 1] || "";
    i++;
  } else if (arg.startsWith("https://") || arg.startsWith("http://")) {
    cliEndpoint = arg;
  }
}

const targetEndpoint = cliEndpoint || process.env.DELENTIA_ENDPOINT || DEFAULT_ENDPOINT;
const apiKey = cliApiKey || process.env.DELENTIA_API_KEY || process.env.ZUPLO_API_KEY || "";
const internalSecret = process.env.DELENTIA_INTERNAL_SECRET || "";
const timeoutMs = Number(process.env.DELENTIA_TIMEOUT_MS) > 0 ? Number(process.env.DELENTIA_TIMEOUT_MS) : 60000;

let sessionId = "";

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const rpcError = (id, code, message) => send({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

/** Every JSON-RPC message in a `text/event-stream` body (one per `data:` event). */
function messagesFromEventStream(text) {
  const out = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    try {
      out.push(JSON.parse(data));
    } catch {
      /* not JSON: ignore this event */
    }
  }
  return out;
}

const rl = readline.createInterface({
  input: process.stdin,
  terminal: false,
});

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let jsonRpcRequest;
  try {
    jsonRpcRequest = JSON.parse(trimmed);
  } catch (err) {
    rpcError(null, -32700, "Client Parse Error: " + (err?.message || "Unknown error"));
    return;
  }

  try {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "User-Agent": "Delentia-MCP-CLI/" + VERSION,
    };
    if (apiKey) headers["Authorization"] = "Bearer " + apiKey;
    if (internalSecret) headers["X-Delentia-Internal-Secret"] = internalSecret;
    if (sessionId) headers["Mcp-Session-Id"] = sessionId;

    const response = await fetch(targetEndpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(jsonRpcRequest),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const newSession = response.headers.get("mcp-session-id");
    if (newSession) sessionId = newSession;

    // If the request was a notification (no id member), JSON-RPC 2.0 prohibits sending a response
    if (jsonRpcRequest.id === undefined) {
      await response.arrayBuffer().catch(() => undefined);
      return;
    }

    if (!response.ok) {
      const errorText = await response.text();
      // A JSON-RPC error body (the quota answer is one) keeps its own code; anything else becomes -32603.
      try {
        const body = JSON.parse(errorText);
        if (body && body.error && typeof body.error.code === "number") {
          send({ jsonrpc: "2.0", id: jsonRpcRequest.id ?? null, error: body.error });
          return;
        }
      } catch {
        /* not JSON */
      }
      rpcError(jsonRpcRequest.id, -32603, "Delentia Gateway returned status " + response.status + ": " + errorText.slice(0, 500));
      return;
    }

    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("text/event-stream")) {
      const messages = messagesFromEventStream(await response.text());
      if (!messages.length) {
        rpcError(jsonRpcRequest.id, -32603, "Delentia Gateway sent an event stream with no JSON-RPC message in it");
        return;
      }
      for (const m of messages) send(m);
      return;
    }

    send(await response.json());
  } catch (err) {
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    rpcError(
      jsonRpcRequest.id,
      timedOut ? -32001 : -32603,
      timedOut ? `Delentia Gateway did not answer within ${timeoutMs} ms` : "Delentia bridge error: " + (err?.message || "Unknown error")
    );
  }
});
