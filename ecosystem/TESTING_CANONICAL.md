# Delentia Sovereign MCP — Testing & Status Canonical

This document is the **single source of truth** for what this repo's deployed
MCP tools actually do. If README.md, BENCHMARK_REPORT.md, or any blog/marketing
copy disagrees with this file, **this file wins** — mirrors the governance
pattern already used in `Delentia-OS/docs/testing/TESTING_CANONICAL.md`.

**Last verified:** 2026-09-12 (direct source-code read + real test run, not a narrative claim)

## Per-tool implementation status

| Tool | Status | Evidence |
|---|---|---|
| `evaluate_fdia` | Real computation. `F = (D^I) * A` computed from actual input; `A` dynamically evaluated via policy wildcard rules; SHA-256 audit digest computed from real request data. Fails closed (returns `SECURITY_POLICY_VIOLATION`, not a NaN-driven false `AUTHORIZED`) on non-finite/negative `data_quality`/`intent_precision`. **2026-09-12**: found and fixed two real rule-matching bugs via adversarial hypothesis testing — see "Security fixes found via hypothesis testing" below. | `packages/shared/src/fdia-core.ts` |
| `configure_policy` | Real state mutation. Full-replace (not merge) semantics; no schema validation before reporting success in the `sovereign` worker (unresolved — tracked in `ROADMAP.md`). `sovereign` worker stores policy in-memory (isolate-scoped, eventually-consistent via optional KV write); the standalone `fdia` worker stores it in a Durable Object (more durable). | `packages/sovereign/src/worker.ts`, `packages/fdia/src/worker.ts` |
| `rct_think` | **Real, deterministic heuristics across all 7 stages.** `verified_alignment_score` is computed from grounding completeness, problem specificity, and lexical overlap. Stages 1-6 now also compute real, input-dependent output: sentence splitting (Stage 1), context/problem lexical overlap (Stage 2), conjunction-based sub-task splitting (Stage 3), keyword-taxonomy failure detection (Stage 4), shared-vocabulary intent extraction (Stage 5), and a blueprint built from Stages 3+5 (Stage 6). Explicitly NOT semantic understanding (no LLM call) — see `docs/RCT7_SCORING_SPEC.md` for the full breakdown and documented limitations. | `packages/rct7/src/index.ts`, `docs/RCT7_SCORING_SPEC.md` |
| `compress_context` | Real dedup + optional keyword filter; SHA-256 hash of real output. `reduction_percentage` is now the **real, unclamped computed value** — it can be negative on already-short/unique input or exceed the old 91.5% figure on highly repetitive input. The 74.2%-91.5% range was a specific benchmark result, not a guarantee, and is no longer enforced. | `packages/delta/src/index.ts` |
| `orchestrate_swarm` | Real objective→pillar keyword routing and delta math. `assigned_pillars` now tags each pillar `role: "primary"` (the one actually routed to, with an objective-specific subtask) or `role: "support"` (standing role only, explicitly labeled as not engaged for this objective) — no longer 4 identical objective-specific claims. `expected_vram_switch_ms` remains a static per-pillar design target (no LoRA runtime exists in this codebase) but is now clearly documented as such. | `packages/jitna/src/index.ts`, `packages/shared/src/jitna-types.ts` |
| `run_intent_loop` (new, 2026-09-12) | Real 5-stage pipeline consolidated from the most-developed of 4-5 diverged Python `loop_engine.py` copies found across the ecosystem. Gate reuses the hardened `evaluateFDIA`; memory is real Jaccard-similarity caching; **execute and verify now make real HTTP calls to real OpenRouter free-tier models** — replacing the Python original's two hardcoded-success stubs (`await sleep(0.1)` + fixed "Processed: {intent}" string; `votes = [True, True, True]` always-pass consensus). Verified against a live model end-to-end (see "Live intent-loop verification" below), not just unit-tested against a mock. **2026-09-12, later same day**: the gate's `intent_precision` (FDIA's `I`) is now synthesized from a real call to `executeRCT7()` instead of a standalone word-count heuristic — the first place anywhere in the ecosystem where RCT-7's actual decomposition output feeds FDIA's `I` parameter. See "RCT-7 → FDIA intent_precision synthesis" below. | `packages/intent-loop/src/index.ts` |

## Test suite

107 tests across 7 files, all passing as of 2026-09-13 (`npm run test:all`):
`tests/ecosystem.test.mjs` (9), `tests/deep-ecosystem.test.mjs` (15),
`tests/test_fdia_policy_engine.mjs` (14), `tests/fdia_deep_hypothesis.test.mjs`
(24), `tests/intent_loop.test.mjs` (24 — deterministic, offline suite for the
intent-loop package, using an injected fake `fetch` so CI never depends on a
live network call or API key; includes the FDIA<->RCT-7 synthesis and MEE
growth-tracker regression tests), `tests/sovereign_rct7_synthesis.test.mjs`
(10) and `tests/fdia_worker_rct7_synthesis.test.mjs` (11) — both call their
respective worker's real `fetch` handler directly, not a mock, and (as of
2026-09-13) also run the real `MEEGrowthSessionDO` Durable Object class
against real in-memory storage via `tests/helpers/fake-durable-object.mjs`.
A SEPARATE, non-CI script, `tests/intent_loop_live.test.mjs` (run via
`npm run test:intent-loop:live` with `OPENROUTER_API_KEY` set), makes real
calls to real OpenRouter free-tier models — see "Live intent-loop
verification" below for its actual output. Includes explicit regression tests
for every behavior change above (real RCT-7 score varies + is deterministic,
all 7 RCT-7 stages produce different output on different input including a
specific "Node.js must not be split on its period" regression, FDIA fails
closed on malformed input, Delta reduction is unclamped in both directions,
JITNA primary/support role split, and the two FDIA rule-matching fixes below).
CI (`.github/workflows/ci.yml`) now runs build + typecheck + this full suite
on every PR and push to `main` — previously this repo had no CI at all.

