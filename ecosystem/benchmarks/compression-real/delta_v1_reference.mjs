/**
 * Frozen copy of compressContext's filtering logic as deployed up to 2026-09-27 (v1),
 * kept so the benchmark can keep comparing against it after packages/delta moved to v2.
 * Returns only the field the benchmark uses.
 */
export function compressContextV1({ raw_context, intent_focus, aggressive_mode }) {
  const lines = raw_context.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const deduplicatedLines = Array.from(new Set(lines));

  let keyLines = deduplicatedLines;
  if (intent_focus) {
    const focusKeywords = intent_focus.toLowerCase().split(/\s+/).filter((k) => k.length > 2);
    keyLines = deduplicatedLines.filter((line) => {
      const lower = line.toLowerCase();
      const hasKeyword = focusKeywords.some((k) => lower.includes(k));
      const isCodeOrState = line.startsWith("+") || line.startsWith("-") || line.includes("error") || line.includes("return") || line.includes("verdict");
      return hasKeyword || isCodeOrState || !aggressive_mode;
    });
    if (keyLines.length === 0) {
      keyLines = deduplicatedLines.slice(-10);
    }
  }

  const deltaHeader = `[DELENTIA-DELTA-STREAM] Intent: "${intent_focus || "General"}" | State Diffs Only:`;
  return { compressed_delta_text: `${deltaHeader}\n${keyLines.join("\n")}` };
}
