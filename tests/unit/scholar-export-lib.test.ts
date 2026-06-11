/**
 * Tests for lib/api/export-scholars.ts — the #847 internal scholar-list CSV
 * builder.
 *
 * Locked v1 invariants exercised here:
 *   - Ranked + capped: the roster is the scope's OWN ranking, capped at
 *     SCHOLAR_EXPORT_CAP (50). The cap is DB-enforced for method-family/topic/
 *     subtopic (asserted via the `take` call arg) and JS-enforced for
 *     supercategory (exercised by feeding 60 distinct scholars and expecting 50).
 *   - Documented columns: the header row is exactly SCOPE_HEADERS[scope]; each
 *     row carries `rank` (1-indexed) and `profile_url` (the root `/{slug}` form).
 *   - NO contact column EVER: neither the header nor any body cell contains an
 *     "email" / contact field.
 *
 * The resolvers (`getFamily` / `getSupercategory` / `getTopic`) and the overlay
 * gate are mocked so the builder runs without a DB; `prisma` is mocked so the
 * ranked loaders return controlled rows. `toCsv` + `profilePath` are PURE and
 * left real so the serialized output is asserted end-to-end.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const {
  mockScholarFamilyFindMany,
  mockScholarFindMany,
  mockPublicationTopicGroupBy,
  mockPublicationAuthorGroupBy,
  mockSubtopicFindFirst,
} = vi.hoisted(() => ({
  mockScholarFamilyFindMany: vi.fn(),
  mockScholarFindMany: vi.fn(),
  mockPublicationTopicGroupBy: vi.fn(),
  mockPublicationAuthorGroupBy: vi.fn(),
  mockSubtopicFindFirst: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    scholarFamily: { findMany: mockScholarFamilyFindMany },
    scholar: { findMany: mockScholarFindMany },
    publicationTopic: { groupBy: mockPublicationTopicGroupBy },
    publicationAuthor: { groupBy: mockPublicationAuthorGroupBy },
    subtopic: { findFirst: mockSubtopicFindFirst },
  },
}));

vi.mock("@/lib/api/methods", () => ({
  getFamily: vi.fn(),
  getSupercategory: vi.fn(),
}));

vi.mock("@/lib/api/topics", () => ({
  getTopic: vi.fn(),
}));

vi.mock("@/lib/api/methods-overlay", () => ({
  loadFamilyOverlayGate: vi.fn(),
  isFamilyPubliclyVisible: vi.fn(),
}));

import {
  buildScholarExport,
  SCHOLAR_EXPORT_CAP,
  SCOPE_HEADERS,
} from "@/lib/api/export-scholars";
import { getFamily, getSupercategory } from "@/lib/api/methods";
import { getTopic } from "@/lib/api/topics";
import { loadFamilyOverlayGate, isFamilyPubliclyVisible } from "@/lib/api/methods-overlay";

/** A scholar identity row as SCHOLAR_SELECT projects it. */
function scholar(i: number) {
  return {
    cwid: `cwid${i}`,
    slug: `slug-${i}`,
    preferredName: `Scholar ${i}`,
    postnominal: i % 2 === 0 ? "Ph.D." : null,
    primaryTitle: `Title ${i}`,
    primaryDepartment: `Dept ${i}`,
    roleCategory: "full_time_faculty",
    email: `scholar${i}@med.cornell.edu`,
  };
}

/** Parse a CSV string (CRLF rows) into [header[], ...body[][]]. */
function parseCsv(csv: string): string[][] {
  return csv
    .trim()
    .split("\r\n")
    .map((line) => line.split(","));
}

beforeEach(() => {
  vi.mocked(loadFamilyOverlayGate).mockReset();
  vi.mocked(isFamilyPubliclyVisible).mockReset();
  vi.mocked(getFamily).mockReset();
  vi.mocked(getSupercategory).mockReset();
  vi.mocked(getTopic).mockReset();
  mockScholarFamilyFindMany.mockReset();
  mockScholarFindMany.mockReset();
  mockPublicationTopicGroupBy.mockReset();
  mockPublicationAuthorGroupBy.mockReset();
  mockSubtopicFindFirst.mockReset();

  // Default: overlay gate present and every family publicly visible.
  vi.mocked(loadFamilyOverlayGate).mockResolvedValue({} as never);
  vi.mocked(isFamilyPubliclyVisible).mockReturnValue(true);
});

