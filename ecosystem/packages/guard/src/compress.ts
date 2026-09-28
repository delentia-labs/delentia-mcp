/**
 * Tool-output compression for the guard (Round 47 / P2).
 *
 * Large tool results (test/build logs, file dumps, search output) are replaced by a compressed
 * view before they reach the agent's context, and the original is kept in memory so the agent
 * can fetch dropped lines with the injected `delentia_expand_context` tool.
 *
 * The compressed view is deterministic (same output -> same text), so conversation history stays
 * append-only and provider prompt caching keeps working — the "compress once at ingestion"
 * pattern measured in benchmarks/compression-real (agent loop: -87% vs -76% caching alone).
 *
 * View = first HEAD lines + lines carrying failure signals (with one line of context, via
 * compress_context's aggressive filter) + last TAIL lines. Head and tail are kept because logs put
 * the command at the top and the summary/result at the bottom.
 *
 * Only tools whose names match `tools` are compressed (commands, tests, builds, logs by default).
 * File reads are deliberately not: an agent that reads a file in order to edit it needs all of it
 * (on this repo's intent-loop source the view would have dropped 81% of the file). The call's own
 * argument terms are not used as keywords either: measured on a real test log, the word "test"
 * from `npm run test:all` matched nearly every line (48% smaller vs 66% with signals only).
 */
import { randomUUID } from "node:crypto";
import { compressContext } from "@delentia/mcp-delta";
import { matchesWildcard, queryLines, type ContextQuery, type ContextQueryResult } from "@delentia/shared";

const HEAD = 15;
const TAIL = 15;
const SIGNALS = "error errors fail failed failure failing exception traceback panic fatal warning warn assert assertion denied refused timeout exit";

export interface CompressOptions {
  /** Only results larger than this many estimated tokens are compressed (default 2000). */
  thresholdTokens?: number;
  /** Tool-name patterns (with *) whose results may be compressed. */
  tools?: string[];
  /** Max characters of originals kept in memory; oldest are dropped first (default 50M). */
  maxStoredChars?: number;
}

export const estimateTokens = (text: string) => Math.ceil(text.length / 3.5);

export class OutputCompressor {
  private store = new Map<string, string>();
  private storedChars = 0;
  readonly stats = { results_seen: 0, results_compressed: 0, tokens_in: 0, tokens_out: 0, expands: 0 };

  constructor(private opts: CompressOptions = {}) {}

  /** Returns a compressed replacement for `text`, or null if it is small enough to pass as is. */
  /** True when results of this tool may be compressed. */
  appliesTo(tool: string): boolean {
    return (this.opts.tools ?? DEFAULT_COMPRESS_TOOLS).some((p) => matchesWildcard(tool, p));
  }

  compress(text: string): { text: string; ref: string } | null {
    this.stats.results_seen++;
    const threshold = this.opts.thresholdTokens ?? 2000;
    if (estimateTokens(text) <= threshold) return null;

    const lines = text.split("\n");
    if (lines.length <= HEAD + TAIL + 5) return null; // one huge line (e.g. minified JSON): nothing to filter safely

    const middle = lines.slice(HEAD, lines.length - TAIL).join("\n");
    const filtered = compressContext({ raw_context: middle, intent_focus: SIGNALS, aggressive_mode: true, outline: true })
      .compressed_delta_text.split("\n")
      .slice(1) // drop compress_context's header line
      // Outline line numbers are relative to `middle`; shift them to the original output.
      .map((l) => l.replace(/^L(\d+): /, (_, n) => `L${Number(n) + HEAD}: `));

    const ref = randomUUID();
    this.remember(ref, text);
    const view = [
      `[delentia-guard: output compressed from ${lines.length} lines; call delentia_expand_context with context_ref "${ref}" and a pattern or line range to see anything that was left out]`,
      ...lines.slice(0, HEAD),
      "…",
      ...filtered,
      "…",
      ...lines.slice(lines.length - TAIL),
    ].join("\n");

    // Never make a result bigger.
    if (view.length >= text.length) {
      this.store.delete(ref);
      return null;
    }
    this.stats.results_compressed++;
    this.stats.tokens_in += estimateTokens(text);
    this.stats.tokens_out += estimateTokens(view);
    return { text: view, ref };
  }

  expand(ref: string, query: ContextQuery): ContextQueryResult | null {
    const text = this.store.get(ref);
    if (text === undefined) return null;
    this.stats.expands++;
    return queryLines(text, query);
  }

  private remember(ref: string, text: string): void {
    const max = this.opts.maxStoredChars ?? 50_000_000;
    this.store.set(ref, text);
    this.storedChars += text.length;
    for (const [oldRef, oldText] of this.store) {
      if (this.storedChars <= max || oldRef === ref) break;
      this.store.delete(oldRef);
      this.storedChars -= oldText.length;
    }
  }
}

export const DEFAULT_COMPRESS_TOOLS = ["run_*", "*_command", "execute_*", "exec_*", "bash*", "shell*", "terminal*", "*test*", "*build*", "*lint*", "*log*"];

export const EXPAND_TOOL_NAME = "delentia_expand_context";

export const EXPAND_TOOL = {
  name: EXPAND_TOOL_NAME,
  description:
    "Fetch lines that delentia-guard left out of a compressed tool result. Pass the context_ref printed at the top of that result, plus `pattern` (space-separated terms, any match, case-insensitive) and/or `start_line`/`end_line`. Returns numbered lines (max 400).",
  inputSchema: {
    type: "object",
    properties: {
      context_ref: { type: "string" },
      pattern: { type: "string" },
      context_lines: { type: "number" },
      start_line: { type: "number" },
      end_line: { type: "number" },
      max_lines: { type: "number" },
    },
    required: ["context_ref"],
  },
};
