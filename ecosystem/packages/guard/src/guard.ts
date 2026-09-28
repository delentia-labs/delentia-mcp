/**
 * Delentia Guard — an enforcing proxy for MCP tool calls.
 *
 * `evaluate_fdia` as an MCP tool is advisory: an agent that doesn't call it isn't stopped.
 * The guard sits between the MCP client (Claude Code, Cursor, Claude Desktop...) and an
 * upstream MCP server, sees every JSON-RPC message, and checks each `tools/call` against the
 * FDIA policy BEFORE it reaches the upstream server. Denied calls never reach the server;
 * the client gets a normal MCP tool error explaining why.
 *
 * Every decision is appended to a hash-chained audit log (each entry carries the SHA-256 of
 * the previous one), so edits or deletions inside the log are detectable (`verifyAuditLog`).
 *
 * Round 48 (audit tier A2 for the MCP path): with `auditSigningKey`, each entry's hash is also
 * signed with Ed25519. The key lives in this proxy's process - separate from the agent - and
 * the guard refuses any tool call whose arguments name the key file or the audit log, so the
 * agent cannot read the key or rewrite the log through the server it is using. A rewrite by
 * someone with the key (or root on the machine) still needs the chain head published
 * elsewhere to be caught (`auditHead` gives the value to publish - tier A3).
 *
 * This module is transport-agnostic and synchronous per message, so it is unit-testable;
 * cli.ts wires it to a spawned stdio server.
 */
import { createHash, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify, type KeyObject } from "node:crypto";
import { FDIAEngine, type FDIAEvaluationResult } from "@delentia/shared";
import { OutputCompressor, EXPAND_TOOL, EXPAND_TOOL_NAME, type CompressOptions } from "./compress.js";
import { ApprovalStore } from "./approvals.js";

export type GuardMode = "enforce" | "monitor";

export interface GuardOptions {
  /** Policy file path or JSON string; omitted = the built-in default policy. */
  policy?: string;
  /** enforce: block denied calls. monitor: log what would be blocked, forward everything. */
  mode?: GuardMode;
  /** Upstream tool name -> policy action name (e.g. { "delete_repository": "delete_repository" }). */
  actionMap?: Record<string, string>;
  /** Name used in audit entries to identify the upstream server. */
  upstreamName?: string;
  callerRole?: string;
  /** D in F = (D^I) x A for proxied calls (the proxy has no data-quality signal of its own). */
  dataQuality?: number;
  /** Receives each audit line (already JSON-serialised, hash-chained). */
  audit?: (line: string) => void;
  /** Last hash of an existing audit log, to continue its chain. */
  previousHash?: string;
  /** Compress large tool results and expose delentia_expand_context (off when omitted). */
  compress?: CompressOptions | false;
  /** Directory for human-approval requests; omitted = approvals disabled (blocked calls stay blocked). */
  approvalsDir?: string;
  /** Sign every audit entry (Ed25519). `protectedPaths`: files no proxied tool call may name. */
  auditSigningKey?: { keyId: string; privateKeyPem: string; protectedPaths?: string[] };
}

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: any;
  result?: any;
  error?: any;
}

export interface Decision {
  /** Forward the message to the upstream server. */
  forward: boolean;
  /** When not forwarded: the response to send back to the client instead. */
  response?: JsonRpcMessage;
  evaluation?: FDIAEvaluationResult;
}

const GENESIS = "0".repeat(64);
const MAX_PAYLOAD_CHARS = 8000;

export class Guard {
  private engine: FDIAEngine;
  private mode: GuardMode;
  private lastHash: string;
  readonly stats = { calls: 0, allowed: 0, blocked: 0, would_block: 0, human_approved: 0 };
  readonly approvals?: ApprovalStore;

  readonly compressor?: OutputCompressor;
  /** Requests forwarded to the server whose responses we may need to rewrite, by JSON-RPC id. */
  private pending = new Map<string, { kind: "tools/list" } | { kind: "tools/call" }>();
  private signKey?: KeyObject;
  private signKeyId?: string;
  private protectedPaths: string[] = [];

