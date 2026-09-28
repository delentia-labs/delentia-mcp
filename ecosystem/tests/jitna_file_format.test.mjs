/**
 * DELENTIA JITNA — real `.jitna` file format tests
 *
 * Added 2026-09-13 in response to the original design intent: JITNA as an
 * actual inter-agent communication medium, not just an in-memory object.
 * These tests use REAL packets produced by the real orchestrateSwarm() tool
 * (not hand-crafted fixtures) and real disk I/O (writeJitnaFile/readJitnaFile
 * write/read an actual temp file each run), proving the format works for
 * genuine "agent A writes, agent B reads" communication, not just an
 * in-memory serialize/deserialize round trip.
 */

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { unlink } from "node:fs/promises";

import {
  serializeJitnaPacket,
  parseJitnaPacket,
  writeJitnaFile,
  readJitnaFile,
  JitnaFileFormatError,
  JITNA_FILE_FORMAT_VERSION,
  serializeJitnaPacketCompact,
  parseJitnaPacketCompact,
  writeJitnaFileCompact,
  readJitnaFileCompact,
  jitnaCompactSizeComparison,
  JITNA_FILE_FORMAT_VERSION_COMPACT,
  toonSerialize,
  toonDeserialize,
} from "../packages/shared/dist/index.js";
import { orchestrateSwarm } from "../packages/jitna/dist/index.js";

function tempJitnaPath() {
  return path.join(os.tmpdir(), `delentia_test_${Date.now()}_${Math.random().toString(36).slice(2)}.jitna`);
}

test("serializeJitnaPacket -> parseJitnaPacket: real round trip on a packet produced by the real orchestrateSwarm() tool", () => {
  const swarm = orchestrateSwarm({
    objective: "migrate the legacy customer database to the new schema",
    data_readiness: 65,
    target_pillar: "auto",
  });
  const packet = swarm.jitna_packet;

  const serialized = serializeJitnaPacket(packet);
  const parsed = parseJitnaPacket(serialized);
  assert.deepEqual(parsed, packet, "round trip must reproduce the exact real packet, not an approximation");
});

test("serializeJitnaPacket: rejects a packet that fails the real JITNAPacketSchema (e.g. an invalid pillar) before ever writing anything", () => {
  assert.throws(() => serializeJitnaPacket({ I: "x", D: 50, delta: 50, A: "not_a_real_pillar", R: "note", M: {} }));
});

test("the file format carries an explicit $jitna_format marker distinguishing it from the unrelated pre-existing .jitna agent-template files elsewhere in the repo", () => {
  const serialized = serializeJitnaPacket({ I: "test_intent", D: 80, delta: 20, A: "guardian", R: "note", M: {} });
  const container = JSON.parse(serialized);
  assert.equal(container.$jitna_format, JITNA_FILE_FORMAT_VERSION);

  // Simulates being handed one of the 254 real, unrelated .jitna files
  // (YAML-ish agent templates with intent/inputs/plan/output keys, found
  // among private intent-driven UI templates during this session's
  // JITNA research) — must be rejected with a clear reason, not silently
  // misparsed as if it were this packet format.
  const unrelatedFormatContent = JSON.stringify({ intent: "some_agent", inputs: {}, plan: [], output: {} });
  assert.throws(() => parseJitnaPacket(unrelatedFormatContent), JitnaFileFormatError);
  try {
    parseJitnaPacket(unrelatedFormatContent);
  } catch (err) {
    assert.match(err.message, /unrelated agent-template files/);
  }
});

test("parseJitnaPacket: detects tampering via checksum mismatch — a hand-edited field is caught, not silently trusted", () => {
  const packet = { I: "test_intent", D: 80, delta: 20, A: "guardian", R: "note", M: { key: "value" } };
  const serialized = serializeJitnaPacket(packet);
  const tampered = serialized.replace('"D": 80', '"D": 999');
  // 999 would also fail the D<=100 schema bound, so use a still-technically-valid
  // but DIFFERENT value to isolate the checksum check from the schema-bounds check.
  const tamperedValidRange = serialized.replace('"D": 80', '"D": 81');
  assert.throws(() => parseJitnaPacket(tampered));
  assert.throws(() => parseJitnaPacket(tamperedValidRange), JitnaFileFormatError, /Checksum mismatch/);
});

