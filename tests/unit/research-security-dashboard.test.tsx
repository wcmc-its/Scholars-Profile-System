/**
 * `components/edit/research-security-dashboard.tsx` — the rendered page body:
 * the caution, the headline tiles, the tabs and filters as plain GET state,
 * and the markers that keep the not-yet-attributed tier out of confirmed counts.
 */
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  ResearchSecurityDashboard,
  type ResearchSecurityDashboardProps,
} from "@/components/edit/research-security-dashboard";
import type { ArticleFact, PersonFact, PersonProfile } from "@/lib/api/research-security-report";
import { parseResearchSecurityParams } from "@/lib/edit/research-security-dashboard";
import { buildResearchSecurityMethodsDoc } from "@/lib/edit/research-security-methods-doc";

const article: ArticleFact = {
  articleId: "39243855",
  pmid: 39243855,
  title: "Regulation of gene expression",
  journal: "BBA",
  publicationDate: new Date("2024-09-05T00:00:00Z"),
  publicationType: "Academic Article",
  totalAuthors: 3,
  doi: null,
  source: "pubmed",
};
const candidate: PersonFact = {
  articleId: article.articleId,
  cwid: "gux2002",
  displayName: "Guoqiang Xu",
  firstName: "Guoqiang",
  lastName: "Xu",
  campus: "wcm",
  department: "Medicine",
  title: null,
  attribution: "pending",
  inReviewQueue: false,
  reciterScore: 100,
};

const profile: PersonProfile = {
  cwid: "abc2001",
  name: "Ann Chen",
  campus: "wcm",
  department: "Medicine",
  title: "Professor",
  confirmedPapers: 12,
  confirmedExcludingConsortia: 11,
  firstYear: 2019,
  lastYear: 2025,
  listsEntityPapers: 2,
  openPapers: 3,
  openAlreadyConfirmed: 1,
  openInReviewQueue: 0,
  openListsEntity: 1,
  scoreMin: 53.8,
  scoreMax: 96.5,
  fundingFlagPapers: 0,
  entities: [{ entity: "China", confirmed: 12, open: 3 }],
  coAuthors: [{ cwid: "xyz1", name: "Lin Zeng", papers: 4 }],
};

function props(over: Partial<ResearchSecurityDashboardProps> = {}): ResearchSecurityDashboardProps {
  return {
    ui: parseResearchSecurityParams({}),
    summary: {
      tier: "entity",
      coPublications: 1799,
      coPublicationsExcludingConsortia: 1500,
      people: 1038,
      entities: 130,
      fundingFlagPapers: 67,
      unattributedPapers: 1354,
    },
    tabCounts: { entity: 130, person: 1038, paper: 1799, funding: 67, unattributed: 1354 },
    current: {
      view: "entity",
      rows: [
        {
          listCode: "house-1286-nominations",
          category: "SASTIND university",
          listNo: 32,
          entity: "Shanghai Jiao Tong University",
          papers: 357,
          papersWcm: 254,
          papersIthaca: 105,
          papersExcludingConsortia: 294,
          people: 280,
          papersOurAuthorListsEntity: 52,
          unattributedPapers: 201,
          unattributedPriority12: 125,
        },
      ],
    },
    page: 1,
    totalPages: 3,
    categories: ["CAS institute", "SASTIND university"],
    entities: ["Shanghai Jiao Tong University", "Soochow University"],
    dataAsOf: new Date("2026-11-17T08:00:00Z"),
    methods: buildResearchSecurityMethodsDoc(),
    ...over,
  };
}

