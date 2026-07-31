/**
 * #2085 — request-scoped ranking-flag override.
 *
 * The load-bearing test here is CONNECTIVITY: every name in
 * `OVERRIDABLE_FLAGS` must actually move its resolver. A name that is listed
 * but never wired into `search-flags.ts` is accepted at parse time, echoed in
 * the response as if it applied, and then silently ignored — an experiment that
 * measured the default while reporting the override. That is the worst failure
 * this feature can have, and it is invisible to a typecheck.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  OVERRIDABLE_FLAGS,
  activeFlagOverride,
  flagOverrideEnabled,
  ovr,
  parseFlagOverride,
  runWithFlagOverride,
  type OverridableFlag,
} from "@/lib/api/flag-override";
import {
  resolveAreaBoostTopN,
  resolveAreaBoostWeights,
  resolveConceptConcentrationAlpha,
  resolveMeshEntryTierParityEnabled,
  resolveMeshResolutionFallbackEnabled,
  resolvePeopleMethodFamilyBoost,
  resolvePeopleMethodFamilyTier,
  resolvePeopleTopicPhraseBoost,
  resolveSearchPeopleAreaBoost,
  resolveSearchPeopleAreaBoostGraded,
  resolveSearchPeopleClinicalFnWeight,
  resolveSearchPeopleConceptArmFirst,
  resolveSearchPeopleFacultyProminence,
  resolveSearchPeoplePubCountDampen,
} from "@/lib/api/search-flags";

/**
 * One row per overridable flag: the value an experimenter would send, what the
 * resolver returns with no override, and what it must return with one. Adding a
 * flag to `OVERRIDABLE_FLAGS` without a row here fails the completeness test.
 */
const WEIGHT_DEFAULTS = { hi: 1, mid: 2, lo: 3 };

const CASES: Record<
  OverridableFlag,
  { value: string; read: () => unknown; dflt: unknown; overridden: unknown }
> = {
  SEARCH_AREA_BOOST_TOP_N: {
    value: "500",
    read: () => resolveAreaBoostTopN(200),
    dflt: 200,
    overridden: 500,
  },
  SEARCH_AREA_BOOST_W_HI: {
    value: "9",
    read: () => resolveAreaBoostWeights(WEIGHT_DEFAULTS).hi,
    dflt: 1,
    overridden: 9,
  },
  SEARCH_AREA_BOOST_W_MID: {
    value: "9",
    read: () => resolveAreaBoostWeights(WEIGHT_DEFAULTS).mid,
    dflt: 2,
    overridden: 9,
  },
  SEARCH_AREA_BOOST_W_LO: {
    value: "9",
    read: () => resolveAreaBoostWeights(WEIGHT_DEFAULTS).lo,
    dflt: 3,
    overridden: 9,
  },
  SEARCH_MESH_ENTRY_TIER_PARITY: {
    value: "on",
    read: resolveMeshEntryTierParityEnabled,
    dflt: false,
    overridden: true,
  },
  SEARCH_MESH_RESOLUTION_FALLBACK: {
    value: "on",
    read: resolveMeshResolutionFallbackEnabled,
    dflt: false,
    overridden: true,
  },
  SEARCH_PEOPLE_AREA_BOOST: {
    value: "on",
    read: resolveSearchPeopleAreaBoost,
    dflt: false,
    overridden: true,
  },
  SEARCH_PEOPLE_AREA_BOOST_GRADED: {
    value: "on",
    read: resolveSearchPeopleAreaBoostGraded,
    dflt: false,
    overridden: true,
  },
  SEARCH_PEOPLE_CLINICAL_FN_WEIGHT: {
    value: "7",
    read: resolveSearchPeopleClinicalFnWeight,
    dflt: 3,
    overridden: 7,
  },
  SEARCH_PEOPLE_CONCEPT_ALPHA: {
    value: "0.5",
    read: resolveConceptConcentrationAlpha,
    dflt: 1,
    overridden: 0.5,
  },
  SEARCH_PEOPLE_CONCEPT_ARM_FIRST: {
    value: "on",
    read: resolveSearchPeopleConceptArmFirst,
    dflt: false,
    overridden: true,
  },
  // Default-ON lever: the override has to be able to turn things OFF too.
  SEARCH_PEOPLE_FACULTY_PROMINENCE: {
    value: "off",
    read: resolveSearchPeopleFacultyProminence,
    dflt: true,
    overridden: false,
  },
  SEARCH_PEOPLE_METHOD_FAMILY: {
    value: "on",
    read: resolvePeopleMethodFamilyBoost,
    dflt: false,
    overridden: true,
  },
  SEARCH_PEOPLE_METHOD_FAMILY_TIER: {
    value: "on",
    read: resolvePeopleMethodFamilyTier,
    dflt: false,
    overridden: true,
  },
  SEARCH_PEOPLE_PHRASE_BOOST: {
    value: "on",
    read: resolvePeopleTopicPhraseBoost,
    dflt: false,
    overridden: true,
  },
  SEARCH_PEOPLE_PUBCOUNT_DAMPEN: {
    value: "capped",
    read: resolveSearchPeoplePubCountDampen,
    dflt: "off",
    overridden: "capped",
  },
};