## Security fixes found via hypothesis testing (2026-09-12)

Requested explicitly: stress-test FDIA's matching *logic* with adversarial
inputs, not just its documented scenarios. Two real bugs were found and
fixed in `packages/shared/src/fdia-core.ts`'s `FDIAEngine.evaluateA()` and
`matchesWildcard()`; full detail and reproduction cases are in
`tests/fdia_deep_hypothesis.test.mjs` (tests `H3a`/`H3b` and `H3e`):

1. **First-match-wins rule resolution let a broad ALLOW rule shadow a
   narrower BLOCK rule when both matched the same action name.** Example:
   `purge_telemetry_cache` matches both the bundled policy's
   `RULE-DATABASE-DESTRUCTIVE-BLOCK` (`purge_*`) and `RULE-READONLY-ALLOW`
   (`*telemetry*`); before the fix, whichever rule happened to be listed
   first in the policy's `rules` array won outright, with no severity
   consideration. This wasn't only a bundled-policy ordering accident — any
   enterprise customer authoring their own `custom_policy` with an ALLOW
   rule listed before a BLOCK rule would hit the identical bypass. Fixed by
   ranking ALL matching rules by severity (`REQUIRE_HUMAN_SIGNATURE` >
   `CONDITIONAL` > `ALLOW`) and always resolving to the most restrictive
   match, regardless of array position. Also reordered the bundled policy's
   `rules` array (`packages/shared/src/default-policy.ts`) most-restrictive-first
   for human readability, though this is no longer load-bearing.
2. **Leading/trailing whitespace on the caller-supplied `action_name`
   defeated anchored (`pattern*` or `*pattern`, no wildcard) rule matching
   while leaving unanchored (`*pattern*`) matching unaffected.** Example:
   `"  purge_telemetry_cache  "` (padded) no longer matched the anchored
   `purge_*` block pattern (the string now starts with whitespace, not
   `purge_`), but still matched the unanchored `*telemetry*` allow pattern
   — so padding moved the request from "correctly blocked" to "explicitly
   authorized" instead of even falling through to the safe zero-trust
   default. Fixed by trimming both the action name and each rule pattern
   before comparison in `matchesWildcard()`.

**Documented, intentionally NOT fixed, structural limitations** (see
`H3c`/`H3f`/`H3g` in the same test file):
- `action_name` is a caller-self-reported string label. FDIA pattern-matches
  the label against policy; it has no way to verify the label actually
  describes what the calling application will execute. A caller that
  mislabels a destructive operation as e.g. `read_something` is authorized
  under the read-only allow rule — this is a trust-boundary property of any
  string-based intent classifier, not a bug this engine can fix. The real
  mitigation is architectural: the calling application must derive
  `action_name` from the actual function/tool being invoked, never let an
  LLM choose it freely.
