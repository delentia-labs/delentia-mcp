#!/usr/bin/env node

/**
 * Delentia Sovereign AI Operating System — Official MCP Bridge CLI
 * Connects standard MCP stdio clients (Claude Desktop, Cursor, VS Code, Windsurf)
 * through the Delentia Zuplo API Gateway & Commercial Paywall.
 *
 * Developed by Delentia Labs
 * Chief Architect: Ittirit Saengow (Chief Architect / Delentia Labs)
 * Strictly zero dollar signs enforced.
 */

import readline from "readline";

const DEFAULT_ENDPOINT = "https://delentia-sovereign-mcp.delentia.workers.dev/mcp";

// Parse CLI flags and environment variables
const args = process.argv.slice(2);
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

const rl = readline.createInterface({
  input: process.stdin,
  terminal: false,
});

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  try {
    const jsonRpcRequest = JSON.parse(trimmed);

    const headers = {
      "Content-Type": "application/json",
      "User-Agent": "Delentia-MCP-CLI/2.0.0",
    };

    if (apiKey) {
      headers["Authorization"] = "Bearer " + apiKey;
    }

    if (internalSecret) {
      headers["X-Delentia-Internal-Secret"] = internalSecret;
    }

    const response = await fetch(targetEndpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(jsonRpcRequest),
    });

    // If the request was a notification (no id member), JSON-RPC 2.0 prohibits sending a response
    if (jsonRpcRequest.id === undefined) {
      return;
    }

    if (!response.ok) {
      const errorText = await response.text();
      const errResponse = {
        jsonrpc: "2.0",
        id: jsonRpcRequest.id ?? null,
        error: {
          code: -32603,
          message: "Delentia Gateway returned status " + response.status + ": " + errorText,
        },
      };
      process.stdout.write(JSON.stringify(errResponse) + "\n");
      return;
    }

    const jsonRpcResponse = await response.json();
    process.stdout.write(JSON.stringify(jsonRpcResponse) + "\n");
  } catch (err) {
    const parseErrorResponse = {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32700,
        message: "Client Parse Error: " + (err?.message || "Unknown error"),
      },
    };
    process.stdout.write(JSON.stringify(parseErrorResponse) + "\n");
  }
});
