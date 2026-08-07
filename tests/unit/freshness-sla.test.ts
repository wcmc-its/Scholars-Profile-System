import { describe, expect, it } from "vitest";

// The policy module, not `etl/freshness/index` — that script runs `main()` and
// `$disconnect()`s both Prisma clients on import, which a test (and the
// `/edit/etl-status` page) must never trigger just to read the SLA table.
import { SLA_HOURS, TRACKED, ackState } from "@/lib/etl/freshness-policy";

describe("freshness SLAs", () => {
  // Spotlight's producer lives in ReciterAI, not this repo, and publishes
  // MONTHLY (reciterai-spotlight-monthly, cron(0 13 1 * ? *)). Under the 8-day
  // weekly SLA it used to carry, the source was stale by construction and the
  // scholars-heartbeat-<env> machine failed every day in BOTH envs. If someone
  // tidies Spotlight back into the weekly block, that daily failure returns —
  // so pin the cadence, not just the number.
  it("tracks Spotlight on the monthly cadence, not weekly", () => {
    expect(TRACKED.Spotlight?.cadence).toBe("monthly");
  });

  // 40d = 31d (longest month) + 7d (our weekly loader's worst-case pickup lag)
  // + 2d grace. Both terms are required: freshness anchors on the PRODUCER's
  // manifestGeneratedAt, but we only re-read it when the weekly ETL runs, so a
  // perfectly healthy monthly producer still reads 38 days old just before our
  // loader next fires. An SLA <= 38 false-alarms every long month.
  //
  // Asserted as the derivation rather than a bare literal, so the next person to
  // adjust it has to move a term they can name. A first cut at 35 forgot the
  // load-lag term entirely and would have alarmed on a healthy producer.
  const LONGEST_MONTH_DAYS = 31;
  const WEEKLY_LOADER_LAG_DAYS = 7;

  it("covers a 31-day month PLUS the weekly loader's pickup lag", () => {
    const worstHealthyAgeDays = LONGEST_MONTH_DAYS + WEEKLY_LOADER_LAG_DAYS;
    expect(SLA_HOURS.monthly).toBeGreaterThan(worstHealthyAgeDays * 24);
    expect(SLA_HOURS.monthly).toBe(40 * 24);
  });

  // The weekly SLA has the same shape of dependency and must stay above a 7-day
  // producer interval; if someone ever tightens it below that, weekly sources
  // start alarming on healthy runs.
  it("keeps the weekly SLA above its own 7-day interval", () => {
    expect(SLA_HOURS.weekly).toBeGreaterThan(7 * 24);
  });

  // Guards the ordering invariant the table depends on: a longer cadence must
  // tolerate a longer silence, or a source would alarm faster than it can run.
  it("keeps SLAs monotonic across cadences", () => {
    expect(SLA_HOURS.nightly).toBeLessThan(SLA_HOURS.weekly);
    expect(SLA_HOURS.weekly).toBeLessThan(SLA_HOURS.monthly);
    expect(SLA_HOURS.monthly).toBeLessThan(SLA_HOURS.annual);
  });

  // Every tracked source must resolve to a cadence that exists in SLA_HOURS —
  // otherwise slaHours is undefined and `ageHours > undefined` is false, so the
  // source silently reads FRESH forever. That is the exact class of bug the
  // manifest-anchoring fix already had to undo once.
  it("resolves every tracked source to a real SLA", () => {
    for (const [source, spec] of Object.entries(TRACKED)) {
      expect(
        SLA_HOURS[spec.cadence],
        `${source} has cadence "${spec.cadence}" with no SLA`,
      ).toBeGreaterThan(0);
    }
  });

  // These three are the sources with NO other detector, so dropping one out of
  // TRACKED restores a total blind spot rather than merely losing a second
  // opinion. Each is a continue-tier nightly step, so a failure never reaches
  // the sps-etl-nightly-status-<env> alarm; and each records `rowsProcessed` =
  // the line count of a curated CSV checked into this repo (33 / 8 / 77), which
  // sits under etl:integrity's minPreviousRows=100 floor AND is constant
  // between two runs of the same image, so the volume guard's drop ratio is 0
  // by construction and lowering that floor would change nothing. Freshness is
  // the whole net.
  //
  // What that net catches: the step DYING, the step being dropped from the
  // nightly step list, and the step never being deployed to an env. `evaluate()`
  // grades on the recency of the last `status:'success'` row and never reads
  // `rowsProcessed`, so it does NOT catch a run that succeeds having processed
  // nothing — that half is closed in each loader's readCurated, which refuses a
  // curated CSV parsing to zero rows (tests/unit/etl-curated-csv-empty-guard).
  const SOLE_DETECTOR_SOURCES = ["FamilySensitivity", "FamilySuppression", "MeshAlias"] as const;

  // Resolve ONCE and assert it exists, rather than re-reading `TRACKED[source]?`
  // in each assertion. Optional chaining makes `?.envs` and `?.ack` undefined —
  // and therefore PASSING — when the entry is absent, so the two guards below
  // used to go green on exactly the removal they exist to catch.
  const trackedEntry = (source: (typeof SOLE_DETECTOR_SOURCES)[number]) => {
    const entry = TRACKED[source];
    expect(
      entry,
      `${source} dropped out of TRACKED — freshness is its only silent-failure detector`,
    ).toBeDefined();
    return entry!;
  };

  it.each(SOLE_DETECTOR_SOURCES)(
    "tracks %s — freshness is its only silent-failure detector",
    (source) => {
      // Nightly, because all three are unconditional steps in the nightly
      // chain (cdk/lib/etl-stack.ts). A longer cadence here would mean a dead
      // step goes unreported for days.
      expect(trackedEntry(source).cadence).toBe("nightly");
    },
  );

  // All three run in BOTH envs — they are in the shared nightlySteps array,
  // outside the `env === "staging"` split that scopes InfoEd. Narrowing one to
  // a single env would silently restore the blind spot in the other, which is
  // exactly how prod's MeshAnchor staleness went unnoticed for eight weeks.
  it.each(SOLE_DETECTOR_SOURCES)("tracks %s in every env, not just one", (source) => {
    expect(trackedEntry(source).envs).toBeUndefined();
  });

  // An ack silences a source, so an ack on one of these is the blind spot
  // returning with paperwork. If one is ever genuinely needed, this test is
  // the place to record the decision — deliberately, not by default.
  it.each(SOLE_DETECTOR_SOURCES)("does not silence %s with an ack", (source) => {
    expect(trackedEntry(source).ack).toBeUndefined();
  });
});

