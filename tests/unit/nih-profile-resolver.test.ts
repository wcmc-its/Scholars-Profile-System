import { describe, expect, it } from "vitest";
import {
  aggregatePreferred,
  namesMatch,
  resolveByNameFallback,
  resolveProjectGrantJoin,
  type GrantRowForResolution,
  type ResolvedObservation,
} from "@/etl/nih-profile/resolver";
import type { ReporterPI, ReporterProject } from "@/etl/nih-profile/fetcher";

function pi(opts: Partial<ReporterPI> & { profile_id: number }): ReporterPI {
  return {
    profile_id: opts.profile_id,
    first_name: opts.first_name ?? null,
    middle_name: opts.middle_name ?? null,
    last_name: opts.last_name ?? null,
    full_name: opts.full_name ?? null,
    is_contact_pi: opts.is_contact_pi ?? false,
    title: opts.title ?? null,
  };
}

function project(opts: Partial<ReporterProject> & { core_project_num: string }): ReporterProject {
  return {
    appl_id: opts.appl_id ?? 999,
    core_project_num: opts.core_project_num,
    project_end_date: opts.project_end_date ?? "2027-01-01",
    principal_investigators: opts.principal_investigators ?? [],
  };
}

function grant(opts: Partial<GrantRowForResolution> & { cwid: string; fullName: string }): GrantRowForResolution {
  return {
    cwid: opts.cwid,
    role: opts.role ?? "PI",
    fullName: opts.fullName,
  };
}

describe("namesMatch", () => {
  it("matches identical names", () => {
    expect(namesMatch("Jane Doe", "Jane Doe")).toBe(true);
  });

  it("matches an initial against a first name", () => {
    expect(namesMatch("J Doe", "Jane Doe")).toBe(true);
    expect(namesMatch("Jane Doe", "J A Doe")).toBe(true);
  });

  it("matches across middle-name presence/absence", () => {
    expect(namesMatch("Jane Adam Doe", "Jane Doe")).toBe(true);
  });

  it("rejects different last names", () => {
    expect(namesMatch("Jane Doe", "Jane Smith")).toBe(false);
  });

  it("rejects same last name + different first name", () => {
    expect(namesMatch("Jane Doe", "John Doe")).toBe(false);
  });

  it("ignores postnominals after the comma", () => {
    expect(namesMatch("Curtis Cole, MD", "Curtis Cole")).toBe(true);
  });

  it("preserves hyphenated last names", () => {
    expect(namesMatch("Maria T Diaz-Meco", "Maria Diaz-Meco")).toBe(true);
    expect(namesMatch("Maria Meco", "Maria Diaz-Meco")).toBe(false);
  });
});

describe("resolveProjectGrantJoin", () => {
  it("pairs the contact PI with the PI grant row's cwid", () => {
    const proj = project({
      core_project_num: "R01CA111",
      principal_investigators: [pi({ profile_id: 100, full_name: "Jane Doe", is_contact_pi: true })],
    });
    const grants = [grant({ cwid: "jad2001", role: "PI", fullName: "Jane A Doe" })];
    const { observations, unresolved } = resolveProjectGrantJoin(proj, grants);
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      profileId: 100,
      cwid: "jad2001",
      resolutionSource: "grant_join_contact",
    });
    expect(unresolved).toHaveLength(0);
  });

  it("name-matches multi-PI co-PIs against other PI-level grant rows", () => {
    const proj = project({
      core_project_num: "U01HL222",
      principal_investigators: [
        pi({ profile_id: 100, full_name: "Jane Doe", is_contact_pi: true }),
        pi({ profile_id: 200, full_name: "John Smith", is_contact_pi: false }),
      ],
    });
    const grants = [
      grant({ cwid: "jad2001", role: "PI", fullName: "Jane Doe" }),
      grant({ cwid: "jos1234", role: "Co-PI", fullName: "John Smith" }),
    ];
    const { observations, unresolved } = resolveProjectGrantJoin(proj, grants);
    expect(observations).toHaveLength(2);
    expect(observations.find((o) => o.profileId === 200)).toMatchObject({
      cwid: "jos1234",
      resolutionSource: "grant_join_pi",
    });
    expect(unresolved).toHaveLength(0);
  });

  it("returns PIs as unresolved when no PI-level grant row exists for the project", () => {
    const proj = project({
      core_project_num: "K99X",
      principal_investigators: [pi({ profile_id: 300, full_name: "Carol Singer", is_contact_pi: true })],
    });
    const { observations, unresolved } = resolveProjectGrantJoin(proj, []);
    expect(observations).toHaveLength(0);
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]!.profile_id).toBe(300);
  });
});

