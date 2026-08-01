/**
 * Issue #2085 — request-scoped ranking-flag override.
 *
 * Ranking flags live in the `sps-app-<env>` task-def env and are read as
 * `process.env.X`, which is frozen for the container's life. Answering "does
 * this lever help?" therefore costs a PR + two deploys (~30-40 min), and the
 * two captures are separated by a container restart — contract rule O5's
 * confound. This makes an A/B two curls against the SAME process, same index,
 * same second.
 *
 * Shape: `?flags=NAME:value,NAME2:value2` on `/api/search`. The value is
 * installed in an AsyncLocalStorage scope for the life of the request; the
 * allowlisted resolvers in `search-flags.ts` consult it before `process.env`.
 *
 * Four properties that are load-bearing, not incidental:
 *
 *  1. STAGING ONLY. `SPS_ENV === "staging"` (wired in cdk/lib/app-stack.ts).
 *     On prod the param is inert — parsed to nothing, never echoed — so a
 *     behaviour override is not a public escalation surface.
 *  2. ALLOWLIST IS RANKING-ONLY. Never authz, export, impersonation or
 *     visibility. Enforced twice over: `OVERRIDABLE_FLAGS` rejects an unknown
 *     name at parse time, AND a resolver that does not call `ovr()` cannot be
 *     overridden even if a name leaks into the list.
 *  3. CACHE-SAFE BY CONSTRUCTION. The `/api/search*` behaviour keys its cache
 *     on `CacheQueryStringBehavior.all()` (cdk/lib/edge-stack.ts), so `?flags=`
 *     is in the cache key AND forwarded. This is why the override MUST be a
 *     query string and MUST NOT be a request header: that same behaviour sets
 *     `CacheHeaderBehavior.none()` while the origin-request policy forwards all
 *     viewer headers — a header override would be forwarded-but-unkeyed, which
 *     is exactly the cache-poisoning class fixed at source in #1935.
 *  4. SELF-IDENTIFYING. An overridden response carries `flagOverride` in its
 *     JSON body, so a capture can never be mistaken for default behaviour.
 *
 * Values are constrained to a short opaque charset: the edge WAF runs
 * KnownBadInputs/SQLi in enforce mode and will block quoted or path-ish values.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Ranking levers only. Each name here MUST also be wired into its resolver in
 * `lib/api/search-flags.ts` via `ovr("<NAME>") ?? process.env.<NAME>` — a name
 * listed but not wired is accepted and then silently ignored, the "declared but
 * never connected" failure. `tests/unit/flag-override.test.ts` asserts every
 * entry actually moves its resolver, so that drift fails CI.
 *
 * To add a lever: one line here, one `ovr(…) ??` in its resolver, one row in
 * the test's RESOLVERS map. Deliberately not the full ~25 RANKING flags —
 * these are the levers the queued experiments (#2068, #2084, O8) actually need.
 */
export const OVERRIDABLE_FLAGS = [
  "SEARCH_AREA_BOOST_TOP_N",
  "SEARCH_AREA_BOOST_W_HI",
  "SEARCH_AREA_BOOST_W_LO",
  "SEARCH_AREA_BOOST_W_MID",
  "SEARCH_MESH_DESCENDANT_TERMS_CAP",
  "SEARCH_MESH_ENTRY_TIER_PARITY",
  "SEARCH_MESH_RESOLUTION_FALLBACK",
  "SEARCH_PEOPLE_AREA_BOOST",
  "SEARCH_PEOPLE_AREA_BOOST_GRADED",
  "SEARCH_PEOPLE_CLINICAL_FN_WEIGHT",
  "SEARCH_PEOPLE_CONCEPT_ALPHA",
  "SEARCH_PEOPLE_CONCEPT_ARM_FIRST",
  "SEARCH_PEOPLE_FACULTY_PROMINENCE",
  "SEARCH_PEOPLE_METHOD_FAMILY",
  "SEARCH_PEOPLE_METHOD_FAMILY_TIER",
  "SEARCH_PEOPLE_PHRASE_BOOST",
  "SEARCH_PEOPLE_PUBCOUNT_DAMPEN",
] as const;

export type OverridableFlag = (typeof OVERRIDABLE_FLAGS)[number];

