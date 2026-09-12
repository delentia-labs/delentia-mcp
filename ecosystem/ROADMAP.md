# Delentia Sovereign MCP — Roadmap

This roadmap tracks work on the live Cloudflare Workers MCP gateway
(`packages/sovereign`, `packages/fdia`, `packages/rct7`, `packages/delta`,
`packages/jitna`, `packages/shared`). It does not replace or duplicate
`Delentia-OS/ROADMAP.md` or `the private services repo`'s internal roadmaps — this
repo is a fully independent codebase with no code path connecting it to
either of those (see `TESTING_CANONICAL.md` for the verified per-tool status
this roadmap is fixing).

## Done (2026-09-12)

- [x] Deep adversarial/hypothesis test pass specifically on `evaluate_fdia`'s matching logic (`tests/fdia_deep_hypothesis.test.mjs`, 24 tests) — found and fixed two real rule-matching bugs (first-match-wins letting a broad ALLOW rule shadow a narrower BLOCK rule; whitespace padding defeating anchored pattern matches) and explicitly documented two structural limitations that were not fixed (self-reported `action_name` trust boundary; zero-width-space pattern evasion under a permissive fallback policy). Full detail in `TESTING_CANONICAL.md`'s "Security fixes found via hypothesis testing" section and `CHANGELOG.md`.

## Done (2026-09-11)

- [x] `rct_think`'s `verified_alignment_score` is now a real computed heuristic, not a hardcoded `1.0` — see `docs/RCT7_SCORING_SPEC.md`.
- [x] All 6 remaining `rct_think` stage narratives (Observe, Analyze, Deconstruct, Reverse Reasoning, Identify Core Intent, Reconstruct) made data-driven — see `docs/RCT7_SCORING_SPEC.md`'s "Stages 1-6" table. All 7 stages now compute real, input-dependent output.
- [x] Removed the 91.5%/15.0% clamp in `compress_context` — `reduction_percentage` is the real computed value.
- [x] `orchestrate_swarm`'s `assigned_pillars` now reflects the actual routing decision (`role: "primary"`/`"support"`); `expected_vram_switch_ms` documented as a design target, not a measurement.
- [x] Fixed a security-relevant bug: `evaluate_fdia` could return `AUTHORIZED` with a `NaN` score on malformed numeric input — now fails closed.
- [x] Added schema validation to `configure_policy` before it reports `"status": "success"`, in both the `sovereign` worker and the standalone `fdia` worker.
- [x] Added CI (`.github/workflows/ci.yml`) — build + typecheck + full test suite on every PR/push to `main`. Previously none existed.
- [x] Added 10+ regression tests covering all of the above; fixed 3 stale test assertions that encoded old buggy/templated behavior as "correct".

## Now — Delta Engine: the gap between "compress one blob" and "remember across a session"

Found during a 2026-09-11 review requested specifically because token
compression is a plausible strongest sales angle: **`compress_context` is
completely stateless across calls today.** Every call re-compresses whatever
`raw_context` the caller pastes in; there is no mechanism that remembers what
was already sent in a *previous* call and returns only the true delta. The
"session memory" idea (dedup a whole session's worth of turns, not just one
blob) is not implemented, even though the infrastructure to support it is
half-built:

- [ ] **Real bug**: all 4 pillar workers (`fdia`, `rct7`, `delta`, `jitna`) key their Durable Object with a hardcoded literal name (`idFromName("global_delta_session")` etc, see `packages/*/src/worker.ts`) — every caller across the entire public endpoint shares **one single object**. For `delta`, this means compression stats silently accumulate across all users mixed together. For `fdia`, this is more serious: `configure_policy` on the standalone `fdia` worker writes to this same global object, so **one caller's policy change can affect every other caller's `evaluate_fdia` results** on the shared public endpoint. Worth a deliberate decision: is a single shared policy intentional for the free tier (with isolation expected only for dedicated enterprise deployments), or does this need real per-caller session scoping?
- [ ] `packages/delta/src/session-do.ts`'s `accumulatedDeltas: string[]` field is defined but never written to or read from anywhere — dead code suggesting the original design intended more than what shipped.
- [ ] To build real cross-session delta memory: `compress_context` would need (a) a `session_id` input parameter (none exists in the tool schema today), (b) to store the last-seen `raw_context` (or its line-set) per session, and (c) to diff the new call's `raw_context` against that stored state and return only genuinely new/changed lines — not re-run the same single-blob dedup on the whole thing every time. This is real, well-scoped feature work, not a quick fix — estimate as its own milestone, not bundled into an integrity pass.

## Now — Remaining integrity fixes

- [ ] Resolve the `sovereign` (in-memory/KV) vs `fdia` standalone (Durable Object) state-storage inconsistency for `configure_policy` — pick one strategy or document why both are intentional
- [ ] Regenerate `BENCHMARK_REPORT.md` and manually verify no unpopulated template placeholders remain before republishing its headline numbers

## Next — Cross-repo FDIA consolidation

- [ ] Decide and document one canonical FDIA implementation (candidate: `packages/shared/src/fdia-core.ts`, live and highest-quality today) vs. `Delentia-OS/rct_control_plane/algorithm_kernel_41.py::algo_01_fdia` and `zk_fdia.py`
- [ ] If both TS and Python implementations must remain, add a golden-vector contract test run in CI on both, failing the build on divergence
- [ ] Retire `zk_fdia.py` from any production path (its own docstring says "educational/SDK-grade"; prover=verifier means the ZK layer adds no real trust boundary here)

## Later — Deeper integration

- [ ] v2/Pro-tier: real multi-model consensus scoring for `rct_think` via a TS reimplementation of `Delentia-OS/rct_control_plane/openrouter_client.py`'s retry/fallback/tiered routing (deferred from this MVP — adds latency, cost, and an external API-key dependency to what is otherwise a self-contained Workers-only guardrail; see `docs/RCT7_SCORING_SPEC.md` for the tradeoff discussion)
- [ ] `rct_think`'s Stage 1-6 heuristics are shallow regex/keyword-based (sentence splitting, conjunction-based clause splitting, a 4-category failure taxonomy, shared-vocabulary extraction) — real NLP (proper tokenization, a larger/configurable failure taxonomy, multi-language stopword lists) would improve fidelity without needing an LLM call