/**
 * Acknowledgements exist because a permanently-red check is worse than no
 * check. scholars-heartbeat-prod FAILED every day from at least 2026-07-30 to
 * 2026-08-05 on Spotlight alone — three pages a night, all identical — so when
 * the prod InfoEd import died on 08-04 its staleness would have been one more
 * line in a message that had already cried wolf ~60 times.
 *
 * The expiry is the whole safety property: an ack that cannot expire is just a
 * blind spot with paperwork. These test that, not the happy path.
 */
describe("freshness acknowledgements", () => {
  const ACK = { until: "2026-09-30", reason: "producer not deployed" };
  const at = (iso: string) => Date.parse(iso);

  it("applies before the expiry and STOPS applying after it", () => {
    expect(ackState(ACK, at("2026-09-29T23:00:00Z"))).toBe("active");
    expect(ackState(ACK, at("2026-10-01T00:00:00Z"))).toBe("expired");
  });

  it("fails CLOSED on an unparseable date — a typo must not silence a source forever", () => {
    expect(ackState({ until: "not-a-date", reason: "x" }, at("2026-08-05T00:00:00Z"))).toBe(
      "invalid",
    );
    expect(ackState({ until: "", reason: "x" }, at("2026-08-05T00:00:00Z"))).toBe("invalid");
  });

  it("reports no ack when none is configured", () => {
    expect(ackState(undefined, at("2026-08-05T00:00:00Z"))).toBe("none");
  });

  it("every configured ack has a parseable expiry and a substantive reason", () => {
    for (const [source, spec] of Object.entries(TRACKED)) {
      if (spec.ack === undefined) continue;
      expect(
        Number.isNaN(Date.parse(spec.ack.until)),
        `${source}: ack.until "${spec.ack.until}" does not parse, so the ack is silently ignored`,
      ).toBe(false);
      // A reason a reader can act on, not "TODO" or "known issue".
      expect(
        spec.ack.reason.length,
        `${source}: ack.reason is too thin to act on`,
      ).toBeGreaterThan(30);
    }
  });

  // An ack until 2099 is a permanent blind spot wearing an expiry's clothes.
  // Pinned to a fixed anchor rather than Date.now() so CI cannot start failing
  // on a date with no code change — this bounds how far ahead an ack may be
  // WRITTEN, and the runtime expiry does the rest.
  it("bounds how far out an ack may reach", () => {
    const ANCHOR = at("2026-08-05T00:00:00Z");
    const MAX_DAYS = 365;
    for (const [source, spec] of Object.entries(TRACKED)) {
      if (spec.ack === undefined) continue;
      const days = (Date.parse(spec.ack.until) - ANCHOR) / (24 * 60 * 60 * 1000);
      expect(days, `${source}: ack reaches ${days.toFixed(0)}d out — too far to be an ack`).toBeLessThanOrEqual(
        MAX_DAYS,
      );
    }
  });

  // Documents the decision, so removing the ack when the producer finally
  // deploys is a deliberate act rather than something nobody remembers.
  it("Spotlight is acknowledged, not silently untracked", () => {
    expect(TRACKED.Spotlight?.ack).toBeDefined();
    expect(TRACKED.Spotlight?.cadence).toBe("monthly");
  });
});
