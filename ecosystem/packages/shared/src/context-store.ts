/**
 * "Compress, but keep it retrievable" (2026-09-27).
 *
 * compress_context's aggressive mode keeps the answer line for questions that reuse the
 * source's words, but loses it for ~40% of paraphrased questions (benchmarks/compression-real).
 * Storing the original next to the compressed text lets an agent fetch exactly the lines it
 * turned out to need, instead of re-sending the whole context or answering without them.
 *
 * Pattern matching is plain case-insensitive substring search (any of the space-separated
 * terms), never a caller-supplied regex, so a query can't be made pathologically slow.
 */

export const MAX_RETAINED_CHARS = 1_000_000;
export const MAX_RETURNED_LINES = 400;

export interface ContextQuery {
  /** Space-separated terms; a line matches if it contains any of them (case-insensitive). */
  pattern?: string;
  /** 1-based inclusive line range. */
  start_line?: number;
  end_line?: number;
  /** Lines of context around each pattern match (default 1, max 10). */
  context_lines?: number;
  max_lines?: number;
}

export interface ContextQueryResult {
  total_lines: number;
  lines: Array<{ n: number; text: string }>;
  truncated: boolean;
}

export function queryLines(text: string, q: ContextQuery): ContextQueryResult {
  const all = text.split("\n");
  const total = all.length;
  const max = Math.min(Math.max(1, Math.floor(q.max_lines ?? 200)), MAX_RETURNED_LINES);
  const start = Math.max(1, Math.floor(q.start_line ?? 1));
  const end = Math.min(total, Math.floor(q.end_line ?? total));

  const keep = new Array<boolean>(total).fill(false);
  const terms = (q.pattern ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) {
    for (let i = start - 1; i < end; i++) keep[i] = true;
  } else {
    const window = Math.min(Math.max(0, Math.floor(q.context_lines ?? 1)), 10);
    for (let i = start - 1; i < end; i++) {
      const lower = all[i].toLowerCase();
      if (terms.some((t) => lower.includes(t))) {
        for (let j = Math.max(start - 1, i - window); j <= Math.min(end - 1, i + window); j++) keep[j] = true;
      }
    }
  }

  const lines: Array<{ n: number; text: string }> = [];
  let truncated = false;
  for (let i = 0; i < total; i++) {
    if (!keep[i]) continue;
    if (lines.length >= max) {
      truncated = true;
      break;
    }
    lines.push({ n: i + 1, text: all[i] });
  }
  return { total_lines: total, lines, truncated };
}
