# Quickstart — gate your agent's risky actions in 5 minutes

The hosted endpoint below is free to try and needs no account:

```
https://delentia-sovereign-mcp.delentia.workers.dev/mcp
```

## 1. See it work (1 minute, just `curl`)

Ask the gate about a read-only action:

```bash
curl -s -X POST https://delentia-sovereign-mcp.delentia.workers.dev/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"evaluate_fdia","arguments":{"action_name":"read_logs","data_quality":0.9,"intent_precision":1.0,"caller_role":"developer"}}}'
```

Now a destructive one:

```bash
curl -s -X POST https://delentia-sovereign-mcp.delentia.workers.dev/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"evaluate_fdia","arguments":{"action_name":"drop_database","data_quality":0.95,"intent_precision":1.0,"caller_role":"developer","caller_context":"DROP TABLE users on production"}}}'
```

Results observed against the live endpoint on 2026-09-27 (default policy `enterprise-fdia-policy-v1`):

| Request | `verdict` | `authorized` | Why |
|---|---|---|---|
| `read_logs` | `AUTHORIZED` | `true` | matches `RULE-READONLY-ALLOW`, score 0.90 ≥ 0.5 |
| `drop_database` | `SECURITY_POLICY_VIOLATION` | `false` | `RULE-DATABASE-DESTRUCTIVE-BLOCK` requires a signed approval |
| `write_file` with context `write .env` | `SECURITY_POLICY_VIOLATION` | `false` | `.env` is a denied path in `RULE-FILE-WRITE-RESTRICTED` |
| any action name not in the policy | `SECURITY_AUTH_DENIED` | `false` | zero-trust default: unregistered ⇒ A = 0 |

Every response carries an `audit_digest` (SHA-256) you can log.

## 2. Connect it to your agent (2 minutes)

**Claude Code** (native HTTP transport):
```bash
claude mcp add --transport http delentia https://delentia-sovereign-mcp.delentia.workers.dev/mcp
```

**Claude Desktop** (`claude_desktop_config.json`, via the `mcp-remote` bridge):
```json
{
  "mcpServers": {
    "delentia": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://delentia-sovereign-mcp.delentia.workers.dev/mcp"]
    }
  }
}
```

**Cursor** (`.cursor/mcp.json`):
```json
{ "mcpServers": { "delentia": { "url": "https://delentia-sovereign-mcp.delentia.workers.dev/mcp" } } }
```

> Only the `curl` calls above were run against the live endpoint when this page was written. The client configs follow each client's documented MCP format but weren't re-tested in each client for this page — please open an issue if one doesn't work.

## 3. Make your agent use it (2 minutes)

Add this to your agent's instructions (system prompt, `CLAUDE.md`, Cursor rules, …):

```
Before running any command or tool call that writes, deletes, deploys, spends money or touches
credentials, call the `evaluate_fdia` tool with a short `action_name` (e.g. write_file,
drop_database, deploy_production) and the concrete command in `caller_context`.
Only proceed if the result has "authorized": true. If not, stop and show the user the `reason`.
```

## 4. Your own rules

`configure_policy` lets you register your own blocked patterns, per-role permissions and threshold. It **requires a `session_id`** (any id of yours except `default`): the policy is stored for that session only, so pass the same `session_id` to `evaluate_fdia` to be evaluated against it. Nobody can change the shared default policy through the API. See the tool's description in `tools/list` for the full schema.

## Honest limits

- The gate is only as good as the calls it receives: an agent that skips calling `evaluate_fdia` is not stopped. For hard enforcement, put the check inside your tool runner rather than only in the prompt.
- `F = (D^I) × A` is a deterministic scoring rule, not a proof; `data_quality` and `intent_precision` are inputs you (or `rct_think`) supply.
- The hosted endpoint is a free preview with no SLA.
