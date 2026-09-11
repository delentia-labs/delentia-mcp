import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createHash } from "node:crypto";

export const CompressContextInputSchema = z.object({
  raw_context: z
    .string()
    .min(1)
    .describe("The verbose conversation history, documents, or logs to compress"),
  intent_focus: z
    .string()
    .optional()
    .describe("The specific goal or task that determines which details to retain (Intent-driven filtering)"),
  aggressive_mode: z
    .boolean()
    .default(false)
    .describe("When true, strips boilerplate and retains only high-entropy semantic delta diffs"),
});

export type CompressContextInput = z.infer<typeof CompressContextInputSchema>;

export interface CompressionResult {
  original_char_count: number;
  compressed_char_count: number;
  estimated_original_tokens: number;
  estimated_compressed_tokens: number;
  reduction_percentage: number;
  compressed_delta_text: string;
  context_hash: string;
  timestamp: string;
}

export function compressContext(input: CompressContextInput): CompressionResult {
  const { raw_context, intent_focus, aggressive_mode } = input;
  const original_char_count = raw_context.length;
  const estimated_original_tokens = Math.ceil(original_char_count / 3.5);

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
  const compressedBody = keyLines.join("\n");
  const compressed_delta_text = `${deltaHeader}\n${compressedBody}`;

  const compressed_char_count = compressed_delta_text.length;
  const estimated_compressed_tokens = Math.ceil(compressed_char_count / 3.5);

  // Real computed ratio, reported as-is. This can legitimately be negative
  // (the added [DELENTIA-DELTA-STREAM] header can outweigh savings on
  // already-short/unique input) or exceed the 74.2%-91.5% range previously
  // hardcoded here — that range described a specific benchmark input, not a
  // guaranteed bound for every input, so it is no longer artificially
  // enforced. Only clamped at the mathematical ceiling: compressed tokens
  // cannot go below 0, so reduction cannot exceed 100%.
  const rawReduction = ((estimated_original_tokens - estimated_compressed_tokens) / estimated_original_tokens) * 100;
  const reduction_percentage = Math.round(Math.min(rawReduction, 100) * 10) / 10;

  const context_hash = createHash("sha256").update(compressed_delta_text).digest("hex");

  return {
    original_char_count,
    compressed_char_count,
    estimated_original_tokens,
    estimated_compressed_tokens,
    reduction_percentage,
    compressed_delta_text,
    context_hash,
    timestamp: new Date().toISOString(),
  };
}

export function createDeltaMcpServer() {
  const server = new McpServer({
    name: "delentia-delta",
    version: "1.0.0",
  });

  server.registerTool(
    "compress_context",
    {
      description:
        "Compresses verbose conversation history, logs, or codebase context by deduplicating repeated lines and, when `intent_focus` is provided, filtering to lines relevant to that intent. Token reduction is computed fresh per request from the actual input (highly variable — near-zero or even negative on already-short/unique input, higher on repetitive logs) — it is not a fixed guaranteed range. USE WHEN: context is large or repetitive and approaching a token budget; supply `intent_focus` for meaningfully better filtering — without it, only deduplication is applied. DO NOT USE WHEN: you need the content reasoned about (use rct_think) or expect true semantic summarization — this is line-level filtering, not an LLM rewrite, so it can drop details a summarizer would keep.",
      inputSchema: {
        raw_context: z
          .string()
          .describe("The verbose conversation history, documents, or logs to compress"),
        intent_focus: z
          .string()
          .optional()
          .describe("The specific goal or task that determines which details to retain (Intent-driven filtering)"),
        aggressive_mode: z
          .boolean()
          .default(false)
          .describe("When true, strips boilerplate and retains only high-entropy semantic delta diffs"),
      } as any,
    },
    async (args: any) => {
      const { raw_context, intent_focus, aggressive_mode } = args;
      const result = compressContext({
        raw_context: String(raw_context ?? ""),
        intent_focus: intent_focus ? String(intent_focus) : undefined,
        aggressive_mode: Boolean(aggressive_mode ?? false),
      });

      const responseText = [
        `# Delentia Delta Context Compression Report`,
        `- **Original Tokens (Est.):** ~${result.estimated_original_tokens}`,
        `- **Compressed Tokens (Est.):** ~${result.estimated_compressed_tokens}`,
        `- **Token Reduction (this request):** ${result.reduction_percentage.toFixed(1)}%`,
        `- **Context Delta SHA-256:** \`${result.context_hash}\``,
        `- **Timestamp:** ${result.timestamp}`,
        `\n---\n`,
        `### Compressed Semantic Delta Stream:`,
        result.compressed_delta_text,
      ].join("\n");

      return {
        content: [
          {
            type: "text" as const,
            text: responseText,
          },
        ],
      };
    }
  );

  return server;
}

if (process.argv[1] && process.argv[1].endsWith("index.js")) {
  const server = createDeltaMcpServer();
  const transport = new StdioServerTransport();
  server.connect(transport).catch((err) => {
    console.error("Failed to start Delentia Delta MCP Server:", err);
    process.exit(1);
  });
}
