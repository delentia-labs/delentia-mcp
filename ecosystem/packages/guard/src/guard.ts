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
 * This module is transport-agnostic and synchronous per message, so it is unit-testable;
 * cli.ts wires it to a spawned stdio server.
 */
import { createHash } from "node:crypto";
import { FDIAEngine, type FDIAEvaluationResult } from "@delentia/shared";
import { OutputCompressor, EXPAND_TOOL, EXPAND_TOOL_NAME, type CompressOptions } from "./compress.js";

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
  readonly stats = { calls: 0, allowed: 0, blocked: 0, would_block: 0 };

  readonly compressor?: OutputCompressor;
  /** Requests forwarded to the server whose responses we may need to rewrite, by JSON-RPC id. */
  private pending = new Map<string, { kind: "tools/list" } | { kind: "tools/call" }>();

  constructor(private opts: GuardOptions = {}) {
    if (opts.compress) this.compressor = new OutputCompressor(opts.compress);
    this.engine = new FDIAEngine(opts.policy);
    this.mode = opts.mode ?? "enforce";
    this.lastHash = opts.previousHash ?? GENESIS;
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
    const denied = !evaluation.authorized;
    const blocked = denied && this.mode === "enforce";
    if (blocked) this.stats.blocked++;
    else if (denied) this.stats.would_block++;
    else this.stats.allowed++;

    this.writeAudit({
      upstream: this.opts.upstreamName ?? "upstream",
      request_id: msg.id ?? null,
      tool,
      action,
      arguments_sha256: sha256(payload),
      decision: blocked ? "blocked" : denied ? "would_block" : "allowed",
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
                `Do not retry this call in another form; ask the user if it is really needed.`,
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
    this.opts.audit(JSON.stringify({ ...entry, hash }));
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

/** Checks every entry's hash and its link to the previous entry. Returns the first broken line (1-based) or null. */
export function verifyAuditLog(logText: string): { ok: boolean; entries: number; broken_at?: number; problem?: string } {
  const lines = logText.split("\n").filter((l) => l.trim());
  let prev = GENESIS;
  for (let i = 0; i < lines.length; i++) {
    let entry: any;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      return { ok: false, entries: lines.length, broken_at: i + 1, problem: "not valid JSON" };
    }
    const { hash, ...rest } = entry;
    if (entry.prev_hash !== prev) return { ok: false, entries: lines.length, broken_at: i + 1, problem: "prev_hash does not match the previous entry" };
    if (sha256(JSON.stringify(rest)) !== hash) return { ok: false, entries: lines.length, broken_at: i + 1, problem: "entry content does not match its hash" };
    prev = hash;
  }
  return { ok: true, entries: lines.length };
}