const ENV_KEYS = [...OVERRIDABLE_FLAGS, "SPS_ENV"] as const;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved.set(k, process.env[k]);
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = saved.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("#2085 — every allowlisted flag is actually wired (declared AND connected)", () => {
  it("covers every name in OVERRIDABLE_FLAGS, with no extras", () => {
    expect(Object.keys(CASES).sort()).toEqual([...OVERRIDABLE_FLAGS].sort());
  });

  for (const name of OVERRIDABLE_FLAGS) {
    const c = CASES[name];
    it(`${name} — resolver follows the request-scoped override`, () => {
      expect(c.read()).toEqual(c.dflt);
      runWithFlagOverride(new Map([[name, c.value]]), () => {
        expect(c.read()).toEqual(c.overridden);
      });
      // Scope is per-request: the value must not leak past the callback.
      expect(c.read()).toEqual(c.dflt);
    });
  }

  it("an override beats the task-def env, and only for the named flag", () => {
    process.env.SEARCH_PEOPLE_PUBCOUNT_DAMPEN = "capped";
    process.env.SEARCH_PEOPLE_AREA_BOOST = "on";
    runWithFlagOverride(new Map([["SEARCH_PEOPLE_PUBCOUNT_DAMPEN", "off"]]), () => {
      expect(resolveSearchPeoplePubCountDampen()).toBe("off");
      expect(resolveSearchPeopleAreaBoost()).toBe(true); // untouched flag falls through
    });
    expect(resolveSearchPeoplePubCountDampen()).toBe("capped");
  });

  it("survives an await — the scope is async-local, not synchronous", async () => {
    await runWithFlagOverride(new Map([["SEARCH_PEOPLE_AREA_BOOST", "on"]]), async () => {
      await Promise.resolve();
      expect(resolveSearchPeopleAreaBoost()).toBe(true);
    });
  });

  // #2094 — the cap reaches a `.slice()` / agg `size`, so a bad value must degrade to the
  // default, never to NaN or an unbounded clause list.
  it("SEARCH_AREA_BOOST_TOP_N rejects junk and falls back to the default", () => {
    for (const bad of ["abc", "-1", "0", "1.5", "99999999", ""]) {
      runWithFlagOverride(new Map([["SEARCH_AREA_BOOST_TOP_N", bad]]), () => {
        expect(resolveAreaBoostTopN(200)).toBe(200);
      });
    }
  });

  it("ovr() is inert outside a request scope (ETL / index build)", () => {
    expect(ovr("SEARCH_PEOPLE_AREA_BOOST")).toBeUndefined();
    expect(activeFlagOverride()).toBeUndefined();
  });
});

describe("#2085 — the environment gate is fail-closed", () => {
  it("is off when SPS_ENV is unset, prod, or anything unexpected", () => {
    expect(flagOverrideEnabled()).toBe(false);
    for (const v of ["prod", "production", "dev", ""]) {
      process.env.SPS_ENV = v;
      expect(flagOverrideEnabled()).toBe(false);
    }
  });

  it("is on only for staging", () => {
    process.env.SPS_ENV = "staging";
    expect(flagOverrideEnabled()).toBe(true);
  });

  it("off-env, a param is inert rather than an error — a stale URL must not 400 prod", () => {
    process.env.SPS_ENV = "prod";
    expect(parseFlagOverride("SEARCH_PEOPLE_AREA_BOOST:on")).toEqual({
      ok: true,
      overrides: null,
    });
    // Even garbage, so prod responses never reveal the allowlist.
    expect(parseFlagOverride("nonsense")).toEqual({ ok: true, overrides: null });
  });
});