- A zero-width space (or other non-whitespace invisible Unicode) inserted
  mid-keyword still defeats a specific pattern match (e.g. `drop_*` no
  longer matches `dr​op_table`). Under the bundled zero-trust default policy
  this still resolves safely (falls to `ZERO_TRUST_FALLBACK`, still denied)
  — but a policy configured with `default_fallback_A: 1` (permissive mode,
  which `validatePolicy()` already emits a warning against) would NOT be
  protected against this specific evasion. Full Unicode normalization was
  judged out of scope for this pass; flagged here for anyone hardening this
  further.

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

## RCT-7 → FDIA intent_precision synthesis (2026-09-12)

Background: the whole point of FDIA's `I` (Intent Precision) parameter, per
the project's original design intent, was to be a value *extracted from*
decomposing the caller's actual intent — not a constant the caller hands in.
Before this change, every real implementation of FDIA anywhere in the
ecosystem (this repo's `evaluate_fdia`, the Python `core/fdia/fdia.py`
scorer, `algorithm_kernel_41.py`'s `algo_01_fdia`) took `I` as a plain
caller-supplied number. RCT-7 (`rct_think`/`executeRCT7`) — the component
that actually performs real, tested, input-dependent intent decomposition —
was never wired to produce it.

**What changed**: `FDIAGatekeeper.validate()` in `packages/intent-loop/src/index.ts`
now calls the real `executeRCT7()` from `@delentia/mcp-rct7` on every intent,
and derives `intent_precision` from its real `verified_alignment_score`
(0-1, itself a real computation from grounding completeness + problem
specificity + lexical overlap — see `docs/RCT7_SCORING_SPEC.md`):

```
I = 0.5 + verified_alignment_score * 1.5    // range [0.5, 2.0]
```

`0.5` is FDIA's own schema floor; `2.0` is a deliberate design ceiling, not
derived from anything else. Semantics: a vague, ungrounded intent (low
alignment) gets the most lenient exponent — `F=D^I` shrinks slower for
imprecise data, matching "we don't understand this well enough to be
strict about data quality either." A precisely-grounded intent (high
alignment) gets a stricter exponent — weak supporting data is punished
harder, matching "we understand exactly what's being asked, so weak data
is less excusable." `data_quality` (D) is deliberately left as a separate,
independent heuristic — RCT-7 measures how well-specified the *intent* is,
not how sufficient the *data backing the action* is; conflating the two
would blur what each FDIA parameter means.

**Verified real, not just wired**:
- Offline: `tests/intent_loop.test.mjs` proves the derived `I` is
  input-dependent (a 2-word vague intent scores a real, lower alignment
  than a grounded, specific one), deterministic (same input -> same score,
  every call), and stays within the documented [0.5, 2.0] range.
- Live, against real OpenRouter models: a destructive intent's rejection
  message itself now includes the real numbers —
  `[RCT-7 alignment=0.125, derived I=0.6875]` — visible directly in
  `TestCLICompile`-style output, not just internal state.
- **Performance**: measured 3,000 real `validate()` calls (RCT-7 execution +
  FDIA evaluation, no network) at an average of **0.0145ms per call**. The
  new synthesis step adds effectively zero latency — all real-world latency
  observed in the live end-to-end test (~3.7-4.1s) came entirely from the
  2 actual network round trips (specialist execute + 3-model consensus
  verify), not from RCT-7 or FDIA.

**Extended to the `sovereign` worker (2026-09-12, same day)**: `sovereign`
is the one production deployment that already bundles both `evaluate_fdia`
and `executeRCT7` in the same Worker (it imports RCT-7 directly via a
relative dist path) — so the identical synthesis was wired into its
`evaluate_fdia` handler with **zero new dependencies**. Fully backward
compatible by construction: `intent_precision`/its 1.0 default behave
byte-identically to before when `problem_statement` is omitted; supplying
it triggers real RCT-7 synthesis and adds an `rct7_synthesis` field to the
response. `packages/sovereign` gained a proper `build` script for the
first time in this change (it previously relied on `wrangler deploy`'s
on-the-fly bundling and had no `tsc` build step of its own, which also
meant it was untestable outside a full Wrangler invocation) — its
`tsconfig.json` now extends the shared root config like every sibling
package, and typechecks clean under `strict: true` with no changes needed
to `worker.ts` itself. 5 new tests in `tests/sovereign_rct7_synthesis.test.mjs`
call the worker's real `fetch` handler directly (not a mock) covering both
backward-compatibility cases and the new synthesis path, including that a
destructive `action_name` is still blocked by its own independent gate
regardless of RCT-7's score.

