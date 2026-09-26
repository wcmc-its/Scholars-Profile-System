/**
 * Phase 3 (TAXONOMY_SCHOLAR_CARDS) — pick-to-filter scholars for the selected
 * rail item, on the topic adapter (subareas) and the category adapter
 * (families):
 *   - each card is an aria-pressed toggle with a SEPARATE profile link;
 *   - picking filters the feed (`scholarCwid`), dims the other cards, shows
 *     "Showing publications by X ×" + "View X's profile →", writes ?scholar=;
 *   - × on the chip, re-pressing the card, picking another rail item, Clear
 *     and "All …" each clear the filter (and the URL param);
 *   - a ?scholar= deep link resolves once the roster loads, and a stale one
 *     (not in the roster) is dropped;
 *   - flag off, the rows keep today's plain rendering (no toggles).
 * Fake scholars only.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

const mockGet = vi.fn();
vi.mock("next/navigation", () => ({
  useSearchParams: () => ({ get: mockGet }),
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => "/",
}));
vi.mock("@/components/topic/publication-feed", () => ({
  PublicationFeed: ({
    activeSubtopic,
    scholarCwid,
  }: {
    activeSubtopic: string | null;
    scholarCwid?: string | null;
  }) => (
    <div data-testid="feed">
      {activeSubtopic ?? "all"}|{scholarCwid ?? "none"}
    </div>
  ),
}));
vi.mock("@/components/method/publication-feed", () => ({
  FamilyPublicationFeed: ({
    familyLabel,
    scholarCwid,
  }: {
    familyLabel: string;
    scholarCwid?: string | null;
  }) => (
    <div data-testid="feed">
      {familyLabel}|{scholarCwid ?? "none"}
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

describe("topic: pick-to-filter subarea scholars", () => {
  it("toggle: aria-pressed, dims the others, filters the feed, chip + profile link, URL", async () => {
    mockGet.mockImplementation((k: string) => (k === "subtopic" ? "s1" : null));
    render(<TopicRailLayout topicSlug="cardio" subtopics={subtopics} scholarFilter />);
    const alpha = await screen.findByRole("button", { name: /Test Alpha/ });
    expect(alpha.getAttribute("aria-pressed")).toBe("false");
    // The profile link is separate from the toggle.
    const profile = screen.getByRole("link", { name: "View Test Alpha's profile" });
    expect(profile.getAttribute("href")).toBe("/test-alpha");
    expect(alpha.contains(profile)).toBe(false);

    fireEvent.click(alpha);
    expect(alpha.getAttribute("aria-pressed")).toBe("true");
    expect(feed()).toBe("s1|aaa1111");
    const cards = screen.getAllByTestId("scholar-pick-card");
    expect(cards[0].getAttribute("data-dimmed")).toBeNull();
    expect(cards[1].getAttribute("data-dimmed")).toBe("true");
    expect(cards[1].className).toContain("opacity-60");
    const chip = screen.getByTestId("scholar-filter-chip");
    expect(within(chip).getByText("Showing publications by")).toBeTruthy();
    expect(
      within(chip).getByRole("link", { name: "View Test Alpha's profile →" }).getAttribute("href"),
    ).toBe("/test-alpha");
    expect(window.location.search).toBe("?scholar=aaa1111");

    // Pressing again un-filters.
    fireEvent.click(alpha);
    expect(feed()).toBe("s1|none");
    expect(screen.queryByTestId("scholar-filter-chip")).toBeNull();
    expect(window.location.search).toBe("");
  });

  it("× on the chip clears the filter and the URL param", async () => {
    mockGet.mockImplementation((k: string) => (k === "subtopic" ? "s1" : null));
    render(<TopicRailLayout topicSlug="cardio" subtopics={subtopics} scholarFilter />);
    fireEvent.click(await screen.findByRole("button", { name: /Test Beta/ }));
    expect(feed()).toBe("s1|bbb2222");
    fireEvent.click(screen.getByRole("button", { name: "Clear scholar filter" }));
    expect(feed()).toBe("s1|none");
    expect(window.location.search).toBe("");
    expect(screen.getAllByRole("button", { pressed: false })).toBeTruthy();
  });

  it("selecting another rail item clears the scholar filter", async () => {
    mockGet.mockImplementation((k: string) => (k === "subtopic" ? "s1" : null));
    render(<TopicRailLayout topicSlug="cardio" subtopics={subtopics} scholarFilter />);
    fireEvent.click(await screen.findByRole("button", { name: /Test Alpha/ }));
    expect(feed()).toBe("s1|aaa1111");
    fireEvent.click(within(desktopRail("Subareas")).getByText("Heart failure"));
    expect(feed()).toBe("s2|none");
    expect(window.location.search).toBe("?subtopic=s2");
    await screen.findByRole("button", { name: /Test Gamma/ });
    expect(screen.queryByTestId("scholar-filter-chip")).toBeNull();
  });

  it("Clear × in the subhead clears the scholar filter too", async () => {
    mockGet.mockImplementation((k: string) => (k === "subtopic" ? "s1" : null));
    render(<TopicRailLayout topicSlug="cardio" subtopics={subtopics} scholarFilter />);
    fireEvent.click(await screen.findByRole("button", { name: /Test Alpha/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Clear Arrhythmia/ }));
    expect(feed()).toBe("all|none");
    expect(window.location.search).toBe("");
  });

  it("resolves a ?subtopic=&scholar= deep link once the roster loads", async () => {
    mockGet.mockImplementation((k: string) =>
      k === "subtopic" ? "s1" : k === "scholar" ? "bbb2222" : null,
    );
    window.history.replaceState(null, "", "/topics/cardio?subtopic=s1&scholar=bbb2222");
    render(<TopicRailLayout topicSlug="cardio" subtopics={subtopics} scholarFilter />);
    await waitFor(() => expect(feed()).toBe("s1|bbb2222"));
    expect(screen.getByRole("button", { name: /Test Beta/ }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("drops a stale ?scholar= that is not in the roster (never filters by it)", async () => {
    mockGet.mockImplementation((k: string) =>
      k === "subtopic" ? "s1" : k === "scholar" ? "zzz9999" : null,
    );
    window.history.replaceState(null, "", "/topics/cardio?subtopic=s1&scholar=zzz9999");
    render(<TopicRailLayout topicSlug="cardio" subtopics={subtopics} scholarFilter />);
    await screen.findByRole("button", { name: /Test Alpha/ });
    await waitFor(() => expect(window.location.search).toBe("?subtopic=s1"));
    expect(feed()).toBe("s1|none");
  });

  it("drops a malformed ?scholar= without a request", async () => {
    mockGet.mockImplementation((k: string) =>
      k === "subtopic" ? "s1" : k === "scholar" ? "<script>" : null,
    );
    render(<TopicRailLayout topicSlug="cardio" subtopics={subtopics} scholarFilter />);
    await screen.findByRole("button", { name: /Test Alpha/ });
    expect(feed()).toBe("s1|none");
  });

  it("flag off: the subarea scholars stay plain profile links (no toggles)", async () => {
    mockGet.mockImplementation((k: string) => (k === "subtopic" ? "s1" : null));
    render(<TopicRailLayout topicSlug="cardio" subtopics={subtopics} />);
    await screen.findAllByRole("link", { name: "Test Alpha" });
    expect(screen.queryByRole("button", { name: /Test Alpha/ })).toBeNull();
    expect(screen.queryByTestId("scholar-pick-list")).toBeNull();
    expect(feed()).toBe("s1|none");
  });
});

describe("category: pick-to-filter family scholars", () => {
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

  it("filters the family feed, and 'All families' clears it", async () => {
    mockGet.mockImplementation((k: string) => (k === "family" ? "mri-fam_0001" : null));
    window.history.replaceState(null, "", "/methods/imaging-x?family=mri-fam_0001");
    render(
      <SupercategoryRailLayout
        supercategorySlug="imaging-x"
        supercategoryLabel="Imaging"
        families={families}
        familyMeta={familyMeta}
        allWorkPubs={[]}
        scholarFilter
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Test Delta/ }));
    expect(feed()).toBe("MRI|ddd4444");
    expect(window.location.search).toBe("?family=mri-fam_0001&scholar=ddd4444");

    fireEvent.click(within(desktopRail("Method families")).getByText("All families"));
    expect(feed()).toBe("all-work");
    expect(window.location.search).toBe("");
  });

  it("switching family clears the scholar filter", async () => {
    mockGet.mockImplementation((k: string) => (k === "family" ? "mri-fam_0001" : null));
    render(
      <SupercategoryRailLayout
        supercategorySlug="imaging-x"
        supercategoryLabel="Imaging"
        families={families}
        familyMeta={familyMeta}
        allWorkPubs={[]}
        scholarFilter
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Test Alpha/ }));
    expect(feed()).toBe("MRI|aaa1111");
    fireEvent.click(within(desktopRail("Method families")).getByText("PET"));
    expect(feed()).toBe("PET|none");
    expect(window.location.search).not.toContain("scholar=");
    await screen.findByRole("button", { name: /Test Epsilon/ });
  });
});
