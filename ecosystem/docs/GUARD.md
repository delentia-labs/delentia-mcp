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
claude mcp add filesystem -- node <path-to-repo>/ecosystem/packages/guard/dist/cli.js --policy <path-to-repo>/ecosystem/packages/guard/policies/coding-agent.json -- npx -y @modelcontextprotocol/server-filesystem .
```

Claude Desktop / Cursor: same idea in the JSON config — `command` becomes `node`, and `args` is
`[".../ecosystem/packages/guard/dist/cli.js", "--policy", ".../coding-agent.json", "--", "npx", "-y", "@modelcontextprotocol/server-filesystem", "."]`.

Once published, `npx -y delentia-guard --policy coding-agent -- <server command>` works anywhere;
`--policy coding-agent` refers to the bundled starter policy. Until then, point at
`ecosystem/packages/guard/dist/cli.js` after `npm run build` inside `ecosystem/`.

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

## Shrink big command / test / log output (`--compress`)

```bash
... cli.js --compress --policy coding-agent.json -- <server command>
```

Results over ~2,000 tokens from command, test, build, lint and log tools are replaced by a compact
view: the first and last 15 lines, plus every line carrying a failure signal (error, fail,
exception, traceback, warning, assert, timeout...) with one line of context. The original stays in
the guard's memory, and the guard adds a `delentia_expand_context` tool so the agent can fetch
anything that was left out (by search terms or line range). The guard answers that tool itself;
it never reaches the server.

- On this repo's real build + test log with one failing test inserted, the view is ~66% smaller
  and keeps the failing test and its assertion.
- File reads are **not** compressed by default (an agent editing a file needs all of it). Change
  which tools are eligible with `--compress-tools "run_*,*test*,..."`; `--compress-over <tokens>`
  sets the threshold.
- The view is deterministic, so your conversation history stays append-only and your provider's
  prompt caching keeps working (see `benchmarks/compression-real/README.md`).

## Human approval for "needs a human" rules

Rules of type `REQUIRE_HUMAN_SIGNATURE` (in the starter policy: delete, drop, reset, push, merge,
shell execution) don't just deny. The block message gives the agent a request id and tells it to ask
you. You decide in your own terminal:

```bash
delentia-guard pending          # what is waiting, with the exact arguments
delentia-guard approve 1a2b3c4d # shows the call again; type the tool name to confirm
```

The agent then repeats the same call and it goes through **once**.

- An approval covers only that exact call (same tool, same arguments), is single use, and expires
  after 10 minutes.
- Unknown tools (zero-trust default) and writes to secrets are never approvable.
- `approve` refuses to run without an interactive terminal, and asks you to type the tool name, so an
  agent can't approve its own request through a shell tool. An agent that controls a real
  pseudo-terminal could still type it: keep agents' shell access limited.
- `--no-approvals` turns this off (those rules then simply deny); `--approvals <dir>` moves the
  request files (default `~/.delentia/approvals`).

## Audit log

Each decision is one JSON line with the tool, the rule, the verdict and a SHA-256 of the arguments
(the arguments themselves are not stored). Every line carries the hash of the previous line, so
editing or deleting an entry is detectable:

```bash
node packages/guard/dist/cli.js --verify ~/.delentia/guard-audit.jsonl
```

### Signed entries (recommended when the log is evidence)

A hash chain alone can be rebuilt from scratch by anyone who can write the file. With a signing
key, each entry's hash is also signed with Ed25519 by the guard process, which runs separately from
the agent:

```bash
delentia-guard keygen --out ~/.delentia/keys/guard-audit.pem --key-id guard-1   # prints the public key
delentia-guard --audit-key ~/.delentia/keys/guard-audit.pem --audit-key-id guard-1 -- <server command>
delentia-guard --verify ~/.delentia/guard-audit.jsonl --pubkey guard-1=<public_key_hex> --require-signed
delentia-guard --head ~/.delentia/guard-audit.jsonl    # entry count + last hash
```

- While signing is on, any tool call whose arguments name the key file or the audit log is refused
  (in monitor mode too), so the agent cannot read the key or edit the log through the proxied server.
  The bare file names are matched as well (`guard-audit.pem`, `guard-audit.jsonl`), because the
  server resolves relative paths itself. This is a substring check, not a sandbox: a glob such as
  `*.pem` or a shell that builds the name at runtime can still get past it, so keep the key outside
  every directory the proxied server can reach and keep shell tools blocked.
- Keep the public key somewhere the agent cannot change (your notes, the team wiki).
- Publish `--head` output outside the machine from time to time (a chat message, a commit in
  another repo). Without that, someone who has the key or root on the machine could rewrite the
  whole log; the published head is what exposes it.

## Limits

- Only tools reached *through* the guard are covered; tools the agent has from other, unwrapped
  servers are not.
- Rules match tool names and a substring check of the arguments; they are not a sandbox. A `.env`
  rule also matches `.environment`. Keep destructive and shell tools blocked unless you need them.
- Human approval relies on the agent not having an interactive terminal of its own (see below).

## Publishing (maintainers)

`npm run build && npm run bundle:guard` produces `packages/guard/npm/`: one bundled `cli.mjs`
(the workspace packages it depends on are not on npm), the starter policy and this README. Check it
with `npm pack --dry-run` inside that folder, then `npm publish` from there.

Decided 2026-09-28 (Round 49): Apache-2.0, like `delentia-mcp`; the bundled FDIA engine is core SDK
code, which the IP policy (`.clinerules` section 4) allows to be public.