  constructor(private opts: GuardOptions = {}) {
    if (opts.compress) this.compressor = new OutputCompressor(opts.compress);
    this.engine = new FDIAEngine(opts.policy);
    this.mode = opts.mode ?? "enforce";
    this.lastHash = opts.previousHash ?? GENESIS;
    if (opts.approvalsDir) this.approvals = new ApprovalStore(opts.approvalsDir);
    if (opts.auditSigningKey) {
      this.signKey = createPrivateKey(opts.auditSigningKey.privateKeyPem);
      this.signKeyId = opts.auditSigningKey.keyId;
      const full = (opts.auditSigningKey.protectedPaths ?? []).map(normalisePath).filter((p) => p.length > 0);
      // Also the bare file names: the proxied server resolves relative paths ("guard.pem",
      // "../keys/guard.pem") against its own working directory, so matching only the absolute
      // path let a relative read of the key through (found by the 0.1.0 pre-publish smoke test).
      const names = full.map((p) => p.slice(p.lastIndexOf("/") + 1)).filter((n) => n.length >= 3);
      this.protectedPaths = [...new Set([...full, ...names])];
    }
  }

  /** Round 48: a call naming the signing key or the audit log never reaches the server, in any mode. */
  private touchesProtectedPath(policyPayload: string): string | undefined {
    const haystack = normalisePath(policyPayload);
    return this.protectedPaths.find((p) => haystack.includes(p));
  }

  /** True when the rule that denied a call asks for a human rather than denying outright. */
  private isHumanApprovable(ruleId: string): boolean {
    const rule = this.engine.getPolicy().rules.find((r) => r.rule_id === ruleId);
    return rule?.action_type === "REQUIRE_HUMAN_SIGNATURE";
  }

  /** Inspect one client -> server message. Anything that isn't tools/call is forwarded untouched. */
  inspect(msg: JsonRpcMessage): Decision {
    const key = msg.id === undefined || msg.id === null ? undefined : JSON.stringify(msg.id);
    if (msg.method === "tools/list" && this.compressor && key) this.pending.set(key, { kind: "tools/list" });
    if (msg.method !== "tools/call") return { forward: true };
    if (this.compressor && msg.params?.name === EXPAND_TOOL_NAME) return this.expandLocally(msg);

    const tool = String(msg.params?.name ?? "");
    const args = msg.params?.arguments ?? {};
    const action = this.opts.actionMap?.[tool] ?? tool;
    let payload = "";
    try {
      payload = JSON.stringify(args).slice(0, MAX_PAYLOAD_CHARS);
    } catch {
      payload = "[unserialisable arguments]";
    }
    // Path rules are written with "/". Windows paths arrive as backslashes (doubled by JSON
    // escaping), so C:\Users\me\.ssh\config must still hit a ".ssh/" rule.
    const policyPayload = payload.replace(/\\+/g, "/");

    const protectedHit = this.touchesProtectedPath(policyPayload);
    if (protectedHit) {
      this.stats.calls++;
      this.stats.blocked++;
      this.writeAudit({
        upstream: this.opts.upstreamName ?? "upstream",
        request_id: msg.id ?? null,
        tool,
        action,
        arguments_sha256: sha256(payload),
        decision: "blocked",
        verdict: "GUARD_PROTECTED_PATH",
        rule: "GUARD_PROTECTED_PATH",
        reason: "the call names the guard's audit signing key or audit log",
        future_score: 0,
      });
      return {
        forward: false,
        response: {
          jsonrpc: "2.0",
          id: msg.id ?? null,
          result: {
            isError: true,
            content: [{ type: "text", text: "Blocked by Delentia Guard: this call refers to the guard's own audit key or audit log, which tools may not read or change." }],
          },
        },
      };
    }

    const evaluation = this.engine.evaluate({
      data_quality: this.opts.dataQuality ?? 0.9,
      intent_precision: 1.0,
      authorized: true,
      action_name: action || "unnamed_tool",
      target_payload: policyPayload,
      caller_role: this.opts.callerRole ?? "developer",
      caller_context: `mcp-guard:${this.opts.upstreamName ?? "upstream"}:${tool}`,
      dual_signoff_confirmed: false,
    });

    this.stats.calls++;
    const callSha = sha256(`${tool}\n${payload}`);
    const approvable = !evaluation.authorized && Boolean(this.approvals) && this.isHumanApprovable(evaluation.rule_triggered);
    const approval = approvable && this.mode === "enforce" ? this.approvals!.consume(callSha) : undefined;
    const denied = !evaluation.authorized && !approval;
    const blocked = denied && this.mode === "enforce";
    if (approval) this.stats.human_approved++;
    else if (blocked) this.stats.blocked++;
    else if (denied) this.stats.would_block++;
    else this.stats.allowed++;
    const pendingRequest = blocked && approvable
      ? this.approvals!.request(callSha, { tool, rule: evaluation.rule_triggered, reason: evaluation.reason, arguments_preview: payload.slice(0, 300) })
      : undefined;

    this.writeAudit({
      upstream: this.opts.upstreamName ?? "upstream",
      request_id: msg.id ?? null,
      tool,
      action,
      arguments_sha256: sha256(payload),
      decision: approval ? "allowed_by_human" : blocked ? "blocked" : denied ? "would_block" : "allowed",
      ...(approval ? { approval_id: approval.id, approved_at: approval.approved_at } : {}),
      ...(pendingRequest ? { approval_requested: pendingRequest.id } : {}),
      verdict: evaluation.verdict,
      rule: evaluation.rule_triggered,
      reason: evaluation.reason,
      future_score: evaluation.future_score,
      policy_id: evaluation.applied_policy_id,
      fdia_audit_digest: evaluation.audit_digest,
    });

    if (!blocked) {
      if (this.compressor && key && this.compressor.appliesTo(tool)) this.pending.set(key, { kind: "tools/call" });
      return { forward: true, evaluation };
    }
    return {
      forward: false,
      evaluation,
      response: {
        jsonrpc: "2.0",
        id: msg.id ?? null,
        result: {
          isError: true,
          content: [
            {
              type: "text",
              text:
                `Blocked by Delentia Guard before reaching the server: ${evaluation.reason} ` +
                `(tool "${tool}", policy rule ${evaluation.rule_triggered || "default zero-trust"}, verdict ${evaluation.verdict}). ` +
                (pendingRequest
                  ? `This action needs a human. Tell the user what you want to do and why, and ask them to run ` +
                    `\`delentia-guard approve ${pendingRequest.id}\` in their own terminal. After they confirm, repeat exactly the same call ` +
                    `(same tool, same arguments) within 10 minutes. Do not run the approve command yourself and do not try the action another way.`
                  : `Do not retry this call in another form; ask the user if it is really needed.`),
            },
          ],
        },
      },
    };
  }

