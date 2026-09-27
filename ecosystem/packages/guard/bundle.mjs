// Builds packages/guard/npm/: a self-contained, publishable `delentia-guard` package
// (the workspace packages @delentia/shared and @delentia/mcp-delta are not on npm, so the
// CLI is bundled with them into one file). Run after `npm run build`.
import { build } from "esbuild";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "npm");
mkdirSync(path.join(out, "policies"), { recursive: true });

await build({
  entryPoints: [path.join(here, "src/cli.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  outfile: path.join(out, "cli.mjs"),
  // Some bundled dependencies are CommonJS and call require(); give the ESM bundle one.
  // (The shebang comes from src/cli.ts; esbuild keeps it on the first line.)
  banner: { js: 'import { createRequire as __createRequire } from "node:module";\nconst require = __createRequire(import.meta.url);' },
  legalComments: "none",
  logLevel: "warning",
});
copyFileSync(path.join(here, "policies/coding-agent.json"), path.join(out, "policies/coding-agent.json"));

const src = JSON.parse(readFileSync(path.join(here, "package.json"), "utf8"));
writeFileSync(
  path.join(out, "package.json"),
  JSON.stringify(
    {
      name: "delentia-guard",
      version: src.version,
      description: src.description,
      type: "module",
      bin: { "delentia-guard": "cli.mjs" },
      files: ["cli.mjs", "policies/", "README.md"],
      engines: { node: ">=18" },
      keywords: ["mcp", "model-context-protocol", "ai-agent", "guardrails", "policy", "audit", "claude", "cursor"],
      // Decide before publishing: see docs/GUARD.md "Publishing".
      license: "UNLICENSED",
    },
    null,
    2
  ) + "\n"
);
copyFileSync(path.join(here, "../../docs/GUARD.md"), path.join(out, "README.md"));
console.log("built", path.relative(process.cwd(), out));
