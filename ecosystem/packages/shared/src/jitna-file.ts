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
import zlib from "node:zlib";
import { JITNAPacketSchema, type JITNAPacket } from "./jitna-types.js";
import { toonSerialize, toonDeserialize } from "./toon-format.js";

/** Bumped only on a breaking change to the container's own shape (not the packet schema inside it). */
export const JITNA_FILE_FORMAT_VERSION = "packet/v1";

/**
 * The compact variant, added 2026-09-13: instead of the packet's plain JSON,
 * the payload is TOON-serialized (this repo's port of
 * Delentia-OS/rct_control_plane/toon_formatter.py, verified byte-for-byte
 * cross-language compatible with the real Python implementation) then
 * zlib-deflated (Node's zlib.deflateSync/inflateSync produce the exact same
 * RFC 1950 zlib format as Python's zlib.compress/decompress — verified by
 * actually compressing with one language and decompressing with the other,
 * both directions, not assumed). Only the OUTER container stays plain JSON
 * (it's tiny — just the format marker, timestamp, and checksum); the packet
 * payload itself is what gets compacted, since that's the part whose size
 * actually matters when many packets accumulate.
 */
export const JITNA_FILE_FORMAT_VERSION_COMPACT = "packet/v2-toon-zlib";

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

// ============================================================================
// Compact variant: TOON + zlib
// ============================================================================

export interface JitnaFileContainerCompact {
  $jitna_format: typeof JITNA_FILE_FORMAT_VERSION_COMPACT;
  created_at: string;
  /** SHA-256 of the canonical JSON of the packet (computed before compression) — same tamper-detection guarantee as the v1 format. */
  checksum: string;
  /** base64(zlib.deflate(toonSerialize(packet))) */
  compressed_toon_base64: string;
}

/** Serializes a JITNA packet into the compact TOON+zlib `.jitna` file format. Real, measured smaller output for typical packets — see jitnaCompactSizeComparison() to measure a specific packet. */
export function serializeJitnaPacketCompact(packet: JITNAPacket): string {
  const validated = JITNAPacketSchema.parse(packet);
  const checksum = createHash("sha256").update(canonicalJson(validated)).digest("hex");
  const toon = toonSerialize(validated);
  const compressed = zlib.deflateSync(Buffer.from(toon, "utf-8"), { level: 6 });

  const container: JitnaFileContainerCompact = {
    $jitna_format: JITNA_FILE_FORMAT_VERSION_COMPACT,
    created_at: new Date().toISOString(),
    checksum,
    compressed_toon_base64: compressed.toString("base64"),
  };
  return JSON.stringify(container);
}

/** Parses compact TOON+zlib `.jitna` file contents back into a validated JITNA packet. Same tamper/format-collision/schema-validation guarantees as parseJitnaPacket(). */
export function parseJitnaPacketCompact(content: string): JITNAPacket {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (err) {
    throw new JitnaFileFormatError(`Not valid JSON: ${(err as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null) {
    throw new JitnaFileFormatError("File content is not a JSON object");
  }
  const container = raw as Partial<JitnaFileContainerCompact>;

  if (container.$jitna_format !== JITNA_FILE_FORMAT_VERSION_COMPACT) {
    throw new JitnaFileFormatError(
      `Not a recognized compact JITNA packet file (found $jitna_format=${JSON.stringify(container.$jitna_format)}, expected ${JSON.stringify(
        JITNA_FILE_FORMAT_VERSION_COMPACT
      )}).`
    );
  }
  if (!container.compressed_toon_base64) {
    throw new JitnaFileFormatError("Missing `compressed_toon_base64` field");
  }

  let toon: string;
  try {
    const compressed = Buffer.from(container.compressed_toon_base64, "base64");
    toon = zlib.inflateSync(compressed).toString("utf-8");
  } catch (err) {
    throw new JitnaFileFormatError(`Failed to decompress payload: ${(err as Error).message}`);
  }

  const decoded = toonDeserialize(toon);
  const parseResult = JITNAPacketSchema.safeParse(decoded);
  if (!parseResult.success) {
    throw new JitnaFileFormatError(`Decompressed packet failed schema validation: ${parseResult.error.message}`);
  }

  const expectedChecksum = createHash("sha256").update(canonicalJson(parseResult.data)).digest("hex");
  if (container.checksum !== expectedChecksum) {
    throw new JitnaFileFormatError(
      `Checksum mismatch — file contents were altered after being written (expected ${expectedChecksum}, got ${container.checksum})`
    );
  }

  return parseResult.data;
}

/** Writes a JITNA packet to a real compact `.jitna` file on disk (TOON+zlib). Node-only — see writeJitnaFile(). */
export async function writeJitnaFileCompact(path: string, packet: JITNAPacket): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, serializeJitnaPacketCompact(packet), "utf-8");
}

/** Reads and parses a real compact `.jitna` file (TOON+zlib) from disk. Node-only — see writeJitnaFileCompact(). */
export async function readJitnaFileCompact(path: string): Promise<JITNAPacket> {
  const { readFile } = await import("node:fs/promises");
  const content = await readFile(path, "utf-8");
  return parseJitnaPacketCompact(content);
}

export interface JitnaCompactSizeComparison {
  json_bytes: number;
  compact_bytes: number;
  reduction_percentage: number;
}

/** Measures the REAL size difference between the plain JSON (v1) and compact TOON+zlib (v2) formats for a specific packet — not a general claim, a per-packet measurement (small packets can compress worse due to zlib/base64 overhead, same honesty principle already applied to compress_context's reduction_percentage elsewhere in this ecosystem). */
export function jitnaCompactSizeComparison(packet: JITNAPacket): JitnaCompactSizeComparison {
  const jsonBytes = Buffer.byteLength(serializeJitnaPacket(packet), "utf-8");
  const compactBytes = Buffer.byteLength(serializeJitnaPacketCompact(packet), "utf-8");
  return {
    json_bytes: jsonBytes,
    compact_bytes: compactBytes,
    reduction_percentage: Math.round(((jsonBytes - compactBytes) / jsonBytes) * 10000) / 100,
  };
}