test("parseJitnaPacket: rejects malformed JSON with a clear JitnaFileFormatError, not a bare SyntaxError", () => {
  assert.throws(() => parseJitnaPacket("{ this is not valid json"), JitnaFileFormatError);
});

test("writeJitnaFile / readJitnaFile: REAL disk round trip — simulates one agent writing a packet and a separate agent reading it back", async () => {
  const packet = {
    I: "provision_new_gpu_cluster",
    D: 90,
    delta: 10,
    A: "executor",
    R: "Approved by capacity planning review",
    M: { region: "us-east-1", node_count: 8, requested_by: "agent-alpha" },
  };
  const filePath = tempJitnaPath();
  try {
    await writeJitnaFile(filePath, packet);
    const readBack = await readJitnaFile(filePath);
    assert.deepEqual(readBack, packet, "a genuinely separate read call against the real file on disk must reproduce the exact packet a different call wrote");
  } finally {
    await unlink(filePath).catch(() => {});
  }
});

test("writeJitnaFile: rejects an invalid packet before touching the filesystem at all (no partial/corrupt file left behind)", async () => {
  const filePath = tempJitnaPath();
  await assert.rejects(writeJitnaFile(filePath, { I: "x", D: 200, delta: 50, A: "router", R: "note", M: {} })); // D=200 violates the 0-100 schema bound
  const { access } = await import("node:fs/promises");
  await assert.rejects(access(filePath), "no file should have been created when the packet failed validation");
});

test("full realistic scenario: two different swarm objectives produce two different real .jitna files, each round-trips independently without cross-contamination", async () => {
  const swarmA = orchestrateSwarm({ objective: "analyze security posture of the payment gateway", data_readiness: 95, target_pillar: "auto" });
  const swarmB = orchestrateSwarm({ objective: "translate the onboarding documentation to Thai", data_readiness: 40, target_pillar: "auto" });

  const pathA = tempJitnaPath();
  const pathB = tempJitnaPath();
  try {
    await writeJitnaFile(pathA, swarmA.jitna_packet);
    await writeJitnaFile(pathB, swarmB.jitna_packet);

    const readA = await readJitnaFile(pathA);
    const readB = await readJitnaFile(pathB);

    assert.deepEqual(readA, swarmA.jitna_packet);
    assert.deepEqual(readB, swarmB.jitna_packet);
    assert.notDeepEqual(readA, readB, "two genuinely different objectives must not collapse into the same packet");
  } finally {
    await unlink(pathA).catch(() => {});
    await unlink(pathB).catch(() => {});
  }
});

// ============================================================================
// TOON serialization — this repo's TS port of
// Delentia-OS/rct_control_plane/toon_formatter.py. Cross-language byte
// compatibility (Node's TOON output identical to Python's, after
// normalizing Python's Windows text-mode \r\n) was verified manually this
// session, not re-verified here (would require invoking a Python
// subprocess from a Node test, which is a heavier CI dependency than this
// suite otherwise has) — these tests cover the TS side's own correctness.
// ============================================================================

test("toonSerialize/toonDeserialize: round trip on a realistic nested packet-shaped object, including Thai text, matches the documented format exactly", () => {
  const data = {
    packet_id: "test-123",
    priority: 3,
    payload: {
      intent: "คำนวณภาษีเงินได้บุคคลธรรมดา",
      income: 1000000,
      active: true,
      ratio: 3.14,
      empty_obj: {},
      empty_list: [],
      tags: ["finance", "thai_tax"],
      nested: { a: 1, b: { c: 2 } },
    },
  };
  const toon = toonSerialize(data);
  // Exact format match against the documented TOON spec (no braces/brackets/quotes, 2-space indent, "- " list prefix).
  assert.equal(
    toon,
    [
      "packet_id: test-123",
      "priority: 3",
      "payload:",
      "  intent: คำนวณภาษีเงินได้บุคคลธรรมดา",
      "  income: 1000000",
      "  active: true",
      "  ratio: 3.14",
      "  empty_obj: {}",
      "  empty_list: []",
      "  tags:",
      "    - finance",
      "    - thai_tax",
      "  nested:",
      "    a: 1",
      "    b:",
      "      c: 2",
    ].join("\n")
  );
  assert.deepEqual(toonDeserialize(toon), data);
});

