/**
 * Report 2 (NCI Table 2a) redesign — the body (`nci-table-2a-body.tsx`:
 * progress, banner copy, stat tiles, status segments, selects, search, chips,
 * footer, Query & Assumptions) and the client table (`nci-2a-table.tsx`:
 * status pills, Accept = PATCH of the same value, Enter / blur saves, Esc
 * undoes, an empty draft never saves, read-only Program, show more, CSV).
 * Assertions are scoped to the rendered container. Fixture people are invented.
 */
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ load: vi.fn(), refresh: vi.fn() }));

vi.mock("@/lib/db", () => ({ db: { read: {}, write: {} } }));
vi.mock("@/lib/edit/nci-2a-report.server", () => ({ loadNci2aReport: h.load }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: h.refresh }) }));
vi.mock("@/components/edit/scholar-hover-card", () => ({
  ScholarHoverCard: ({ cwid, children }: { cwid: string; children: React.ReactNode }) => (
    <span data-testid="hover-card" data-cwid={cwid}>
      {children}
    </span>
  ),
}));

import { renderNciTable2aReport } from "@/components/edit/reports/nci-table-2a-body";
import { Nci2aDownloadButton, Nci2aTable } from "@/components/edit/reports/nci-2a-table";
import type { Nci2aAward } from "@/lib/edit/nci-2a-report";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const BASE = "/edit/reports/nci-table-2a";
const CENTER = "meyer_cancer_center";

function award(over: Partial<Nci2aAward> & { id: string }): Nci2aAward {
  const pct = over.cancerRelevantPercent === undefined ? 50 : over.cancerRelevantPercent;
  return {
    pi: `Testperson, ${over.id}`,
    specificFundingSource: "National Cancer Institute",
    projectNumber: `P-${over.id}`,
    projectTitle: `Project ${over.id}`,
    projectStartDate: "2024-01-01",
    projectEndDate: "2028-12-31",
    annualProjectDirectCosts: 100000,
    cancerRelevantPercentSource: "llm",
    cancerRelevantRationale: "because",
    cancerRelevantAnnualProjectDc: pct == null ? null : pct * 1000,
    isPeerReviewed: true,
    grantCwid: `zzz${over.id}`,
    applId: null,
    programFrom: "membership",
    allocations: [
      {
        id: `al-${over.id}`,
        programCode: "CB",
        programLabel: "Cancer Biology",
        programPercent: 100,
        source: "membership",
        annualProgramDirectCosts: null,
      },
    ],
    ...over,
    cancerRelevantPercent: pct,
  };
}

const AI = award({ id: "1", pi: "Alpha, Ann", cancerRelevantPercent: 40 });
const DONE = award({
  id: "2",
  pi: "Beta, Bob",
  cancerRelevantPercentSource: "human",
  cancerRelevantPercent: 100,
  applId: 777,
});
const NONE = award({
  id: "3",
  pi: "Gamma, Cy",
  cancerRelevantPercent: null,
  grantCwid: null,
  allocations: [],
  programFrom: "stored",
});
const DATA = {
  cycle: "osra-2026-07-14",
  programs: [
    { code: "CB", label: "Cancer Biology" },
    { code: "CT", label: "Cancer Therapeutics" },
  ],
  awards: [AI, DONE, NONE],
};

async function renderBody(searchParams: Record<string, string> = {}) {
  const { main } = await renderNciTable2aReport({
    code: CENTER,
    searchParams,
    basePath: BASE,
  } as unknown as Parameters<typeof renderNciTable2aReport>[0]);
  const r = render(<div data-testid="body">{main}</div>);
  return within(r.getByTestId("body"));
}

function renderTable(rows: Nci2aAward[], resetKey = "") {
  const r = render(
    <div data-testid="t">
      <Nci2aTable
        centerCode={CENTER}
        rows={rows}
        resetKey={resetKey}
        sort="pi"
        dir="asc"
        sortHrefs={{
          pi: `${BASE}?sort=pi&dir=desc`,
          dc: `${BASE}?sort=dc&dir=desc`,
          pct: "#",
          rel: "#",
        }}
        emptyMessage="No projects match these filters."
      />
    </div>,
  );
  return { ...r, q: within(r.getByTestId("t")) };
}

function stubFetch(ok = true, status = 200) {
  const f = vi.fn(async () => ({ ok, status, json: async () => ({}) }));
  vi.stubGlobal("fetch", f);
  return f;
}

beforeEach(() => {
  h.load.mockReset().mockResolvedValue(DATA);
  h.refresh.mockReset();
});

