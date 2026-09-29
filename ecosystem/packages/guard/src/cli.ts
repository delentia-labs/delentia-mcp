#!/usr/bin/env node
/**
 * delentia-guard — wrap any stdio MCP server so every tool call is checked against a policy.
 *
 *   delentia-guard [options] -- <server command> [server args...]
 *   delentia-guard --verify <audit.jsonl> [--pubkey <key_id>=<hex>] [--require-signed]
 *   delentia-guard --head <audit.jsonl>     entry count + last hash (publish it elsewhere)
 *   delentia-guard keygen --out <pem> [--key-id <id>]   create an audit signing key
 *   delentia-guard anchor <audit.jsonl> --url <witness> --audit-key <pem> --audit-key-id <id>
 *                                          publish the signed chain head to an outside witness (A3)
 *   delentia-guard check-anchors <audit.jsonl> --url <witness> --audit-key-id <id>
 *                                          check every anchored head against the local log
 *   delentia-guard pending                 list approval requests
 *   delentia-guard approve <id>            approve one blocked call (interactive terminal only)
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
 *   --approvals <dir>        where approval requests live (default: ~/.delentia/approvals)
 *   --no-approvals           never offer human approval; human-signature rules just deny
 *   --audit-key <pem>        sign every audit entry (Ed25519); keep the key outside the upstream
 *                            server's reach - calls naming it or the audit log are refused
 *   --audit-key-id <id>      key id recorded in each entry (default: guard-1)
 *   --compress-tools a,b*    tool-name patterns whose results may be compressed
 *                            (default: commands, tests, builds, lint, logs — never plain file reads)
 *
 * MCP stdio messages are newline-delimited JSON-RPC. Client -> server messages are inspected;
 * server -> client output is passed through untouched. Guard diagnostics go to stderr only,
 * so they never corrupt the protocol stream on stdout.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Guard, auditHead, auditPublicKeyHex, checkAuditAnchors, lastAuditHash, signAnchor, verifyAuditLog, type JsonRpcMessage } from "./guard.js";
import { ApprovalStore } from "./approvals.js";

const DEFAULT_APPROVALS = path.join(homedir(), ".delentia", "approvals");

/** `--policy coding-agent` resolves to the bundled policies/coding-agent.json; anything else is a path. */
function resolvePolicy(value: string | undefined): string | undefined {
  if (!value || /[\\/]/.test(value) || value.endsWith(".json")) return value;
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const dir of [path.join(here, "policies"), path.join(here, "..", "policies")]) {
    const f = path.join(dir, `${value}.json`);
    if (existsSync(f)) return f;
  }
  return value;
}

const argv = process.argv.slice(2);
const log = (m: string) => process.stderr.write(`[delentia-guard] ${m}\n`);

if (argv[0] === "--verify") {
  const file = argv[1];
  if (!file || !existsSync(file)) {
    log(`usage: delentia-guard --verify <audit.jsonl> [--pubkey <key_id>=<hex>] [--require-signed]`);
    process.exitCode = 2;
  } else {
    const publicKeys: Record<string, string> = {};
    argv.forEach((a, i) => {
      if (a === "--pubkey" && argv[i + 1]?.includes("=")) {
        const [id, hex] = argv[i + 1].split("=");
        publicKeys[id] = hex;
      }
    });
    const r = verifyAuditLog(readFileSync(file, "utf8"), {
      publicKeys: Object.keys(publicKeys).length ? publicKeys : undefined,
      requireSigned: argv.includes("--require-signed"),
    });
    process.stdout.write(JSON.stringify(r) + "\n");
    process.exitCode = r.ok ? 0 : 1;
  }
} else if (argv[0] === "--head") {
  const file = argv[1];
  if (!file || !existsSync(file)) {
    log("usage: delentia-guard --head <audit.jsonl>");
    process.exitCode = 2;
  } else {
    process.stdout.write(JSON.stringify(auditHead(readFileSync(file, "utf8"))) + "\n");
  }
} else if (argv[0] === "keygen") {
  const out = argv[argv.indexOf("--out") + 1];
  const keyId = argv.includes("--key-id") ? argv[argv.indexOf("--key-id") + 1] : "guard-1";
  if (!argv.includes("--out") || !out) {
    log("usage: delentia-guard keygen --out <pem> [--key-id <id>]");
    process.exitCode = 2;
  } else if (existsSync(out)) {
    log(`${out} already exists; refusing to overwrite a key`);
    process.exitCode = 1;
  } else {
    const { privateKey } = generateKeyPairSync("ed25519");
    const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    writeFileSync(out, pem, { mode: 0o600, flag: "wx" });
    process.stdout.write(`${JSON.stringify({ key_id: keyId, public_key_hex: auditPublicKeyHex(pem) })}\n`);
    log(`verify later with: delentia-guard --verify <audit.jsonl> --pubkey ${keyId}=<public_key_hex> --require-signed`);
  }
} else if (argv[0] === "anchor" || argv[0] === "check-anchors") {
  void anchorCommand(argv[0]);
} else if (argv[0] === "pending") {
  const store = new ApprovalStore(argv[1] === "--approvals" && argv[2] ? argv[2] : DEFAULT_APPROVALS);
  const now = Date.now();
  const open = store.list().filter((r) => !r.used_at && Date.parse(r.expires_at) > now);
  if (!open.length) process.stdout.write("No pending approval requests.\n");
  for (const r of open) {
    process.stdout.write(
      `${r.id}  ${r.approved_at ? "APPROVED (waiting for the agent to retry)" : "waiting for you"}  ${r.tool}  rule ${r.rule}  expires ${r.expires_at}\n    args: ${r.arguments_preview}\n`
    );
  }
} else if (argv[0] === "approve") {
  void approve(argv[1], argv[2] === "--approvals" && argv[3] ? argv[3] : DEFAULT_APPROVALS);
} else {
  run();
}

