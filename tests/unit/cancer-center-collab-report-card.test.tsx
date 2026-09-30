/**
 * CancerCenterCollabReportCard — report 1's client half (Optimize membership
 * redesign, 2026-09-25):
 *  - tabs per list with counts and the live rule text; recruit exclusive of
 *    collaborators;
 *  - threshold inputs and the papers / % toggle (a switch resets to the
 *    unit's default); every param mirrored into the URL and the .xlsx link;
 *  - search + institution filter, header sort, "Show 25 more";
 *  - row selection, Export selected (disabled above the cap), Open in roster
 *    editor; the name links to the per-person CSV (no per-row CSV column);
 *  - the "How cancer-relevance is determined" modal: tabs, search with hit
 *    highlighting, the site / cross-cutting filter, the empty-taxonomy state.
 * Every assertion is scoped to the rendered container (or the dialog).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor, within } from "@testing-library/react";

import { CancerCenterCollabReportCard } from "@/components/edit/cancer-center-collab-report-card";
import {
  DEFAULT_OPTIMIZE_PARAMS,
  type CollabRow,
  type OptimizeParams,
} from "@/lib/edit/optimize-membership-report";

// Like the real card, the hover content portals out to document.body.
vi.mock("@/components/edit/scholar-hover-card", async () => {
  const { createPortal } = await import("react-dom");
  return {
    ScholarHoverCard: ({ cwid, children }: { cwid: string; children: React.ReactNode }) => (
      <>
        {children}
        {createPortal(<div data-testid={`hc-${cwid}`}>Hover card body</div>, document.body)}
      </>
    ),
  };
});

function row(over: Partial<CollabRow> & { cwid: string }): CollabRow {
  return {
    surname: over.cwid,
    givenName: "G",
    primaryDepartment: "Medicine",
    institution: "Weill Cornell Medicine",
    totalPapersPostCutoff: 10,
    collaborationsWithCenter: 0,
    cancerRelatedPapers: 0,
    isCurrentMember: false,
    currentProgramCode: null,
    programLabel: null,
    ...over,
  };
}

const ROWS: CollabRow[] = [
  row({
    cwid: "m1",
    surname: "Removeperson",
    givenName: "R",
    isCurrentMember: true,
    currentProgramCode: "CB",
    programLabel: "Cancer Biology",
  }),
  row({
    cwid: "c1",
    surname: "Collabrelevant",
    givenName: "C",
    institution: "Hospital for Special Surgery",
    collaborationsWithCenter: 3,
    cancerRelatedPapers: 5,
  }),
  row({
    cwid: "r1",
    surname: "Recruitperson",
    givenName: "R2",
    collaborationsWithCenter: 0,
    cancerRelatedPapers: 4,
  }),
  row({
    cwid: "r2",
    surname: "Aardvark",
    givenName: "A",
    institution: "Hospital for Special Surgery",
    collaborationsWithCenter: 1,
    cancerRelatedPapers: 8,
  }),
  row({
    cwid: "n1",
    surname: "Neitherperson",
    givenName: "N",
    collaborationsWithCenter: 1,
    cancerRelatedPapers: 1,
  }),
];

function renderCard(
  over: { rows?: CollabRow[]; initial?: Partial<OptimizeParams>; cap?: number } = {},
) {
  return render(
    <CancerCenterCollabReportCard
      centerCode="meyer_cancer_center"
      rows={over.rows ?? ROWS}
      initial={{ ...DEFAULT_OPTIMIZE_PARAMS, ...over.initial }}
      basePath="/edit/reports/optimize-membership"
      keepQuery="center=meyer_cancer_center"
      cap={over.cap ?? 50}
    />,
  );
}

const names = (c: HTMLElement) =>
  within(c)
    .queryAllByTestId("om-row")
    .map((tr) => tr.querySelectorAll("td")[1].querySelector("a")!.textContent);

let replaceState: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  replaceState = vi.spyOn(window.history, "replaceState");
});
const lastUrl = () => replaceState.mock.calls.at(-1)?.[2];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("CancerCenterCollabReportCard — lists", () => {
  it("shows a tab per list with its count, and the open tab's rule", () => {
    const { container } = renderCard();
    const c = within(container);
    expect(c.getByTestId("om-tab-remove").textContent).toBe("Remove (1)");
    expect(c.getByTestId("om-tab-collab").textContent).toBe("Add: collaborators (1)");
    expect(c.getByTestId("om-tab-recruit").textContent).toBe("Add: recruits (2)");
    expect(c.getByTestId("om-tab-remove").getAttribute("aria-selected")).toBe("true");
    expect(c.getByTestId("om-rule").textContent).toMatch(
      /^Current members who haven.t co-authored/,
    );
    expect(names(container)).toEqual(["R Removeperson"]);
  });

  it("recruit excludes anyone already a collaborator; the tab switch shows its own rule", () => {
    const { container } = renderCard();
    const c = within(container);
    fireEvent.click(c.getByTestId("om-tab-recruit"));
    expect(names(container)).toEqual(["A Aardvark", "R2 Recruitperson"]);
    expect(c.getByTestId("om-rule").textContent).toContain(
      "fewer than 2 co-authored papers with members",
    );
    fireEvent.click(c.getByTestId("om-tab-collab"));
    expect(names(container)).toEqual(["C Collabrelevant"]);
  });

  it("the Program column (code + name) shows on Remove only", () => {
    const { container } = renderCard();
    const c = within(container);
    expect(c.getByRole("columnheader", { name: "Program" })).toBeTruthy();
    expect(c.getByText("CB")).toBeTruthy();
    expect(c.getByText("Cancer Biology")).toBeTruthy();
    fireEvent.click(c.getByTestId("om-tab-collab"));
    expect(c.queryByRole("columnheader", { name: "Program" })).toBeNull();
  });

  it("the name links to that person's per-paper CSV; there is no per-row CSV column", () => {
    const { container } = renderCard();
    const link = within(container).getByLabelText(
      "R Removeperson: download papers (CSV)",
    ) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe(
      "/api/edit/center/meyer_cancer_center/collab-report/export?cwid=m1",
    );
    expect(within(container).queryByText("CSV")).toBeNull();
    expect(container.querySelectorAll("thead th")).toHaveLength(7);
  });

  it("says so when nothing matches, and when the weekly run hasn't happened", () => {
    const { container, unmount } = renderCard({ initial: { q: "zzz" } });
    expect(within(container).getByTestId("om-empty").textContent).toBe(
      "No one matches. Try lowering a threshold or clearing the search.",
    );
    unmount();
    const empty = renderCard({ rows: [] });
    expect(within(empty.container).getByTestId("om-no-data")).toBeTruthy();
  });
});

describe("CancerCenterCollabReportCard — thresholds and URL", () => {
  it("a threshold change re-buckets, rewrites the rule, the URL and the .xlsx link", () => {
    const { container } = renderCard();
    const c = within(container);
    fireEvent.change(c.getByLabelText("Collaboration threshold"), { target: { value: "1" } });
    expect(c.getByTestId("om-tab-collab").textContent).toBe("Add: collaborators (2)");
    expect(c.getByTestId("om-tab-recruit").textContent).toBe("Add: recruits (1)");
    expect(lastUrl()).toBe("/edit/reports/optimize-membership?center=meyer_cancer_center&c=1");
    expect(c.getByTestId("om-download").getAttribute("href")).toBe(
      "/api/edit/center/meyer_cancer_center/collab-report/xlsx?c=1",
    );
    fireEvent.click(c.getByTestId("om-tab-collab"));
    expect(c.getByTestId("om-rule").textContent).toContain(
      "at least 1 co-authored paper with members",
    );
    // The tab rides on the page URL but never on the download.
    expect(lastUrl()).toBe(
      "/edit/reports/optimize-membership?center=meyer_cancer_center&c=1&tab=collab",
    );
    expect(c.getByTestId("om-download").getAttribute("href")).toBe(
      "/api/edit/center/meyer_cancer_center/collab-report/xlsx?c=1",
    );
  });

  it("switching to % of papers resets to that unit's default", () => {
    const { container } = renderCard();
    const c = within(container);
    const group = c.getByTestId("om-threshold-x");
    fireEvent.click(within(group).getByRole("button", { name: "% of papers" }));
    expect((c.getByLabelText("Cancer-relevance threshold") as HTMLInputElement).value).toBe("20");
    expect(
      within(group).getByRole("button", { name: "% of papers" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(c.getByTestId("om-download").getAttribute("href")).toBe(
      "/api/edit/center/meyer_cancer_center/collab-report/xlsx?xmode=percent",
    );
  });

  it("opens on the URL's params", () => {
    const { container } = renderCard({ initial: { tab: "recruit", x: 5 } });
    expect(names(container)).toEqual(["A Aardvark"]);
  });

  it("the download note says a list over the cap is withheld", () => {
    const { container } = renderCard({ cap: 1 });
    const note = within(container).getByTestId("om-download-note");
    expect(note.textContent).toContain("withheld");
    expect(note.textContent).toContain("Add: recruits (2)");
  });
});

describe("CancerCenterCollabReportCard — table controls", () => {
  it("the institution select and search narrow the table, the counts and the download", () => {
    const { container } = renderCard();
    const c = within(container);
    fireEvent.change(c.getByLabelText("Institution"), {
      target: { value: "Hospital for Special Surgery" },
    });
    expect(c.getByTestId("om-tab-recruit").textContent).toBe("Add: recruits (1)");
    expect(c.getByTestId("om-tab-remove").textContent).toBe("Remove (0)");
    expect(c.getByTestId("om-download").getAttribute("href")).toContain(
      "inst=Hospital+for+Special+Surgery",
    );
    fireEvent.change(c.getByLabelText("Institution"), { target: { value: "" } });
    fireEvent.click(c.getByTestId("om-tab-recruit"));
    fireEvent.change(c.getByLabelText("Search name, department or institution"), {
      target: { value: "aard" },
    });
    expect(names(container)).toEqual(["A Aardvark"]);
  });

  it("header click sorts, and a second click flips the direction", () => {
    const { container } = renderCard({ initial: { tab: "recruit" } });
    const c = within(container);
    expect(names(container)).toEqual(["A Aardvark", "R2 Recruitperson"]); // surname A→Z
    fireEvent.click(c.getByTestId("om-sort-cancer"));
    expect(names(container)).toEqual(["A Aardvark", "R2 Recruitperson"]); // 8 then 4
    fireEvent.click(c.getByTestId("om-sort-cancer"));
    expect(names(container)).toEqual(["R2 Recruitperson", "A Aardvark"]);
    fireEvent.click(c.getByTestId("om-sort-name"));
    expect(names(container)).toEqual(["A Aardvark", "R2 Recruitperson"]);
  });

  it("pages 25 at a time", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      row({ cwid: `m${String(i).padStart(2, "0")}`, isCurrentMember: true }),
    );
    const { container } = renderCard({ rows: many });
    const c = within(container);
    expect(c.getAllByTestId("om-row")).toHaveLength(25);
    expect(c.getByTestId("om-range").textContent).toBe("Showing 25 of 30 people");
    fireEvent.click(c.getByRole("button", { name: "Show 25 more" }));
    expect(c.getAllByTestId("om-row")).toHaveLength(30);
    expect(c.queryByRole("button", { name: "Show 25 more" })).toBeNull();
  });
});

describe("CancerCenterCollabReportCard — selection", () => {
  it("row click selects; the bar offers Export selected (an .xlsx of those CWIDs) and the roster editor", () => {
    const { container } = renderCard({ initial: { tab: "recruit" } });
    const c = within(container);
    expect(c.queryByTestId("om-selection")).toBeNull();
    fireEvent.click(c.getAllByTestId("om-row")[0].querySelectorAll("td")[2]);
    fireEvent.click(c.getByLabelText("Select R2 Recruitperson"));
    expect(c.getByTestId("om-selection").textContent).toContain("2 selected");
    expect(c.getByTestId("om-export-selected").getAttribute("href")).toBe(
      "/api/edit/center/meyer_cancer_center/collab-report/selected?cwid=r1&cwid=r2",
    );
    expect(c.getByTestId("om-roster-editor").getAttribute("href")).toBe(
      "/edit/center/meyer_cancer_center",
    );
    // Selection is per tab: Remove has none of these.
    fireEvent.click(c.getByTestId("om-tab-remove"));
    expect(c.queryByTestId("om-selection")).toBeNull();
    fireEvent.click(c.getByTestId("om-tab-recruit"));
    fireEvent.click(c.getByRole("button", { name: "Clear" }));
    expect(c.queryByTestId("om-selection")).toBeNull();
  });

  it("clicking the name link doesn't toggle the row", () => {
    const { container } = renderCard();
    const link = within(container).getByLabelText("R Removeperson: download papers (CSV)");
    link.addEventListener("click", (e) => e.preventDefault());
    fireEvent.click(link);
    expect(within(container).queryByTestId("om-selection")).toBeNull();
  });

  it("a click inside the (portalled) hover card doesn't toggle the row", () => {
    const { container } = renderCard();
    const content = document.body.querySelector('[data-testid="hc-m1"]')!;
    expect(container.contains(content)).toBe(false);
    fireEvent.click(content);
    expect(within(container).queryByTestId("om-selection")).toBeNull();
  });

  it("Export selected carries the thresholds but not the search it outlives", () => {
    const { container } = renderCard({ initial: { tab: "recruit", c: 3 } });
    const c = within(container);
    fireEvent.click(c.getByLabelText("Select R2 Recruitperson"));
    fireEvent.change(c.getByLabelText("Search name, department or institution"), {
      target: { value: "aard" },
    });
    fireEvent.change(c.getByLabelText("Institution"), {
      target: { value: "Hospital for Special Surgery" },
    });
    fireEvent.click(c.getByLabelText("Select A Aardvark"));
    expect(c.getByTestId("om-export-selected").getAttribute("href")).toBe(
      "/api/edit/center/meyer_cancer_center/collab-report/selected?cwid=r1&cwid=r2&c=3",
    );
  });

  it("select-all ticks the shown rows; above the cap Export selected is disabled", () => {
    const { container } = renderCard({ initial: { tab: "recruit" }, cap: 1 });
    const c = within(container);
    fireEvent.click(c.getByLabelText("Select all shown"));
    expect(c.getByTestId("om-selection").textContent).toContain("2 selected");
    const btn = c.getByTestId("om-export-selected") as HTMLButtonElement;
    expect(btn.tagName).toBe("BUTTON");
    expect(btn.disabled).toBe(true);
    expect(c.getByText("Select 1 or fewer people to export.")).toBeTruthy();
    fireEvent.click(c.getByLabelText("Select all shown"));
    expect(c.queryByTestId("om-selection")).toBeNull();
  });

  it("a tap on the name re-fires its click; a finger that moved (a scroll) does not", () => {
    const { container } = renderCard();
    const link = within(container).getByLabelText("R Removeperson: download papers (CSV)");
    const clicks = vi.fn((e: Event) => e.preventDefault());
    link.addEventListener("click", clicks);
    fireEvent.touchStart(link, { touches: [{ clientX: 10, clientY: 100 }] });
    fireEvent.touchEnd(link, { changedTouches: [{ clientX: 12, clientY: 102 }] });
    expect(clicks).toHaveBeenCalledTimes(1);
    fireEvent.touchStart(link, { touches: [{ clientX: 10, clientY: 100 }] });
    fireEvent.touchEnd(link, { changedTouches: [{ clientX: 10, clientY: 40 }] });
    expect(clicks).toHaveBeenCalledTimes(1);
  });

  it("formats tab counts in en-US whatever the browser's locale", () => {
    const orig = Number.prototype.toLocaleString;
    Number.prototype.toLocaleString = function (
      this: number,
      loc?: Intl.LocalesArgument,
      opts?: Intl.NumberFormatOptions,
    ) {
      return orig.call(this, loc ?? "de-DE", opts);
    };
    try {
      const many = Array.from({ length: 1200 }, (_, i) =>
        row({ cwid: `m${i}`, isCurrentMember: true }),
      );
      const { container } = renderCard({ rows: many });
      expect(within(container).getByTestId("om-tab-remove").textContent).toBe("Remove (1,200)");
    } finally {
      Number.prototype.toLocaleString = orig;
    }
  });

  it("the advisory note links to the roster editor", () => {
    const { container } = renderCard();
    const link = within(container).getByRole("link", { name: "roster editor" });
    expect(link.getAttribute("href")).toBe("/edit/center/meyer_cancer_center");
  });
});

const TOPICS = [
  {
    topic: "breast",
    descriptorCount: 12,
    exampleDescriptors: ["Breast Neoplasms, Male", "Carcinoma, Lobular"],
  },
  { topic: "future-bucket", descriptorCount: 1, exampleDescriptors: ["Something New"] },
  { topic: "cc-biology", descriptorCount: 3, exampleDescriptors: ["Oncogenes"] },
  { topic: "unassigned", descriptorCount: 2, exampleDescriptors: ["Carcinoma"] },
];

function stubTaxonomy(body: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, ...body }) })),
  );
}

async function openModal(container: HTMLElement) {
  fireEvent.click(
    within(container).getByRole("button", { name: "How cancer-relevance is determined" }),
  );
  return within(await within(document.body).findByRole("dialog"));
}

describe("MeshLogicModal", () => {
  it("opens on Method with the live summary line; Browse jumps to the buckets", async () => {
    stubTaxonomy({ topics: TOPICS, totalRelevant: 878, ruleCount: 165, meshRelease: "MeSH 2026" });
    const { container } = renderCard();
    const d = await openModal(container);
    expect(d.getByText(/A paper counts toward this report's cancer-relevance axis/)).toBeTruthy();
    await waitFor(() =>
      expect(d.getByText(/878 cancer-relevant descriptors from 165 ruleset rows/)).toBeTruthy(),
    );
    expect(d.getByText(/Resolved against MeSH 2026/)).toBeTruthy();
    expect(d.getByRole("tab", { name: "Topic buckets (4)" })).toBeTruthy();
    expect(d.getByText("The full ruleset, all 165 rows ↗")).toBeTruthy();
    fireEvent.click(d.getByRole("button", { name: "Browse the topic buckets →" }));
    expect(d.getByRole("tab", { name: "Topic buckets (4)" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(d.getAllByTestId("om-bucket")).toHaveLength(4);
    expect(d.getByText("Breast")).toBeTruthy();
    expect(d.getByText("Future bucket")).toBeTruthy(); // uncurated slug fallback
    expect(d.getByText("+10 more")).toBeTruthy();
  });

  it("searches buckets and descriptors, highlighting the hit, and filters site / cross-cutting", async () => {
    stubTaxonomy({ topics: TOPICS, totalRelevant: 878, ruleCount: 165, meshRelease: null });
    const { container } = renderCard();
    const d = await openModal(container);
    await waitFor(() => expect(d.getByRole("tab", { name: "Topic buckets (4)" })).toBeTruthy());
    fireEvent.click(d.getByRole("tab", { name: "Topic buckets (4)" }));
    fireEvent.change(d.getByLabelText("Search buckets or descriptors"), {
      target: { value: "lobular" },
    });
    const hits = d.getAllByTestId("om-bucket");
    expect(hits).toHaveLength(1);
    expect(within(hits[0]).getByText("Carcinoma, Lobular").getAttribute("data-hit")).toBe("true");
    expect(within(hits[0]).getByText("Breast Neoplasms, Male").getAttribute("data-hit")).toBeNull();
    fireEvent.change(d.getByLabelText("Search buckets or descriptors"), { target: { value: "" } });
    // Two site buckets (breast, future-bucket); unassigned is neither.
    fireEvent.click(d.getByRole("button", { name: "Disease site 2" }));
    expect(
      d.getAllByTestId("om-bucket").map((b) => b.querySelector(".font-mono")!.textContent),
    ).toEqual(["breast", "future-bucket"]);
    fireEvent.click(d.getByRole("button", { name: "Cross-cutting 1" }));
    expect(d.getAllByTestId("om-bucket")).toHaveLength(1);
    fireEvent.change(d.getByLabelText("Search buckets or descriptors"), {
      target: { value: "breast" },
    });
    expect(d.getByText("No buckets match.")).toBeTruthy();
  });

  it("says the taxonomy hasn't been generated when it is empty, not '0 descriptors'", async () => {
    stubTaxonomy({ topics: [], totalRelevant: 0, ruleCount: 165, meshRelease: "MeSH 2026" });
    const { container } = renderCard();
    const d = await openModal(container);
    await waitFor(() =>
      expect(
        d.getByText(
          "The cancer taxonomy hasn't been generated in this environment yet, so no publications are classified as cancer-relevant.",
        ),
      ).toBeTruthy(),
    );
    expect(d.queryByText(/0 cancer-relevant descriptors/)).toBeNull();
    expect(d.queryByText(/0 disease-site buckets/)).toBeNull();
    fireEvent.click(d.getByRole("tab", { name: "Topic buckets" }));
    expect(d.getByTestId("om-taxonomy-empty")).toBeTruthy();
  });
});