describe("ResearchSecurityDashboard", () => {
  it("leads with the screening caution and carries the methods", () => {
    render(<ResearchSecurityDashboard {...props()} />);
    expect(screen.getByRole("note").textContent).toContain("screening results, not determinations");
    expect(screen.getByRole("heading", { name: "Methods & assumptions" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Known limits" })).toBeTruthy();
  });

  it("shows the headline tiles and says country of concern is not in them", () => {
    render(<ResearchSecurityDashboard {...props()} />);
    expect(screen.getByText("Listed-entity co-publications")).toBeTruthy();
    // The tile and the By paper tab both show the confirmed count.
    expect(screen.getAllByText("1,799")).toHaveLength(2);
    expect(screen.getByText(/Papers awaiting review · not in any confirmed count/)).toBeTruthy();
    expect(screen.getByText(/country-of-concern matches are a separate tier/)).toBeTruthy();
  });

  it("labels the country tier as its own when that list is selected", () => {
    render(
      <ResearchSecurityDashboard
        {...props({
          ui: parseResearchSecurityParams({ list: "country-of-concern" }),
          summary: { ...props().summary, tier: "country" },
        })}
      />,
    );
    expect(screen.getByText("Country-of-concern co-publications")).toBeTruthy();
    expect(screen.queryByText("Listed-entity co-publications")).toBeNull();
    expect(screen.getAllByText(/never added to an entity total/).length).toBeGreaterThan(0);
  });

  it("names the filters in force as chips, each removable on its own", () => {
    render(
      <ResearchSecurityDashboard
        {...props({
          ui: parseResearchSecurityParams({ campus: "ithaca", category: "CAS institute", consortia: "exclude" }),
        })}
      />,
    );
    const chips = within(screen.getByRole("list", { name: "Filters applied" }));
    expect(chips.getByText("Cornell University")).toBeTruthy();
    expect(chips.getByText("50+ author consortia excluded")).toBeTruthy();
    expect(chips.getByRole("link", { name: "Remove filter: Category: CAS institute" }).getAttribute("href")).toBe(
      "/edit/research-security?campus=ithaca&consortia=exclude",
    );
    // A filter at its default is named but has nothing to remove.
    expect(chips.queryByRole("link", { name: /Remove filter: All listed entities/ })).toBeNull();
    expect(screen.getByText(/Data as of 2026-11-17/)).toBeTruthy();
  });

  it("an entity row drills down: the name and its counts link to the rows behind them", () => {
    const ui = parseResearchSecurityParams({ campus: "ithaca" });
    render(<ResearchSecurityDashboard {...props({ ui })} />);
    const e = "entity=Shanghai+Jiao+Tong+University";
    expect(screen.getByRole("link", { name: "Shanghai Jiao Tong University" }).getAttribute("href")).toBe(
      `/edit/research-security?view=paper&campus=ithaca&${e}`,
    );
    expect(screen.getByRole("link", { name: "280" }).getAttribute("href")).toBe(
      `/edit/research-security?view=person&campus=ithaca&${e}`,
    );
    expect(screen.getByRole("link", { name: "201" }).getAttribute("href")).toBe(
      `/edit/research-security?view=unattributed&campus=ithaca&${e}`,
    );
    // The WCM count links to WCM papers whatever campus is selected.
    expect(screen.getByRole("link", { name: "254" }).getAttribute("href")).toBe(
      `/edit/research-security?view=paper&campus=wcm&${e}`,
    );
  });

  it("the headline tiles link to their views and keep the filters", () => {
    render(<ResearchSecurityDashboard {...props({ ui: parseResearchSecurityParams({ consortia: "exclude" }) })} />);
    expect(screen.getByRole("link", { name: /Papers awaiting review/ }).getAttribute("href")).toBe(
      "/edit/research-security?view=unattributed&consortia=exclude",
    );
  });

  it("a person row links to that person's papers, and each entity to the pair", () => {
    render(
      <ResearchSecurityDashboard
        {...props({
          ui: parseResearchSecurityParams({ view: "person" }),
          current: {
            view: "person",
            rows: [
              {
                cwid: "abc2001",
                name: "Ann Chen",
                campus: "wcm",
                department: "Medicine",
                title: "Professor",
                papers: 4,
                papersExcludingConsortia: 4,
                entities: ["Soochow University"],
              },
            ],
          },
        })}
      />,
    );
    expect(screen.getByRole("link", { name: "Ann Chen" }).getAttribute("href")).toBe(
      "/edit/research-security?view=paper&person=abc2001",
    );
    expect(screen.getByRole("link", { name: "Soochow University" }).getAttribute("href")).toBe(
      "/edit/research-security?view=paper&entity=Soochow+University&person=abc2001",
    );
  });

  it("the country tier offers a Country filter instead of Category, and keeps a person filter", () => {
    const { container } = render(
      <ResearchSecurityDashboard
        {...props({
          ui: parseResearchSecurityParams({ list: "country-of-concern", entity: "China", person: "abc2001" }),
          summary: { ...props().summary, tier: "country" },
          entities: ["China", "Russia"],
          profile,
          profileLinks: { console: "/edit/scholar/abc2001", publicProfile: "/ann-chen" },
        })}
      />,
    );
    const form = container.querySelector("form")!;
    expect(form.querySelector('select[name="category"]')).toBeNull();
    expect(within(form).getByLabelText("Country")).toBeTruthy();
    expect((form.querySelector('select[name="entity"]') as HTMLSelectElement).value).toBe("China");
    expect((form.querySelector('input[name="person"]') as HTMLInputElement).value).toBe("abc2001");
    expect(screen.getByText("Person: Ann Chen (abc2001)")).toBeTruthy();
    expect(screen.getByText(/every count covers this person's papers only/)).toBeTruthy();

    // The person card: everything on file, each figure linked to its rows.
    const card = within(screen.getByRole("region", { name: "On file for Ann Chen" }));
    const q = "list=country-of-concern&entity=China&person=abc2001";
    expect(card.getByRole("link", { name: "12" }).getAttribute("href")).toBe(`/edit/research-security?view=paper&${q}`);
    expect(card.getByRole("link", { name: "3" }).getAttribute("href")).toBe(`/edit/research-security?view=unattributed&${q}`);
    expect(card.getByText(/2019–2025 · 11 excluding consortia/)).toBeTruthy();
    expect(card.getByText(/ReCiter scores 53.8–96.5 · 1 also list the entity/)).toBeTruthy();
    expect(card.getByRole("link", { name: "Console record" }).getAttribute("href")).toBe("/edit/scholar/abc2001");
    expect(card.getByRole("link", { name: "Public profile" }).getAttribute("href")).toBe("/ann-chen");
    // The other tier is one click away, with the person kept.
    expect(card.getByRole("link", { name: "See listed entities" }).getAttribute("href")).toBe(
      "/edit/research-security?person=abc2001",
    );
    expect(card.getByRole("link", { name: "Lin Zeng" }).getAttribute("href")).toBe(
      "/edit/research-security?list=country-of-concern&entity=China&person=xyz1",
    );
  });

  it("says so when the selected person is on nothing in scope", () => {
    render(<ResearchSecurityDashboard {...props({ ui: parseResearchSecurityParams({ person: "zzz9" }), profile: null })} />);
    expect(screen.getByText(/Nothing is on file for/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Remove the person filter" }).getAttribute("href")).toBe("/edit/research-security");
  });

  it("Not yet attributed is one row per candidate, and the name opens that person", () => {
    const row = {
      priority: 1 as const,
      alreadyConfirmed: false,
      person: candidate,
      article,
      entities: ["Soochow University"],
      categories: ["SASTIND university"],
      candidateListsEntity: true,
    };
    const rows = Array.from({ length: 7 }, (_, i) => ({
      ...row,
      article: { ...article, articleId: String(i), pmid: i + 1, title: `Paper ${i}` },
    }));
    render(
      <ResearchSecurityDashboard
        {...props({
          ui: parseResearchSecurityParams({ view: "unattributed" }),
          current: {
            view: "unattributed",
            rows: [],
            groups: [
              {
                key: "gux2002",
                person: candidate,
                rows,
                papers: 7,
                priority: 1,
                maxScore: 100,
                entities: ["Soochow University"],
                candidateListsEntity: true,
              },
            ],
          },
        })}
      />,
    );
    const mine = "/edit/research-security?view=unattributed&person=gux2002";
    expect(screen.getByRole("link", { name: "Guoqiang Xu" }).getAttribute("href")).toBe(mine);
    expect(screen.getByText("7 rows")).toBeTruthy();
    // Five papers are previewed; the rest are behind the person.
    expect(screen.getByText("Paper 4")).toBeTruthy();
    expect(screen.queryByText("Paper 5")).toBeNull();
    expect(screen.getByRole("link", { name: "All 7 rows →" }).getAttribute("href")).toBe(mine);
  });

  it("column headers sort the view, a second click reverses, and search is kept", () => {
    const ui = parseResearchSecurityParams({ view: "person", q: "chiang", sort: "name" });
    render(
      <ResearchSecurityDashboard
        {...props({ ui, current: { view: "person", rows: [] }, viewShown: 2, viewTotal: 583 })}
      />,
    );
    expect(screen.getByRole("link", { name: /Sort by Person, currently ascending/ }).getAttribute("href")).toBe(
      "/edit/research-security?view=person&q=chiang&sort=name&dir=desc",
    );
    // The default column needs no sort parameter.
    expect(screen.getByRole("link", { name: "Sort by Co-publications" }).getAttribute("href")).toBe(
      "/edit/research-security?view=person&q=chiang",
    );
    expect(screen.getByText("2 of 583 rows")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Clear search" }).getAttribute("href")).toBe(
      "/edit/research-security?view=person&sort=name",
    );
    // The export downloads what is on screen; another view starts clean.
    expect(screen.getByRole("link", { name: "Download this view (.xlsx)" }).getAttribute("href")).toBe(
      "/edit/research-security/export?view=person&q=chiang&sort=name",
    );
    const tabs = within(screen.getByRole("navigation", { name: "Views" }));
    expect(tabs.getByRole("link", { name: /By paper/ }).getAttribute("href")).toBe("/edit/research-security?view=paper");
  });

  it("Methods is collapsed until asked for, and stays in the page", () => {
    const { container } = render(<ResearchSecurityDashboard {...props()} />);
    const details = container.querySelector("details#methods") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    (screen.getByRole("note").querySelector('a[href="#methods"]') as HTMLAnchorElement).click();
    expect(details.open).toBe(true);
  });

  it("tabs, pager and export are links that keep the filters", () => {
    const ui = parseResearchSecurityParams({ campus: "ithaca", consortia: "exclude" });
    render(<ResearchSecurityDashboard {...props({ ui })} />);
    const tabs = within(screen.getByRole("navigation", { name: "Views" }));
    expect(tabs.getByRole("link", { name: /By person/ }).getAttribute("href")).toBe("/edit/research-security?view=person&campus=ithaca&consortia=exclude");
    expect(tabs.getByRole("link", { name: /By entity/ }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Next →" }).getAttribute("href")).toBe("/edit/research-security?campus=ithaca&consortia=exclude&page=2");
    expect(screen.getByRole("link", { name: "Download this view (.xlsx)" }).getAttribute("href")).toBe("/edit/research-security/export?campus=ithaca&consortia=exclude");
  });

  it("the filter form is a plain GET that keeps the view", () => {
    const { container } = render(
      <ResearchSecurityDashboard {...props({ ui: parseResearchSecurityParams({ view: "paper" }) , current: { view: "paper", rows: [], matchedStrings: [] } })} />,
    );
    const form = container.querySelector("form")!;
    expect(form.getAttribute("method")).toBe("get");
    expect(form.getAttribute("action")).toBe("/edit/research-security");
    expect((form.querySelector('input[name="view"]') as HTMLInputElement).value).toBe("paper");
    expect((form.querySelector('input[name="from"]') as HTMLInputElement).value).toBe("2021-01-01");
    expect((form.querySelector('select[name="list"]') as HTMLInputElement).value).toBe("entities");
    expect(screen.getByText("Nothing matches these filters.")).toBeTruthy();
  });

  it("By paper shows the exact matched co-author and affiliation strings", () => {
    render(
      <ResearchSecurityDashboard
        {...props({
          ui: parseResearchSecurityParams({ view: "paper" }),
          current: {
            view: "paper",
            rows: [
              {
                article,
                wcmAuthors: ["Ann Chen (abc2001)"],
                ithacaAuthors: [],
                entities: ["Soochow University"],
                categories: ["SASTIND university"],
                coAuthorsAtEntities: 1,
                ourAuthorListsEntity: false,
                fundingPrograms: [],
                consortium: false,
              },
            ],
            matchedStrings: [
              {
                articleId: article.articleId,
                listCode: "house-1286-nominations",
                category: "SASTIND university",
                listNo: 40,
                entity: "Soochow University",
                authorName: "Wei Li",
                affiliation: "Jiangsu Key Laboratory, Soochow University, Suzhou, China",
                isInstitutionAuthor: false,
                ourAuthorCwids: null,
              },
            ],
          },
        })}
      />,
    );
    expect(screen.getByText("1 matched string · 1 co-author")).toBeTruthy();
    expect(screen.getByText("Wei Li")).toBeTruthy();
    expect(
      screen.getByText("Jiangsu Key Laboratory, Soochow University, Suzhou, China"),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Regulation of gene expression" }).getAttribute("href")).toBe("https://pubmed.ncbi.nlm.nih.gov/39243855/");
  });

  it("Not yet attributed marks a paper already confirmed for another author as not counted", () => {
    render(
      <ResearchSecurityDashboard
        {...props({
          ui: parseResearchSecurityParams({ view: "unattributed" }),
          current: {
            view: "unattributed",
            rows: [
              {
                priority: 1,
                alreadyConfirmed: true,
                person: candidate,
                article,
                entities: ["Soochow University"],
                categories: ["SASTIND university"],
                candidateListsEntity: true,
              },
            ],
          },
        })}
      />,
    );
    expect(screen.getByText(/Already confirmed for another author; not counted/)).toBeTruthy();
    expect(screen.getByText("Candidate also lists the entity")).toBeTruthy();
    expect(screen.getByText("ReCiter suggestion, not yet reviewed")).toBeTruthy();
    expect(screen.getByText("100.0")).toBeTruthy();
  });

  it("says so when nothing has been loaded yet, and shows no numbers", () => {
    render(<ResearchSecurityDashboard {...props({ dataAsOf: null })} />);
    expect(screen.getByText(/No data has been loaded yet/)).toBeTruthy();
    expect(screen.queryByText("1,799")).toBeNull();
  });
});
