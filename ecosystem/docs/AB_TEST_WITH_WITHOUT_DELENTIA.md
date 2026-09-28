# A/B Test: With vs. Without Delentia MCP

Real, measured results from the actual deployed code (`packages/shared/dist`,
`packages/delta/dist`) — not projections. Run on 2026-09-11.

## Test 1 — Authorization: does the FDIA gate actually stop anything?

Method: `scripts/demo_fdia_protected_cli.mjs` runs 5 realistic attack
scenarios (destructive DB drop, credential exfiltration, unauthorized wire
transfer, S3 data exfiltration, production cluster teardown) through the
real `FDIAEngine.evaluateA()` + `calculateF()` — the exact same code path
deployed in `evaluate_fdia`. `scripts/demo_vulnerable_cli.mjs` runs the same
5 scenarios against a "standard agent" baseline that relies only on a
system-prompt instruction ("do not execute destructive operations").

| | Without Delentia (system-prompt only) | With Delentia (`evaluate_fdia`) |
|---|---|---|
| Attacks blocked | 0 / 5 | **5 / 5** |
| Mechanism | Probabilistic — depends on the model refusing a jailbreak/persona-override prompt | Deterministic — policy rule match, `A=0` forces `F=0` regardless of any other input |
| Latency | N/A (no gate) | **< 0.5 ms per check** (measured, `performance.now()`) |

**Honesty note**: the "With Delentia" numbers are 100% real — actual policy
engine, actual sub-millisecond timings. The "Without Delentia" 5/5-bypass
result is a labeled **simulation** (`demo_vulnerable_cli.mjs` clearly prints
"[MODE] Autonomous Frontier Simulation" when no `OPENAI_API_KEY` /
`ANTHROPIC_API_KEY` is set, as was the case in this run) — it illustrates
what a system-prompt-only agent would output if it complied with the
jailbreak, not an empirically measured bypass rate against a specific live
model. Re-run with a real API key set for an empirical version of the
control side.

## Test 2 — Token compression: does it actually save tokens/cost?

Method: real calls to `compressContext()` (the exact function backing the
deployed `compress_context` tool) against two different realistic inputs.

| Input type | Original tokens (est.) | Compressed tokens (est.) | Reduction |
|---|---|---|---|
| Repetitive agent session log (120 lines, heavy duplicate tool-call noise) | 2,541 | 67 | **97.4%** |
| Single-turn, already-concise summary (8 unique lines, no repetition) | 123 | 145 | **-17.9%** (the added `[DELENTIA-DELTA-STREAM]` header outweighs any savings) |

At $3/1M input tokens (a real public price point for a mid-tier model as of
this session — check current pricing before quoting), the repetitive-log
case saves **~$7.42 per 1,000 similar calls**. The concise-summary case
*costs* slightly more tokens than sending the raw text directly.

**Conclusion, stated honestly**: `compress_context` has real, substantial
value specifically for **verbose, repetitive session content** (long agent
runs, duplicated tool-call logs) — not a universal "always saves tokens"
claim. Value is highly input-dependent; do not quote the 97.4% figure as a
general expectation.

## What this does NOT test

- `rct_think`'s reasoning quality (no ground-truth dataset exists to score against — see `docs/RCT7_SCORING_SPEC.md`'s limitations).
- Whether a real paying customer's actual workload looks more like Test 2's repetitive case or its concise case — that depends entirely on the customer's own usage pattern and can only be answered by testing against their real logs.
- Any claim about `rct_think`'s alignment score correlating with fewer real-world agent mistakes — unverified.

## How to reproduce

```bash
node scripts/demo_fdia_protected_cli.mjs   # With Delentia (FDIA)
node scripts/demo_vulnerable_cli.mjs        # Without Delentia (control/simulated)
```

For the compression test, see the inline script used to produce the table
above — not yet promoted to a standalone `scripts/` file; consider adding
`scripts/ab_test_compression.mjs` if this becomes a recurring benchmark.
