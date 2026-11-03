/**
 * `/edit/matcha/report` — Matcha Phase 4, the printable scouting report.
 *
 * Pinned here:
 *  - 404 unless BOTH `MATCHA` and `MATCHA_BRIEF` are on; the Matcha read gate, observers allowed;
 *  - the selection is checked against the SAVED result: unknown cwids are ignored, cap 50;
 *  - the rendered HTML never carries a brief note or a researcher email (the officer's own email
 *    on the cover is the only one), nor a score or `removedCount`;
 *  - edited text wins over generated; a PI with no brief renders records only, "No brief drafted."
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const {
  mockGetSession,
  mockSubFindUnique,
  mockSubFindMany,
  mockBriefFindMany,
  mockScholarFindMany,
  mockScholarFindUnique,
  mockPubFindMany,
  mockLoadRecords,
  mockDirectory,
} = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockSubFindUnique: vi.fn(),
  mockSubFindMany: vi.fn(),
  mockBriefFindMany: vi.fn(),
  mockScholarFindMany: vi.fn(),
  mockScholarFindUnique: vi.fn(),
  mockPubFindMany: vi.fn(),
  mockLoadRecords: vi.fn(),
  mockDirectory: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("__NOT_FOUND__");
  },
  redirect: (url: string) => {
    throw new Error(`__REDIRECT__:${url}`);
  },
}));
vi.mock("@/lib/db", () => ({
  db: {
    read: {
      sponsorMatchSubmission: { findUnique: mockSubFindUnique, findMany: mockSubFindMany },
      matchaBrief: { findMany: mockBriefFindMany },
      scholar: { findMany: mockScholarFindMany, findUnique: mockScholarFindUnique },
      publication: { findMany: mockPubFindMany },
    },
  },
}));
vi.mock("@/lib/auth/effective-identity", () => ({ getEffectiveEditSession: mockGetSession }));
vi.mock("@/lib/edit/authz", () => ({ logEditDenial: vi.fn() }));
vi.mock("@/lib/sources/ldap", () => ({ fetchDirectoryPeopleByCwid: mockDirectory }));
vi.mock("@/components/edit/forbidden-edit-page", () => ({
  ForbiddenEditPage: () => <p>__FORBIDDEN__</p>,
}));
vi.mock("@/lib/api/matcha-brief", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/matcha-brief")>()),
  loadBriefRecords: mockLoadRecords,
}));

import MatchaReportPage from "@/app/edit/matcha/report/page";

const OFFICER = { cwid: "off1", isSuperuser: false, isDeveloper: true };
const OFFICER_EMAIL = "officer@example.org";

const candidate = (cwid: string, fusedScore = 1) => ({
  cwid,
  name: `Cand ${cwid}`,
  profileSlug: `slug-${cwid}`,
  title: "Professor",
  department: "Medicine",
  fusedScore,
  contributions: [{ term: "obesity", rank: 1 }],
  technologyCount: 0,
});

const records = (cwid: string) => ({
  funding: [
    {
      mechanism: "R01",
      funder: "NIH",
      title: `Award for ${cwid}`,
      endYear: 2029,
      applId: 111,
      roleLabel: "PI",
    },
  ],
  translation: [],
  secondaryAppointments: [],
  centers: [],
});

function setup(opts: { candidates: string[]; briefs?: Record<string, unknown>[] }) {
  mockSubFindUnique.mockResolvedValue({
    descriptionHash: "h1",
    description: "We want obesity collaborators.",
    title: "obesity · generated",
    titleOverride: "Industry ask: wave 1",
  });
  mockSubFindMany.mockImplementation(async (args: { select: Record<string, boolean> }) =>
    args.select.resultKey
      ? [{ id: "r1", resultKey: "k1" }]
      : [
          {
            id: "r1",
            result: {
              concepts: [],
              candidates: opts.candidates.map((c, i) => candidate(c, 10 - i)),
            },
          },
        ],
  );
  mockBriefFindMany.mockImplementation(async (args: { where: { cwid: { in: string[] } } }) =>
    (opts.briefs ?? []).filter((b) => args.where.cwid.in.includes(b.cwid as string)),
  );
  // The mock ignores `select`, so a row carrying an email proves the VIEW never reads it.
  mockScholarFindMany.mockImplementation(async (args: { where: { cwid: { in: string[] } } }) =>
    args.where.cwid.in.map((cwid) => ({
      cwid,
      preferredName: `Dr ${cwid}`,
      postnominal: null,
      primaryTitle: "Professor of Medicine",
      primaryDepartment: "Medicine",
      slug: `slug-${cwid}`,
      email: `${cwid}@researcher.example.org`,
    })),
  );
  mockPubFindMany.mockResolvedValue([]);
  mockLoadRecords.mockImplementation(
    async (cwids: string[]) => new Map(cwids.map((c) => [c, records(c)])),
  );
}

const brief = (cwid: string, extra: Record<string, unknown> = {}) => ({
  cwid,
  generated: {
    why: `Generated why for ${cwid}. More.`,
    topics: [
      {
        concept: "obesity",
        text: `Generated topic ${cwid}`,
        sources: [{ kind: "pub", pmid: "999", year: 2024, title: "A cited paper" }],
      },
    ],
    removedCount: 7,
  },
  edited: null,
  note: "PRIVATE NOTE never exported",
  createdAt: new Date("2026-11-02T15:00:00Z"),
  ...extra,
});

async function renderPage(params: Record<string, string>) {
  const tree = await MatchaReportPage({ searchParams: Promise.resolve(params) });
  return renderToStaticMarkup(tree);
}

beforeEach(() => {
  vi.stubEnv("MATCHA", "on");
  vi.stubEnv("MATCHA_BRIEF", "on");
  mockGetSession.mockResolvedValue(OFFICER);
  mockDirectory.mockResolvedValue([
    {
      cwid: "off1",
      name: "Officer One",
      firstName: "Olive",
      lastName: "Officer",
      email: OFFICER_EMAIL,
      title: null,
      dept: null,
    },
  ]);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("Matcha report page", () => {
  it("404s when MATCHA_BRIEF is off", async () => {
    vi.stubEnv("MATCHA_BRIEF", "off");
    setup({ candidates: ["a"] });
    await expect(renderPage({ submissionId: "s1", cwids: "a" })).rejects.toThrow("__NOT_FOUND__");
    expect(mockSubFindUnique).not.toHaveBeenCalled();
  });

  it("404s when MATCHA is off", async () => {
    vi.stubEnv("MATCHA", "off");
    setup({ candidates: ["a"] });
    await expect(renderPage({ submissionId: "s1", cwids: "a" })).rejects.toThrow("__NOT_FOUND__");
  });

  it("refuses a viewer outside the Matcha read gate, and lets an observer read", async () => {
    setup({ candidates: ["a"], briefs: [brief("a")] });
    mockGetSession.mockResolvedValue({ cwid: "x", isSuperuser: false, isDeveloper: false });
    expect(await renderPage({ submissionId: "s1", cwids: "a" })).toContain("__FORBIDDEN__");
    expect(mockSubFindUnique).not.toHaveBeenCalled();

    mockGetSession.mockResolvedValue({ cwid: "obs", isSuperuser: false, isObserver: true });
    const html = await renderPage({ submissionId: "s1", cwids: "a" });
    expect(html).toContain("Generated why for a.");
    // Scoped like Recent: a non-privileged viewer only reaches their own submission.
    expect(mockSubFindUnique.mock.calls[0][0].where).toEqual({ id: "s1", submittedBy: "obs" });
  });

  it("ignores cwids not in the stored result and caps at 50", async () => {
    const known = Array.from({ length: 60 }, (_, i) => `k${i + 1}`);
    setup({ candidates: known });
    const html = await renderPage({
      submissionId: "s1",
      cwids: ["ghost1", ...known, "ghost2"].join(","),
    });
    const asked = mockBriefFindMany.mock.calls[0][0].where.cwid.in as string[];
    expect(asked).toEqual(known.slice(0, 50));
    expect(mockLoadRecords).toHaveBeenCalledWith(known.slice(0, 50));
    expect(html).not.toContain("ghost");
    expect(html).toContain("Dr k50");
    expect(html).not.toContain("Dr k51");
    expect((html.match(/data-report-pi=/g) ?? []).length).toBe(50);
  });

  it("renders no notes, no researcher emails, no scores and no removed count", async () => {
    setup({ candidates: ["a", "b"], briefs: [brief("a")] });
    const html = await renderPage({ submissionId: "s1", cwids: "a,b" });
    expect(html).not.toContain("PRIVATE NOTE");
    expect(html).not.toContain("researcher.example.org");
    const emails = html.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) ?? [];
    expect(new Set(emails)).toEqual(new Set([OFFICER_EMAIL]));
    expect(html).not.toMatch(/removed|fusedScore/i);
    // Cover: the search's Rename, the officer's name.
    expect(html).toContain("Industry ask: wave 1");
    expect(html).toContain("Olive Officer");
    expect(html).toContain("We want obesity collaborators.");
  });

  it("uses edited text over generated, and marks a PI with no brief", async () => {
    setup({
      candidates: ["a", "b"],
      briefs: [
        brief("a", {
          edited: {
            why: "Officer edited why. Second.",
            topics: [{ concept: "", text: "Officer topic", sources: [] }],
          },
        }),
      ],
    });
    const html = await renderPage({ submissionId: "s1", cwids: "a,b" });
    expect(html).toContain("Officer edited why.");
    expect(html).toContain("Officer topic");
    expect(html).not.toContain("Generated why for a");
    expect(html).not.toContain("Generated topic a");
    // b has no brief: records only (its funding still renders), marked.
    expect(html).toContain("Award for b");
    expect(html).toContain("No brief drafted.");
    expect(html).toContain("https://reporter.nih.gov/project-details/111");
  });

  it("404s a submission outside the caller's scope", async () => {
    setup({ candidates: ["a"] });
    mockSubFindUnique.mockResolvedValue(null);
    await expect(renderPage({ submissionId: "s1", cwids: "a" })).rejects.toThrow("__NOT_FOUND__");
  });
});