describe("#2085 — parsing rejects loudly on staging", () => {
  beforeEach(() => {
    process.env.SPS_ENV = "staging";
  });

  it("parses a single pair and a comma-separated list", () => {
    expect(parseFlagOverride("SEARCH_PEOPLE_AREA_BOOST:on")).toEqual({
      ok: true,
      overrides: new Map([["SEARCH_PEOPLE_AREA_BOOST", "on"]]),
    });
    expect(
      parseFlagOverride("SEARCH_PEOPLE_AREA_BOOST:on,SEARCH_PEOPLE_PUBCOUNT_DAMPEN:capped"),
    ).toEqual({
      ok: true,
      overrides: new Map([
        ["SEARCH_PEOPLE_AREA_BOOST", "on"],
        ["SEARCH_PEOPLE_PUBCOUNT_DAMPEN", "capped"],
      ]),
    });
  });

  it("treats an absent or empty param as no override", () => {
    expect(parseFlagOverride(null)).toEqual({ ok: true, overrides: null });
    expect(parseFlagOverride("")).toEqual({ ok: true, overrides: null });
  });

  it("refuses a flag that is not on the ranking allowlist", () => {
    // The whole security property: nothing outside OVERRIDABLE_FLAGS is reachable.
    for (const name of [
      "SCHOLAR_EXPORT_CAP",
      "SEARCH_SCHOLAR_LIST_EXPORT",
      "COAUTHOR_HIDDEN_STUDENT_CHIPS",
      "NODE_ENV",
      "SPS_ENV",
      "DATABASE_URL",
    ]) {
      const r = parseFlagOverride(`${name}:on`);
      expect(r.ok, `${name} must not be overridable`).toBe(false);
    }
  });

  it("refuses a malformed pair", () => {
    for (const raw of ["SEARCH_PEOPLE_AREA_BOOST", ":on", "SEARCH_PEOPLE_AREA_BOOST:"]) {
      expect(parseFlagOverride(raw).ok, raw).toBe(false);
    }
  });

  it("refuses a value outside the WAF-safe charset", () => {
    // KnownBadInputs/SQLi run in enforce mode at the edge; keep values opaque.
    for (const v of ["'or 1=1", "../etc", "a b", "<script>", "x".repeat(25)]) {
      expect(parseFlagOverride(`SEARCH_PEOPLE_AREA_BOOST:${v}`).ok, v).toBe(false);
    }
  });

  it("refuses a repeated flag rather than picking a winner silently", () => {
    expect(parseFlagOverride("SEARCH_PEOPLE_AREA_BOOST:on,SEARCH_PEOPLE_AREA_BOOST:off").ok).toBe(
      false,
    );
  });

  it("bounds the number of pairs", () => {
    const tooMany = Array.from({ length: OVERRIDABLE_FLAGS.length + 1 }, () => "X:on").join(",");
    expect(parseFlagOverride(tooMany).ok).toBe(false);
  });
});

describe("#2085 — an overridden response is self-identifying", () => {
  it("reports the active overrides, sorted and stable", () => {
    runWithFlagOverride(
      new Map([
        ["SEARCH_PEOPLE_PUBCOUNT_DAMPEN", "capped"],
        ["SEARCH_PEOPLE_AREA_BOOST", "on"],
      ]),
      () => {
        expect(activeFlagOverride()).toEqual([
          "SEARCH_PEOPLE_AREA_BOOST=on",
          "SEARCH_PEOPLE_PUBCOUNT_DAMPEN=capped",
        ]);
      },
    );
  });

  it("reports nothing when no override is installed", () => {
    runWithFlagOverride(null, () => {
      expect(activeFlagOverride()).toBeUndefined();
    });
  });
});