describe("buildScholarExport — method-family scope", () => {
  it("caps the roster at SCHOLAR_EXPORT_CAP (50) and emits the documented columns", async () => {
    vi.mocked(getFamily).mockResolvedValue({
      supercategory: "animal_cell_models",
      supercategorySlug: "animal-cell-models",
      familyId: "fam_x",
      familyLabel: "CRISPR screens",
      familySlug: "crispr-screens-fam_x",
    } as never);

    // The loader itself passes `take: SCHOLAR_EXPORT_CAP` to prisma; simulate the
    // DB honoring that cap so even a generous source yields <= 50 body rows.
    const rows = Array.from({ length: SCHOLAR_EXPORT_CAP }, (_, i) => ({
      pmidCount: SCHOLAR_EXPORT_CAP - i, // already ranked desc
      scholar: scholar(i),
    }));
    mockScholarFamilyFindMany.mockResolvedValue(rows);

    const result = await buildScholarExport("method-family", {
      supercategory: "animal-cell-models",
      family: "crispr-screens-fam_x",
    });

    expect(result).not.toBeNull();
    expect(result!.filename).toMatch(/^Method-Family-Scholars-\d{4}-\d{2}-\d{2}\.csv$/);

    const table = parseCsv(result!.csv);
    const header = table[0];
    const body = table.slice(1);

    // Header is exactly the documented per-scope header set.
    expect(header).toEqual([...SCOPE_HEADERS["method-family"]]);
    // The cap is DB-enforced for this scope: the loader MUST ask prisma for at
    // most SCHOLAR_EXPORT_CAP rows (deleting `take` would silently uncap it).
    expect(mockScholarFamilyFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: SCHOLAR_EXPORT_CAP }),
    );
    // Body capped at 50.
    expect(body.length).toBe(SCHOLAR_EXPORT_CAP);
    expect(body.length).toBeLessThanOrEqual(50);

    // rank + profile_url present and correctly shaped on the first row.
    const rankIdx = header.indexOf("rank");
    const urlIdx = header.indexOf("profile_url");
    expect(rankIdx).toBeGreaterThanOrEqual(0);
    expect(urlIdx).toBeGreaterThanOrEqual(0);
    expect(body[0][rankIdx]).toBe("1");
    expect(body[49][rankIdx]).toBe("50");
    expect(body[0][urlIdx]).toBe("/slug-0"); // root `/{slug}` form (profilePath)

    // The scope count column is the per-family pub count.
    const countIdx = header.indexOf("pubs_in_family");
    expect(body[0][countIdx]).toBe(String(SCHOLAR_EXPORT_CAP));

    // NO email / contact column anywhere — header or body.
    expect(result!.csv.toLowerCase()).not.toContain("email");
    expect(header.some((h) => h.toLowerCase().includes("email"))).toBe(false);
    expect(header.some((h) => h.toLowerCase().includes("phone"))).toBe(false);
  });

  it("blanks profile_url for hidden-display roles (doctoral students), matching the unlinked public roster (#536)", async () => {
    vi.mocked(getFamily).mockResolvedValue({
      supercategory: "animal_cell_models",
      supercategorySlug: "animal-cell-models",
      familyId: "fam_x",
      familyLabel: "CRISPR screens",
      familySlug: "crispr-screens-fam_x",
    } as never);

    // A faculty scholar (linked) and a doctoral student (listed but unlinked).
    mockScholarFamilyFindMany.mockResolvedValue([
      { pmidCount: 9, scholar: scholar(0) },
      { pmidCount: 8, scholar: { ...scholar(1), roleCategory: "doctoral_student" } },
    ]);

    const result = await buildScholarExport("method-family", {
      supercategory: "animal-cell-models",
      family: "crispr-screens-fam_x",
    });

    const table = parseCsv(result!.csv);
    const header = table[0];
    const body = table.slice(1);
    const urlIdx = header.indexOf("profile_url");

    // Both scholars are present (all roles), but only the publicly-displayed
    // one carries a link; the doctoral student's URL cell is blank.
    expect(body.length).toBe(2);
    expect(body[0][urlIdx]).toBe("/slug-0");
    expect(body[1][urlIdx]).toBe("");
  });

  it("returns null when the family does not resolve", async () => {
    vi.mocked(getFamily).mockResolvedValue(null as never);
    const result = await buildScholarExport("method-family", {
      supercategory: "x",
      family: "y",
    });
    expect(result).toBeNull();
  });

  it("returns null when required params are missing", async () => {
    const result = await buildScholarExport("method-family", { supercategory: "x" });
    expect(result).toBeNull();
    expect(getFamily).not.toHaveBeenCalled();
  });

  it("drops scholars from suppressed/sensitive families (overlay gate not bypassed)", async () => {
    vi.mocked(getFamily).mockResolvedValue({
      supercategory: "animal_cell_models",
      supercategorySlug: "animal-cell-models",
      familyId: "fam_x",
      familyLabel: "Gated family",
      familySlug: "gated-family-fam_x",
    } as never);
    // The family fails the public-visibility gate -> roster is empty (header-only).
    vi.mocked(isFamilyPubliclyVisible).mockReturnValue(false);
    mockScholarFamilyFindMany.mockResolvedValue([{ pmidCount: 9, scholar: scholar(0) }]);

    const result = await buildScholarExport("method-family", {
      supercategory: "animal-cell-models",
      family: "gated-family-fam_x",
    });

    expect(result).not.toBeNull();
    const table = parseCsv(result!.csv);
    expect(table.length).toBe(1); // header only — no scholar leaked
    expect(mockScholarFamilyFindMany).not.toHaveBeenCalled();
  });
});

