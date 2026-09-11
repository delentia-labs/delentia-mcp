# RCT-7 `verified_alignment_score` — Scoring Spec

This is the first concrete spec for how `rct_think`'s alignment score is
computed. It did not exist anywhere in the ecosystem before 2026-09-11 — the
whitepaper (`Delentia-OS/whitepapers/01_foundation/RCT_ECOSYSTEM_WHITEPAPER_TH_2026.md`
§4.1) gives one line per stage with no formula, and the "reference
implementation" it points to (`the private services repo/core/kernel/rct7_kernel_integration.py`)
is a typed skeleton with a hardcoded `intent_match_score: 0.95`. Neither
specifies an actual algorithm. This document is that algorithm.

## What this is, and what it is not

This is a **deterministic heuristic**, computed entirely inside the
Cloudflare Worker with no external LLM calls. It measures three
*structural* properties of the request — how much context was supplied, how
specific the stated problem is, and how much vocabulary the stated goal
shares with the stated problem. It does **not** understand meaning. A
request can score high while still being reasoned about incorrectly, and can
score low while being handled correctly with little context. Treat the score
as a **confidence signal about how well-grounded the input was**, not a
correctness guarantee.

A v2 option — real multi-model consensus scoring via an LLM jury (the
pattern already implemented, unused, in `Delentia-OS/rct_control_plane/openrouter_client.py`)
— would have materially higher fidelity but adds latency, cost, and an
external API-key dependency to what is otherwise a self-contained guardrail
tool. That tradeoff is deferred; see `ROADMAP.md`.

## Formula

Implemented in `packages/rct7/src/index.ts` (`computeAlignmentScore`).

```
grounding_completeness = 0.5 * has(environment_context) + 0.5 * has(target_desired_outcome)   // in [0, 1]
problem_specificity    = clamp(word_count(problem_statement) / 12, 0, 1)
lexical_alignment      = jaccard(tokens(problem_statement), tokens(target_desired_outcome))     // 0 if target_desired_outcome absent

verified_alignment_score = round4(clamp(
  0.30 * grounding_completeness +
  0.30 * problem_specificity +
  0.40 * lexical_alignment,
  0, 1
))
```

- `has(x)` — 1 if the field was supplied and non-empty after trimming, else 0.
- `word_count` — whitespace-split token count of `problem_statement`.
- `tokens(text)` — lowercased, split on non-alphanumeric (ASCII + Thai range), words of length > 2 only, deduplicated into a set.
- `jaccard(A, B) = |A ∩ B| / |A ∪ B|` (0 if both sets are empty).

Weights (0.30 / 0.30 / 0.40) favor lexical alignment slightly, since a target
that shares no vocabulary with the stated problem is the strongest single
signal that reverse reasoning may be anchored on the wrong thing.

## Worked examples

Computed directly from the shipped `computeAlignmentScore()` (verified by
running the compiled function, not hand-calculated):

| `problem_statement` | `environment_context` | `target_desired_outcome` | grounding | specificity | lexical | **score** |
|---|---|---|---|---|---|---|
| `"fix it"` | — | — | 0.0000 | 0.1667 | 0.0000 | **0.0500** |
| `"Reduce checkout API p99 latency below 200ms"` | `"Node.js, 3 replicas, Redis cache"` | `"p99 latency under 200ms sustained for 24h"` | 1.0000 | 0.5833 | 0.2727 | **0.5841** |
| `"Reduce checkout API p99 latency"` | — | `"Ship a mobile app redesign"` | 0.5000 | 0.4167 | 0.0000 | **0.2750** |

The third row shows the intended failure mode: a stated target with no
lexical relationship to the stated problem drags the score down even though
`grounding_completeness` isn't zero — this is the "target may not be
grounded in the problem as described" signal this spec exists to surface.
Row 2 also shows that a fully-grounded, on-target request still lands
mid-range (0.58) rather than near 1.0 — `problem_specificity` saturates at 12
words, so most real single-sentence requests will not score near the
ceiling; treat scores as relative/comparative, not as a pass/fail threshold
against some fixed number.

## Known limitations (stated plainly)

- Purely lexical — synonyms, paraphrases, and non-English/non-Thai phrasing beyond the tokenizer's ranges are not credited.
- `problem_specificity` rewards verbosity, not clarity — a long vague statement scores the same as a long precise one.
- No cross-request memory or actual verification against ground truth; this cannot detect hallucination in the *content* of the 7 stage outputs, only in whether the request itself was well-formed.
- All 7 stage texts besides stage 7 remain templated prose (see `packages/rct7/src/index.ts`) — this spec covers only the numeric score, not stage-by-stage content generation.

## Change log

- 2026-09-11 — Initial spec. Replaces the previous hardcoded `verified_alignment_score = 1.0`.
