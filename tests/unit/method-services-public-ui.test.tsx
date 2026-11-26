/**
 * METHOD_SERVICES on the public method page, rendered:
 *   - `MethodServicesBlock`: the "WCM services for this method" block;
 *   - `FamilyPublicationFeed` with services: the service filter (`?service=`,
 *     "{Unit} collaborations", "{Unit} support" or both), its request, and the
 *     "{Unit} collaboration" / "{Unit} support" badge.
 * Made-up units and PMIDs only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

vi.mock("@/components/publication/publication-modal", () => ({
  usePublicationModal: () => ({ open: vi.fn() }),
}));
vi.mock("@/components/publication/author-chip-row", () => ({ AuthorChipRow: () => null }));
vi.mock("@/components/publication/publication-meta", () => ({ PublicationMeta: () => null }));
vi.mock("next/link", () => ({
  default: (props: { href: string; children: React.ReactNode; prefetch?: boolean }) => {
    const rest: Record<string, unknown> = { ...props };
    delete rest.prefetch;
    return <a {...rest} />;
  },
}));
let search = new URLSearchParams();
const replaceSpy = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceSpy, push: vi.fn() }),
  usePathname: () => "/methods/sc/fam-fam_1",
  useSearchParams: () => search,
}));

import { FamilyListAboutButton } from "@/components/method/family-list-about-button";
import { MethodServicesBlock } from "@/components/method/method-services-block";
import { isSystematicReviewFamily } from "@/lib/methods/systematic-review-family";
import { FamilyPublicationFeed } from "@/components/taxonomy/publication-feed";
import type { FamilyServiceEntry } from "@/lib/api/methods";

const LIBRARY: FamilyServiceEntry = {
  id: 7,
  name: "Example review service",
  url: "https://example.org/reviews",
  unitName: "Example Library",
  unitHref: "/departments/example-library",
  label: "Example Library",
  count: 188,
  collaborations: 12,
  support: 176,
};
const CORE: FamilyServiceEntry = {
  id: 9,
  name: "Imaging help",
  url: "https://example.org/imaging",
  unitName: "The Example Imaging Core",
  unitHref: "/cores/77",
  label: "The Example Imaging Core",
  count: 0,
  collaborations: 0,
  support: 0,
};

describe("MethodServicesBlock", () => {
  const renderBlock = (services: FamilyServiceEntry[]) =>
    render(<MethodServicesBlock services={services} total={1159} familyPath="/methods/sc/fam-fam_1" />);

  it("renders nothing when there is no service", () => {
    const { container } = renderBlock([]);
    expect(container.innerHTML).toBe("");
  });

  it("has the heading, the service as an external https link, and the unit, fully named and linked", () => {
    renderBlock([LIBRARY]);
    expect(screen.getByRole("heading", { name: "WCM services for this method" })).toBeTruthy();
    const out = screen.getByRole("link", { name: /Example review service/ }) as HTMLAnchorElement;
    expect(out.getAttribute("href")).toBe("https://example.org/reviews");
    expect(out.target).toBe("_blank");
    expect(out.rel).toContain("noopener");
    const row = within(screen.getByTestId("method-service-7"));
    expect(row.getByText(/Offered by the/).textContent).toBe("Offered by the Example Library");
    expect(row.getByRole("link", { name: "Example Library" }).getAttribute("href")).toBe(
      "/departments/example-library",
    );
  });

  it("S is 0: collaborated on N of the M", () => {
    renderBlock([{ ...LIBRARY, collaborations: 188, support: 0 }]);
    const row = screen.getByTestId("method-service-7");
    expect(row.textContent).toContain(
      "The Example Library collaborated on 188 of the 1,159 publications listed here.",
    );
    expect(row.textContent).not.toContain("supported");
    expect(screen.getByTestId("method-service-show-7").getAttribute("aria-label")).toBe(
      "Show them: the 188 Example Library collaborations",
    );
  });

  it("N is 0: supported S of the M", () => {
    renderBlock([{ ...LIBRARY, collaborations: 0, support: 188 }]);
    const row = screen.getByTestId("method-service-7");
    expect(row.textContent).toContain(
      "The Example Library supported 188 of the 1,159 publications listed here.",
    );
    expect(row.textContent).not.toContain("collaborated");
    expect(screen.getByTestId("method-service-show-7").getAttribute("aria-label")).toBe(
      "Show them: the 188 Example Library support",
    );
  });

  it("N and S: collaborated on N and supported S of the M, with Show them", () => {
    renderBlock([LIBRARY]);
    const row = screen.getByTestId("method-service-7");
    expect(row.textContent).toContain(
      "The Example Library collaborated on 12 and supported 176 of the 1,159 publications listed here.",
    );
    expect(screen.getByTestId("method-service-show-7").getAttribute("aria-label")).toBe(
      "Show them: the 188 Example Library collaborations and support",
    );
    const show = screen.getByTestId("method-service-show-7");
    expect(show.getAttribute("href")).toBe("/methods/sc/fam-fam_1?service=7#publications");
    expect(show.textContent).toContain("Show them");
    // The accessible name starts with the visible text.
    expect(show.getAttribute("aria-label")).toMatch(/^Show them/);
  });

  it("leaves the sentence and Show them out when N and S are both 0, and never doubles the article", () => {
    renderBlock([CORE]);
    const row = screen.getByTestId("method-service-9");
    expect(row.textContent).not.toContain("collaborated on");
    expect(row.textContent).not.toContain("supported");
    expect(screen.queryByTestId("method-service-show-9")).toBeNull();
    expect(row.textContent).toContain("Offered by the Example Imaging Core");
    expect(row.textContent).not.toContain("the The");
  });

  it("lists every service, in the order given", () => {
    renderBlock([LIBRARY, CORE]);
    const items = screen.getAllByTestId(/^method-service-\d+$/);
    expect(items.map((el) => el.getAttribute("data-testid"))).toEqual([
      "method-service-7",
      "method-service-9",
    ]);
  });

  it("does not turn a non-https address into a link", () => {
    renderBlock([{ ...LIBRARY, url: "javascript:alert(1)" }]);
    expect(screen.queryByRole("link", { name: /Example review service/ })).toBeNull();
    expect(screen.getByText("Example review service")).toBeTruthy();
  });
});

describe("the systematic review family's About this list note", () => {
  it("is for the systematic review family only, spelling aside", () => {
    expect(
      isSystematicReviewFamily("computational_statistical", "Systematic review and meta-analysis"),
    ).toBe(true);
    expect(
      isSystematicReviewFamily("computational_statistical", "Systematic Review and Meta-Analysis"),
    ).toBe(true);
    expect(isSystematicReviewFamily("computational_statistical", "Example review methods")).toBe(
      false,
    );
    expect(isSystematicReviewFamily("evidence_synthesis", "Systematic review and meta-analysis")).toBe(
      false,
    );
  });

  it("opens to say where the list comes from", async () => {
    render(<FamilyListAboutButton />);
    expect(screen.queryByText(/full-time or part-time faculty author/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "About this list" }));
    const note = await screen.findByText(/full-time or part-time faculty author/);
    expect(note.textContent).toContain(
      "This list combines methods extracted from papers with PubMed's systematic review filter.",
    );
  });
});

describe("FamilyPublicationFeed with services", () => {
  const SERVICES = [
    { id: 7, label: "Example Library", count: 188, collaborations: 12, support: 176 },
    { id: 9, label: "Example Imaging Core", count: 4, collaborations: 4, support: 0 },
  ];
  const hit = (pmid: string, extra: Record<string, unknown> = {}) => ({
    pmid,
    title: `Example paper ${pmid}`,
    journal: "Example Journal",
    year: 2024,
    publicationType: "Academic Article",
    citationCount: null,
    pubmedUrl: null,
    doi: null,
    pmcid: null,
    impactScore: null,
    abstract: null,
    hasAbstract: false,
    authors: [],
    ...extra,
  });
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    search = new URLSearchParams();
    replaceSpy.mockReset();
    fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        hits: [
          hit("101", { serviceIds: [7, 9], supportServiceIds: [7] }),
          hit("102"),
          hit("103", { serviceIds: [7] }),
        ],
        total: 3,
        totalAllTypes: 1200,
        totalResearchOnly: 1159,
        page: 1,
        pageSize: 20,
        services: [
          { id: 7, label: "Example Library", count: 190, collaborations: 12, support: 178 },
          { id: 9, label: "Example Imaging Core", count: 4, collaborations: 4, support: 0 },
        ],
      }),
    }));
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  const renderFeed = (services?: typeof SERVICES) =>
    render(
      <FamilyPublicationFeed
        supercategorySlug="sc"
        familySegment="fam-fam_1"
        familyLabel="Fam"
        services={services}
      />,
    );
  const requests = () => fetchSpy.mock.calls.map((c) => new URL(String(c[0])));

  it("shows one labelled filter per service, off by default, with the response's count", async () => {
    renderFeed(SERVICES);
    await screen.findByText("Example paper 101");
    // Named for what it selects: both kinds for the library, one for the core.
    const library = screen.getByRole("button", { name: /^Example Library collaborations and support/ });
    expect(library.getAttribute("aria-pressed")).toBe("false");
    expect(library.textContent).toContain("190");
    const core = screen.getByRole("button", { name: /^Example Imaging Core collaborations/ });
    expect(core.textContent).not.toContain("support");
    expect(requests()[0].searchParams.has("service")).toBe(false);
  });

  it("badges each matching publication, one badge per unit", async () => {
    renderFeed(SERVICES);
    await screen.findByText("Example paper 101");
    const rows = screen.getAllByRole("listitem");
    const badges = (i: number) =>
      within(rows[i]).queryAllByTestId("pub-service-badge").map((b) => b.textContent);
    expect(badges(0)).toEqual(["Example Library support", "Example Imaging Core collaboration"]);
    expect(badges(1)).toEqual([]);
    expect(badges(2)).toEqual(["Example Library collaboration"]);
  });

  it("turning a filter on writes ?service= to the URL and resets paging", async () => {
    search = new URLSearchParams("page=3&shown=60&entity=tool_1");
    renderFeed(SERVICES);
    await screen.findByText("Example paper 101");
    fireEvent.click(screen.getByRole("button", { name: /Example Library collaborations/ }));
    expect(replaceSpy).toHaveBeenCalledWith(
      "/methods/sc/fam-fam_1?entity=tool_1&service=7",
      { scroll: false },
    );
  });

  it("?service= turns the filter on, sends it to the feed route and says N of M publications", async () => {
    search = new URLSearchParams("service=7");
    renderFeed(SERVICES);
    await screen.findByText("Example paper 101");
    expect(requests()[0].searchParams.get("service")).toBe("7");
    const library = screen.getByRole("button", { name: /Example Library collaborations/ });
    expect(library.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("publications-count").textContent).toBe("3 of 1,159 publications");
    expect(screen.getAllByRole("status").map((el) => el.textContent)).toContain(
      "Showing Example Library collaborations and support",
    );
    // Pressing it again clears the filter.
    fireEvent.click(library);
    expect(replaceSpy).toHaveBeenCalledWith("/methods/sc/fam-fam_1", { scroll: false });
  });

  it("a service with only support is called '{Unit} support', in the filter and the empty text", async () => {
    search = new URLSearchParams("service=7");
    fetchSpy.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        hits: [],
        total: 0,
        totalAllTypes: 1200,
        totalResearchOnly: 1159,
        page: 1,
        pageSize: 20,
        services: [{ id: 7, label: "Example Library", count: 30, collaborations: 0, support: 30 }],
      }),
    }));
    renderFeed([{ id: 7, label: "Example Library", count: 30, collaborations: 0, support: 30 }]);
    await screen.findByText("No Example Library support in this view.");
    const filter = screen.getByTestId("service-filter-7");
    expect(filter.textContent).toContain("Example Library support");
    expect(filter.textContent).not.toContain("collaborations");
    expect(screen.getAllByRole("status").map((el) => el.textContent)).toContain(
      "Showing Example Library support",
    );
  });

  it("the filter's name follows the response's counts for the view", async () => {
    // Default view: only collaborations. Under all types the response adds support.
    renderFeed([{ id: 7, label: "Example Library", count: 12, collaborations: 12, support: 0 }]);
    await screen.findByText("Example paper 101");
    expect(screen.getByTestId("service-filter-7").textContent).toContain(
      "Example Library collaborations and support",
    );
  });

  it("a response without the split (an older task mid-deploy) reads as collaborations", async () => {
    fetchSpy.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        hits: [hit("101", { serviceIds: [7] })],
        total: 1,
        totalAllTypes: 1200,
        totalResearchOnly: 1159,
        page: 1,
        pageSize: 20,
        services: [{ id: 7, label: "Example Library", count: 190 }],
      }),
    }));
    renderFeed(SERVICES);
    await screen.findByText("Example paper 101");
    const text = screen.getByTestId("service-filter-7").textContent ?? "";
    expect(text).toContain("Example Library collaborations");
    expect(text).not.toContain("support");
    expect(screen.getByTestId("pub-service-badge").textContent).toBe("Example Library collaboration");
  });

  it("ignores a ?service= that is not one of the page's services", async () => {
    search = new URLSearchParams("service=555");
    renderFeed(SERVICES);
    await screen.findByText("Example paper 101");
    expect(requests()[0].searchParams.has("service")).toBe(false);
    expect(screen.getByTestId("publications-count").textContent).toBe("3");
  });

  it("a service with no collaborations in the view gets no filter", async () => {
    fetchSpy.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        hits: [hit("101", { serviceIds: [7] })],
        total: 1,
        totalAllTypes: 1200,
        totalResearchOnly: 1159,
        page: 1,
        pageSize: 20,
        services: [
          { id: 7, label: "Example Library", count: 190 },
          { id: 9, label: "Example Imaging Core", count: 0 },
        ],
      }),
    }));
    renderFeed([SERVICES[0], { ...SERVICES[1], count: 0 }]);
    await screen.findByText("Example paper 101");
    expect(screen.getByRole("button", { name: /Example Library collaborations/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Example Imaging Core collaborations/ })).toBeNull();
  });

  it("a filter that is on with nothing to show stays so it can be turned off, and the empty text names it", async () => {
    search = new URLSearchParams("service=9");
    fetchSpy.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        hits: [],
        total: 0,
        totalAllTypes: 1200,
        totalResearchOnly: 1159,
        page: 1,
        pageSize: 20,
        services: [
          { id: 7, label: "Example Library", count: 190 },
          { id: 9, label: "Example Imaging Core", count: 0 },
        ],
      }),
    }));
    renderFeed([SERVICES[0], { ...SERVICES[1], count: 0 }]);
    await screen.findByText("No Example Imaging Core collaborations in this view.");
    expect(screen.queryByText(/will appear as they are indexed/)).toBeNull();
    const core = screen.getByRole("button", { name: /Example Imaging Core collaborations/ });
    expect(core.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(core);
    expect(replaceSpy).toHaveBeenCalledWith("/methods/sc/fam-fam_1", { scroll: false });
  });

  it("with no services there is no filter, no badge, and ?service= is ignored", async () => {
    search = new URLSearchParams("service=7");
    renderFeed(undefined);
    await screen.findByText("Example paper 101");
    expect(screen.queryByRole("button", { name: /collaborations/ })).toBeNull();
    expect(screen.queryAllByTestId("pub-service-badge")).toEqual([]);
    expect(requests()[0].searchParams.has("service")).toBe(false);
  });
});
