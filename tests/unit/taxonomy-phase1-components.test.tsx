/**
 * Topic & Method refactor phase 1 — component contracts:
 *   (b) TopScholarsChipRow takes a heading/info prop; the default keeps the topic
 *       copy byte-for-byte for every existing caller.
 *   (c) Method-page feeds render the Abstract link through PublicationMeta's
 *       `lazyAbstract` (#1537), keyed on the hit's `hasAbstract` (#1881).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

vi.mock("@/components/topic/top-scholar-chip", () => ({
  TopScholarChip: ({ scholar }: { scholar: { cwid: string } }) => (
    <span data-testid="chip">{scholar.cwid}</span>
  ),
}));
vi.mock("@/components/publication/publication-modal", () => ({
  usePublicationModal: () => ({ open: vi.fn() }),
}));
vi.mock("@/components/publication/author-chip-row", () => ({
  AuthorChipRow: () => <div data-testid="author-chips" />,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/methods/sc/fam-fam_1",
  useSearchParams: () => new URLSearchParams(),
}));
const metaProps: Record<string, unknown>[] = [];
vi.mock("@/components/publication/publication-meta", () => ({
  PublicationMeta: (props: Record<string, unknown>) => {
    metaProps.push(props);
    return <div data-testid="meta" />;
  },
}));

import { TopScholarsChipRow } from "@/components/topic/top-scholars-chip-row";
import { SupercategoryAllWorkFeed } from "@/components/method/supercategory-all-work-feed";
import { FamilyPublicationFeed } from "@/components/method/publication-feed";
import type { MethodPublicationHit } from "@/lib/api/methods";

const scholars = ["a", "b", "c"].map((cwid, i) => ({
  cwid,
  slug: cwid,
  preferredName: cwid,
  primaryTitle: null,
  identityImageEndpoint: "",
  rank: i + 1,
}));

describe("(b) TopScholarsChipRow heading", () => {
  it("defaults to the topic copy (existing callers unchanged)", () => {
    render(<TopScholarsChipRow scholars={scholars} scholarCount={3} topicSlug="t" />);
    expect(screen.getByText("Scholars in this area")).toBeTruthy();
    expect(screen.getByRole("button", { name: "About Scholars in this area" })).toBeTruthy();
  });

  it("renders a caller-supplied heading and info label", () => {
    render(
      <TopScholarsChipRow
        scholars={scholars}
        heading="Scholars using this"
        info="Method copy."
        enablePopover
      />,
    );
    expect(screen.getByText("Scholars using this")).toBeTruthy();
    expect(screen.queryByText("Scholars in this area")).toBeNull();
    expect(screen.getByRole("button", { name: "About Scholars using this" })).toBeTruthy();
  });
});

const hit = (pmid: string, hasAbstract: boolean): MethodPublicationHit => ({
  pmid,
  title: `Paper ${pmid}`,
  journal: "Nature",
  year: 2025,
  publicationType: "Journal Article",
  citationCount: 1,
  pubmedUrl: null,
  doi: null,
  pmcid: null,
  impactScore: null,
  abstract: null,
  hasAbstract,
  authors: [
    {
      name: "Ada",
      cwid: "aaa1111",
      slug: "ada",
      identityImageEndpoint: "",
      isFirst: true,
      isLast: false,
    } as MethodPublicationHit["authors"][number],
  ],
});

describe("(c) method feeds pass lazyAbstract from hasAbstract", () => {
  beforeEach(() => {
    metaProps.length = 0;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("supercategory All-work feed", () => {
    render(
      <SupercategoryAllWorkFeed pubs={[hit("1", true), hit("2", false)]} supercategoryLabel="SC" />,
    );
    expect(metaProps.map((p) => [p.pmid, p.lazyAbstract])).toEqual([
      ["1", true],
      ["2", false],
    ]);
  });

  it("family publication feed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              hits: [hit("1", true), hit("2", false)],
              total: 2,
              totalAllTypes: 2,
              totalResearchOnly: 2,
              page: 0,
              pageSize: 20,
            }),
        }),
      ),
    );
    render(
      <FamilyPublicationFeed supercategorySlug="sc" familySegment="fam-fam_1" familyLabel="Fam" />,
    );
    await waitFor(() => expect(screen.getAllByTestId("meta")).toHaveLength(2));
    const last = metaProps.slice(-2);
    expect(last.map((p) => [p.pmid, p.lazyAbstract])).toEqual([
      ["1", true],
      ["2", false],
    ]);
  });
});