**Extended to the standalone `fdia` worker (2026-09-12, Tier 1 complete)**:
unlike `sovereign`, this worker did not already import RCT-7 —
`@delentia/mcp-rct7` was added as a genuinely new dependency, and the root
`build` script was reordered (`build:rct7` now runs before `build:fdia`)
since the compiled output now depends on it. Same optional
`problem_statement` contract, same backward-compatibility guarantee,
verified with 6 new tests calling the worker's real `fetch` handler
directly — including one that omits the `FDIA_SESSION_DO` binding entirely
to prove the worker's own try/catch fallback around its Durable Object
calls is exercised for real (this is what a fresh deployment's very first
request looks like, before any session has ever been created). All 3 TS
deployments that expose `evaluate_fdia` (`intent-loop`, `sovereign`, `fdia`)
now support the identical RCT-7 synthesis contract.

**Known limitation, disclosed rather than hidden**: the `rct7`/`delta`/`jitna`
standalone deployments don't expose `evaluate_fdia` at all, so there is
nothing to synthesize into there. The Python `rct_control_plane` side
(`intent_compiler.py` + its own FDIA scorer) is a separate runtime entirely
and still takes `intent_precision` as a plain field — porting this
synthesis there needs its own design, not a copy of the TS approach.

## MEE growth now driven by the ConsensusVerifier's real confidence (2026-09-12, Tier 2)

Background: MEE (`Delentia-OS/rct_control_plane/mee_engine.py`) was found
orphaned earlier this session, then wired into `algorithm_kernel_41.py`'s
ALGO-07 slot using each pipeline run's FDIA score as its growth signal.
That signal answers "how well did we understand the intent going in" —
useful, but the SAME question FDIA's `I` already answers. A genuinely
different, complementary signal exists in `packages/intent-loop`'s
`ConsensusVerifier`: real post-execution agreement from independent models
answering "did what we actually produced hold up." Cloudflare Workers has
no Python runtime and no path to call `mee_engine.py` directly, so this
is a from-scratch **TypeScript port of the identical formula and
constants** (`G(t+1) = G(t) x (1+MΔ) x R_t`, same `M=0.1`,
`RESILIENCE_PENALTY=0.02`, `RESILIENCE_RECOVERY=0.005`, `G_FLOOR=0.1`,
`G_CAP=1000`) — `MEEGrowthTracker` in `packages/intent-loop/src/index.ts`.

**Verified numerical parity against the real Python module**: ran an
identical 8-step sequence of deltas/violations through both
`MEEGrowthTracker.step()` and the actual `MEESession.step()` from
`mee_engine.py`. Every single step's `g_after` and `resilience` matched to
6 decimal places (not just the final value) — e.g. step 4:
TS `g_after=0.906985, resilience=0.9650` vs Python
`g_after=0.906985, resilience=0.9650`, identically, all 8 steps. This is
locked in as a permanent regression test in `tests/intent_loop.test.mjs`.

