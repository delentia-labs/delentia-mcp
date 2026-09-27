# Delentia Guard — enforce a policy on every MCP tool call

`evaluate_fdia` on the hosted endpoint is advisory: an agent that doesn't call it isn't stopped.
**Delentia Guard is the enforcing version.** It wraps any stdio MCP server; every `tools/call`
the agent sends is checked against your policy *before* it reaches the server. Denied calls never
run — the agent gets a normal MCP tool error explaining why. Everything runs on your machine:
tool arguments, file contents and tokens never leave it.

```
Claude Code / Cursor / Claude Desktop  ──stdio──►  delentia-guard  ──stdio──►  your MCP server
                                                     │ policy check on each tools/call
                                                     └─► hash-chained audit log (~/.delentia/guard-audit.jsonl)
```

## Set up (Claude Code example)

Put `delentia-guard --policy <policy> --` in front of the server command you already use:

```bash
claude mcp add filesystem -- node <path-to-repo>/packages/guard/dist/cli.js --policy <path-to-repo>/packages/guard/policies/coding-agent.json -- npx -y @modelcontextprotocol/server-filesystem .
```

Claude Desktop / Cursor: same idea in the JSON config — `command` becomes `node`, and `args` is
`[".../packages/guard/dist/cli.js", "--policy", ".../coding-agent.json", "--", "npx", "-y", "@modelcontextprotocol/server-filesystem", "."]`.

(Until the package is published to npm, point at `packages/guard/dist/cli.js` after `npm run build`.)

## Start in monitor mode

```bash
... cli.js --monitor --policy coding-agent.json -- <server command>
```

Nothing is blocked; every call that *would* have been blocked is logged as `"decision":"would_block"`.
Run a normal day of work, read the log, adjust the policy, then drop `--monitor`.

## Policies

- `policies/coding-agent.json` — starter policy for filesystem / git / GitHub / shell servers: reads
  allowed; writes allowed except to `.env`, keys, `.ssh/`, `.git/` internals and system paths;
  delete / drop / reset / push / merge and shell execution blocked; **anything not listed is
  blocked** (zero trust).
- Without `--policy`, the built-in default policy is used (stricter; blocks most write tools).
- `--map upstream_tool=policy_action` reuses a rule for a differently named tool.

Path rules use `/`; Windows paths are normalised before matching.

## Audit log

Each decision is one JSON line with the tool, the rule, the verdict and a SHA-256 of the arguments
(the arguments themselves are not stored). Every line carries the hash of the previous line, so
editing or deleting an entry is detectable:

```bash
node packages/guard/dist/cli.js --verify ~/.delentia/guard-audit.jsonl
```

## Limits

- Only tools reached *through* the guard are covered; tools the agent has from other, unwrapped
  servers are not.
- Rules match tool names and a substring check of the arguments; they are not a sandbox. A `.env`
  rule also matches `.environment`. Keep destructive and shell tools blocked unless you need them.
- Requests blocked with `REQUIRE_HUMAN_SIGNATURE` have no approval flow yet: they are simply denied.
