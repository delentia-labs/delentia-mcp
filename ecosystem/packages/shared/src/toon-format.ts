/**
 * TOON (Token-Oriented Object Notation) — a faithful TypeScript port of
 * Delentia-OS/rct_control_plane/toon_formatter.py's real, already-tested
 * serializer (ALGO-42). Ported line-for-line against the Python
 * implementation (same indentation rule: 2 spaces per level, same list
 * "- " prefix convention, same scalar encoding for null/bool/int/float/string)
 * rather than redesigned, so a TOON string produced by either language
 * round-trips through the other identically.
 *
 * Key properties (same as the Python original): no braces/brackets/quotes,
 * nested structures via indentation, ~40-50% fewer tokens than equivalent
 * JSON for typical structured data.
 */

const INT_RE = /^-?\d+$/;
const FLOAT_RE = /^-?\d+\.\d+$/;

function scalarToStr(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value.replace(/\n/g, "\\n");
  return String(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function writeToon(value: unknown, lines: string[], level: number): void {
  const indent = "  ".repeat(level);

  if (isPlainObject(value)) {
    for (const [key, v] of Object.entries(value)) {
      if (isPlainObject(v)) {
        if (Object.keys(v).length === 0) {
          lines.push(`${indent}${key}: {}`);
        } else {
          lines.push(`${indent}${key}:`);
          writeToon(v, lines, level + 1);
        }
      } else if (Array.isArray(v)) {
        if (v.length === 0) {
          lines.push(`${indent}${key}: []`);
        } else {
          lines.push(`${indent}${key}:`);
          writeToon(v, lines, level + 1);
        }
      } else {
        lines.push(`${indent}${key}: ${scalarToStr(v)}`);
      }
    }
  } else if (Array.isArray(value)) {
    for (const item of value) {
      if (isPlainObject(item) || Array.isArray(item)) {
        lines.push(`${indent}-`);
        writeToon(item, lines, level + 1);
      } else {
        lines.push(`${indent}- ${scalarToStr(item)}`);
      }
    }
  } else {
    lines.push(`${indent}${scalarToStr(value)}`);
  }
}

/** Serializes a value to TOON format. Supported types: object, array, string, number, boolean, null (same as the Python original). */
export function toonSerialize(data: unknown): string {
  const lines: string[] = [];
  writeToon(data, lines, 0);
  return lines.join("\n");
}

function parseScalar(value: string): unknown {
  if (value === "null") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (INT_RE.test(value)) return parseInt(value, 10);
  if (FLOAT_RE.test(value)) return parseFloat(value);
  return value.replace(/\\n/g, "\n");
}

type ParsedLine = [indent: number, content: string];

function readBlock(lines: ParsedLine[], start: number, baseSpaces: number): [unknown, number] {
  if (start >= lines.length) return [{}, start];
  const firstContent = lines[start][1];
  if (firstContent.startsWith("- ") || firstContent === "-") {
    return readList(lines, start, baseSpaces);
  }
  return readDict(lines, start, baseSpaces);
}

function readDict(lines: ParsedLine[], start: number, baseSpaces: number): [Record<string, unknown>, number] {
  const result: Record<string, unknown> = {};
  let i = start;
  while (i < lines.length) {
    const [spaces, content] = lines[i];
    if (spaces < baseSpaces) break;
    if (spaces > baseSpaces) {
      i++;
      continue;
    }
    if (content.startsWith("- ") || content === "-") break;

    const colonSpace = content.indexOf(": ");
    if (colonSpace !== -1) {
      const key = content.slice(0, colonSpace);
      const valStr = content.slice(colonSpace + 2);
      if (valStr === "{}") result[key] = {};
      else if (valStr === "[]") result[key] = [];
      else result[key] = parseScalar(valStr);
      i++;
    } else if (content.endsWith(":")) {
      const key = content.slice(0, -1);
      i++;
      const childSpaces = baseSpaces + 2;
      if (i < lines.length && lines[i][0] >= childSpaces) {
        const [childVal, next] = readBlock(lines, i, childSpaces);
        result[key] = childVal;
        i = next;
      } else {
        result[key] = {};
      }
    } else {
      // A bare scalar with no key at dict level — the Python original
      // returns it directly as a top-level result in this rare case; not
      // reproduced here since every real JITNA packet is a full object at
      // the top level, never a bare scalar. Documented, not silently
      // mishandled: this loop simply stops, leaving `result` as parsed so far.
      break;
    }
  }
  return [result, i];
}

function readList(lines: ParsedLine[], start: number, baseSpaces: number): [unknown[], number] {
  const result: unknown[] = [];
  let i = start;
  while (i < lines.length) {
    const [spaces, content] = lines[i];
    if (spaces < baseSpaces) break;
    if (spaces > baseSpaces) {
      i++;
      continue;
    }
    if (content.startsWith("- ")) {
      result.push(parseScalar(content.slice(2)));
      i++;
    } else if (content === "-") {
      i++;
      const childSpaces = baseSpaces + 2;
      if (i < lines.length && lines[i][0] >= childSpaces) {
        const [childVal, next] = readBlock(lines, i, childSpaces);
        result.push(childVal);
        i = next;
      } else {
        result.push({});
      }
    } else {
      break;
    }
  }
  return [result, i];
}

/** Deserializes a TOON-formatted string back into a plain object/array. */
export function toonDeserialize(toonStr: string): unknown {
  const rawLines = toonStr.split("\n");
  const parsed: ParsedLine[] = [];
  for (const line of rawLines) {
    if (!line.trim()) continue;
    const spaces = line.length - line.replace(/^ +/, "").length;
    parsed.push([spaces, line.trim()]);
  }
  if (parsed.length === 0) return {};
  const [result] = readBlock(parsed, 0, parsed[0][0]);
  return result;
}