**Wiring**: `IntentLoopEngine` steps the tracker with
`confidenceToGrowthDelta(verification.confidence)` (linear map:
confidence 1.0 -> delta +1, confidence 0.0 -> delta -1, confidence 0.5 ->
delta 0) whenever real execution was attempted:
- A **successful completion** steps growth positively, `governance_violation: false`.
- A **failed consensus** (verification didn't pass) steps growth negatively, `governance_violation: true` — resilience degrades, exactly matching `mee_engine.py`'s semantics for a governance violation.
- **Every candidate specialist model failing** (no verification ever ran) still steps growth, with a fixed `delta: -1` and `governance_violation: true` — a real infrastructure-quality signal, not silently skipped.
- A **cache hit** does NOT step growth — no new execution happened, so there is no new evidence of quality either way.
- An **FDIA gate rejection** does NOT step growth — a pure security block is a different kind of event than an execution-quality signal, and conflating the two would make the growth metric mean two different things depending on why a request failed.

**Verified real, live**: re-ran `tests/intent_loop_live.test.mjs` against
real OpenRouter models. Across 4 real requests (1 destructive rejection, 1
fresh execution, 1 cache-hit repeat, 1 second fresh execution routed to a
different specialist role), `mee_growth.steps` correctly ended at exactly
**2** (only the 2 genuinely fresh executions, both with real unanimous 3/3
consensus), and `G` genuinely grew **1.0 -> 1.1 -> 1.21** across those 2
real steps — not a fixed or simulated trajectory.

9 new deterministic tests in `tests/intent_loop.test.mjs` cover the formula
parity, the floor/cap bounds under sustained violations, the
confidence-to-delta mapping, and each of the 5 wiring cases above
individually (success grows it, failed verification shrinks it, all-models-failing
still steps it, cache hit doesn't step it, gate rejection doesn't step it).

**Known limitation, disclosed rather than hidden**: this confidence-driven
growth signal exists only in `packages/intent-loop`. `sovereign` and `fdia`
don't run a multi-step orchestration loop with a memory layer to attach
persistent growth state to — see the next section for how they got a
different, complementary growth signal instead.

## MEE growth given real persistent state via Cloudflare Durable Objects (2026-09-13)

`MEEGrowthTracker`/`MEEStepRecord`/`confidenceToGrowthDelta` moved from
`packages/intent-loop` into `@delentia/shared` (`packages/shared/src/mee-growth.ts`)
— same anti-duplication reasoning already applied to FDIA itself: one
canonical formula, not a third reimplementation. `packages/intent-loop`'s
behavior is unchanged (imports it from `@delentia/shared` now; same 24
tests still pass).

**New: `MEEGrowthSessionDO`** (`packages/shared/src/mee-session-do.ts`), a
real Cloudflare Durable Object giving MEE growth state genuine persistent
storage, bound into both `sovereign` and `fdia` as `MEE_SESSION_DO`.
Session scoping is a **deliberate, documented** decision: omitting
`session_id` resolves to a shared `"default"` aggregate representing the
deployment's overall growth trend (matching `mee_engine.py`'s original
single-session design intent); passing an explicit `session_id` gets an
isolated per-caller/per-agent trajectory instead. This was written
specifically to avoid repeating the "one hardcoded global name for every
caller" bug already documented above for the other 4 pillar workers'
Durable Objects (the one with the real `configure_policy`-sharing security
implication for `fdia`) — here the choice is explicit, not accidental, and
carries no security consequence either way since growth is a read-mostly,
additive metric, not an authorization decision.