describe("report 2 body", () => {
  it("progress is cycle-wide, the banner says title and funding source, tiles exclude not-inferred", async () => {
    const q = await renderBody();
    expect(h.load).toHaveBeenCalledWith(CENTER);
    const progress = q.getByTestId("nci-2a-progress");
    expect(progress.textContent).toContain("1 of 3");
    expect(within(progress).getByTestId("nci-2a-banner").textContent).toContain(
      "from the project title and funding source",
    );
    expect(within(progress).getByTestId("nci-2a-review-link").getAttribute("href")).toBe(
      `${BASE}?status=needs`,
    );
    expect(within(progress).getByTestId("nci-2a-review-link").textContent).toBe(
      "Review 2 suggestions",
    );
    const labels = [...q.getByTestId("nci-2a-stats").querySelectorAll("dt")].map(
      (d) => d.textContent,
    );
    expect(labels).toEqual([
      "Direct costs, 3 projects",
      "Cancer-relevant (70%; excludes 1 not inferred)",
      "Peer-reviewed funding",
    ]);
    expect(q.getByTestId("nci-2a-download-note").textContent).toBe(
      "Cycle osra-2026-07-14 · annual figures. 2 rows still need review and are flagged in the file.",
    );
  });

  it("status segments count over the other filters and link with them kept", async () => {
    const q = await renderBody({ peer: "yes", status: "needs" });
    const links = within(q.getByTestId("nci-2a-status-filter")).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(["All 3", "Needs review 2", "Reviewed 1"]);
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
      `${BASE}?peer=yes`,
      `${BASE}?status=needs&peer=yes`,
      `${BASE}?status=done&peer=yes`,
    ]);
    expect(links[1].getAttribute("aria-current")).toBe("page");
    // The table and the numbers follow the status filter too.
    expect(within(q.getByTestId("nci-2a-table")).getAllByTestId("nci-2a-row")).toHaveLength(2);
    expect(q.getByTestId("nci-2a-stats").querySelector("dt")?.textContent).toBe(
      "Direct costs, 2 projects",
    );
  });

  it("the selects and search submit with the other params carried; chips remove one filter", async () => {
    const q = await renderBody({ program: "CB", q: "alpha", sort: "dc", dir: "asc" });
    const fd = new FormData(q.getByTestId("nci-2a-filters") as HTMLFormElement);
    expect(Object.fromEntries(fd)).toEqual({
      q: "alpha",
      sort: "dc",
      dir: "asc",
      program: "CB",
      peer: "",
    });
    const sfd = new FormData(q.getByTestId("nci-2a-search") as HTMLFormElement);
    expect(Object.fromEntries(sfd)).toEqual({ program: "CB", sort: "dc", dir: "asc", q: "alpha" });
    const program = q.getByRole("combobox", { name: "Program" }) as HTMLSelectElement;
    expect([...program.options].map((o) => o.value)).toEqual(["", "CB", "CT", "none"]);
    const chips = within(q.getByTestId("nci-2a-chips")).getAllByRole("link");
    expect(chips.map((c) => c.getAttribute("href"))).toEqual([
      `${BASE}?q=alpha&sort=dc&dir=asc`,
      `${BASE}?program=CB&sort=dc&dir=asc`,
    ]);
    expect(within(q.getByTestId("nci-2a-table")).getAllByTestId("nci-2a-row")).toHaveLength(1);
  });

  it("the empty Needs review list says nothing is left", async () => {
    h.load.mockResolvedValue({ ...DATA, awards: [DONE] });
    const q = await renderBody({ status: "needs" });
    expect(q.getByTestId("nci-2a-empty").textContent).toBe(
      "Nothing left to review. Every percentage is confirmed.",
    );
    expect(q.queryByTestId("nci-2a-review-link")).toBeNull();
  });

  it("no cycle yet → the import hint, nothing else", async () => {
    h.load.mockResolvedValue({ cycle: null, programs: [], awards: [] });
    const q = await renderBody();
    expect(q.getByTestId("nci-2a-no-cycle")).toBeTruthy();
    expect(q.queryByTestId("nci-2a-table")).toBeNull();
  });

  it("the footer links the roster and Query & Assumptions states the CSV exemption", async () => {
    const q = await renderBody();
    expect(q.getByRole("link", { name: "edit it in the center roster" }).getAttribute("href")).toBe(
      `/edit/center/${CENTER}`,
    );
    const qa = q.getByTestId("nci-2a-assumptions");
    expect(qa.textContent).toContain("Query & Assumptions");
    expect(qa.textContent).toContain("exempt from the 50-person limit on scholar exports");
    expect(qa.textContent).toContain("no CWID column");
    expect(qa.textContent).toContain("Review Status");
  });
});