describe("buildScholarExport — supercategory scope", () => {
  it("aggregates per-scholar pub count, ranks desc, and emits top_family", async () => {
    vi.mocked(getSupercategory).mockResolvedValue({
      id: "animal_cell_models",
      slug: "animal-cell-models",
      label: "Animal & Cell Models",
      description: "",
    } as never);

    // Two families for one scholar; the more-prolific one is the top_family.
    mockScholarFamilyFindMany.mockResolvedValue([
      { familyLabel: "Family A", pmidCount: 3, scholar: scholar(0) },
      { familyLabel: "Family B", pmidCount: 7, scholar: scholar(0) },
      { familyLabel: "Family A", pmidCount: 2, scholar: scholar(1) },
    ]);

    const result = await buildScholarExport("supercategory", {
      supercategory: "animal-cell-models",
    });

    expect(result).not.toBeNull();
    expect(result!.filename).toMatch(/^Supercategory-Scholars-\d{4}-\d{2}-\d{2}\.csv$/);

    const table = parseCsv(result!.csv);
    const header = table[0];
    const body = table.slice(1);

    expect(header).toEqual([...SCOPE_HEADERS.supercategory]);
    expect(body.length).toBe(2);

    const sumIdx = header.indexOf("pubs_in_supercategory");
    const topIdx = header.indexOf("top_family");
    // Scholar 0 (3 + 7 = 10) ranks above scholar 1 (2).
    expect(body[0][sumIdx]).toBe("10");
    expect(body[0][topIdx]).toBe("Family B");
    expect(body[1][sumIdx]).toBe("2");

    expect(result!.csv.toLowerCase()).not.toContain("email");
  });

  it("caps at SCHOLAR_EXPORT_CAP (50) when more than 50 distinct scholars qualify", async () => {
    vi.mocked(getSupercategory).mockResolvedValue({
      id: "animal_cell_models",
      slug: "animal-cell-models",
      label: "Animal & Cell Models",
      description: "",
    } as never);

    // 60 distinct scholars, one family row each — the supercategory loader caps
    // in JS via `.slice(0, SCHOLAR_EXPORT_CAP)`, so this genuinely exercises the
    // cap (a removed/broken slice would leak all 60 rows).
    const rows = Array.from({ length: 60 }, (_, i) => ({
      familyLabel: `Family ${i}`,
      pmidCount: 60 - i, // already ranked desc
      scholar: scholar(i),
    }));
    mockScholarFamilyFindMany.mockResolvedValue(rows);

    const result = await buildScholarExport("supercategory", {
      supercategory: "animal-cell-models",
    });

    expect(result).not.toBeNull();
    const body = parseCsv(result!.csv).slice(1);
    expect(body.length).toBe(SCHOLAR_EXPORT_CAP);
  });
});

