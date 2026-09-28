/**
 * Human approval for calls blocked by a REQUIRE_HUMAN_SIGNATURE rule.
 *
 * Flow: the guard blocks the call and writes a pending request; the agent is told to ask the user;
 * the user runs `delentia-guard approve <id>` in their own terminal; the agent repeats the exact
 * same call, which is let through once.
 *
 * - An approval is bound to the exact call (SHA-256 of tool name + arguments), single use, and
 *   expires after 10 minutes.
 * - Only rules of type REQUIRE_HUMAN_SIGNATURE are approvable; unknown tools (zero-trust default)
 *   and path violations stay denied.
 * - The CLI refuses to approve from a non-interactive shell and asks the human to type the tool
 *   name, so an agent can't simply run the approve command through its own shell tool. An agent
 *   with a real pseudo-terminal could still type it — keep agents' shell access limited.
 *
 * Requests are small JSON files in a directory (default ~/.delentia/approvals) so the guard
 * process and the human's terminal share them without any server.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export const APPROVAL_TTL_MS = 10 * 60 * 1000;

export interface ApprovalRequest {
  id: string;
  call_sha256: string;
  tool: string;
  rule: string;
  reason: string;
  arguments_preview: string;
  created_at: string;
  expires_at: string;
  approved_at?: string;
  used_at?: string;
}

export class ApprovalStore {
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private file(id: string): string {
    if (!/^[0-9a-f]{8}$/.test(id)) throw new Error(`invalid approval id "${id}"`);
    return path.join(this.dir, `${id}.json`);
  }

  get(id: string): ApprovalRequest | undefined {
    const f = this.file(id);
    return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as ApprovalRequest) : undefined;
  }

  private save(r: ApprovalRequest): void {
    writeFileSync(this.file(r.id), JSON.stringify(r, null, 2));
  }

  /** All requests, newest first. */
  list(): ApprovalRequest[] {
    return readdirSync(this.dir)
      .filter((f) => /^[0-9a-f]{8}\.json$/.test(f))
      .map((f) => JSON.parse(readFileSync(path.join(this.dir, f), "utf8")) as ApprovalRequest)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  /** Reuses an open (unexpired, unused) request for the same call instead of piling up duplicates. */
  request(callSha: string, fields: Pick<ApprovalRequest, "tool" | "rule" | "reason" | "arguments_preview">, now = Date.now()): ApprovalRequest {
    const open = this.list().find((r) => r.call_sha256 === callSha && !r.used_at && Date.parse(r.expires_at) > now);
    if (open) return open;
    const r: ApprovalRequest = {
      id: randomBytes(4).toString("hex"),
      call_sha256: callSha,
      ...fields,
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + APPROVAL_TTL_MS).toISOString(),
    };
    this.save(r);
    return r;
  }

  approve(id: string, now = Date.now()): ApprovalRequest {
    const r = this.get(id);
    if (!r) throw new Error(`no approval request ${id}`);
    if (r.used_at) throw new Error(`request ${id} was already used`);
    if (Date.parse(r.expires_at) <= now) throw new Error(`request ${id} expired at ${r.expires_at}`);
    r.approved_at = new Date(now).toISOString();
    this.save(r);
    return r;
  }

  /** If this exact call has an approved, unexpired, unused request: mark it used and return it. */
  consume(callSha: string, now = Date.now()): ApprovalRequest | undefined {
    const r = this.list().find((x) => x.call_sha256 === callSha && x.approved_at && !x.used_at && Date.parse(x.expires_at) > now);
    if (!r) return undefined;
    r.used_at = new Date(now).toISOString();
    this.save(r);
    return r;
  }
}
