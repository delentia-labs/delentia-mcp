# Measured results and their limits

This page lists only what was measured, how, and what the measurement does **not** show. Earlier versions of this page carried a four-pillar table ("100% block rate", "0.0% hallucination drift", "94.7% bypass rate", "91.5%–99.4% compression"). Those figures were withdrawn on 2026-09-27 and are no longer repeated here; the reasons are in the "Withdrawn figures" section. The old text stays in the git history.

**Repository:** [delentia-mcp](https://github.com/delentia-labs/delentia-mcp) (server source in [`ecosystem/`](ecosystem/)). Reproduction commands are given per result. Nothing here has been checked by an independent party.

## 1. Hosted tools: response time and formula agreement

Method: read-only calls against the deployed Workers, repeated, from one machine on 2026-10-16. The script is a maintainer's local file and is not in this repository, so this result cannot be reproduced from here.

| Call | p50 | p95 |
|---|---|---|
| `tools/list` | 14 ms | 20 ms |
| `evaluate_fdia` | 50 ms | 58 ms |
| `compress_context` | 19 ms | 31 ms |

The deployed `F = D^I × A` returned the same number as the reference implementation in 8 of 8 probes.

Limits: one client location, a small number of calls, no load test, no uptime history. The free sandbox quota (50 calls per day per IP) is counted in the Worker's memory, so it is approximate. Latency from your location will differ.

## 2. What the FDIA gate blocks, and what it does not

The gate evaluates the declared `action_name` and the numbers you pass (data quality D, intent precision I, and an owner decision A) against a policy. In the 19-vector benchmark (`ecosystem/tests/benchmark_*.mjs`) 19 of 19 destructive actions that were declared honestly were blocked. Unregistered actions are denied by default.

Limits: the attack prompt text is **not** what the gate reads in that benchmark, so the result says "honestly declared destructive actions are blocked", not "prompt injection is detected". An agent that mislabels an action is outside what this measures. The unprotected-model comparison that used to accompany this result was never run (see below).

Contract check: the TypeScript and Python implementations agree on 422 shared vectors (`contracts/fdia_vectors.v1.json` in the Delentia-OS repository). Three out-of-range clamping differences remain.

## 3. Context compression on real text

Method: `compress_context` run on real code, build and test logs and documentation, token counts from a real tokenizer; questions asked about the compressed text. Full method and data: `ecosystem/benchmarks/compression-real/REPORT.md`.

| Mode | Tokens removed | Answer line kept |
|---|---|---|
| aggressive | about 70–75% | 100% of questions phrased in the source's own words; about 60% of paraphrased questions |
| default | about 6–12% | – |

Limits: the figure depends strongly on how repetitive the input is. A synthetic input of ten identical lines repeated thousands of times removes about 99%, which says nothing about real logs. The original is kept so that `expand_context` can return it.

## 4. Delentia Guard: hostile tool calls

Method: 43 calls that look routine but are harmful (reading `.env`, `id_rsa` or credentials, writing a CI workflow or a shell start-up file, fetching to an arbitrary address, text that only mentions a secret file) were sent through the shipped `coding-agent` policy; each was judged by what a careful reviewer would want (`ecosystem/tests/guard_hardening_r91.test.mjs`).

| | Judged as a careful reviewer wants |
|---|---|
| Before the Round 91 changes | 30 of 43 |
| After | 41 of 43 |

The two remaining differences are file names that really differ from the patterns, and `fetch` to arbitrary hosts, which needs the opt-in `--allow-hosts` list. Decision cost is about 10 µs.

Limits: the 43 calls were written by the developers after they knew the rules, so this is a regression guard and not an independent test. Guard is a policy filter in a separate process; it is not a sandbox.

## 5. Not measured

- Whether a model that uses these tools makes fewer mistakes than one that does not. No controlled comparison with a capable model has been run.
- Any hallucination rate. The earlier "0.0% hallucination drift" was a score the benchmark computed from its own checklist, not a rate of wrong answers.
- Behaviour under load, availability over time, or any service level.
- Anything about real users. There are none we can point to yet; npm download counts are mostly automatic fetches and do not show use.

## Withdrawn figures

| Figure | Why it was withdrawn |
|---|---|
| "94.7% bypass rate" of an unprotected model | No model was run; the benchmark hard-coded the flag on 18 of 19 vectors. |
| "100% block rate" as a security claim | True only for honestly declared actions (section 2). |
| "91.5%–99.4% compression" | Came from a synthetic repeated-line input. |
| "0.0% hallucination drift", "100% invariant compliance" | Self-scored by the benchmark's own checklist. |
| "ZK-FDIA", "zero-knowledge" | The code is a hash commitment, not a zero-knowledge proof. |

`demo/delentia_showcase.html` is a scripted animation for illustration. Its numbers are not measurements.

If you find a number here that you cannot reproduce, open an issue. We would rather correct it than keep it.