  /**
   * Inspect one server -> client message. Returns the message to deliver: unchanged, or with
   * a large tool result compressed / the expand tool appended to tools/list.
   */
  inspectServer(msg: JsonRpcMessage): JsonRpcMessage {
    if (!this.compressor || msg.id === undefined || msg.id === null || !msg.result) return msg;
    const key = JSON.stringify(msg.id);
    const pending = this.pending.get(key);
    if (!pending) return msg;
    this.pending.delete(key);

    if (pending.kind === "tools/list") {
      const tools = Array.isArray(msg.result.tools) ? msg.result.tools : [];
      if (tools.some((t: any) => t?.name === EXPAND_TOOL_NAME)) return msg;
      return { ...msg, result: { ...msg.result, tools: [...tools, EXPAND_TOOL] } };
    }

    const content = Array.isArray(msg.result.content) ? msg.result.content : null;
    if (!content) return msg;
    let changed = false;
    const newContent = content.map((part: any) => {
      if (part?.type !== "text" || typeof part.text !== "string") return part;
      const c = this.compressor!.compress(part.text);
      if (!c) return part;
      changed = true;
      this.writeAudit({ event: "output_compressed", request_id: msg.id, context_ref: c.ref, chars_in: part.text.length, chars_out: c.text.length });
      return { ...part, text: c.text };
    });
    return changed ? { ...msg, result: { ...msg.result, content: newContent } } : msg;
  }

  private expandLocally(msg: JsonRpcMessage): Decision {
    const a = msg.params?.arguments ?? {};
    const num = (v: unknown) => (typeof v === "number" ? v : undefined);
    const r = this.compressor!.expand(String(a.context_ref ?? ""), {
      pattern: typeof a.pattern === "string" ? a.pattern : undefined,
      context_lines: num(a.context_lines),
      start_line: num(a.start_line),
      end_line: num(a.end_line),
      max_lines: num(a.max_lines),
    });
    const text = r
      ? `${r.lines.map((l) => `${l.n}: ${l.text}`).join("\n")}${r.truncated ? "\n[more lines match; narrow the pattern or range]" : ""}\n(${r.total_lines} lines in the original)`
      : "Unknown context_ref (the original may have been evicted or the guard restarted).";
    return { forward: false, response: { jsonrpc: "2.0", id: msg.id ?? null, result: { content: [{ type: "text", text }], ...(r ? {} : { isError: true }) } } };
  }

