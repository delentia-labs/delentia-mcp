# Changelog

## Unreleased

### Added
- `ROADMAP.md` and `TESTING_CANONICAL.md` — this repo had neither before; both establish the same governance pattern already used in `Delentia-OS` (a single status doc that overrides marketing copy on disagreement).
- `docs/RCT7_SCORING_SPEC.md` — the first concrete spec anywhere in the ecosystem for how RCT-7's alignment score is computed (formula, worked examples, documented limitations). Neither the whitepaper nor the Python "reference implementation" in `the private services repo` ever specified one.
- `.github/workflows/ci.yml` — this repo had **no CI at all** before; now builds, typechecks, and runs the full test suite on every PR and push to `main`.
- 5 new regression tests in `tests/ecosystem.test.mjs` and 0 new assertions changed correctness in `tests/deep-ecosystem.test.mjs` (fixed 2 stale assertions there — see Fixed, below) covering every behavior change in this release.

### Changed
- Rewrote all 5 live tool descriptions (`evaluate_fdia`, `configure_policy`, `rct_think`, `compress_context`, `orchestrate_swarm`) across `packages/sovereign`, `packages/fdia`, `packages/rct7`, `packages/delta`, `packages/jitna` to explain what each output value means, the impact/reversibility of `configure_policy`, the JITNA packet fields, and explicit "use when / do not use when" guidance relative to the other 4 tools. (Initially done only for `sovereign` and `fdia`; the standalone `rct7`, `delta`, and `jitna` worker deployments had their own separate, stale `tools/list` descriptions that were missed and are now synced too.)
- `rct_think`'s `verified_alignment_score` is now a real, deterministic heuristic (grounding completeness + problem specificity + lexical overlap) instead of a hardcoded `1.0`. See `docs/RCT7_SCORING_SPEC.md`.
- `compress_context`'s `reduction_percentage` is now the real, unclamped computed value — no more artificial 91.5% cap or 15.0% floor-fallback.
- `orchestrate_swarm`'s `assigned_pillars` now tags each pillar `role: "primary"` or `role: "support"` and only gives the actually-routed pillar an objective-specific subtask — the other 3 no longer claim to be doing work they aren't.

### Fixed
- **Security-relevant**: `evaluate_fdia` could previously return `verdict: "AUTHORIZED"` with a `NaN` `future_score` when given malformed numeric input (e.g. negative `data_quality`) — `Math.pow` on an invalid domain produced `NaN`, which compared `false` against every threshold check and fell through to the authorized branch. Now fails closed (`SECURITY_POLICY_VIOLATION`, `future_score: 0`, `authorized: false`) on any non-finite or negative `data_quality`/`intent_precision`.
- `configure_policy` in both `sovereign` and standalone `fdia` workers now validates the submitted policy against the schema *before* mutating state or reporting `"status": "success"` — previously a schema-invalid policy was accepted, echoed back as success, and only silently rejected the next time `evaluate_fdia` tried to use it.
- Fixed an operator-precedence bug in the standalone `fdia` worker's `configure_policy` route guard (`A && B || C` instead of `A && (B || C)`) that could match on `body.tool` alone regardless of `body.method`.
- 2 stale assertions in `tests/deep-ecosystem.test.mjs` that encoded the old hardcoded/clamped behavior as "correct" (`verified_alignment_score === 1.0`, `reduction_percentage <= 91.5`) — these would have failed correctly once the underlying bugs were fixed; rewritten to assert the real behavior instead.
- **CI-blocking**: root `npm run typecheck` was `tsc --noEmit` with no project reference — every package's `worker.ts`/`session-do.ts` uses Cloudflare Workers ambient types (`DurableObjectState`, `ExecutionContext`, `KVNamespace`, ...) that only resolve through each package's own `tsconfig.json` (`types: ["@cloudflare/workers-types"]`). The root script never worked and would have made the CI workflow added in this release red on its very first run. Replaced with a per-package loop (`typecheck:shared`, `:fdia`, `:rct7`, `:delta`, `:jitna`, `:sovereign`), matching the existing `build` script's pattern.
- Root `package.json` had `deploy:fdia`/`deploy:rct7`/`deploy:delta`/`deploy:jitna` and a `deploy:all` that silently never deployed the `sovereign` (all-in-one, 5-tool) worker. Added `deploy:sovereign` and included it in `deploy:all`.

### Version
- Bumped all package versions (root + each `packages/*`) and `delentia-mcp`'s `package.json`/`server.json`/`server-card.json` by one minor version to reflect the behavior changes in this release — see each file for its prior version.

### Known issues (see `TESTING_CANONICAL.md` for detail)
- `configure_policy` in the `sovereign` worker still has no schema validation before reporting success, and its in-memory/KV state strategy is still inconsistent with the `fdia` worker's Durable Object approach.
- The FDIA formula is still duplicated (not shared) across this repo and `Delentia-OS` — no contract test exists yet between `fdia-core.ts`, `algorithm_kernel_41.py::algo_01_fdia`, and `zk_fdia.py`.
- `BENCHMARK_REPORT.md` still contains unpopulated `"undefined"` template placeholders in its headline numbers — not regenerated yet.
- 6 of `rct_think`'s 7 stage narratives are still templated prose, not data-driven.
