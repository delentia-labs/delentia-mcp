<div align="center">

<img src="./assets/delentia-green-logo.png" alt="Delentia Labs Logo" width="128" height="128" />

# Delentia Sovereign AI Operating System
### Official Model Context Protocol (MCP) Public Client & Connector

[![Release](https://img.shields.io/github/v/release/delentia-labs/delentia-mcp?color=brightgreen)](https://github.com/delentia-labs/delentia-mcp/releases)
[![Smithery Quality](https://img.shields.io/badge/Smithery%20Quality-100%2F100-brightgreen)](https://smithery.ai/servers/delentia/delentia-sovereign)
[![Edge Health Check](https://github.com/delentia-labs/delentia-mcp/actions/workflows/healthcheck.yml/badge.svg)](https://github.com/delentia-labs/delentia-mcp/actions/workflows/healthcheck.yml)
[![MCP Protocol](https://img.shields.io/badge/MCP%20Protocol-2024--11--05-blue)](https://modelcontextprotocol.io/)
[![License](https://img.shields.io/badge/License-Apache%202.0-orange)](./LICENSE)
[![Website](https://img.shields.io/badge/Website-delentia.com-emerald)](https://delentia.com)

**The World's First Deterministic Sovereign AI Operating System Gateway.**  
Bridging autonomous AI agents (Claude, Cursor, VS Code, Windsurf, Codex) to the Delentia Sovereign Edge Network.

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
Deterministic ZK Gate         7-Stage Reverse Mental       Context Compression
    F = (D^I) * A             Anti-Hallucination Pipeline  & 1+4 LoRA Swarms
```

---

## 🛠️ The 5 Sovereign Core Tools

| Tool Name | Type | Key Mission | Mathematical / Functional Core |
| :--- | :---: | :--- | :--- |
| **`evaluate_fdia`** | Read-Only | Prompt Injection & Rogue Action Preemption | Evaluates F = (D^I) * A to mathematically cut off unauthorized tool executions with SHA-256 audit digest. |
| **`configure_policy`** | Action | Enterprise Tool-Calling Policy Gate | Configures RBAC, action blacklists, dual-signoff rules, and safety thresholds for parameter A. |
| **`rct_think`** | Read-Only | 7-Stage Reverse Component Thinking | Eliminates LLM hallucination through Inversion Anchors; yields 1.0000 Alignment Index. |
| **`compress_context`** | Read-Only | State Differential Compression | Compresses verbose dialogue transcripts by 74.2% to 91.5% token reduction with state hashing. |
| **`orchestrate_swarm`** | Read-Only | 1+4 Specialized Swarm Routing | Decomposes goals into JITNA v3 packets across Router, Guardian, Executor, and Scribe pillars. |

---

## 🚀 Quickstart: 1-Click Client Setup

### Option A: Cursor IDE Configuration
Add this entry to your Cursor `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "delentia-sovereign": {
      "command": "npx",
      "args": [
        "-y",
        "delentia-mcp"
      ]
    }
  }
}
```

### Option B: Claude Desktop Configuration
Add this entry to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "delentia-sovereign": {
      "command": "npx",
      "args": [
        "-y",
        "delentia-mcp"
      ]
    }
  }
}
```

### Option C: Direct Remote Cloud Connection (No Local Node required)
If your client supports remote HTTP MCP servers, point directly to:

```text
Endpoint: https://delentia-sovereign-mcp.delentia.workers.dev/mcp
Transport: Streamable HTTP (JSON-RPC 2.0)
```

### Option D: Instant Terminal Verification (1-Line cURL)
Test the live Sovereign MCP server directly in any terminal:

```bash
curl -X POST https://delentia-sovereign-mcp.delentia.workers.dev/mcp \
  -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}"
```

---

## 🔒 Enterprise Security & Verification

- **Tamper-Proof Audit Digest:** Every security evaluation computes a SHA-256 cryptographic verification digest.
- **Dual Sign-Off Gate:** High-risk actions unconditionally mandate multi-party authorization tokens.
- **Zero Hallucination Guarantee:** The RCT-7 mental OS guarantees 100% causal intent alignment before execution.

---

## 📜 Intellectual Property & Attribution

- **Developer:** **Delentia Labs**
- **Chief Architect:** **Ittirit Saengow (The Architect)**
- **Official Portal:** [https://delentia.com](https://delentia.com)
- **License:** Apache-2.0 (Public Client Connector)
