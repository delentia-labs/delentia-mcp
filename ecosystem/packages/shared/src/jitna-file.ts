/**
 * A real `.jitna` FILE FORMAT for the JITNA packet (I/D/delta/A/R/M) —
 * added 2026-09-13 in response to the original design intent: JITNA as an
 * actual inter-agent communication medium, not just an in-memory object
 * passed between function calls in the same process.
 *
 * Prior state (found via a dedicated audit this session): JSON
 * serialization of the packet was already essentially free (this file's
 * `JITNAPacketSchema` on the TS side, `to_dict()`/`to_json()` on the Python
 * side), and Python's jitna_protocol_v3.py already has a real TOON text
 * serializer plus real zlib/zstd compression with magic-byte detection —
 * but no single FILE CONTAINER combining any of that existed, and nothing
 * anywhere actually wrote a JITNA packet to disk as a file other agents
 * could read back.
 *
 * Also found: 254 pre-existing files already use the `.jitna` extension
 * elsewhere in the repo tree (the private services repo's private-UI intent-driven
 * UI templates) — a completely unrelated YAML-ish agent-template format
 * (`intent`/`inputs`/`plan`/`output` keys), not this I/D/delta/A/R/M
 * packet. Renaming either format was judged out of scope (that other
 * format is live, tested, and deployed elsewhere) — instead, this format
 * carries an explicit `$jitna_format` marker so any tool can immediately
 * tell the two apart by content, not just by extension.
 */

import { createHash } from "node:crypto";
import { JITNAPacketSchema, type JITNAPacket } from "./jitna-types.js";

/** Bumped only on a breaking change to the container's own shape (not the packet schema inside it). */
export const JITNA_FILE_FORMAT_VERSION = "packet/v1";

export interface JitnaFileContainer {
  /** Distinguishes this format from the unrelated pre-existing .jitna agent-template files elsewhere in the repo. */
  $jitna_format: typeof JITNA_FILE_FORMAT_VERSION;
  created_at: string;
  /** SHA-256 of the canonical JSON of `packet` below — lets a reader detect truncation/corruption/hand-editing before trusting the contents. */
  checksum: string;
  packet: JITNAPacket;
}

export class JitnaFileFormatError extends Error {}

/** Canonical (sorted-key) JSON used for checksum computation, so field reordering never changes the hash. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, Object.keys(value as object).sort());
}

/**
 * Serializes a JITNA packet into real `.jitna` file CONTENTS (a string
 * ready to be written to disk). Validates the packet against the real Zod
 * schema first — a malformed packet is rejected here, not silently written
 * to a file another agent would later fail to parse.
 */
export function serializeJitnaPacket(packet: JITNAPacket): string {
  const validated = JITNAPacketSchema.parse(packet);
  const checksum = createHash("sha256").update(canonicalJson(validated)).digest("hex");
  const container: JitnaFileContainer = {
    $jitna_format: JITNA_FILE_FORMAT_VERSION,
    created_at: new Date().toISOString(),
    checksum,
    packet: validated,
  };
  return JSON.stringify(container, null, 2);
}

/**
 * Parses real `.jitna` file contents back into a validated JITNA packet.
 * Throws JitnaFileFormatError (never a bare JSON.parse SyntaxError leaking
 * out) on: invalid JSON, a missing/wrong `$jitna_format` marker (e.g. this
 * being handed one of the unrelated 254 agent-template `.jitna` files by
 * mistake), a checksum mismatch (corruption or hand-editing), or a packet
 * that fails the real Zod schema.
 */
export function parseJitnaPacket(content: string): JITNAPacket {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (err) {
    throw new JitnaFileFormatError(`Not valid JSON: ${(err as Error).message}`);
  }

  if (typeof raw !== "object" || raw === null) {
    throw new JitnaFileFormatError("File content is not a JSON object");
  }
  const container = raw as Partial<JitnaFileContainer>;

  if (container.$jitna_format !== JITNA_FILE_FORMAT_VERSION) {
    throw new JitnaFileFormatError(
      `Not a recognized JITNA packet file (found $jitna_format=${JSON.stringify(container.$jitna_format)}, expected ${JSON.stringify(
        JITNA_FILE_FORMAT_VERSION
      )}). Note: unrelated agent-template files also use the .jitna extension elsewhere in this repo — this reader only accepts the I/D/delta/A/R/M packet format.`
    );
  }
  if (!container.packet) {
    throw new JitnaFileFormatError("Missing `packet` field");
  }

  const parseResult = JITNAPacketSchema.safeParse(container.packet);
  if (!parseResult.success) {
    throw new JitnaFileFormatError(`Packet failed schema validation: ${parseResult.error.message}`);
  }

  const expectedChecksum = createHash("sha256").update(canonicalJson(parseResult.data)).digest("hex");
  if (container.checksum !== expectedChecksum) {
    throw new JitnaFileFormatError(
      `Checksum mismatch — file contents were altered after being written (expected ${expectedChecksum}, got ${container.checksum})`
    );
  }

  return parseResult.data;
}

/**
 * Writes a JITNA packet to a real `.jitna` file on disk. Node-only (uses
 * node:fs) — for the Cloudflare Workers side, use serializeJitnaPacket()
 * directly and write the string via whatever storage is available there
 * (KV, R2, a Durable Object) instead of a filesystem path.
 */
export async function writeJitnaFile(path: string, packet: JITNAPacket): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, serializeJitnaPacket(packet), "utf-8");
}

/** Reads and parses a real `.jitna` file from disk. Node-only — see writeJitnaFile(). */
export async function readJitnaFile(path: string): Promise<JITNAPacket> {
  const { readFile } = await import("node:fs/promises");
  const content = await readFile(path, "utf-8");
  return parseJitnaPacket(content);
}