describe("buildScholarExport — topic scope", () => {
  it("ranks by distinct pub count per scholar and maps the documented columns", async () => {
    vi.mocked(getTopic).mockResolvedValue({ id: "cardio", label: "Cardio" } as never);

    mockPublicationTopicGroupBy.mockResolvedValue([
      { cwid: "cwid0", _count: { pmid: 12 } },
      { cwid: "cwid1", _count: { pmid: 5 } },
    ]);
    mockScholarFindMany.mockResolvedValue([scholar(0), scholar(1)]);

    const result = await buildScholarExport("topic", { slug: "cardio" });

    expect(result).not.toBeNull();
    expect(result!.filename).toMatch(/^Topic-Scholars-\d{4}-\d{2}-\d{2}\.csv$/);

    const table = parseCsv(result!.csv);
    const header = table[0];
    const body = table.slice(1);

    expect(header).toEqual([...SCOPE_HEADERS.topic]);
    expect(body.length).toBe(2);

    const rankIdx = header.indexOf("rank");
    const urlIdx = header.indexOf("profile_url");
    const countIdx = header.indexOf("pubs_in_topic");
    expect(body[0][rankIdx]).toBe("1");
    expect(body[0][urlIdx]).toBe("/slug-0");
    expect(body[0][countIdx]).toBe("12");

    expect(result!.csv.toLowerCase()).not.toContain("email");
  });

  it("returns null when the topic does not resolve", async () => {
    vi.mocked(getTopic).mockResolvedValue(null as never);
    const result = await buildScholarExport("topic", { slug: "nope" });
    expect(result).toBeNull();
  });
});

describe("buildScholarExport — subtopic scope", () => {
  it("emits pubs_in_subtopic + pubs_total and resolves the subtopic under its topic", async () => {
    vi.mocked(getTopic).mockResolvedValue({ id: "cardio", label: "Cardio" } as never);
    mockSubtopicFindFirst.mockResolvedValue({ id: "sub_a" });

    mockPublicationTopicGroupBy.mockResolvedValue([
      { cwid: "cwid0", _count: { pmid: 8 } },
    ]);
    mockScholarFindMany.mockResolvedValue([scholar(0)]);
    mockPublicationAuthorGroupBy.mockResolvedValue([{ cwid: "cwid0", _count: { pmid: 40 } }]);

    const result = await buildScholarExport("subtopic", {
      slug: "cardio",
      subtopic: "sub_a",
    });

    expect(result).not.toBeNull();
    const table = parseCsv(result!.csv);
    const header = table[0];
    const body = table.slice(1);

    expect(header).toEqual([...SCOPE_HEADERS.subtopic]);
    expect(body[0][header.indexOf("pubs_in_subtopic")]).toBe("8");
    expect(body[0][header.indexOf("pubs_total")]).toBe("40");

    expect(result!.csv.toLowerCase()).not.toContain("email");
  });

  it("returns null when the subtopic is not under the resolved topic", async () => {
    vi.mocked(getTopic).mockResolvedValue({ id: "cardio", label: "Cardio" } as never);
    mockSubtopicFindFirst.mockResolvedValue(null);

    const result = await buildScholarExport("subtopic", {
      slug: "cardio",
      subtopic: "from-another-topic",
    });
    expect(result).toBeNull();
  });
});

