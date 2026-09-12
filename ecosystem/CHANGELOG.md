# Changelog

## Unreleased (2026-09-12)

### Added
- `tests/fdia_deep_hypothesis.test.mjs` — 24 new adversarial/edge-case hypothesis tests for `evaluate_fdia`'s core matching and math logic (mathematical invariants of `F = D^I * A`, determinism, wildcard-matching evasion attempts, prototype-pollution/injection robustness, custom-policy isolation, RBAC-severity interaction). Requested specifically to go deeper than the existing scenario-based test suite. Test count: 38 → 62.

### Fixed
- **Security-relevant**: `FDIAEngine.evaluateA()` used first-match-wins rule resolution — when an action name matched more than one policy rule, whichever rule was listed first in the `rules` array won, with no regard for severity. Found via hypothesis testing: `purge_telemetry_cache` matched both the bundled `RULE-DATABASE-DESTRUCTIVE-BLOCK` (`purge_*`) and `RULE-READONLY-ALLOW` (`*telemetry*`); it was authorized because the ALLOW rule happened to be declared first. This is not just a bundled-policy ordering issue — any customer-authored `custom_policy` listing an ALLOW rule before a BLOCK rule would hit the same bypass. Fixed by ranking all matching rules by severity (`REQUIRE_HUMAN_SIGNATURE` > `CONDITIONAL` > `ALLOW`) and always resolving to the most restrictive match, independent of array order. Also reordered `default-policy.ts`'s bundled rules most-restrictive-first for readability (no longer load-bearing after the fix).
- **Security-relevant**: `matchesWildcard()` did not trim whitespace before matching, so leading/trailing padding on `action_name` broke anchored patterns (`purge_*`) while leaving unanchored patterns (`*telemetry*`) unaffected — `"  purge_telemetry_cache  "` moved from correctly-blocked to explicitly-authorized instead of falling through to the safe zero-trust fallback. Fixed by trimming both the action name and each rule pattern before comparison.
- Documented (intentionally not "fixed", since no code fix is well-scoped): `action_name` is a caller-self-reported label the engine cannot verify against what the caller will actually execute, and a zero-width-space-style invisible-Unicode evasion of a specific block pattern is only caught by the zero-trust *default* (not by the engine itself) — see `TESTING_CANONICAL.md`'s "Security fixes found via hypothesis testing" section.

## Unreleased

### Added
- `ROADMAP.md` and `TESTING_CANONICAL.md` — this repo had neither before; both establish the same governance pattern already used in `Delentia-OS` (a single status doc that overrides marketing copy on disagreement).
- `docs/RCT7_SCORING_SPEC.md` — the first concrete spec anywhere in the ecosystem for how RCT-7's alignment score is computed (formula, worked examples, documented limitations). Neither the whitepaper nor the Python "reference implementation" in `the private services repo` ever specified one.
- `.github/workflows/ci.yml` — this repo had **no CI at all** before; now builds, typechecks, and runs the full test suite on every PR and push to `main`.
- 5 new regression tests in `tests/ecosystem.test.mjs` and 0 new assertions changed correctness in `tests/deep-ecosystem.test.mjs` (fixed 2 stale assertions there — see Fixed, below) covering every behavior change in this release.

### Changed
- Rewrote all 5 live tool descriptions (`evaluate_fdia`, `configure_policy`, `rct_think`, `compress_context`, `orchestrate_swarm`) across `packages/sovereign`, `packages/fdia`, `packages/rct7`, `packages/delta`, `packages/jitna` to explain what each output value means, the impact/reversibility of `configure_policy`, the JITNA packet fields, and explicit "use when / do not use when" guidance relative to the other 4 tools. (Initially done only for `sovereign` and `fdia`; the standalone `rct7`, `delta`, and `jitna` worker deployments had their own separate, stale `tools/list` descriptions that were missed and are now synced too.)
- `rct_think`'s `verified_alignment_score` is now a real, deterministic heuristic (grounding completeness + problem specificity + lexical overlap) instead of a hardcoded `1.0`. See `docs/RCT7_SCORING_SPEC.md`.
- `rct_think`'s remaining 6 stage narratives (Observe, Analyze, Deconstruct, Reverse Reasoning, Identify Core Intent, Reconstruct) are now also data-driven — real sentence splitting, real context/problem lexical overlap, real conjunction-based sub-task extraction, real keyword-taxonomy failure detection, real shared-vocabulary intent extraction, and a blueprint built from the two. Previously these were fixed prose, including a hardcoded "3 critical failure paths" claim regardless of input. See `docs/RCT7_SCORING_SPEC.md`'s "Stages 1-6" section.
- `compress_context`'s `reduction_percentage` is now the real, unclamped computed value — no more artificial 91.5% cap or 15.0% floor-fallback.
- `orchestrate_swarm`'s `assigned_pillars` now tags each pillar `role: "primary"` or `role: "support"` and only gives the actually-routed pillar an objective-specific subtask — the other 3 no longer claim to be doing work they aren't.

