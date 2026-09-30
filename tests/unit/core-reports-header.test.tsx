/**
 * `components/edit/reports/core-reports-header.tsx` — the shared header of a
 * core's numbered report (`?kind=core`, mockup `Core Reports.dc.html`).
 * Protects: the "Core facility" eyebrow and "{core} reports" h1; "← Review
 * queue" to `/edit/core/<id>/review`; one tab per core report, the current one
 * `aria-current`, each carrying ONLY `center` + `kind` (a report's own filters
 * never ride to another report); the "Viewing" picker lists the options it is
 * handed, is hidden for one core, pushes the SAME report for a new core, and
 * GETs that report without JS. Assertions are scoped to the rendered container.
 */
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockPush } = vi.hoisted(() => ({ mockPush: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mockPush }) }));

import { CoreReportsHeader } from "@/components/edit/reports/core-reports-header";

const TABS = [
  { n: "3", name: "Publications", slug: "publications" },
  { n: "6", name: "NIH-funded pubs", slug: "nih-funded-pubs" },
  { n: "11", name: "Core users", slug: "core-users" },
  { n: "12", name: "Output over time", slug: "core-output-over-time" },
  { n: "13", name: "Grants citing the core", slug: "core-grants" },
];
const OPTIONS = [
  { code: "2", name: "Alpha Imaging Core" },
  { code: "14", name: "Beta Sequencing Core" },
  { code: "7", name: "Gamma Proteomics Core" },
];

function renderHeader(props: Partial<Parameters<typeof CoreReportsHeader>[0]> = {}) {
  const { container } = render(
    <CoreReportsHeader
      coreId="14"
      coreName="Beta Sequencing Core"
      options={OPTIONS}
      tabs={TABS}
      current="12"
      {...props}
    />,
  );
  return within(container);
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("CoreReportsHeader", () => {
  it("eyebrow, '{core} reports' h1 and the review-queue link", () => {
    const q = renderHeader();
    expect(q.getByText("Core facility")).toBeTruthy();
    expect(q.getByRole("heading", { level: 1 }).textContent).toBe("Beta Sequencing Core reports");
    const back = q.getByTestId("core-reports-queue-link");
    expect(back.getAttribute("href")).toBe("/edit/core/14/review");
    expect(back.textContent).toContain("Review queue");
  });

  it("one tab per core report, the current one selected, each carrying only center + kind", () => {
    const q = renderHeader();
    const tabs = within(q.getByTestId("core-reports-tabs")).getAllByRole("link");
    expect(tabs.map((t) => t.textContent)).toEqual(TABS.map((t) => t.name));
    expect(tabs.map((t) => t.getAttribute("href"))).toEqual(
      TABS.map((t) => `/edit/reports/${t.slug}?center=14&kind=core`),
    );
    expect(
      tabs.filter((t) => t.getAttribute("aria-current") === "page").map((t) => t.textContent),
    ).toEqual(["Output over time"]);
  });

  it("the picker lists the options in the order given, on the current core", () => {
    const q = renderHeader();
    const select = q.getByTestId("core-reports-core-select") as HTMLSelectElement;
    expect([...select.options].map((o) => [o.value, o.text])).toEqual(
      OPTIONS.map((o) => [o.code, o.name]),
    );
    expect(select.value).toBe("14");
    expect(q.getByLabelText("Viewing")).toBe(select);
  });

  it("a pick pushes the SAME report for the new core, with no other params", () => {
    const q = renderHeader();
    fireEvent.change(q.getByTestId("core-reports-core-select"), { target: { value: "7" } });
    expect(mockPush).toHaveBeenCalledWith("/edit/reports/core-output-over-time?center=7&kind=core");
  });

  it("without JS the picker GETs the same report with center + kind=core", () => {
    const q = renderHeader();
    const form = q.getByTestId("core-reports-core-select").closest("form")!;
    expect(form.getAttribute("method")).toBe("get");
    expect(form.getAttribute("action")).toBe("/edit/reports/core-output-over-time");
    expect(q.getByTestId("core-reports-core-select").getAttribute("name")).toBe("center");
    const kind = form.querySelector('input[type="hidden"][name="kind"]') as HTMLInputElement;
    expect(kind.value).toBe("core");
  });

  it("single-core mode keeps the Core facility eyebrow and no roll-up lede", () => {
    const q = renderHeader();
    expect(q.getByTestId("core-reports-eyebrow").textContent).toBe("Core facility");
    expect(q.queryByTestId("core-reports-lede")).toBeNull();
  });

  it("All cores: roll-up eyebrow, 'All cores reports', the counts-once lede, no Review queue", () => {
    const q = renderHeader({
      coreId: "all",
      coreName: "All cores",
      options: [{ code: "all", name: "All cores (3)" }, ...OPTIONS],
      tabs: TABS.slice(2),
      current: "11",
      allCount: 3,
    });
    expect(q.getByTestId("core-reports-eyebrow").textContent).toBe("Core facilities · Roll-up");
    expect(q.getByRole("heading", { level: 1 }).textContent).toBe("All cores reports");
    expect(q.getByTestId("core-reports-lede").textContent).toContain(
      "A publication used by two cores counts once",
    );
    expect(q.queryByTestId("core-reports-queue-link")).toBeNull();
    expect(q.queryByText(/Review queue/)).toBeNull();
    const tabs = within(q.getByTestId("core-reports-tabs")).getAllByRole("link");
    expect(tabs.map((t) => t.getAttribute("href"))).toEqual([
      "/edit/reports/core-users?center=all&kind=core",
      "/edit/reports/core-output-over-time?center=all&kind=core",
      "/edit/reports/core-grants?center=all&kind=core",
    ]);
    const select = q.getByTestId("core-reports-core-select") as HTMLSelectElement;
    expect(select.value).toBe("all");
    expect(select.options[0].text).toBe("All cores (3)");
  });

  it("one core → no picker", () => {
    const q = renderHeader({ options: [{ code: "14", name: "Beta Sequencing Core" }] });
    expect(q.queryByTestId("core-reports-core-select")).toBeNull();
    expect(q.queryByText("Viewing")).toBeNull();
    // The rest of the header still renders.
    expect(q.getByTestId("core-reports-tabs")).toBeTruthy();
  });
});