describe("report 2 table", () => {
  it("status pills, Accept only on AI rows, PI in the hover card, read-only program", () => {
    const { q } = renderTable([AI, DONE, NONE]);
    const rows = q.getAllByTestId("nci-2a-row");
    expect(rows.map((r) => within(r).getByTestId("nci-2a-status").textContent)).toEqual([
      "AI-suggested",
      "Confirmed",
      "Not inferred",
    ]);
    expect(rows.map((r) => within(r).queryByRole("button", { name: /Accept/ }) !== null)).toEqual([
      true,
      false,
      false,
    ]);
    expect(within(rows[0]).getByTestId("hover-card").getAttribute("data-cwid")).toBe("zzz1");
    expect(within(rows[2]).queryByTestId("hover-card")).toBeNull();
    expect(within(rows[1]).getByRole("link", { name: "P-2" }).getAttribute("href")).toContain(
      "777",
    );
    expect(q.queryAllByRole("combobox")).toHaveLength(0);
    expect(rows[0].textContent).toContain("Cancer Biology");
    expect(rows[2].textContent).toContain("Unassigned");
  });

  it("Accept PATCHes the same value, then refreshes", async () => {
    const f = stubFetch();
    const { q } = renderTable([AI]);
    fireEvent.click(q.getByRole("button", { name: "Accept 40% for P-1" }));
    await waitFor(() => expect(h.refresh).toHaveBeenCalled());
    expect(f).toHaveBeenCalledWith(
      `/api/edit/center/${CENTER}/nci-2a/1`,
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ cancerRelevantPercent: 40 }),
      }),
    );
  });

  it("Enter saves a changed value; an unchanged Confirmed value never saves", async () => {
    const f = stubFetch();
    const { q } = renderTable([AI, DONE]);
    const [ai, done] = q.getAllByRole("spinbutton") as HTMLInputElement[];
    fireEvent.change(ai, { target: { value: "65" } });
    fireEvent.keyDown(ai, { key: "Enter" });
    fireEvent.blur(ai); // jsdom's blur() doesn't fire the handler on an unfocused input
    await waitFor(() => expect(f).toHaveBeenCalledTimes(1));
    expect(f.mock.calls[0]).toEqual([
      `/api/edit/center/${CENTER}/nci-2a/1`,
      expect.objectContaining({ body: JSON.stringify({ cancerRelevantPercent: 65 }) }),
    ]);
    fireEvent.change(done, { target: { value: "100" } });
    fireEvent.blur(done);
    await act(async () => {});
    expect(f).toHaveBeenCalledTimes(1);
    expect(done.value).toBe("100");
  });

  it("Esc undoes the draft and saves nothing", async () => {
    const f = stubFetch();
    const { q } = renderTable([AI]);
    const input = q.getByRole("spinbutton") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "90" } });
    expect(input.value).toBe("90");
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.blur(input);
    await act(async () => {});
    expect(input.value).toBe("40");
    expect(f).not.toHaveBeenCalled();
  });

  it("an empty or out-of-range draft reverts; a not-inferred row never saves a 0%", async () => {
    const f = stubFetch();
    const { q } = renderTable([AI, NONE]);
    const [ai, none] = q.getAllByRole("spinbutton") as HTMLInputElement[];
    fireEvent.change(ai, { target: { value: "150" } });
    fireEvent.blur(ai);
    fireEvent.change(none, { target: { value: "" } });
    fireEvent.blur(none);
    await act(async () => {});
    expect(ai.value).toBe("40");
    expect(none.value).toBe("");
    expect(f).not.toHaveBeenCalled();
  });

  it("a failed save shows an error, reverts, and doesn't refresh", async () => {
    stubFetch(false, 403);
    const { q } = renderTable([AI]);
    const input = q.getByRole("spinbutton") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "10" } });
    fireEvent.blur(input);
    await waitFor(() => expect(q.getByRole("alert").textContent).toContain("Save failed (403)"));
    expect(input.value).toBe("40");
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("shows 25, then 25 more; the range label counts projects", () => {
    const many = Array.from({ length: 30 }, (_, i) => award({ id: String(100 + i) }));
    const { q } = renderTable(many);
    expect(q.getAllByTestId("nci-2a-row")).toHaveLength(25);
    expect(q.getByTestId("nci-2a-range").textContent).toBe("Showing 25 of 30 projects");
    fireEvent.click(q.getByRole("button", { name: "Show 25 more" }));
    expect(q.getAllByTestId("nci-2a-row")).toHaveLength(30);
    expect(q.queryByRole("button", { name: "Show 25 more" })).toBeNull();
  });

  it("sort headers link to the server sort and mark the current column", () => {
    const { q } = renderTable([AI]);
    const pi = q.getByRole("link", { name: "Sort by PI" });
    expect(pi.getAttribute("href")).toBe(`${BASE}?sort=pi&dir=desc`);
    expect(pi.closest("th")?.getAttribute("aria-sort")).toBe("ascending");
    expect(
      q
        .getByRole("link", { name: "Sort by Direct costs" })
        .closest("th")
        ?.getAttribute("aria-sort"),
    ).toBeNull();
  });

  it("the CSV button downloads exactly the rows it was given, with no CWID", async () => {
    let blob: Blob | null = null;
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: (b: Blob) => ((blob = b), "blob:x"),
      revokeObjectURL: () => {},
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const r = render(<Nci2aDownloadButton cycle="osra-2026-07-14" rows={[AI, NONE]} />);
    fireEvent.click(within(r.container).getByTestId("nci-2a-download"));
    expect(click).toHaveBeenCalled();
    const text = await new Promise<string>((resolve) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result as string);
      fr.readAsText(blob as unknown as Blob);
    });
    expect(text.split("\n")).toHaveLength(3);
    expect(text).toContain("Review Status");
    expect(text).not.toContain("zzz1");
    click.mockRestore();
  });

  it("the CSV button is disabled with no rows", () => {
    const r = render(<Nci2aDownloadButton cycle="c" rows={[]} />);
    expect((within(r.container).getByTestId("nci-2a-download") as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
