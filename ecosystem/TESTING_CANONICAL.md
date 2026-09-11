# Delentia Sovereign MCP — Testing & Status Canonical

This document is the **single source of truth** for what this repo's deployed
MCP tools actually do. If README.md, BENCHMARK_REPORT.md, or any blog/marketing
copy disagrees with this file, **this file wins** — mirrors the governance
pattern already used in `Delentia-OS/docs/testing/TESTING_CANONICAL.md`.

**Last verified:** 2026-09-11 (direct source-code read + real test run, not a narrative claim)

## Per-tool implementation status

| Tool | Status | Evidence |
|---|---|---|
| `evaluate_fdia` | Real computation. `F = (D^I) * A` computed from actual input; `A` dynamically evaluated via policy wildcard rules; SHA-256 audit digest computed from real request data. Now fails closed (returns `SECURITY_POLICY_VIOLATION`, not a NaN-driven false `AUTHORIZED`) on non-finite/negative `data_quality`/`intent_precision`. | `packages/shared/src/fdia-core.ts` |
| `configure_policy` | Real state mutation. Full-replace (not merge) semantics; no schema validation before reporting success in the `sovereign` worker (unresolved — tracked in `ROADMAP.md`). `sovereign` worker stores policy in-memory (isolate-scoped, eventually-consistent via optional KV write); the standalone `fdia` worker stores it in a Durable Object (more durable). | `packages/sovereign/src/worker.ts`, `packages/fdia/src/worker.ts` |
| `rct_think` | **Real, deterministic heuristic score.** `verified_alignment_score` is computed from grounding completeness, problem specificity, and lexical overlap between `problem_statement`/`target_desired_outcome` — varies with input, documented in full in `docs/RCT7_SCORING_SPEC.md`. Explicitly NOT semantic understanding (no LLM call); 6 of 7 stage narratives remain templated prose (only stage 7's text is now data-driven). | `packages/rct7/src/index.ts`, `docs/RCT7_SCORING_SPEC.md` |
| `compress_context` | Real dedup + optional keyword filter; SHA-256 hash of real output. `reduction_percentage` is now the **real, unclamped computed value** — it can be negative on already-short/unique input or exceed the old 91.5% figure on highly repetitive input. The 74.2%-91.5% range was a specific benchmark result, not a guarantee, and is no longer enforced. | `packages/delta/src/index.ts` |
| `orchestrate_swarm` | Real objective→pillar keyword routing and delta math. `assigned_pillars` now tags each pillar `role: "primary"` (the one actually routed to, with an objective-specific subtask) or `role: "support"` (standing role only, explicitly labeled as not engaged for this objective) — no longer 4 identical objective-specific claims. `expected_vram_switch_ms` remains a static per-pillar design target (no LoRA runtime exists in this codebase) but is now clearly documented as such. | `packages/jitna/src/index.ts`, `packages/shared/src/jitna-types.ts` |

## Test suite

37 tests across 3 files, all passing as of 2026-09-11 (`npm run test:all`):
`tests/ecosystem.test.mjs` (8), `tests/deep-ecosystem.test.mjs` (15),
`tests/test_fdia_policy_engine.mjs` (14). Includes explicit regression tests
for every behavior change above (real RCT-7 score varies + is deterministic,
FDIA fails closed on malformed input, Delta reduction is unclamped in both
directions, JITNA primary/support role split). CI (`.github/workflows/ci.yml`)
now runs build + typecheck + this full suite on every PR and push to `main` —
previously this repo had no CI at all.

## Post-deploy verification (2026-09-11)

All 5 workers (`fdia`, `rct7`, `delta`, `jitna`, `sovereign`) deployed to
Cloudflare Workers at v2.1.0 and independently verified against the LIVE
production endpoints (not local `dist/`), via direct `curl` calls to
`https://delentia-sovereign-mcp.delentia.workers.dev/mcp`:

- `evaluate_fdia`: normal case correct; malformed-input fail-closed fix confirmed live (`SECURITY_POLICY_VIOLATION`, not `AUTHORIZED`+NaN)
- `rct_think`: vague input scored `0.05`, specific+grounded input scored `0.5841` — matches local unit test values exactly
- `compress_context`: tiny input returned `reduction_percentage: -1700` (real unclamped value, not forced to 15.0)
- `orchestrate_swarm`: security-flavored objective correctly routed `guardian` as `primary`, other 3 pillars as `support`
- `configure_policy`: malformed policy correctly rejected with validation error, no state changed. (The valid-input success path was not re-tested against production — it mutates shared live policy state for real callers; already covered by 14 passing local tests instead.)

`delentia-mcp@2.1.0` published to npm (`npm view delentia-mcp version` confirms).
`io.github.delentia-labs/delentia-mcp@2.1.0` published to the official MCP
Registry via a new GitHub Actions OIDC workflow (`delentia-mcp/.github/workflows/publish-registry.yml`)
— a personal `mcp-publisher login github` cannot publish under an org
namespace regardless of membership visibility; OIDC proves org ownership
cryptographically. Independently confirmed via `registry.modelcontextprotocol.io`'s
public API.

## Known false/unverifiable claims elsewhere in this repo (not yet fixed)

- `BENCHMARK_REPORT.md` (dated 2026-09-08) labels itself "100% VERIFIED & VALIDATED ACROSS ALL 4 PILLARS" but contains literal unpopulated template placeholders (e.g. `"undefined% (undefined/19 attacks successfully neutralized)"`) — the report generator did not finish substituting its own variables. Do not cite this report's headline numbers until it is regenerated and manually spot-checked.
- The FDIA equation `F = (D^I) * A` is implemented independently in at least 3 places across this ecosystem (`fdia-core.ts` here, plus `algorithm_kernel_41.py` and `zk_fdia.py` in `Delentia-OS`), with no shared source of truth or contract test between them. Treat any cross-repo FDIA claim as unverified until that contract test exists.
- 6 of `rct_think`'s 7 stage narratives are still templated prose (see `rct_think` row above) — only the numeric score and stage-7 text are now data-driven.

## Why this file exists

This repo had no `ROADMAP.md`, `CHANGELOG.md`, or canonical status doc before
2026-09-11, unlike `Delentia-OS` which already has this governance pattern
(`docs/testing/TESTING_CANONICAL.md`, `docs/release/PUBLIC_RELEASE_PROVENANCE.md`).
See `ROADMAP.md` for planned fixes to the items still flagged above, and
`CHANGELOG.md` for the full change history.