**Growth signal for `sovereign`/`fdia`**: these two workers have no
execution or verification pipeline of their own (unlike `intent-loop`) —
`evaluate_fdia` is a bare authorization gate. So the growth signal here is
`delta = future_score - 0.5`, `governance_violation = !authorized` — the
same design already used in `Delentia-OS/rct_control_plane/algorithm_kernel_41.py`'s
ALGO-07 wiring for exactly this kind of gate-only signal. This is
deliberately a *different* signal than `intent-loop`'s confidence-based one
(that answers "did what we produced hold up to scrutiny"; this answers "how
confidently is the gate authorizing over time") — not an inconsistency, two
different deployment shapes with two different available signals.

**Verified against the real DO class, not a mock**:
`tests/helpers/fake-durable-object.mjs` runs the actual `MEEGrowthSessionDO`
constructor and its actual `fetch()` handler, swapping out only the
underlying `storage.get/put` persistence layer (Cloudflare's own
infrastructure) for a plain in-memory `Map` — the only piece Wrangler
itself would otherwise have to provide. 10 new tests in
`tests/sovereign_rct7_synthesis.test.mjs` and 6 in
`tests/fdia_worker_rct7_synthesis.test.mjs` prove, for real: growth
persists across calls to the same session (`g_before` of call 2 equals
`g_after` of call 1 — not reset per request); a distinct `session_id`
starts fresh at G=1.0, fully isolated from the default session's state; an
unauthorized result degrades resilience by exactly the documented 0.02
penalty; and the whole feature is silently, gracefully absent when no
`MEE_SESSION_DO` binding exists (backward compatible with every existing
caller).

**Known limitation, disclosed rather than hidden**: `sovereign`/`fdia`'s
growth signal (FDIA-score-based) and `intent-loop`'s (confidence-based)
are not unified into one semantic — reconciling them, if ever desired, is
a real design question flagged in `ROADMAP.md`, not an oversight.

## Live intent-loop verification (2026-09-12, real OpenRouter free-tier models)

Run via `OPENROUTER_API_KEY=... npm run test:intent-loop:live` — full output
saved in this session's transcript, summarized here:

1. **Legitimate intent, full real pipeline**: `"Explain in one sentence why
   the sky appears blue."` → real FDIA gate pass (score 0.625) → real cache
   miss → real call to `nex-agi/nex-n2.5-pro:free` returned a correct,
   coherent scientific explanation (Rayleigh scattering, in substance) → 3
   independent real models asked to vote; 1 hit its token budget and
   contributed no vote (treated as a real non-answer, not counted either
   way), the other 2 both answered YES → confidence 1.0, verification
   passed, result committed to memory. Total latency 3,675ms (real network
   round trips).
2. **Identical repeat intent**: hit the real in-process cache — 1ms latency
   (vs. 3,675ms), `cache_hit: true`. This is the first time this session
   the "warm recall, system gets faster over time" claim from the original
   Python design has actually been demonstrated to be true rather than
   simulated.
3. **Destructive intent** (`"drop the production database table"`): rejected
   by the real FDIA gate, 0ms latency, zero network calls made — confirms
   the gate genuinely runs BEFORE any model is touched, not just in the
   deterministic offline test suite.
4. **Different intent, different real routing**: `"Write one line of Python
   code that reverses a list."` → keyword-routed to the `code` role → real
   call to `cohere/north-mini-code:free` → returned a correct one-liner
   (`reversed_list = my_list[::-1]`) → unanimous real 3/3 verification.

**Two real bugs found and fixed while getting this to actually work** (both
in code newly written for this pass, not the Python original):
- The action-name mapping from free-text intent to an FDIA `action_name`
  originally prefixed destructive intents with `"write_"` (e.g. `"drop the
  production database table"` → `"write_drop the production database
  table"`), which matched FDIA's permissive CONDITIONAL file-write rule
  instead of its DATABASE-DESTRUCTIVE-BLOCK rule — the destructive intent
  was silently `AUTHORIZED`. Fixed by detecting the actual destructive verb
  and using it as the prefix, so it lands on the real block rule. Caught by
  manual testing before this ever reached the committed test suite; now
  covered by a regression test in `tests/intent_loop.test.mjs`.
- The consensus verifier's model calls used `max_tokens: 20` — several
  free-tier OpenRouter models are reasoning models that consume their whole
  token budget on hidden "thinking" tokens before any visible answer, so
  the first live run got `finish_reason: length` with empty content from
  2 of 3 verifier models on every single call, making verification
  effectively unusable. Fixed by raising the budget to 250 and parsing the
  LAST yes/no token in the reply (reasoning models often restate both words
  while thinking) instead of checking for bare presence of "yes".

**Known, disclosed limitation NOT fixed in this pass**: `MemoryLayer`'s
cache is an in-process `Map`, scoped to one Worker isolate — it does not
survive an isolate recycle or span multiple isolates once deployed. This is
the same class of gap already tracked in ROADMAP.md's Delta Engine section
for the other 4 pillar workers' global-Durable-Object pattern. This package
has not been deployed to Cloudflare Workers as of 2026-09-12 (built and
tested locally only — `deploy:intent-loop` exists in package.json but is
deliberately excluded from `deploy:all` until this is decided).

## Known false/unverifiable claims elsewhere in this repo (not yet fixed)

- `BENCHMARK_REPORT.md` (dated 2026-09-08) labels itself "100% VERIFIED & VALIDATED ACROSS ALL 4 PILLARS" but contains literal unpopulated template placeholders (e.g. `"undefined% (undefined/19 attacks successfully neutralized)"`) — the report generator did not finish substituting its own variables. Do not cite this report's headline numbers until it is regenerated and manually spot-checked.
- The FDIA equation `F = (D^I) * A` is implemented independently in at least 3 places across this ecosystem (`fdia-core.ts` here, plus `algorithm_kernel_41.py` and `zk_fdia.py` in `Delentia-OS`), with no shared source of truth or contract test between them. Treat any cross-repo FDIA claim as unverified until that contract test exists.

## Why this file exists

This repo had no `ROADMAP.md`, `CHANGELOG.md`, or canonical status doc before
2026-09-11, unlike `Delentia-OS` which already has this governance pattern
(`docs/testing/TESTING_CANONICAL.md`, `docs/release/PUBLIC_RELEASE_PROVENANCE.md`).
See `ROADMAP.md` for planned fixes to the items still flagged above, and
`CHANGELOG.md` for the full change history.