  private writeAudit(fields: Record<string, unknown>): void {
    if (!this.opts.audit) return;
    const entry = { ts: new Date().toISOString(), ...fields, prev_hash: this.lastHash };
    const hash = sha256(JSON.stringify(entry));
    this.lastHash = hash;
    const signature = this.signKey
      ? { sig: edSign(null, Buffer.from(hash, "hex"), this.signKey).toString("base64url"), key_id: this.signKeyId }
      : {};
    this.opts.audit(JSON.stringify({ ...entry, hash, ...signature }));
  }
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Last hash in an audit log's text (to continue the chain after a restart), or the genesis hash. */
export function lastAuditHash(logText: string): string {
  const lines = logText.split("\n").filter((l) => l.trim());
  if (!lines.length) return GENESIS;
  try {
    return JSON.parse(lines[lines.length - 1]).hash ?? GENESIS;
  } catch {
    return GENESIS;
  }
}

function normalisePath(p: string): string {
  return p.replace(/\\+/g, "/").toLowerCase();
}

/** Raw Ed25519 public key (hex) of a PEM private key - what verifiers pass to verifyAuditLog. */
export function auditPublicKeyHex(privateKeyPem: string): string {
  const jwk = createPublicKey(createPrivateKey(privateKeyPem)).export({ format: "jwk" }) as { x: string };
  return Buffer.from(jwk.x, "base64url").toString("hex");
}

function verifyEntrySignature(hash: string, sig: string, publicKeyHex: string): boolean {
  try {
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(publicKeyHex, "hex").toString("base64url") }, format: "jwk" });
    return edVerify(null, Buffer.from(hash, "hex"), key, Buffer.from(sig, "base64url"));
  } catch {
    return false;
  }
}

/**
 * Checks every entry's hash and its link to the previous entry, and - when `publicKeys`
 * (key_id -> Ed25519 public key hex) is given - every entry's signature. Returns the first
 * broken line (1-based). `requireSigned`: an unsigned entry is a failure (use once signing is on).
 */
export function verifyAuditLog(
  logText: string,
  opts: { publicKeys?: Record<string, string>; requireSigned?: boolean } = {}
): { ok: boolean; entries: number; signed: number; head?: string; broken_at?: number; problem?: string } {
  const lines = logText.split("\n").filter((l) => l.trim());
  let prev = GENESIS;
  let signed = 0;
  const fail = (i: number, problem: string) => ({ ok: false, entries: lines.length, signed, broken_at: i + 1, problem });
  for (let i = 0; i < lines.length; i++) {
    let entry: any;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      return fail(i, "not valid JSON");
    }
    const { hash, sig, key_id, ...rest } = entry;
    if (entry.prev_hash !== prev) return fail(i, "prev_hash does not match the previous entry");
    if (sha256(JSON.stringify(rest)) !== hash) return fail(i, "entry content does not match its hash");
    if (sig !== undefined) {
      signed++;
      if (opts.publicKeys) {
        const pub = opts.publicKeys[String(key_id)];
        if (!pub) return fail(i, `entry signed by an unknown key "${key_id}"`);
        if (!verifyEntrySignature(hash, String(sig), pub)) return fail(i, "signature does not verify");
      }
    } else if (opts.requireSigned) {
      return fail(i, "entry is not signed");
    }
    prev = hash;
  }
  return { ok: true, entries: lines.length, signed, head: lines.length ? prev : undefined };
}

/** The value to publish outside this machine (tier A3): entry count, last hash and its timestamp. */
export function auditHead(logText: string): { entries: number; hash: string; ts?: string } {
  const lines = logText.split("\n").filter((l) => l.trim());
  if (!lines.length) return { entries: 0, hash: GENESIS };
  const last = JSON.parse(lines[lines.length - 1]);
  return { entries: lines.length, hash: last.hash, ts: last.ts };
}
