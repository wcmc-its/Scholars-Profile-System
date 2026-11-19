import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/components/publication/author-chip-row", () => ({ AuthorChipRow: () => null }));

import { PublicationCard } from "@/components/department/publication-card";

const PUB = {
  pmid: "1",
  title: "A paper",
  journal: "Nature metabolism",
  year: 2026,
  citationCount: 0,
  doi: null,
  pubmedUrl: null,
  authors: [],
};

describe("PublicationCard (unit pages), stage badge", () => {
  it("ends the journal/year line with the stage badge", () => {
    render(<PublicationCard pub={{ ...PUB, translationalStage: "T1" }} />);
    const badge = screen.getByTestId("pub-row-stage");
    expect(badge.parentElement!.textContent).toBe("Nature metabolism · 2026T1 Early translation");
    expect(badge.parentElement!.lastElementChild).toBe(badge);
  });

  it("no stage, no badge", () => {
    render(<PublicationCard pub={PUB} />);
    expect(screen.queryByTestId("pub-row-stage")).toBeNull();
  });
});
