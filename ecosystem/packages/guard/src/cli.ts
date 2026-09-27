#!/usr/bin/env node
/**
 * delentia-guard — wrap any stdio MCP server so every tool call is checked against a policy.
 *
 *   delentia-guard [options] -- <server command> [server args...]
 *   delentia-guard --verify <audit.jsonl>
 *
 * Options:
 *   --policy <file>          policy JSON (default: built-in policy)
 *   --monitor                log what would be blocked, but forward everything
 *   --audit <file>           audit log path (default: ~/.delentia/guard-audit.jsonl)
 *   --map tool=action,...    map upstream tool names to policy action names
 *   --role <role>            caller role for RBAC rules (default: developer)
 *   --name <name>            upstream name recorded in the audit log (default: the command)
 *   --compress               compress large tool results; adds the delentia_expand_context tool
 *   --compress-over <tokens> size threshold for --compress (default 2000 estimated tokens)
 *   --compress-tools a,b*    tool-name patterns whose results may be compressed
 *                            (default: commands, tests, builds, lint, logs — never plain file reads)
 *
 * MCP stdio messages are newline-delimited JSON-RPC. Client -> server messages are inspected;
 * server -> client output is passed through untouched. Guard diagnostics go to stderr only,
 * so they never corrupt the protocol stream on stdout.
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { Guard, lastAuditHash, verifyAuditLog, type JsonRpcMessage } from "./guard.js";

const argv = process.argv.slice(2);
const log = (m: string) => process.stderr.write(`[delentia-guard] ${m}\n`);

if (argv[0] === "--verify") {
  const file = argv[1];
  if (!file || !existsSync(file)) {
    log(`usage: delentia-guard --verify <audit.jsonl>`);
    process.exitCode = 2;
  } else {
    const r = verifyAuditLog(readFileSync(file, "utf8"));
    process.stdout.write(JSON.stringify(r) + "\n");
    process.exitCode = r.ok ? 0 : 1;
  }
} else {
  run();
}

function run(): void {
  const sep = argv.indexOf("--");
  if (sep === -1 || sep === argv.length - 1) {
    log("usage: delentia-guard [--policy file] [--monitor] [--audit file] [--map tool=action,...] -- <server command> [args...]");
    process.exitCode = 2;
    return;
  }
  const opts = argv.slice(0, sep);
  const [command, ...commandArgs] = argv.slice(sep + 1);
  const opt = (name: string) => (opts.includes(name) ? opts[opts.indexOf(name) + 1] : undefined);

  const auditPath = path.resolve(opt("--audit") ?? path.join(homedir(), ".delentia", "guard-audit.jsonl"));
  mkdirSync(path.dirname(auditPath), { recursive: true });
  const actionMap: Record<string, string> = {};
  for (const pair of (opt("--map") ?? "").split(",").filter(Boolean)) {
    const [tool, action] = pair.split("=");
    if (tool && action) actionMap[tool.trim()] = action.trim();
  }

  const guard = new Guard({
    policy: opt("--policy"),
    mode: opts.includes("--monitor") ? "monitor" : "enforce",
    actionMap,
    callerRole: opt("--role"),
    upstreamName: opt("--name") ?? [command, ...commandArgs].join(" ").slice(0, 120),
    previousHash: existsSync(auditPath) ? lastAuditHash(readFileSync(auditPath, "utf8")) : undefined,
    audit: (line) => appendFileSync(auditPath, line + "\n"),
    compress: opts.includes("--compress")
      ? {
          thresholdTokens: Number(opt("--compress-over") ?? 2000),
          tools: opt("--compress-tools")?.split(",").map((t) => t.trim()).filter(Boolean),
        }
      : false,
  });
  log(`${opts.includes("--monitor") ? "monitoring" : "enforcing"} tool calls for: ${command} ${commandArgs.join(" ")} (audit: ${auditPath})`);

  // Windows resolves bare names like npx/npm/uvx through .cmd shims, which need a shell. A full
  // path to an executable must not go through the shell: cmd.exe would split it at spaces.
  const useShell = process.platform === "win32" && !existsSync(command);
  const quote = (a: string) => (useShell && /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
  const child = spawn(quote(command), commandArgs.map(quote), { stdio: ["pipe", "pipe", "inherit"], shell: useShell });
  child.on("error", (err) => {
    log(`could not start the server: ${err.message}`);
    process.exitCode = 1;
  });
  if (!guard.compressor) {
    child.stdout.pipe(process.stdout);
  } else {
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
      let nl: number;
      while ((nl = out.indexOf("\n")) !== -1) {
        const line = out.slice(0, nl);
        out = out.slice(nl + 1);
        process.stdout.write(rewriteServerLine(line) + "\n");
      }
    });
    child.stdout.on("end", () => {
      if (out) process.stdout.write(rewriteServerLine(out));
    });
  }

  function rewriteServerLine(line: string): string {
    if (!line.trim()) return line;
    try {
      const msg = JSON.parse(line);
      if (Array.isArray(msg)) return JSON.stringify(msg.map((m) => guard.inspectServer(m)));
      const next = guard.inspectServer(msg);
      return next === msg ? line : JSON.stringify(next);
    } catch {
      return line;
    }
  }

  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      handle(line);
    }
  });
  process.stdin.on("end", () => {
    if (buffer.trim()) handle(buffer);
    child.stdin.end();
  });

  function handle(line: string): void {
    if (!line.trim()) return;
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line);
    } catch {
      child.stdin.write(line + "\n"); // not ours to judge; let the server reject it
      return;
    }
    const batch = Array.isArray(msg);
    const messages: JsonRpcMessage[] = batch ? (msg as unknown as JsonRpcMessage[]) : [msg];
    const forwarded: JsonRpcMessage[] = [];
    for (const m of messages) {
      const d = guard.inspect(m);
      if (d.forward) forwarded.push(m);
      else if (d.response) {
        process.stdout.write(JSON.stringify(d.response) + "\n");
        log(`blocked ${m.params?.name}: ${d.evaluation?.reason ?? ""}`);
      }
    }
    if (!forwarded.length) return;
    child.stdin.write(JSON.stringify(batch ? forwarded : forwarded[0]) + "\n");
  }

  child.on("exit", (code, signal) => {
    log(`server exited (${signal ?? code}); tool calls: ${guard.stats.calls}, allowed: ${guard.stats.allowed}, blocked: ${guard.stats.blocked}, would block: ${guard.stats.would_block}`);
    if (guard.compressor) {
      const c = guard.compressor.stats;
      log(`compressed ${c.results_compressed}/${c.results_seen} results, ~${c.tokens_in} -> ~${c.tokens_out} tokens, expands: ${c.expands}`);
    }
    process.exitCode = code ?? 1;
    process.stdin.pause();
  });
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill(sig));
}
