/**
 * #1762 — the honors queue loader.
 *
 * Two behaviours carry real risk and are pinned here:
 *
 *  1. GROUPING BY ROSTER LINE. Rows sharing a `sourceRef` are competing claims on
 *     one award; at most one is true. If grouping breaks, the UI offers a plain
 *     approve on each and two people get credited with one fellowship — the
 *     mismatch the SPEC calls expensive.
 *  2. THE YEAR SIGNAL IS A NOTE, NEVER A FILTER. It annotates; it must never drop
 *     a row. A genuine emeritus hit in the 1980s band is plausible.
 */
import { describe, expect, it } from "vitest";

import {
  isHonorsQueueTabVisible,
  loadHonorQueue,
  yearPlausibilityNote,
} from "@/lib/edit/honor-queue";

type Row = {
  id: string;
  cwid: string;
  category: "PRIZE";
  name: string;
  organization: string;
  year: number | null;
  source: string;
  sourceRef: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function honor(over: Partial<Row> & { id: string; cwid: string }): Row {
  return {
    category: "PRIZE",
    name: "Sloan Research Fellowship",
    organization: "Sloan Foundation",
    year: 2014,
    source: "D3_RERUN_sloan",
    sourceRef: null,
    createdAt: new Date("2026-07-17T00:00:00Z"),
    updatedAt: new Date("2026-07-17T00:00:00Z"),
    ...over,
  };
}

/** Minimal stand-in for the Prisma surface the loader touches. */
function client(
  rows: Row[],
  scholars: Array<{ cwid: string; preferredName: string; primaryTitle?: string; postnominal?: string | null; roleCategory?: string | null }>,
) {
  return {
    honor: { findMany: async () => rows },
    scholar: {
      findMany: async () =>
        scholars.map((s) => ({
          cwid: s.cwid,
          slug: `slug-${s.cwid}`,
          preferredName: s.preferredName,
          postnominal: s.postnominal ?? null,
          fullName: s.preferredName,
          roleCategory: s.roleCategory ?? "full_time_faculty",
          primaryTitle: s.primaryTitle ?? "Professor of Medicine",
          primaryDepartment: "Medicine",
        })),
    },
  } as unknown as Parameters<typeof loadHonorQueue>[0];
}

describe("loadHonorQueue — grouping by roster line", () => {
  it("groups rows sharing a sourceRef and marks them contested", async () => {
    const rows = [
      honor({ id: "a", cwid: "aaa1001", sourceRef: "https://sloan.org/db#Smith|2014" }),
      honor({ id: "b", cwid: "bbb2002", sourceRef: "https://sloan.org/db#Smith|2014" }),
    ];
    const groups = await loadHonorQueue(
      client(rows, [
        { cwid: "aaa1001", preferredName: "A Smith" },
        { cwid: "bbb2002", preferredName: "B Smith" },
      ]),
    );

    expect(groups).toHaveLength(1);
    expect(groups[0].contested).toBe(true);
    expect(groups[0].rows).toHaveLength(2);
    // Each candidate knows who it competes with — that's what lets the UI refuse
    // a plain approve.
    expect(groups[0].rows[0].competingCwids).toEqual(["bbb2002"]);
    expect(groups[0].rows[1].competingCwids).toEqual(["aaa1001"]);
  });

  it("does NOT lump distinct NULL-sourceRef rows into one contested group", async () => {
    // The trap: keying on `sourceRef` alone makes every NULL collide, marking
    // unrelated honors as competing and inviting a curator to reject real ones.
    const rows = [
      honor({ id: "a", cwid: "aaa1001", sourceRef: null }),
      honor({ id: "b", cwid: "bbb2002", sourceRef: null }),
    ];
    const groups = await loadHonorQueue(
      client(rows, [
        { cwid: "aaa1001", preferredName: "A Smith" },
        { cwid: "bbb2002", preferredName: "B Smith" },
      ]),
    );

    expect(groups).toHaveLength(2);
    expect(groups.every((g) => !g.contested)).toBe(true);
    expect(groups.flatMap((g) => g.rows).every((r) => r.competingCwids.length === 0)).toBe(true);
  });

  it("treats the same scholar twice on one line as uncontested, not a rivalry", async () => {
    const rows = [
      honor({ id: "a", cwid: "aaa1001", sourceRef: "ref-1" }),
      honor({ id: "b", cwid: "aaa1001", sourceRef: "ref-1" }),
    ];
    const groups = await loadHonorQueue(client(rows, [{ cwid: "aaa1001", preferredName: "A Smith" }]));

    expect(groups).toHaveLength(1);
    expect(groups[0].contested).toBe(false);
  });

  it("orders confident single matches BEFORE contested lines (2026-07-17 curator ask)", async () => {
    // Confidence DESC: a clean single match outranks an ambiguous contested line,
    // the inverse of the original contested-first ordering. The curator rubber-
    // stamps the confident ones and deals with the messy contested lines after.
    const rows = [
      honor({ id: "c1", cwid: "bbb2002", sourceRef: "sloan|Jo Lee|2020", year: 2020 }),
      honor({ id: "c2", cwid: "ccc3003", sourceRef: "sloan|Jo Lee|2020", year: 2020 }),
      honor({ id: "single", cwid: "aaa1001", sourceRef: "sloan|Ada Byron|2019", year: 2019 }),
    ];
    const groups = await loadHonorQueue(
      client(rows, [
        { cwid: "aaa1001", preferredName: "Ada Byron" },
        { cwid: "bbb2002", preferredName: "Jo Lee" },
        { cwid: "ccc3003", preferredName: "Jordan Lee" },
      ]),
    );

    expect(groups[0].contested).toBe(false);
    expect(groups[0].rows[0].id).toBe("single");
    expect(groups[1].contested).toBe(true);
  });

  it("within confident matches, sorts most-recent award first (nulls last)", async () => {
    const rows = [
      honor({ id: "old", cwid: "aaa1001", sourceRef: "sloan|Ann Old|1990", year: 1990 }),
      honor({ id: "new", cwid: "bbb2002", sourceRef: "sloan|Bea New|2024", year: 2024 }),
      honor({ id: "noyear", cwid: "ccc3003", sourceRef: "sloan|Cy None|", year: null }),
    ];
    const groups = await loadHonorQueue(
      client(rows, [
        { cwid: "aaa1001", preferredName: "Ann Old" },
        { cwid: "bbb2002", preferredName: "Bea New" },
        { cwid: "ccc3003", preferredName: "Cy None" },
      ]),
    );
    expect(groups.map((g) => g.rows[0].id)).toEqual(["new", "old", "noyear"]);
  });

  it("returns [] for an empty queue without querying scholars", async () => {
    let scholarCalls = 0;
    const c = {
      honor: { findMany: async () => [] },
      scholar: {
        findMany: async () => {
          scholarCalls++;
          return [];
        },
      },
    } as unknown as Parameters<typeof loadHonorQueue>[0];

    expect(await loadHonorQueue(c)).toEqual([]);
    expect(scholarCalls).toBe(0);
  });
});

describe("loadHonorQueue — the verification pair (name matched against + published name)", () => {
  it("recovers the roster's printed name from sourceRef and applies the postnominal", async () => {
    const rows = [honor({ id: "a", cwid: "aaa1001", sourceRef: "sloan_full|Robert Young|2013" })];
    const groups = await loadHonorQueue(
      client(rows, [{ cwid: "aaa1001", preferredName: "Robert C Young", postnominal: "MD" }]),
    );
    // The name the ROSTER printed — "the name being matched against".
    expect(groups[0].rosterMatchedName).toBe("Robert Young");
    // The name the PROFILE will render — preferredName + postnominal.
    expect(groups[0].rows[0].scholarName).toBe("Robert C Young, MD");
  });

  it("leaves rosterMatchedName null for a hand-entered honor (null sourceRef)", async () => {
    const groups = await loadHonorQueue(
      client([honor({ id: "a", cwid: "aaa1001", sourceRef: null })], [{ cwid: "aaa1001", preferredName: "A Smith" }]),
    );
    expect(groups[0].rosterMatchedName).toBeNull();
  });

  it("carries the roleCategory + a display label for the person filter", async () => {
    const groups = await loadHonorQueue(
      client([honor({ id: "a", cwid: "aaa1001", sourceRef: "x|Y|2013" })], [
        { cwid: "aaa1001", preferredName: "A", roleCategory: "affiliated_faculty" },
      ]),
    );
    expect(groups[0].rows[0].roleCategory).toBe("affiliated_faculty");
    expect(groups[0].rows[0].roleLabel).toBeTruthy();
  });

  it("loads a non-pending status when asked (the Approved/Rejected history)", async () => {
    let whereStatus: unknown;
    const c = {
      honor: {
        findMany: async (args: { where: { status: string } }) => {
          whereStatus = args.where.status;
          return [];
        },
      },
      scholar: { findMany: async () => [] },
    } as unknown as Parameters<typeof loadHonorQueue>[0];
    await loadHonorQueue(c, "published");
    expect(whereStatus).toBe("published");
  });
});

describe("isFullTimeFaculty", () => {
  it("is true only for full_time_faculty", async () => {
    const { isFullTimeFaculty } = await import("@/lib/edit/honor-queue");
    expect(isFullTimeFaculty("full_time_faculty")).toBe(true);
    expect(isFullTimeFaculty("affiliated_faculty")).toBe(false);
    expect(isFullTimeFaculty("postdoc")).toBe(false);
    expect(isFullTimeFaculty(null)).toBe(false);
  });
});

describe("honorPrestige — a sort weight, never a gate", () => {
  it("ranks the national academies above the early-career fellowships", async () => {
    const { honorPrestige } = await import("@/lib/edit/honor-queue");
    expect(honorPrestige("National Academy of Sciences")).toBeGreaterThan(
      honorPrestige("Alfred P. Sloan Foundation"),
    );
    expect(honorPrestige("National Academy of Medicine")).toBeGreaterThan(
      honorPrestige("American Association for the Advancement of Science"),
    );
  });

  it("scores an unknown body 0 (it sorts last, is never dropped)", async () => {
    const { honorPrestige } = await import("@/lib/edit/honor-queue");
    expect(honorPrestige("Some Society We Have Not Weighted")).toBe(0);
  });

  it("tolerates surrounding whitespace on the organization key", async () => {
    const { honorPrestige } = await import("@/lib/edit/honor-queue");
    expect(honorPrestige("  National Academy of Sciences  ")).toBe(
      honorPrestige("National Academy of Sciences"),
    );
  });

  it("attaches the weight to each loaded row", async () => {
    const groups = await loadHonorQueue(
      client([honor({ id: "a", cwid: "aaa1001", sourceRef: "x|Y|2013", organization: "National Academy of Sciences" })], [
        { cwid: "aaa1001", preferredName: "A" },
      ]),
    );
    expect(groups[0].rows[0].prestige).toBe(100);
  });
});

describe("yearPlausibilityNote — a SIGNAL, never a filter", () => {
  it("flags an old award on a junior current title", () => {
    expect(yearPlausibilityNote({ year: 1985, title: "Clinical Instructor in Emergency Medicine" }))
      .toMatch(/check this is the same person/i);
  });

  it("stays silent on an old award held by a senior title (a real emeritus hit)", () => {
    expect(yearPlausibilityNote({ year: 1985, title: "Professor of Surgery" })).toBeNull();
  });

  it("stays silent on a recent award, junior title or not", () => {
    expect(yearPlausibilityNote({ year: 2020, title: "Assistant Professor of Medicine" })).toBeNull();
  });

  it("stays silent when the year is unknown rather than guessing", () => {
    expect(yearPlausibilityNote({ year: null, title: "Postdoctoral Associate" })).toBeNull();
  });

  it("stays silent when there is no title to judge", () => {
    expect(yearPlausibilityNote({ year: 1970, title: null })).toBeNull();
  });
});

describe("yearPlausibilityNote — the threshold must not rot", () => {
  // The rule this encodes is "pre-1996 award + junior current title", which was
  // measured in 2026. A literal 1996 in the source would still say 1996 in 2036,
  // by which point it means "40 years ago" — a different rule that no test would
  // have flagged. `now` is injected for the same reason `honorYearMax` takes it.
  const AT_2026 = new Date("2026-06-01T00:00:00Z");
  const JUNIOR = "Postdoctoral Associate";

  it("reproduces the original pre-1996 boundary exactly, as of 2026", () => {
    expect(yearPlausibilityNote({ year: 1995, title: JUNIOR }, AT_2026)).not.toBeNull();
    // 1996 was NOT a suspect year under the original rule. Strictly-greater-than.
    expect(yearPlausibilityNote({ year: 1996, title: JUNIOR }, AT_2026)).toBeNull();
  });

  it("moves with the calendar rather than staying pinned to 1996", () => {
    const AT_2036 = new Date("2036-06-01T00:00:00Z");
    // A 2005 award is unremarkable in 2026 (21y) and suspect in 2036 (31y). A
    // hardcoded 1996 would call it fine forever.
    expect(yearPlausibilityNote({ year: 2005, title: JUNIOR }, AT_2026)).toBeNull();
    expect(yearPlausibilityNote({ year: 2005, title: JUNIOR }, AT_2036)).not.toBeNull();
  });

  it("defaults `now` to the real clock rather than requiring the caller to pass it", () => {
    // The production call site passes nothing; a very old award must still annotate.
    expect(yearPlausibilityNote({ year: 1970, title: JUNIOR })).not.toBeNull();
  });
});

describe("isHonorsQueueTabVisible", () => {
  const on = { HONORS_APPROVAL_QUEUE: "on" };
  const withEnv = <T,>(env: Record<string, string>, fn: () => T): T => {
    const prev = { ...process.env };
    Object.assign(process.env, env);
    try {
      return fn();
    } finally {
      process.env = prev as NodeJS.ProcessEnv;
    }
  };

  it("admits a non-superuser honors_curator — the whole point of the role", () => {
    // The Research Dean's office self-serves. If this is false the tab is invisible
    // to exactly the people it was built for.
    expect(
      withEnv(on, () => isHonorsQueueTabVisible({ isSuperuser: false, isHonorsCurator: true })),
    ).toBe(true);
  });

  it("admits a superuser who is NOT in the curator group", () => {
    // `isSuperuser || isHonorsCurator`, never bare: the session route reports
    // isDeveloper:false FOR a superuser, and a bare role read inherits that shape.
    expect(
      withEnv(on, () => isHonorsQueueTabVisible({ isSuperuser: true, isHonorsCurator: false })),
    ).toBe(true);
  });

  it("tolerates the flag being absent from a synthetic session", () => {
    expect(withEnv(on, () => isHonorsQueueTabVisible({ isSuperuser: true }))).toBe(true);
    expect(withEnv(on, () => isHonorsQueueTabVisible({ isSuperuser: false }))).toBe(false);
  });

  it("refuses everyone when the surface is dark, curator or not", () => {
    expect(
      withEnv({ HONORS_APPROVAL_QUEUE: "off" }, () =>
        isHonorsQueueTabVisible({ isSuperuser: true, isHonorsCurator: true }),
      ),
    ).toBe(false);
  });

  it("refuses a viewer who is neither", () => {
    expect(
      withEnv(on, () => isHonorsQueueTabVisible({ isSuperuser: false, isHonorsCurator: false })),
    ).toBe(false);
  });
});
