/**
 * TAXONOMY_SCHOLAR_CARDS — the selected rail item's scholars (subarea on the
 * topic adapter, family on the category adapter) render as a "Scholars" h3 +
 * muted count over plain slate profile links (mockup `showSubNames`):
 *   - no pick-to-filter: no aria-pressed toggles, no "Showing publications by"
 *     chip, no live region, the feed gets no scholar prop;
 *   - `?scholar=` is neither read nor written;
 *   - flag off, the rows keep today's rendering.
 * Fake scholars only.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";

const mockGet = vi.fn();
vi.mock("next/navigation", () => ({
  useSearchParams: () => ({ get: mockGet }),
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => "/",
}));
vi.mock("@/components/taxonomy/publication-feed", () => ({
  TopicPublicationFeed: (props: Record<string, unknown>) => (
    <div data-testid="feed" data-props={Object.keys(props).sort().join(",")}>
      {(props.activeSubtopic as string | null) ?? "all"}
    </div>
  ),
  FamilyPublicationFeed: (props: Record<string, unknown>) => (
    <div data-testid="feed" data-props={Object.keys(props).sort().join(",")}>
      {props.familyLabel as string}
    </div>
  ),
}));
vi.mock("@/components/method/supercategory-all-work-feed", () => ({
  SupercategoryAllWorkFeed: () => <div data-testid="feed">all-work</div>,
}));

import { TopicRailLayout } from "@/components/topic/topic-rail-layout";
import { SupercategoryRailLayout } from "@/components/method/supercategory-rail-layout";

const subtopics = [
  {
    id: "s1",
    label: "Arrhythmia",
    displayName: "Arrhythmia",
    description: null,
    shortDescription: null,
    pubCount: 20,
  },
  {
    id: "s2",
    label: "Heart failure",
    displayName: "Heart failure",
    description: null,
    shortDescription: null,
    pubCount: 12,
  },
];

const person = (cwid: string, name: string) => ({
  cwid,
  slug: name.toLowerCase().replace(/\s+/g, "-"),
  preferredName: name,
  primaryTitle: "Professor",
  identityImageEndpoint: "",
  rank: 1,
  primaryDepartment: null,
  pubCountInSubtopic: 3,
  pubCountTotal: 9,
});
const ROSTERS: Record<string, ReturnType<typeof person>[]> = {
  s1: [person("aaa1111", "Test Alpha"), person("bbb2222", "Test Beta")],
  s2: [person("ccc3333", "Test Gamma")],
  fam_0001: [person("aaa1111", "Test Alpha"), person("ddd4444", "Test Delta")],
  fam_0002: [person("eee5555", "Test Epsilon")],
};

function desktopRail(name: string) {
  return screen.getAllByRole("complementary", { name })[0];
}
const feed = () => screen.getByTestId("feed").textContent;

let replaceSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  mockGet.mockReset();
  mockGet.mockReturnValue(null);
  window.history.replaceState(null, "", "/topics/cardio");
  replaceSpy = vi.spyOn(window.history, "replaceState");
  replaceSpy.mockClear();
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const key = Object.keys(ROSTERS).find((k) => url.includes(`/${k}/scholars`));
      return { ok: true, json: async () => ({ scholars: key ? ROSTERS[key] : [] }) };
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function expectNoPickUi() {
  expect(screen.queryAllByRole("button", { pressed: true })).toHaveLength(0);
  expect(screen.queryAllByRole("button", { pressed: false })).toHaveLength(0);
  expect(screen.queryByText(/Showing publications by/)).toBeNull();
  expect(screen.queryByTestId("scholar-filter-chip")).toBeNull();
  expect(screen.queryByTestId("scholar-filter-status")).toBeNull();
  expect(screen.queryByTestId("scholar-pick-list")).toBeNull();
  expect(screen.getByTestId("feed").getAttribute("data-props")).not.toMatch(/scholar|cwid/i);
}

describe("topic: subarea scholars as names", () => {
  it("'Scholars' h3 + count, then plain slate profile links (no avatars, no cards)", async () => {
    mockGet.mockImplementation((k: string) => (k === "subtopic" ? "s1" : null));
    render(<TopicRailLayout topicSlug="cardio" subtopics={subtopics} totalPubCount={1} scholarNames />);
    const list = await screen.findByTestId("scholar-name-list");
    const h3 = within(list).getByRole("heading", { level: 3, name: "Scholars" });
    expect(h3.className).toContain("text-xl");
    expect(h3.className).toContain("font-medium");
    expect(within(list).getByText("2").className).toContain("text-muted-foreground");
    const alpha = within(list).getByRole("link", { name: "Test Alpha" });
    expect(alpha.getAttribute("href")).toBe("/test-alpha");
    expect(alpha.className).toContain("text-[var(--color-accent-slate)]");
    expect(within(list).getByRole("link", { name: "Test Beta" })).toBeTruthy();
    expect(list.querySelector("img")).toBeNull();
    expectNoPickUi();
  });

  it("clicking a name is a profile link, never a filter (feed + URL unchanged)", async () => {
    mockGet.mockImplementation((k: string) => (k === "subtopic" ? "s1" : null));
    window.history.replaceState(null, "", "/topics/cardio?subtopic=s1");
    render(<TopicRailLayout topicSlug="cardio" subtopics={subtopics} totalPubCount={1} scholarNames />);
    const alpha = await screen.findByRole("link", { name: "Test Alpha" });
    // jsdom cannot navigate; the default action is the profile href (asserted above).
    alpha.addEventListener("click", (e) => e.preventDefault());
    fireEvent.click(alpha);
    expect(feed()).toBe("s1");
    expect(window.location.search).toBe("?subtopic=s1");
    expectNoPickUi();
  });

  it("ignores ?scholar= entirely: not read, not stripped, feed unfiltered", async () => {
    mockGet.mockImplementation((k: string) =>
      k === "subtopic" ? "s1" : k === "scholar" ? "bbb2222" : null,
    );
    window.history.replaceState(null, "", "/topics/cardio?subtopic=s1&scholar=bbb2222");
    render(<TopicRailLayout topicSlug="cardio" subtopics={subtopics} totalPubCount={1} scholarNames />);
    await screen.findByTestId("scholar-name-list");
    expect(mockGet.mock.calls.map((c) => c[0])).not.toContain("scholar");
    expect(feed()).toBe("s1");
    expectNoPickUi();
    // Changing subarea does not touch ?scholar= either (no clearParamsOnChange).
    fireEvent.click(within(desktopRail("Subareas")).getByText("Heart failure"));
    expect(window.location.search).toBe("?subtopic=s2&scholar=bbb2222");
  });

  it("flag off: today's middot name list, no names block", async () => {
    mockGet.mockImplementation((k: string) => (k === "subtopic" ? "s1" : null));
    render(<TopicRailLayout topicSlug="cardio" subtopics={subtopics} totalPubCount={1} />);
    await screen.findAllByRole("link", { name: "Test Alpha" });
    expect(screen.queryByTestId("scholar-name-list")).toBeNull();
    expect(screen.getByText(/Researchers in Arrhythmia · 2/)).toBeTruthy();
    expectNoPickUi();
  });
});

describe("category: family scholars as names", () => {
  const families = [
    { familyId: "fam_0001", familyLabel: "MRI", scholarCount: 2, pubCount: 9, exemplarTools: [] },
    { familyId: "fam_0002", familyLabel: "PET", scholarCount: 1, pubCount: 4, exemplarTools: [] },
  ];
  const familyMeta = {
    fam_0001: {
      familyLabel: "MRI",
      familySegment: "mri-fam_0001",
      definition: null,
      definitionSource: null,
    },
    fam_0002: {
      familyLabel: "PET",
      familySegment: "pet-fam_0002",
      definition: null,
      definitionSource: null,
    },
  };

  it("'Scholars' h3 + count + plain links; subhead eyebrow is 'Family'", async () => {
    mockGet.mockImplementation((k: string) => (k === "family" ? "mri-fam_0001" : null));
    render(
      <SupercategoryRailLayout
        supercategorySlug="imaging-x"
        supercategoryLabel="Imaging"
        families={families}
        familyMeta={familyMeta}
        allWorkPubs={[]}
        scholarNames
      />,
    );
    const list = await screen.findByTestId("scholar-name-list");
    expect(within(list).getByRole("heading", { level: 3, name: /Scholars/ })).toBeTruthy();
    expect(within(list).getByRole("link", { name: "Test Delta" }).getAttribute("href")).toBe(
      "/test-delta",
    );
    expect(within(screen.getByTestId("rail-subhead")).getByText("Family")).toBeTruthy();
    expect(feed()).toBe("MRI");
    expectNoPickUi();
    fireEvent.click(within(desktopRail("Method families")).getByText("All families"));
    expect(feed()).toBe("all-work");
  });
});