/** Round 50 (audit tier A3): publish / check chain heads at an outside witness. */
async function anchorCommand(command: string): Promise<void> {
  const arg = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  const file = argv[1];
  const base = arg("--url")?.replace(/\/+$/, "");
  const keyId = arg("--audit-key-id");
  const keyFile = arg("--audit-key");
  if (!file || !existsSync(file) || !base || !keyId || (command === "anchor" && !keyFile)) {
    log(command === "anchor"
      ? "usage: delentia-guard anchor <audit.jsonl> --url <witness> --audit-key <pem> --audit-key-id <id>"
      : "usage: delentia-guard check-anchors <audit.jsonl> --url <witness> --audit-key-id <id>");
    process.exitCode = 2;
    return;
  }
  const logText = readFileSync(file, "utf8");
  try {
    if (command === "anchor") {
      const body = signAnchor(readFileSync(keyFile!, "utf8"), keyId, logText);
      const res = await fetch(`${base}/v1/audit/anchor`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      process.stdout.write(`${JSON.stringify({ status: res.status, ...((await res.json()) as object) })}\n`);
      process.exitCode = res.ok ? 0 : 1;
    } else {
      const res = await fetch(`${base}/v1/audit/anchor/${encodeURIComponent(keyId)}?limit=1000`);
      if (!res.ok) {
        process.stdout.write(`${JSON.stringify({ ok: false, status: res.status, ...((await res.json()) as object) })}\n`);
        process.exitCode = 1;
        return;
      }
      const report = checkAuditAnchors(logText, (await res.json()) as Parameters<typeof checkAuditAnchors>[1]);
      process.stdout.write(`${JSON.stringify(report)}\n`);
      process.exitCode = report.ok ? 0 : 1;
    }
  } catch (err) {
    log(`${command} failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

async function approve(id: string | undefined, dir: string): Promise<void> {
  if (!id) {
    log("usage: delentia-guard approve <id>   (see: delentia-guard pending)");
    process.exitCode = 2;
    return;
  }
  // An agent's shell tool is not an interactive terminal; a person at a keyboard is.
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    log("approve must be run by a person in an interactive terminal. Nothing was approved.");
    process.exitCode = 3;
    return;
  }
  const store = new ApprovalStore(dir);
  const r = store.get(id);
  if (!r) {
    log(`no approval request ${id} (see: delentia-guard pending)`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`\nThe agent wants to run: ${r.tool}\n  arguments: ${r.arguments_preview}\n  blocked by rule ${r.rule}: ${r.reason}\n  expires: ${r.expires_at}\n\n`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const typed = (await rl.question(`Type the tool name (${r.tool}) to approve this one call, anything else to cancel: `)).trim();
  rl.close();
  if (typed !== r.tool) {
    process.stdout.write("Not approved.\n");
    process.exitCode = 1;
    return;
  }
  try {
    store.approve(id);
    process.stdout.write(`Approved once. The agent can now repeat the same call within the expiry time.\n`);
  } catch (err) {
    log((err as Error).message);
    process.exitCode = 1;
  }
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
    policy: resolvePolicy(opt("--policy")),
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
    approvalsDir: opts.includes("--no-approvals") ? undefined : path.resolve(opt("--approvals") ?? DEFAULT_APPROVALS),
    auditSigningKey: opt("--audit-key")
      ? {
          keyId: opt("--audit-key-id") ?? "guard-1",
          privateKeyPem: readFileSync(path.resolve(opt("--audit-key")!), "utf8"),
          protectedPaths: [path.resolve(opt("--audit-key")!), auditPath],
        }
      : undefined,
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
    log(`server exited (${signal ?? code}); tool calls: ${guard.stats.calls}, allowed: ${guard.stats.allowed}, blocked: ${guard.stats.blocked}, would block: ${guard.stats.would_block}, approved by a human: ${guard.stats.human_approved}`);
    if (guard.compressor) {
      const c = guard.compressor.stats;
      log(`compressed ${c.results_compressed}/${c.results_seen} results, ~${c.tokens_in} -> ~${c.tokens_out} tokens, expands: ${c.expands}`);
    }
    process.exitCode = code ?? 1;
    process.stdin.pause();
  });
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill(sig));
}
