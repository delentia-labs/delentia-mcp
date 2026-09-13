# Delentia Sovereign MCP — Roadmap

This roadmap tracks work on the live Cloudflare Workers MCP gateway
(`packages/sovereign`, `packages/fdia`, `packages/rct7`, `packages/delta`,
`packages/jitna`, `packages/shared`). It does not replace or duplicate
`Delentia-OS/ROADMAP.md` or `the private services repo`'s internal roadmaps — this
repo is a fully independent codebase with no code path connecting it to
either of those (see `TESTING_CANONICAL.md` for the verified per-tool status
this roadmap is fixing).

## Done (2026-09-13, part 4)

- [x] **`.jitna` now has a compact TOON+zlib variant** (`packet/v2-toon-zlib`), porting `Delentia-OS/rct_control_plane/toon_formatter.py`'s real TOON serializer to TS and verifying byte-for-byte cross-language compatibility empirically (both TOON text and zlib compression, both directions between Node and Python). Real per-packet measurement (`jitnaCompactSizeComparison()`) rather than a blanket claim — small packets barely benefit, larger ones with richer `M` fields shrink substantially (36% measured on a realistic example).
- [ ] Not done: zstd support (Python's v3 protocol prefers zstd when available, falling back to zlib — this port is zlib-only; Node has no built-in zstd, would need a native addon), and the compact format isn't yet the default anywhere (both v1 JSON and v2 compact coexist, caller's choice).

## Done (2026-09-13, part 3)

- [x] **RCTDB's 8-dimension schema adopted (as a data model, not a separately-hosted service)** and folded into the same Durable Object pattern as `MEEGrowthSessionDO` — new `RCTDBLogSessionDO` + 4 `buildRctdbEntryFrom*` helpers, tested against real FDIA/Delta/JITNA output, wired into `intent-loop`'s worker for real production logging. See `TESTING_CANONICAL.md`'s "RCTDB's 8-dimension schema" section for the full recommendation this implements and why the separately-hosted-service design was explicitly rejected.
- [ ] Not yet wired into `sovereign`/`fdia` workers (they'd log FDIA-only entries — real but narrower than intent-loop's full 8 dimensions; a reasonable next step, not done here). No compact encoding — entries are stored as plain JSON in the DO, same as MEE growth state.

## Done (2026-09-13, part 2)

- [x] **JITNA is now a real file format**, not just an in-memory object. `packages/shared/src/jitna-file.ts` adds `serializeJitnaPacket`/`parseJitnaPacket`/`writeJitnaFile`/`readJitnaFile`, an explicit `$jitna_format` marker resolving a real naming collision against 254 unrelated pre-existing `.jitna` files elsewhere in the repo (a different, YAML-ish agent-template format in `the private services repo`'s private-UI templates), and a SHA-256 checksum catching tampering/corruption. 8 new tests use real packets from the real `orchestrateSwarm()` tool and real disk I/O.
- [ ] Not done: promoting this beyond a "save/load one packet" format — no compact binary encoding (Python's `jitna_protocol_v3.py` already has real TOON serialization + zlib/zstd compression that could be adapted here, but wasn't in this pass), no multi-packet container/streaming format, and the `M` (memory) field stays intentionally unconstrained (`z.record(z.unknown())`) since tightening it is a schema-design decision, not a file-format one.

## Done (2026-09-13)

- [x] **MEE growth now has real persistent state**, via a new Cloudflare Durable Object (`MEEGrowthSessionDO`, in `@delentia/shared`) bound into both `sovereign` and `fdia`. `MEEGrowthTracker` moved from `packages/intent-loop` into `@delentia/shared` so all 3 TS deployments share one canonical implementation. Session scoping is explicit and documented (default = shared deployment-wide aggregate; explicit `session_id` = isolated per-caller trajectory) — a deliberate design choice made specifically to avoid the "one hardcoded global name for every caller" bug already flagged below for the other 4 pillar workers. 16 new tests (10 + 6) run the REAL DO class against real in-memory storage via a reusable fake-namespace harness, proving genuine persistence and genuine isolation, not just that the code compiles.
- [ ] Still not done: `sovereign`/`fdia`'s MEE growth uses the FDIA-score-based signal (matching Python ALGO-07's design, since these workers have no execution/verification step); `intent-loop`'s confidence-based signal remains richer but isolated to that one package. Reconciling these into one unified growth semantic (if desired at all) is a real design question, not an oversight. The Python `rct_control_plane`/`intent_compiler.py` side is still a separate runtime with its own `intent_precision` contract, unaddressed.

## Done (2026-09-12, part 5)

- [x] **Tier 1 complete**: extended RCT-7 -> intent_precision synthesis to the standalone `fdia` worker (added `@delentia/mcp-rct7` as a new dependency; reordered root `build` so `rct7` builds before `fdia`). All 3 TS deployments that expose `evaluate_fdia` (`intent-loop`, `sovereign`, `fdia`) now support real RCT-7 synthesis identically. 6 new tests.
- [x] **Tier 2 complete**: ported `mee_engine.py`'s real growth formula to TypeScript (`MEEGrowthTracker` in `packages/intent-loop`) — necessary because Cloudflare Workers cannot call the Python engine — verified byte-for-byte numerical parity against the actual Python module for an 8-step sequence. Wired `IntentLoopEngine` to step it using the `ConsensusVerifier`'s real post-execution confidence (not the FDIA score, which already has its own role), so growth now reflects "did what we produced hold up to independent scrutiny," not "did we understand the request going in." 9 new tests + a live re-run against real OpenRouter models (G: 1.0 -> 1.1 -> 1.21 across 2 real, unanimously-verified executions).

## Done (2026-09-12, part 3)

- [x] **Closed the loop between RCT-7 and FDIA.** `packages/intent-loop`'s `FDIAGatekeeper.validate()` now derives FDIA's `intent_precision` (I) from a real call to `executeRCT7()`'s `verified_alignment_score`, instead of a caller-supplied constant or an unrelated heuristic — the original design intent for this whole ecosystem (I extracted from decomposing the caller's actual intent, not handed in) implemented for the first time anywhere in the codebase. See `TESTING_CANONICAL.md`'s "RCT-7 → FDIA intent_precision synthesis" section for the exact mapping, live verification against real models, and a real performance measurement (0.0145ms/call average — the synthesis adds no meaningful latency).
- [ ] This synthesis is intent-loop-only so far. Extending it to the standalone `fdia`/`sovereign` workers (which currently take `intent_precision` as a plain request field) and to the Python `rct_control_plane`/`intent_compiler.py` side is real follow-up work, not done in this pass — each has its own calling contract that would need a deliberate compatibility decision (e.g., an optional `problem_statement` input that triggers RCT-7 synthesis when present, falling back to the explicit `intent_precision` field when absent, so existing callers aren't broken).

## Done (2026-09-12, part 2)

- [x] Consolidated Intent Loop into `packages/intent-loop` (new `@delentia/mcp-intent-loop` package, `run_intent_loop` MCP tool) from the most-developed of 4-5 diverged Python `loop_engine.py` copies found across the ecosystem on 2026-09-11. Reuses the hardened `evaluateFDIA` for its gate (no second FDIA implementation). Replaced both of the Python original's hardcoded-success stubs with real logic: `execute()` now makes real calls to real OpenRouter free-tier models, `verify()` now runs a real 3-model consensus vote. Verified end-to-end against live models, not just mocked — see `TESTING_CANONICAL.md`'s "Live intent-loop verification" section. 15 new deterministic tests + a separate live-network test script.
- [ ] Not done in this pass, tracked here: per-caller/per-session memory scoping (currently one shared in-process cache per Worker isolate — same class of gap as the global-Durable-Object issue below), Durable-Object-backed persistent memory (currently lost on isolate recycle), and actual deployment of this package (built + tested locally only).

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
