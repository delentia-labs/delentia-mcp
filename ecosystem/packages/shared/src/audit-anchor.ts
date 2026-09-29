/**
 * Audit tier A3: an outside witness for audit-log chain heads (Round 50).
 *
 * A hash chain (Guard's guard-audit.jsonl, Delentia-OS's audit_chain) shows
 * that an entry was edited, but whoever controls the machine can rewrite the
 * whole log and recompute every hash. Publishing the chain head somewhere the
 * machine cannot rewrite closes that gap: a later log whose entry N does not
 * hash to the head anchored for N has been rewritten.
 *
 * Protocol (shared by the Guard CLI and `delentia audit-chain anchor`):
 *   message   = "delentia-audit-anchor:v1|<key_id>|<entries>|<head>|<signed_at>"
 *   signature = Ed25519 over the UTF-8 message, hex
 * `entries` is the 1-based position of `head` in the chain (Guard: line
 * count; Delentia-OS: audit_chain.seq). The verifying keys come only from
 * the Worker's AUDIT_ANCHOR_KEYS_JSON, never from the request.
 *
 * AuditAnchorDO keeps one append-only record per key_id. It never overwrites
 * an anchor: a lower entry count (rollback) or the same count with a
 * different head (fork) is refused with 409 and kept as a conflict record,
 * because a validly signed conflict is itself evidence that the log was
 * rewritten by someone holding the key.
 */

export const ANCHOR_MESSAGE_PREFIX = "delentia-audit-anchor:v1";
/** Anchors signed further in the past than this are refused (stale replays). */
export const ANCHOR_MAX_AGE_SECONDS = 24 * 3600;
/** Small clock skew allowance for anchors signed "in the future". */
export const ANCHOR_MAX_SKEW_SECONDS = 300;

export interface TrustedAnchorKey {
  key_id: string;
  public_key_hex: string;
}

export interface AnchorSubmission {
  key_id: string;
  entries: number;
  head: string;
  signed_at: string;
  signature: string;
}

export interface StoredAnchor extends AnchorSubmission {
  received_at: string;
}

export interface AnchorConflict extends StoredAnchor {
  kind: "rollback" | "fork";
  previous_entries: number;
  previous_head: string;
}

const KEY_ID = /^[A-Za-z0-9._-]{1,64}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

export function anchorMessage(keyId: string, entries: number, head: string, signedAt: string): string {
  return `${ANCHOR_MESSAGE_PREFIX}|${keyId}|${entries}|${head}|${signedAt}`;
}

export function parseTrustedAnchorKeys(json: string | undefined | null): TrustedAnchorKey[] {
  if (!json) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (k): k is TrustedAnchorKey =>
      !!k && typeof k === "object" && KEY_ID.test(String((k as TrustedAnchorKey).key_id)) &&
      HEX64.test(String((k as TrustedAnchorKey).public_key_hex))
  );
}

