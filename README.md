<div align="center">

<img src="./assets/delentia-green-logo.png" alt="Delentia Labs Logo" width="128" height="128" />

# Delentia Sovereign AI Operating System
### Official Model Context Protocol (MCP) Public Client & Connector

[![Release](https://img.shields.io/github/v/release/delentia-labs/delentia-mcp?color=brightgreen)](https://github.com/delentia-labs/delentia-mcp/releases)
[![Smithery Quality](https://img.shields.io/badge/Smithery%20Quality-100%2F100-brightgreen)](https://smithery.ai/servers/delentia/delentia-sovereign)
[![Edge Health Check](https://github.com/delentia-labs/delentia-mcp/actions/workflows/healthcheck.yml/badge.svg)](https://github.com/delentia-labs/delentia-mcp/actions/workflows/healthcheck.yml)
[![MCP Protocol](https://img.shields.io/badge/MCP%20Protocol-2024--11--05-blue)](https://modelcontextprotocol.io/)
[![License](https://img.shields.io/badge/License-Apache%202.0-orange)](./LICENSE)
[![Benchmarks](https://img.shields.io/badge/Benchmarks-measured-blueviolet)](./BENCHMARKS.md)
[![Website](https://img.shields.io/badge/Website-delentia.com-emerald)](https://delentia.com)

**Stop rogue AI-agent tool calls before they run: a deterministic policy gate with an audit trail.**  
Bridging autonomous AI agents (Claude, Cursor, VS Code, Windsurf, Codex) to the Delentia Sovereign Edge Network.  
📊 **[View Empirical Benchmarks & 30-Second Visual Proof](./BENCHMARKS.md)**

---

</div>

## 🏛️ Executive Architectural Overview

The **Delentia Sovereign AI Operating System** provides a mathematically verifiable layer of defense, reasoning rigor, context compression, and swarm coordination for autonomous AI workflows:

```text
       ┌─────────────────────────────────────────────────────────────┐
       │              Autonomous AI Clients & IDEs                   │
       │    (Claude Desktop, Cursor, VS Code, Windsurf, Cline)       │
       └──────────────────────────────┬──────────────────────────────┘
                                      │
                         stdio / Streamable HTTP (MCP)
                                      │
       ┌──────────────────────────────▼──────────────────────────────┐
       │              Delentia Sovereign Edge Gateway                │
       │         (Cloudflare Global Workers + Durable Objects)       │
       └──────────────────────────────┬──────────────────────────────┘
                                      │
         ┌────────────────────────────┼────────────────────────────┐
         ▼                            ▼                            ▼
  [ 1. FDIA Security ]        [ 2. RCT-7 Thinking ]        [ 3. Delta & JITNA ]
Deterministic policy gate     7-stage reasoning            Context compression
    F = (D^I) * A             checklist                    & signed task packets
```

---

## 🛠️ The 6 Tools

| Tool Name | Type | What it does |
| :--- | :---: | :--- |
| **`evaluate_fdia`** | Read-Only | Scores a proposed action with F = (D^I) × A against your policy and returns AUTHORIZED or a block verdict with a SHA-256 audit digest. A = 0 (policy says no, or a required human signature is missing) always gives F = 0. Actions that need a human require an Ed25519-signed Architect token from a key the deployment trusts. |
| **`configure_policy`** | Action | Sets the rules for *your* session only (RBAC, blocked actions, dual sign-off, safety threshold). The deployment's default policy is never changed. |
| **`rct_think`** | Read-Only | Walks a 7-stage reasoning checklist over a plan and returns a heuristic alignment score. It helps catch vague or misaligned plans; it does not guarantee correct answers. |
| **`compress_context`** | Read-Only | Deterministic compression of long tool output and logs (no LLM call). Measured ~70% fewer tokens on real logs while literal-wording questions stayed answerable ([benchmark](./BENCHMARKS.md)). Can keep the original for `expand_context`. |
| **`expand_context`** | Read-Only | Returns lines of the original behind a compressed result, by line range or search, when the compressed version left something out. |
| **`orchestrate_swarm`** | Read-Only | Splits a goal into signed JITNA task packets for several roles. |

> **Advisory vs enforcing:** these tools help an agent that chooses to call them. To *enforce* a policy on every tool call of another MCP server, use **Delentia Guard** (`delentia-guard`), an stdio proxy with a signed audit log.

---

## 🚀 Quickstart: Universal 1-Click Client Setup

### Universal Remote Bridge (Zero-Friction 1-Click Setup)
Connect any MCP-compatible environment (Claude Desktop, Cursor, Antigravity IDE, VS Code, Windsurf) directly to the Delentia Sovereign Global Edge:

```bash
npx -y mcp-remote https://delentia-sovereign-mcp.delentia.workers.dev/mcp
```

> **Developer Sandbox Free Tier**: Includes 50 daily free calls per caller IP out of the box with zero registration required!  
> **Paid tier (preview)**: For a higher quota, pass a Zuplo API Key from the [Delentia Developer Portal](https://delentia-gateway-main-c7624a5.zuplo.site/pricing):
> ```bash
> npx -y mcp-remote https://delentia-sovereign-mcp.delentia.workers.dev/mcp --header "Authorization: Bearer YOUR_ZUPLO_API_KEY"
> ```

### Option A: Cursor IDE Configuration (`~/.cursor/mcp.json`)
```json
{
  "mcpServers": {
    "delentia-sovereign": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://delentia-sovereign-mcp.delentia.workers.dev/mcp"
      ]
    }
  }
}
```

### Option B: Claude Desktop Configuration (`claude_desktop_config.json`)

#### 1. Free Community Sandbox (Zero-Config / 50 calls daily):
```json
{
  "mcpServers": {
    "delentia-sovereign": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://delentia-sovereign-mcp.delentia.workers.dev/mcp"
      ]
    }
  }
}
```

#### 2. Paid tier (Zuplo API Key, higher quota — no SLA is offered yet):
```json
{
  "mcpServers": {
    "delentia-sovereign": {
      "command": "node",
      "args": [
        "./bin/cli.js"
      ],
      "env": {
        "DELENTIA_API_KEY": "YOUR_ZUPLO_API_KEY"
      }
    }
  }
}
```

### Option D: Instant Terminal Verification (1-Line cURL)
Test the live Sovereign MCP server directly in any terminal:

```bash
curl -X POST https://delentia-sovereign-mcp.delentia.workers.dev/mcp \
  -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}"
```

---

## 🌐 Official Marketplace & Registry Listings

| Marketplace / Directory | Status | Official Live Listing Link |
| :--- | :---: | :--- |
| **Smithery.ai** | **Published** | [smithery.ai/servers/delentia/delentia-sovereign](https://smithery.ai/servers/delentia/delentia-sovereign) |
| **Glama.ai** | **Published** | [glama.ai/mcp/servers/delentia-labs/delentia-mcp](https://glama.ai/mcp/servers/delentia-labs/delentia-mcp) |
| **Official MCP Registry** | **Published** | [registry.modelcontextprotocol.io/?q=delentia](https://registry.modelcontextprotocol.io/?q=delentia) |
| **MCPize** | **Published** | [mcpize.com/mcp/delentia-mcp](https://mcpize.com/mcp/delentia-mcp) |
| **Zuplo Developer Portal** | **Published** | [delentia-gateway-main-c7624a5.zuplo.site/introduction](https://delentia-gateway-main-c7624a5.zuplo.site/introduction) |
| **PulseMCP** | **Auto-Syncing** | Synced via Official MCP Registry Index |
| **Awesome MCP Servers** | **PR Submitted (Pending Merge)** | [github.com/punkpeye/awesome-mcp-servers/pull/13430](https://github.com/punkpeye/awesome-mcp-servers/pull/13430) |
| **MCP Market (CherryHQ)** | **Issue Submitted (Pending Review)** | [github.com/CherryHQ/mcpmarket/issues/51](https://github.com/CherryHQ/mcpmarket/issues/51) |

---

## 🔒 Enterprise Security & Verification

- **Audit digest:** every evaluation returns a SHA-256 digest of its inputs and verdict. A digest shows that a record was changed; on its own it does not make a log tamper-proof. For an enforcing, Ed25519-signed, hash-chained log of every tool call, run [Delentia Guard](ecosystem/docs/GUARD.md).
- **Architect sign-off:** high-risk actions need an Ed25519-signed Architect token bound to that action and payload, from a key the deployment trusts; dual sign-off actions need two different trusted keys. Unsigned or forged tokens fail closed.
- **Structured pre-execution reasoning:** `rct_think` walks a 7-stage checklist and returns a heuristic alignment score. It helps catch vague or misaligned plans; it does not guarantee the absence of hallucinations.

---

## 🧩 Source code

This repository holds both the public connector (root: `bin/`, `dist/`, listing files) and the server source in [`ecosystem/`](ecosystem/): the Cloudflare Workers behind the 6 tools (`sovereign`, `fdia`, `rct7`, `delta`, `jitna`, `intent-loop`, `shared`) and [Delentia Guard](ecosystem/docs/GUARD.md) (`packages/guard`).

```bash
cd ecosystem
npm ci
npm run build && npm run typecheck && npm run test:all
```

Cross-stack bridge tests that need Delentia's non-public Python services skip unless `DELENTIA_PRIVATE_SERVICES_DIR` is set.

---

## 📜 Intellectual Property & Attribution

- **Developer:** **Delentia Labs**
- **Chief Architect:** **Ittirit Saengow (The Architect)**
- **Official Portal:** [https://delentia.com](https://delentia.com)
- **License:** Apache-2.0 (connector and `ecosystem/` server source)