### Fixed
- **Security-relevant**: `evaluate_fdia` could previously return `verdict: "AUTHORIZED"` with a `NaN` `future_score` when given malformed numeric input (e.g. negative `data_quality`) — `Math.pow` on an invalid domain produced `NaN`, which compared `false` against every threshold check and fell through to the authorized branch. Now fails closed (`SECURITY_POLICY_VIOLATION`, `future_score: 0`, `authorized: false`) on any non-finite or negative `data_quality`/`intent_precision`.
- `configure_policy` in both `sovereign` and standalone `fdia` workers now validates the submitted policy against the schema *before* mutating state or reporting `"status": "success"` — previously a schema-invalid policy was accepted, echoed back as success, and only silently rejected the next time `evaluate_fdia` tried to use it.
- Fixed an operator-precedence bug in the standalone `fdia` worker's `configure_policy` route guard (`A && B || C` instead of `A && (B || C)`) that could match on `body.tool` alone regardless of `body.method`.
- 3 stale assertions in `tests/deep-ecosystem.test.mjs` that encoded the old hardcoded/clamped/templated behavior as "correct" (`verified_alignment_score === 1.0`, `reduction_percentage <= 91.5`, `stage4.output.includes("failure paths")`) — these would have failed correctly once the underlying bugs were fixed; rewritten to assert the real behavior instead.
- A real bug caught during manual verification of the new Stage 1 (OBSERVE) sentence splitter: naively splitting on every `.` broke "Node.js" into "Node" + "js". Fixed to only split on `.` when followed by whitespace or end-of-string.
- A regex bug in the new Stage 3 (DECONSTRUCT) sub-task splitter: `\band\then\b` (a typo missing a space) was silently interpreted as `\band` + literal tab character + `then\b`, which could never match real text. Fixed to `\band then\b`.
- **CI-blocking**: root `npm run typecheck` was `tsc --noEmit` with no project reference — every package's `worker.ts`/`session-do.ts` uses Cloudflare Workers ambient types (`DurableObjectState`, `ExecutionContext`, `KVNamespace`, ...) that only resolve through each package's own `tsconfig.json` (`types: ["@cloudflare/workers-types"]`). The root script never worked and would have made the CI workflow added in this release red on its very first run. Replaced with a per-package loop (`typecheck:shared`, `:fdia`, `:rct7`, `:delta`, `:jitna`, `:sovereign`), matching the existing `build` script's pattern.
- Root `package.json` had `deploy:fdia`/`deploy:rct7`/`deploy:delta`/`deploy:jitna` and a `deploy:all` that silently never deployed the `sovereign` (all-in-one, 5-tool) worker. Added `deploy:sovereign` and included it in `deploy:all`.

### Version
- Bumped all package versions (root + each `packages/*`) and `delentia-mcp`'s `package.json`/`server.json`/`server-card.json` by one minor version to reflect the behavior changes in this release — see each file for its prior version.

### Known issues (see `TESTING_CANONICAL.md` for detail)
- `sovereign` worker's in-memory/KV `configure_policy` state strategy is still inconsistent with the `fdia` worker's Durable Object approach (both now validate on write; the storage backend itself is still different).
- The FDIA formula is still duplicated (not shared) across this repo and `Delentia-OS` — no contract test exists yet between `fdia-core.ts`, `algorithm_kernel_41.py::algo_01_fdia`, and `zk_fdia.py`.
- `BENCHMARK_REPORT.md` still contains unpopulated `"undefined"` template placeholders in its headline numbers — not regenerated yet.
- `rct_think`'s Stage 1-6 heuristics are shallow regex/keyword-based, not real NLP — see `ROADMAP.md`.