describe("buildScholarExport — includeEmail option (#866 UC-B)", () => {
  function resolveCrisprFamily() {
    vi.mocked(getFamily).mockResolvedValue({
      supercategory: "animal_cell_models",
      supercategorySlug: "animal-cell-models",
      familyId: "fam_x",
      familyLabel: "CRISPR screens",
      familySlug: "crispr-screens-fam_x",
    } as never);
  }

  it("inserts the email column immediately after profile_url and carries each scholar's email", async () => {
    resolveCrisprFamily();
    mockScholarFamilyFindMany.mockResolvedValue([
      { pmidCount: 9, scholar: scholar(0) },
      { pmidCount: 8, scholar: scholar(1) },
    ]);

    const result = await buildScholarExport(
      "method-family",
      { supercategory: "animal-cell-models", family: "crispr-screens-fam_x" },
      undefined,
      { includeEmail: true },
    );

    const table = parseCsv(result!.csv);
    const header = table[0];
    const body = table.slice(1);

    // `email` sits right after `profile_url` (and the no-email canonical headers
    // are otherwise unchanged, with `email` spliced in).
    const urlIdx = header.indexOf("profile_url");
    expect(header[urlIdx + 1]).toBe("email");
    expect(header).toEqual([
      ...SCOPE_HEADERS["method-family"].slice(0, urlIdx + 1),
      "email",
      ...SCOPE_HEADERS["method-family"].slice(urlIdx + 1),
    ]);

    // A faculty row carries the scholar's email.
    const emailIdx = header.indexOf("email");
    expect(body[0][emailIdx]).toBe("scholar0@med.cornell.edu");
    expect(body[1][emailIdx]).toBe("scholar1@med.cornell.edu");
  });

  it("blanks email for hidden-display roles (doctoral / affiliate alumni), mirroring profile_url", async () => {
    resolveCrisprFamily();
    mockScholarFamilyFindMany.mockResolvedValue([
      { pmidCount: 9, scholar: scholar(0) },
      { pmidCount: 8, scholar: { ...scholar(1), roleCategory: "doctoral_student" } },
      { pmidCount: 7, scholar: { ...scholar(2), roleCategory: "affiliate_alumni" } },
    ]);

    const result = await buildScholarExport(
      "method-family",
      { supercategory: "animal-cell-models", family: "crispr-screens-fam_x" },
      undefined,
      { includeEmail: true },
    );

    const table = parseCsv(result!.csv);
    const header = table[0];
    const body = table.slice(1);
    const emailIdx = header.indexOf("email");
    const urlIdx = header.indexOf("profile_url");

    // Faculty: email + link present. Hidden-display roles: BOTH blank, in lockstep.
    expect(body[0][emailIdx]).toBe("scholar0@med.cornell.edu");
    expect(body[0][urlIdx]).toBe("/slug-0");
    expect(body[1][emailIdx]).toBe("");
    expect(body[1][urlIdx]).toBe("");
    expect(body[2][emailIdx]).toBe("");
    expect(body[2][urlIdx]).toBe("");
  });

  it("emits a blank email cell (not the column's absence) when a faculty scholar has no email", async () => {
    resolveCrisprFamily();
    mockScholarFamilyFindMany.mockResolvedValue([
      { pmidCount: 9, scholar: { ...scholar(0), email: null } },
    ]);

    const result = await buildScholarExport(
      "method-family",
      { supercategory: "animal-cell-models", family: "crispr-screens-fam_x" },
      undefined,
      { includeEmail: true },
    );

    const table = parseCsv(result!.csv);
    const header = table[0];
    const body = table.slice(1);
    expect(header).toContain("email");
    expect(body[0][header.indexOf("email")]).toBe("");
  });

  it("includeEmail=false leaves the output byte-identical to the no-email canonical (no email column)", async () => {
    resolveCrisprFamily();
    const rows = [
      { pmidCount: 9, scholar: scholar(0) },
      { pmidCount: 8, scholar: scholar(1) },
    ];

    // Default (omitted) and explicit false both produce the canonical output.
    mockScholarFamilyFindMany.mockResolvedValue(rows);
    const defaulted = await buildScholarExport("method-family", {
      supercategory: "animal-cell-models",
      family: "crispr-screens-fam_x",
    });

    mockScholarFamilyFindMany.mockResolvedValue(rows);
    const explicitFalse = await buildScholarExport(
      "method-family",
      { supercategory: "animal-cell-models", family: "crispr-screens-fam_x" },
      undefined,
      { includeEmail: false },
    );

    expect(defaulted!.csv).toBe(explicitFalse!.csv);

    const header = parseCsv(defaulted!.csv)[0];
    expect(header).toEqual([...SCOPE_HEADERS["method-family"]]);
    expect(header.some((h) => h.toLowerCase().includes("email"))).toBe(false);
    expect(defaulted!.csv.toLowerCase()).not.toContain("@med.cornell.edu");
  });
});
