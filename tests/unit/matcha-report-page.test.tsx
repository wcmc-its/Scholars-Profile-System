/**
 * `/edit/matcha/report` — Matcha Phase 4, the printable scouting report (v2 coverage layout).
 *
 * Pinned here:
 *  - 404 unless BOTH `MATCHA` and `MATCHA_BRIEF` are on; the Matcha read gate, observers allowed;
 *  - the selection is checked against the SAVED result: unknown cwids are ignored, cap 50;
 *  - the rendered HTML never carries a brief note or a researcher email (the officer's own email
 *    on the cover is the only one), nor a score or `removedCount`;
 *  - edited text wins over generated; a PI with no brief renders records only, "No brief drafted."
 *  - the raw paste is never rendered; themes drive the coverage table, gaps callout and amber
 *    card, and all three are hidden when grouping fails (themes null);
 *  - v3 card: topics cite the numbered key papers as [n]; other sources go on an "Also:" line;
 *    funding is a strip of at most four (grouped) rows, then "+N more" to the profile.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { BriefRecords } from "@/lib/edit/matcha-brief-types";

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
  mockThemes,
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
  mockThemes: vi.fn(),
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
vi.mock("@/lib/api/matcha-report-themes", () => ({ loadReportThemes: mockThemes }));
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
  contributions: [{ term: "widgets", rank: 1 }],
  technologyCount: 0,
});

const CONCEPTS = [
  { term: "widgets", kind: "concept", members: ["widgets", "widget assembly"], centrality: 1, weightFactor: 1 },
  { term: "sprockets", kind: "concept", members: ["sprockets"], centrality: 0.5, weightFactor: 1 },
];
const THEMES = [
  { label: "Widget biology", terms: ["widgets"] },
  { label: "Sprocket outcomes", terms: ["sprockets"] },
];

const records = (cwid: string) => ({
  funding: [
    {
      // "b" holds only a foundation award: no mechanism.
      mechanism: cwid === "b" ? null : "R01",
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
  methods: [],
  trialCount: 0,
});

function setup(opts: {
  candidates: string[];
  briefs?: Record<string, unknown>[];
  contributions?: Record<string, { term: string; rank: number }[]>;
  themes?: typeof THEMES | null;
  requester?: string;
  requesterOverride?: string | null;
  records?: Record<string, Partial<BriefRecords>>;
}) {
  mockThemes.mockResolvedValue(opts.themes === undefined ? THEMES : opts.themes);
  mockSubFindUnique.mockResolvedValue({
    descriptionHash: "h1",
    description: "We want widget collaborators.",
    title: "widget · generated",
    titleOverride: "Industry ask: wave 1",
    requesterOverride: opts.requesterOverride ?? null,
  });
  mockSubFindMany.mockImplementation(async (args: { select: Record<string, boolean> }) =>
    args.select.resultKey
      ? [{ id: "r1", resultKey: "k1" }]
      : [
          {
            id: "r1",
            result: {
              ...(opts.requester ? { requester: opts.requester } : {}),
              concepts: CONCEPTS,
              candidates: opts.candidates.map((c, i) => ({
                ...candidate(c, 10 - i),
                ...(opts.contributions?.[c] ? { contributions: opts.contributions[c] } : {}),
              })),
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
      hasHeadshot: null,
      email: `${cwid}@researcher.example.org`,
    })),
  );
  mockPubFindMany.mockResolvedValue([]);
  mockLoadRecords.mockImplementation(
    async (cwids: string[]) =>
      new Map(cwids.map((c) => [c, { ...records(c), ...opts.records?.[c] }])),
  );
}

const brief = (cwid: string, extra: Record<string, unknown> = {}) => ({
  cwid,
  generated: {
    why: `Generated why for ${cwid}. More.`,
    topics: [
      {
        concept: "widgets",
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
      dept: "Information Technologies & Services",
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
    // Header: the search's Rename, the officer's name. The raw paste is gone.
    expect(html).toContain("Industry ask: wave 1");
    expect(html).toContain("Olive Officer, Information Technologies &amp; Services");
    // The unit is the officer's own directory department, never a hard-coded CTL.
    expect(html).not.toContain("Center for Technology Licensing");
    expect(html).not.toMatch(/reviewed by/i);
    expect(html).toMatch(/<img src="data:image\/svg\+xml;base64,[^"]+" alt="Weill Cornell Medicine"/);
    expect(html).not.toContain("We want widget collaborators.");
    expect(html).toContain("Two Weill Cornell investigators whose published work");
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

  it("renders the coverage table, totals, gaps callout and amber card from the themes", async () => {
    setup({
      candidates: ["a", "b"],
      briefs: [brief("a")],
      contributions: {
        a: [{ term: "widgets", rank: 3 }],
        b: [
          { term: "widgets", rank: 25 },
          { term: "sprockets", rank: 40 },
        ],
      },
    });
    const html = await renderPage({ submissionId: "s1", cwids: "a,b" });
    expect(mockThemes).toHaveBeenCalledWith("h1", CONCEPTS);
    expect(html).toContain("Coverage of your ask");
    expect(html).toContain("Your 3 search terms, grouped into two themes.");
    expect((html.match(/data-report-mark="primary"/g) ?? []).length).toBe(1 + 1); // cell + legend
    expect((html.match(/data-report-mark="related"/g) ?? []).length).toBe(2 + 1);
    expect((html.match(/data-report-mark="none"/g) ?? []).length).toBe(1);
    // Totals row: 2 PIs on widgets, 1 on sprockets.
    const totals = /data-report-totals[^]*?<\/tr>/.exec(html)?.[0] ?? "";
    expect(totals).toMatch(/>2<\/td>[^]*>1<\/td>/);
    // Sprocket outcomes has no primary cell: it is the gap, and b is the closest.
    expect(html).toContain("data-report-gaps=");
    expect(html).toContain("works directly on Sprocket outcomes.");
    expect(html).toContain("Dr b&#x27;s work is the closest match on Sprocket outcomes.");
    expect(html).toContain("data-report-gaps-card=");
    expect(html).toContain("area with no strong match yet: Sprocket outcomes");
    // Footer: every concept member.
    expect(html).toContain("Full search terms: widgets, widget assembly, sprockets.");
    // Shortlist: the first sentence of Why, and record chips.
    expect(html).toContain("Generated why for a.");
    expect(html).toContain("1 active NIH award");
  });

  it("hides coverage, gaps and the amber card when themes are null", async () => {
    setup({ candidates: ["a"], briefs: [brief("a")], themes: null });
    const html = await renderPage({ submissionId: "s1", cwids: "a" });
    expect(html).not.toContain("Coverage of your ask");
    expect(html).not.toContain("data-report-gaps=");
    expect(html).not.toContain("data-report-gaps-card=");
    expect(html).toContain("Shortlist");
    expect(html).toContain("data-report-pi=");
  });

  it("hides the gaps callout and card when every theme has a primary cell", async () => {
    setup({
      candidates: ["a"],
      contributions: { a: [{ term: "widgets", rank: 1 }, { term: "sprockets", rank: 10 }] },
    });
    const html = await renderPage({ submissionId: "s1", cwids: "a" });
    expect(html).toContain("Coverage of your ask");
    expect(html).not.toContain("data-report-gaps=");
  });

  it("drops the funding mechanism column for a PI whose awards have none", async () => {
    setup({ candidates: ["a", "b"], briefs: [brief("a"), brief("b")] });
    const html = await renderPage({ submissionId: "s1", cwids: "a,b" });
    expect(html.match(/grid-cols-\[56px_/g)).toHaveLength(1);
  });

  it("numbers key papers and cites them from topics; other sources go on an Also line", async () => {
    setup({
      candidates: ["a"],
      briefs: [
        brief("a", {
          generated: {
            why: "Why a.",
            topics: [
              {
                concept: "widgets",
                text: "Topic one",
                sources: [
                  { kind: "pub", pmid: "11", year: 2024, title: "Widget paper one" },
                  { kind: "pub", pmid: "12", year: 2023, title: "Widget paper two" },
                ],
              },
              {
                concept: "sprockets",
                text: "Topic two",
                sources: [
                  { kind: "pub", pmid: "13", year: 2022, title: "Sprocket paper three" },
                  {
                    kind: "pub",
                    pmid: "14",
                    year: 2025,
                    title: "Widget assembly kinetics in a randomized sprocket cohort of adults.",
                  },
                  { kind: "grant", mechanism: "R01", funder: "NIH", endYear: 2029, applId: 111 },
                ],
              },
              {
                concept: "widgets",
                text: "Topic three",
                sources: [{ kind: "pub", pmid: "12", year: 2023, title: "Widget paper two" }],
              },
              { concept: "widgets", text: "Topic four, unsourced", sources: [] },
            ],
            removedCount: 0,
          },
        }),
      ],
    });
    const html = await renderPage({ submissionId: "s1", cwids: "a" });
    // Key papers: the brief's own pubs, in order, numbered.
    for (const n of [1, 2, 3]) expect(html).toContain(`data-report-paper="${n}"`);
    expect(html).not.toContain('data-report-paper="4"');
    expect(html).toContain(">[1]</span>");
    expect(html).toMatch(
      /2024 · <a href="https:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/11\/"[^>]*>PMID 11 ↗<\/a>/,
    );
    // Topic cites, sorted and de-duplicated.
    expect(html).toMatch(/Topic one <sup data-report-cite="[^"]*"[^>]*>\[1, 2\]<\/sup>/);
    expect(html).toMatch(/Topic two <sup data-report-cite="[^"]*"[^>]*>\[3\]<\/sup>/);
    expect(html).toMatch(/Topic three <sup data-report-cite="[^"]*"[^>]*>\[2\]<\/sup>/);
    // A pub beyond the key papers and a grant: the Also line, clipped, joined with "; ".
    const doc = new DOMParser().parseFromString(html, "text/html");
    const also = doc.querySelectorAll("[data-report-also]");
    expect(also).toHaveLength(1);
    const alsoText = also[0]?.textContent ?? "";
    expect(alsoText).toContain(
      "Also: 2025 · Widget assembly kinetics in a randomized…; R01 (through 2029)",
    );
    // The unsourced topic carries neither cites nor an Also line.
    expect(html).toMatch(/Topic four, unsourced<\/span><\/div>/);
  });

  it("caps funding at four rows, groups shared stems, and links the rest to the profile", async () => {
    const award = (
      applId: number,
      mechanism: string,
      funder: string,
      title: string,
      endYear = 2027,
    ) => ({
      mechanism,
      funder,
      title,
      endYear,
      applId,
      roleLabel: "PI",
    });
    setup({
      candidates: ["a", "b"],
      briefs: [brief("a"), brief("b")],
      records: {
        a: {
          funding: [
            award(1, "R01", "NIH", "Alpha study", 2028),
            award(2, "P50", "NIMHD", "Widget Center: Core A"),
            award(3, "P50", "NIMHD", "Widget Center: Core B", 2028),
            award(4, "P50", "NIMHD", "Widget Center: Supplement"),
            // Same stem, different funder: not grouped.
            award(5, "P50", "NIDDK", "Widget Center: Core C"),
            award(6, "R01", "NIH", "Beta study", 2029),
            award(7, "U01", "NIH", "Gamma study", 2026),
          ],
          translation: [
            {
              title: "Sprocket imaging device",
              patentStatus: null,
              url: "https://tech.example.org/1",
            },
          ],
        },
      },
    });
    const html = await renderPage({ submissionId: "s1", cwids: "a,b" });
    const cardA = /data-report-pi="a"[^]*?<\/article>/.exec(html)?.[0] ?? "";
    const cardB = /data-report-pi="b"[^]*?<\/article>/.exec(html)?.[0] ?? "";
    expect(cardA).toContain("Active funding · 7");
    expect((cardA.match(/data-report-funding-row/g) ?? []).length).toBe(4);
    expect(cardA).toContain("Widget Center: Core A, Core B and Supplement (3 awards)");
    // A grouped row has no single RePORTER link, and ends at the group's latest year.
    expect(cardA).not.toContain('project-details/2"');
    expect(cardA).toMatch(/\(3 awards\)[^]*?to 2028/);
    expect(cardA).toContain("Widget Center: Core C");
    expect(cardA).toContain("Beta study");
    expect(cardA).not.toContain("Gamma study");
    // 7 awards, 6 shown (1 + 3 + 1 + 1): one more, linked to the profile.
    expect(cardA).toMatch(/href="[^"]*slug-a"[^>]*>\+1 more on Scholars profile ↗<\/a>/);
    // The strip sits after the key-papers rail, full width.
    expect(cardA.indexOf("data-report-funding=")).toBeGreaterThan(cardA.indexOf("Key papers"));
    // Technology: a tinted, labelled box.
    expect(cardA).toContain("Licensable technology");
    expect(cardA).toContain("data-report-tech");
    expect(cardA).toContain("Sprocket imaging device");
    expect(html).not.toContain("Available technology");
    // b's single award fits: no "+N more".
    expect(cardB).toContain("Active funding · 1");
    expect(cardB).not.toContain("more on Scholars profile");
  });

  it("shows the partnership angle under the header (edited wins), and omits it when empty", async () => {
    setup({
      candidates: ["a", "b", "c"],
      briefs: [
        brief("a", {
          generated: { ...brief("a").generated, angle: "Generated angle for a." },
          edited: { angle: "Edited angle for a." },
        }),
        brief("b", { generated: { ...brief("b").generated, angle: "Trial lead with patient data." } }),
        // Drafted before angles existed: no angle at all.
        brief("c"),
      ],
    });
    const html = await renderPage({ submissionId: "s1", cwids: "a,b,c" });
    const card = (cwid: string) =>
      new RegExp(`data-report-pi="${cwid}"[^]*?</article>`).exec(html)?.[0] ?? "";
    expect(card("a")).toContain("Partnership angle");
    expect(card("a")).toContain("Edited angle for a.");
    expect(card("a")).not.toContain("Generated angle for a.");
    // Directly under the header: before the "Why this investigator" section.
    expect(card("a").indexOf("Edited angle for a.")).toBeLessThan(
      card("a").indexOf("Why this investigator"),
    );
    expect(card("b")).toContain("Trial lead with patient data.");
    expect(card("c")).not.toContain("Partnership angle");
    expect(card("c")).not.toContain("data-report-angle");
  });

  it("lists methods and tools after the discussion topics, and omits the section when empty", async () => {
    setup({
      candidates: ["a", "b", "c"],
      briefs: [brief("a"), brief("b")],
      records: {
        a: {
          methods: [
            { name: "Mouse models", category: null, papers: 14 },
            { name: "Flow cytometry", category: null, papers: 1 },
          ],
          trialCount: 3,
        },
        b: { methods: [], trialCount: 0 },
        c: { methods: [], trialCount: 1 },
      },
    });
    const html = await renderPage({ submissionId: "s1", cwids: "a,b,c" });
    const card = (cwid: string) =>
      new RegExp(`data-report-pi="${cwid}"[^]*?</article>`).exec(html)?.[0] ?? "";
    expect(card("a")).toContain("Methods and tools");
    expect(card("a")).toContain("Mouse models · 14 papers");
    expect(card("a")).toContain("Flow cytometry · 1 paper");
    expect(card("a")).toContain("3 clinical trials on record");
    expect(card("a").indexOf("Suggested discussion topics")).toBeLessThan(
      card("a").indexOf("Methods and tools"),
    );
    expect(card("b")).not.toContain("Methods and tools");
    // Records, not the brief: shown for a PI with no brief, and a single trial reads singular.
    expect(card("c")).toContain("1 clinical trial on record");
  });

  it("404s a submission outside the caller's scope", async () => {
    setup({ candidates: ["a"] });
    mockSubFindUnique.mockResolvedValue(null);
    await expect(renderPage({ submissionId: "s1", cwids: "a" })).rejects.toThrow("__NOT_FOUND__");
  });

  it("shows Prepared for only when there is a requester, before Prepared by; the override wins", async () => {
    setup({ candidates: ["a"] });
    expect(await renderPage({ submissionId: "s1", cwids: "a" })).not.toContain("Prepared for");

    setup({ candidates: ["a"], requester: "Northlake Therapeutics" });
    let html = await renderPage({ submissionId: "s1", cwids: "a" });
    expect(html).toContain("Prepared for");
    expect(html).toContain("Northlake Therapeutics");
    expect(html.indexOf("Prepared for")).toBeLessThan(html.indexOf("Prepared by"));

    setup({
      candidates: ["a"],
      requester: "Northlake Therapeutics",
      requesterOverride: "Quillfin Bio",
    });
    html = await renderPage({ submissionId: "s1", cwids: "a" });
    expect(html).toContain("Quillfin Bio");
    expect(html).not.toContain("Northlake Therapeutics");
  });
});