describe("resolveByNameFallback", () => {
  const pool: GrantRowForResolution[] = [
    grant({ cwid: "abc1001", role: "PI", fullName: "Alice Aaron" }),
    grant({ cwid: "bbb2002", role: "PI", fullName: "Bob Baker" }),
    grant({ cwid: "ccc3003", role: "Co-I", fullName: "Carol Singer" }),
  ];

  it("returns a cwid when exactly one scholar matches", () => {
    expect(resolveByNameFallback(pi({ profile_id: 1, full_name: "Bob Baker" }), pool)).toBe("bbb2002");
  });

  it("returns null when zero scholars match", () => {
    expect(resolveByNameFallback(pi({ profile_id: 1, full_name: "Daniel Davis" }), pool)).toBeNull();
  });

  it("returns null on ambiguity (multiple matches)", () => {
    const ambiguousPool = [
      ...pool,
      grant({ cwid: "abc9999", role: "PI", fullName: "Alex Aaron" }),
    ];
    expect(resolveByNameFallback(pi({ profile_id: 1, full_name: "A Aaron" }), ambiguousPool)).toBeNull();
  });
});

describe("aggregatePreferred", () => {
  it("marks the latest-end-date profile_id as preferred when a scholar has multiple", () => {
    const obs: ResolvedObservation[] = [
      {
        profileId: 100,
        cwid: "jad2001",
        fullName: "Jane Doe",
        projectEndDate: "2020-01-01",
        resolutionSource: "grant_join_contact",
      },
      {
        profileId: 200,
        cwid: "jad2001",
        fullName: "Jane Doe",
        projectEndDate: "2027-01-01",
        resolutionSource: "grant_join_contact",
      },
    ];
    const out = aggregatePreferred(obs);
    expect(out).toHaveLength(2);
    const preferred = out.find((r) => r.isPreferred);
    expect(preferred?.profileId).toBe(200);
    const nonPreferred = out.find((r) => !r.isPreferred);
    expect(nonPreferred?.profileId).toBe(100);
  });

  it("keeps the strongest resolution_source per (cwid, profile_id) pair", () => {
    const obs: ResolvedObservation[] = [
      {
        profileId: 100,
        cwid: "jad2001",
        fullName: "Jane Doe",
        projectEndDate: "2025-01-01",
        resolutionSource: "name_match",
      },
      {
        profileId: 100,
        cwid: "jad2001",
        fullName: "Jane Doe",
        projectEndDate: "2025-01-01",
        resolutionSource: "grant_join_contact",
      },
    ];
    const out = aggregatePreferred(obs);
    expect(out).toHaveLength(1);
    expect(out[0]!.resolutionSource).toBe("grant_join_contact");
  });

  it("trivially marks is_preferred when only one profile_id maps to the cwid", () => {
    const obs: ResolvedObservation[] = [
      {
        profileId: 100,
        cwid: "jad2001",
        fullName: "Jane Doe",
        projectEndDate: "2025-01-01",
        resolutionSource: "grant_join_contact",
      },
    ];
    const out = aggregatePreferred(obs);
    expect(out).toEqual([
      {
        cwid: "jad2001",
        profileId: 100,
        isPreferred: true,
        resolutionSource: "grant_join_contact",
      },
    ]);
  });
});
