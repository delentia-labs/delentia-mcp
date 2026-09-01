#!/usr/bin/env node

/**
 * Delentia Sovereign AI Operating System — Official MCP Bridge CLI
 * Connects standard MCP stdio clients (Claude Desktop, Cursor, VS Code, Windsurf)
 * directly to the Delentia Sovereign Cloudflare Edge Gateway.
 *
 * Developed by Delentia Labs
 * Chief Architect: Ittirit Saengow (The Architect)
 */

import readline from "readline";

const DEFAULT_ENDPOINT = "https://delentia-sovereign-mcp.delentia.workers.dev/mcp";
const targetEndpoint = process.env.DELENTIA_ENDPOINT || DEFAULT_ENDPOINT;
const apiKey = process.env.DELENTIA_API_KEY || "";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
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
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const response = await fetch(targetEndpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(jsonRpcRequest),
    });

    if (!response.ok) {
      const errorText = await response.text();
      const errResponse = {
        jsonrpc: "2.0",
        id: jsonRpcRequest.id ?? null,
        error: {
          code: -32603,
          message: `Delentia Gateway returned status ${response.status}: ${errorText}`,
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
        message: `Client Parse Error: ${err?.message || "Unknown error"}`,
      },
    };
    process.stdout.write(JSON.stringify(parseErrorResponse) + "\n");
  }
});