test("toonSerialize: null/negative-number/newline-in-string edge cases round-trip correctly", () => {
  const data = { a: null, b: -42, c: -3.5, d: "line1\nline2" };
  const toon = toonSerialize(data);
  assert.match(toon, /a: null/);
  assert.match(toon, /b: -42/);
  assert.match(toon, /c: -3\.5/);
  assert.deepEqual(toonDeserialize(toon), data);
});

// ============================================================================
// Compact `.jitna` format: TOON + zlib (2026-09-13)
// ============================================================================

test("serializeJitnaPacketCompact -> parseJitnaPacketCompact: real round trip on a packet from the real orchestrateSwarm() tool", () => {
  const swarm = orchestrateSwarm({ objective: "provision a new GPU cluster in us-east-1", data_readiness: 60, target_pillar: "auto" });
  const compact = serializeJitnaPacketCompact(swarm.jitna_packet);
  const parsed = parseJitnaPacketCompact(compact);
  assert.deepEqual(parsed, swarm.jitna_packet);

  const container = JSON.parse(compact);
  assert.equal(container.$jitna_format, JITNA_FILE_FORMAT_VERSION_COMPACT);
  assert.notEqual(container.$jitna_format, JITNA_FILE_FORMAT_VERSION, "compact format must carry its own distinct marker, not collide with v1's");
});

test("jitnaCompactSizeComparison: HONEST, real measured size difference — small packets barely benefit (compression+base64 overhead), larger packets with richer M fields genuinely shrink", () => {
  const small = orchestrateSwarm({ objective: "deploy service", data_readiness: 70, target_pillar: "auto" }).jitna_packet;
  const smallComparison = jitnaCompactSizeComparison(small);
  // Not asserting a specific percentage for the small case — the whole
  // point is this is genuinely input-dependent, same honesty principle as
  // compress_context's reduction_percentage elsewhere in this ecosystem.
  assert.ok(typeof smallComparison.reduction_percentage === "number");

  const large = {
    I: "migrate_customer_database_to_new_schema_with_zero_downtime",
    D: 65,
    delta: 35,
    A: "executor",
    R: "Approved after capacity review; rollback plan documented; monitoring dashboards configured for the migration window.",
    M: {
      objective: "migrate the legacy customer database to the new schema with zero downtime",
      steps: ["snapshot", "dual_write", "backfill", "verify", "cutover", "cleanup"],
      owner: "platform-team",
      region: "us-east-1",
      estimated_duration_minutes: 240,
      risk_notes: "Requires coordination with the billing service team since they share the customers table.",
      approvals: [
        { name: "alice", role: "DBA", approved: true },
        { name: "bob", role: "SRE", approved: true },
      ],
    },
  };
  const largeComparison = jitnaCompactSizeComparison(large);
  assert.ok(largeComparison.reduction_percentage > 20, `a realistic, richer packet must show a real, substantial reduction (got ${largeComparison.reduction_percentage}%)`);
  assert.equal(largeComparison.json_bytes, Buffer.byteLength(serializeJitnaPacket(large), "utf-8"));
});

test("parseJitnaPacketCompact: rejects the plain v1 JSON format with a clear error (the two formats are not interchangeable)", () => {
  const v1Content = serializeJitnaPacket({ I: "x", D: 50, delta: 50, A: "router", R: "note", M: {} });
  assert.throws(() => parseJitnaPacketCompact(v1Content), JitnaFileFormatError);
});

test("parseJitnaPacketCompact: detects tampering via checksum mismatch, same guarantee as the v1 format", () => {
  const packet = { I: "test_intent", D: 80, delta: 20, A: "guardian", R: "note", M: {} };
  const compact = serializeJitnaPacketCompact(packet);
  const container = JSON.parse(compact);
  container.checksum = "0".repeat(64); // corrupt the checksum, leave the real compressed payload intact
  assert.throws(() => parseJitnaPacketCompact(JSON.stringify(container)), JitnaFileFormatError, /Checksum mismatch/);
});

test("writeJitnaFileCompact / readJitnaFileCompact: REAL disk round trip", async () => {
  const packet = { I: "provision_gpu_cluster", D: 90, delta: 10, A: "executor", R: "note", M: { region: "us-east-1" } };
  const filePath = tempJitnaPath();
  try {
    await writeJitnaFileCompact(filePath, packet);
    const readBack = await readJitnaFileCompact(filePath);
    assert.deepEqual(readBack, packet);
  } finally {
    await unlink(filePath).catch(() => {});
  }
});
