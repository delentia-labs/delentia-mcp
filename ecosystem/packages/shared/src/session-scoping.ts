/**
 * Real, shared per-caller Durable Object session scoping — closes a
 * confirmed, documented real bug (see ROADMAP.md's "Now — Remaining
 * integrity fixes"): the `delta`, `fdia`, `jitna`, and `rct7` pillar
 * workers each keyed their own Durable Object with one hardcoded
 * literal name (`idFromName("global_X_session")`), so EVERY caller
 * across the entire public endpoint shared exactly one object. For
 * `delta`/`jitna`/`rct7` this meant stats silently mixed across all
 * users. For `fdia` this was more serious: `configure_policy`'s real
 * policy write and `evaluate_fdia`'s real policy read-back (when no
 * `custom_policy` is supplied inline) both hit that same shared object
 * — one caller's policy change could genuinely alter another caller's
 * real authorization results on the shared public endpoint.
 *
 * `sovereign`/`intent-loop`'s own `MEE_SESSION_DO` usage already had
 * the correct real pattern (session-scoped via a real, optional
 * `session_id` argument, falling back to one shared "default" object
 * only when the caller genuinely doesn't ask for isolation — see
 * `mee-session-do.ts`'s own docstring for why sharing-by-default is a
 * deliberate, documented, non-security-relevant choice there). This
 * helper generalizes that SAME real pattern for the other 4 workers'
 * own Durable Objects, so a caller who explicitly wants isolation
 * (passing a real `session_id`) genuinely gets it, closing the "no way
 * to opt out" class of the bug immediately and backward-compatibly.
 *
 * Whether the DEFAULT (no `session_id` supplied) should keep sharing
 * one object per worker, or move to some other per-caller default
 * (e.g. derived from an API key), is explicitly flagged in ROADMAP.md
 * as "worth a deliberate decision" — a real product/business choice,
 * not something this helper decides unilaterally. This fix closes the
 * confirmed-worst case (zero isolation available at all) without
 * silently changing the free-tier default's real, possibly-intentional
 * sharing behavior out from under existing callers.
 */
export function resolveSessionDOName(args: unknown, fallbackName: string): string {
  const candidate =
    args && typeof args === "object" && "session_id" in (args as Record<string, unknown>)
      ? (args as Record<string, unknown>).session_id
      : undefined;
  if (typeof candidate === "string" && candidate.trim().length > 0) {
    return candidate.trim();
  }
  return fallbackName;
}