const ALLOWED: ReadonlySet<string> = new Set(OVERRIDABLE_FLAGS);

/** WAF-safe: short opaque tokens (`on`, `off`, `capped`, `2.5`). No quotes, no slashes. */
const VALUE_RE = /^[A-Za-z0-9._-]{1,24}$/;

const MAX_PAIRS = OVERRIDABLE_FLAGS.length;

const store = new AsyncLocalStorage<ReadonlyMap<string, string>>();

/**
 * The environment gate. `=== "staging"` and not `!== "prod"` so the override is
 * fail-CLOSED: an unset or unexpected `SPS_ENV` disables it rather than opening it.
 *
 * ponytail: env-gated rather than its own task-def flag, so this ships with no
 * CDK change and no snapshot regen. The ceiling is that there is no runtime kill
 * switch — disabling it early needs a revert + deploy. Add a
 * `SEARCH_FLAG_OVERRIDE` flag (wired per-env in cdk/lib/app-stack.ts, which
 * flag-parity.mjs will then require) if it ever needs to run anywhere else or
 * be switchable without a deploy.
 */
export function flagOverrideEnabled(): boolean {
  return process.env.SPS_ENV === "staging";
}

export type ParsedFlagOverride =
  | { ok: true; overrides: ReadonlyMap<string, string> | null }
  | { ok: false; error: string };

/**
 * Parse `?flags=NAME:value,NAME2:value2`.
 *
 * Off-env (or param absent) → `{ok: true, overrides: null}`: inert, no error,
 * so a stale param in a bookmarked URL cannot 400 a prod request and the
 * feature is not discoverable from prod responses. On staging a malformed or
 * non-allowlisted entry is a hard 400 rather than a silent no-op — an
 * experiment that quietly measured the default is worse than no measurement.
 */
export function parseFlagOverride(raw: string | null | undefined): ParsedFlagOverride {
  if (!flagOverrideEnabled() || raw === null || raw === undefined || raw === "") {
    return { ok: true, overrides: null };
  }
  const pairs = raw.split(",");
  if (pairs.length > MAX_PAIRS) {
    return { ok: false, error: `flags: at most ${MAX_PAIRS} overrides per request` };
  }
  const overrides = new Map<string, string>();
  for (const pair of pairs) {
    const sep = pair.indexOf(":");
    if (sep <= 0) {
      return { ok: false, error: `flags: expected NAME:value, got "${pair}"` };
    }
    const name = pair.slice(0, sep);
    const value = pair.slice(sep + 1);
    if (!ALLOWED.has(name)) {
      return {
        ok: false,
        error: `flags: "${name}" is not overridable. Allowed: ${OVERRIDABLE_FLAGS.join(", ")}`,
      };
    }
    if (!VALUE_RE.test(value)) {
      return {
        ok: false,
        error: `flags: value for "${name}" must match ${VALUE_RE.source}`,
      };
    }
    if (overrides.has(name)) {
      return { ok: false, error: `flags: "${name}" given twice` };
    }
    overrides.set(name, value);
  }
  return { ok: true, overrides };
}

/**
 * Install `overrides` for the duration of `fn`. A null override runs `fn`
 * unwrapped, so the default path allocates nothing and enters no scope.
 */
export function runWithFlagOverride<T>(
  overrides: ReadonlyMap<string, string> | null,
  fn: () => T,
): T {
  return overrides === null ? fn() : store.run(overrides, fn);
}

/**
 * The override value for `name`, or undefined outside a request scope / when
 * that flag was not overridden. Callers keep `?? process.env.<NAME>` as the
 * fallback — which also keeps the literal read shape that
 * `scripts/release/flag-parity.mjs` greps for, so the CI parity gate keeps
 * seeing these keys as consumed.
 */
export function ovr(name: OverridableFlag): string | undefined {
  return store.getStore()?.get(name);
}

/**
 * `["SEARCH_X=on"]` for the active scope, else undefined. Stamped into the
 * search response so an overridden capture is self-identifying (constraint 4).
 */
export function activeFlagOverride(): string[] | undefined {
  const s = store.getStore();
  if (s === undefined || s.size === 0) return undefined;
  return [...s].map(([k, v]) => `${k}=${v}`).sort();
}
