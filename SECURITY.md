# Security Policy

## Reporting a vulnerability

Please do not open a public GitHub issue for a security problem.

Report it **privately through GitHub**: [Report a vulnerability](https://github.com/delentia-labs/delentia-mcp/security/advisories/new) (the Security tab of this repository). There is **no monitored security mailbox yet**, so please do not rely on email; if you cannot use GitHub, open a public issue that says only "I have a security report, please tell me how to send it" and put no details in it. Include what you found, the steps to reproduce it (request payloads, the endpoint or tool, what you observed) and what you think the impact is.

This project has one maintainer: we aim to acknowledge a report within 7 days and to fix critical issues within 30 days. Please treat that as a goal and not as a guarantee. We will tell you what we find and credit you if you wish.

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