/** Shape and freshness checks; returns a reason string when the submission is malformed. */
export function validateAnchorSubmission(body: unknown, nowMs: number = Date.now()): string | null {
  if (!body || typeof body !== "object") return "body must be a JSON object";
  const b = body as Record<string, unknown>;
  if (typeof b.key_id !== "string" || !KEY_ID.test(b.key_id)) return "key_id must match [A-Za-z0-9._-]{1,64}";
  if (typeof b.entries !== "number" || !Number.isInteger(b.entries) || b.entries < 1) return "entries must be an integer >= 1";
  if (typeof b.head !== "string" || !HEX64.test(b.head)) return "head must be 64 lowercase hex characters";
  if (typeof b.signature !== "string" || !HEX128.test(b.signature)) return "signature must be 128 lowercase hex characters";
  if (typeof b.signed_at !== "string") return "signed_at must be an ISO-8601 UTC timestamp";
  const t = Date.parse(b.signed_at);
  if (Number.isNaN(t)) return "signed_at must be an ISO-8601 UTC timestamp";
  if (t > nowMs + ANCHOR_MAX_SKEW_SECONDS * 1000) return "signed_at is in the future";
  if (t < nowMs - ANCHOR_MAX_AGE_SECONDS * 1000) return "signed_at is older than 24 hours";
  return null;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** WebCrypto Ed25519 check (works in workerd and Node >= 20). */
export async function verifyAnchorSignature(sub: AnchorSubmission, trusted: TrustedAnchorKey[]): Promise<boolean> {
  const key = trusted.find((k) => k.key_id === sub.key_id);
  if (!key) return false;
  try {
    const pub = await crypto.subtle.importKey("raw", hexToBytes(key.public_key_hex), { name: "Ed25519" }, false, ["verify"]);
    const message = new TextEncoder().encode(anchorMessage(sub.key_id, sub.entries, sub.head, sub.signed_at));
    return await crypto.subtle.verify({ name: "Ed25519" }, pub, hexToBytes(sub.signature), message);
  } catch {
    return false;
  }
}

interface AnchorMeta {
  count: number;
  conflicts: number;
  last?: StoredAnchor;
}

const META = "meta";
const anchorKey = (i: number) => `anchor:${String(i).padStart(10, "0")}`;
const conflictKey = (i: number) => `conflict:${String(i).padStart(10, "0")}`;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/**
 * One instance per key_id (the Worker uses idFromName(key_id)). The Worker
 * verifies the signature before forwarding; this object only enforces the
 * append-only ordering and keeps the record.
 */
export class AuditAnchorDO {
  constructor(private readonly state: DurableObjectState) {}

  private async meta(): Promise<AnchorMeta> {
    return ((await this.state.storage.get<AnchorMeta>(META)) ?? { count: 0, conflicts: 0 }) as AnchorMeta;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/append" && request.method === "POST") {
      const sub = (await request.json()) as AnchorSubmission;
      const record: StoredAnchor = { ...sub, received_at: new Date().toISOString() };
      const meta = await this.meta();
      const last = meta.last;
      if (last) {
        const kind = sub.entries < last.entries ? "rollback" : sub.entries === last.entries && sub.head !== last.head ? "fork" : null;
        if (kind) {
          const conflict: AnchorConflict = { ...record, kind, previous_entries: last.entries, previous_head: last.head };
          meta.conflicts += 1;
          await this.state.storage.put(conflictKey(meta.conflicts), conflict);
          await this.state.storage.put(META, meta);
          return json({ accepted: false, conflict }, 409);
        }
        if (sub.entries === last.entries) return json({ accepted: true, duplicate: true, anchor: last });
      }
      meta.count += 1;
      meta.last = record;
      await this.state.storage.put(anchorKey(meta.count), record);
      await this.state.storage.put(META, meta);
      return json({ accepted: true, index: meta.count, anchor: record }, 201);
    }
    if (url.pathname === "/list" && request.method === "GET") {
      const meta = await this.meta();
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 100) || 100, 1), 1000);
      const anchors: StoredAnchor[] = [];
      for (let i = Math.max(1, meta.count - limit + 1); i <= meta.count; i++) {
        const a = await this.state.storage.get<StoredAnchor>(anchorKey(i));
        if (a) anchors.push(a);
      }
      const conflicts: AnchorConflict[] = [];
      for (let i = 1; i <= meta.conflicts; i++) {
        const c = await this.state.storage.get<AnchorConflict>(conflictKey(i));
        if (c) conflicts.push(c);
      }
      return json({ count: meta.count, anchors, conflicts });
    }
    return json({ error: "not_found" }, 404);
  }
}

/**
 * Client-side check: every anchored (entries, head) must match the log.
 * `headAt(n)` returns the chain hash of entry n, or undefined when the log is
 * shorter than n.
 */
export function checkAnchors(
  anchors: Array<Pick<StoredAnchor, "entries" | "head" | "received_at">>,
  headAt: (n: number) => string | undefined,
  conflicts: unknown[] = []
): { ok: boolean; checked: number; problems: string[] } {
  const problems: string[] = [];
  for (const a of anchors) {
    const h = headAt(a.entries);
    if (h === undefined) problems.push(`log has fewer than ${a.entries} entries, but entry ${a.entries} was anchored at ${a.received_at} (truncated)`);
    else if (h !== a.head) problems.push(`entry ${a.entries} hashes to ${h.slice(0, 12)}..., anchored ${a.head.slice(0, 12)}... at ${a.received_at} (rewritten)`);
  }
  if (conflicts.length) problems.push(`the witness recorded ${conflicts.length} conflicting anchor(s) (rollback/fork) for this key`);
  return { ok: problems.length === 0, checked: anchors.length, problems };
}
