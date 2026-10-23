# Security Policy

## Reporting a vulnerability

Please do not open a public GitHub issue for a security problem.

Email **security@delentia.com** (copy **founder@delentia.com** if you do not get an acknowledgement). Include what you found, the steps to reproduce it (request payloads, the endpoint or tool, what you observed) and what you think the impact is.

We aim to acknowledge a report within 48 hours. This is a very small team, so please treat that as a goal and not as a guarantee. We will tell you what we find and credit you if you wish.

## What is in scope

- The `delentia-mcp` npm connector (`bin/cli.js`).
- The hosted MCP Workers whose source is in `ecosystem/` (`sovereign`, `fdia`, `rct7`, `delta`, `jitna`, `intent-loop`).
- `delentia-guard` (`ecosystem/packages/guard`): a policy filter that runs as a separate process in front of an MCP server. It is not a sandbox. A way to make it allow a call its policy should refuse is in scope.

## Supported versions

| Package | Supported |
|---|---|
| `delentia-mcp` 2.1.x | yes |
| `delentia-guard` 0.1.x | yes |
| older | no |

## What this software does not promise

The gate and Guard reduce risk; they do not make an agent safe. See [BENCHMARKS.md](./BENCHMARKS.md) for what has and has not been measured.
