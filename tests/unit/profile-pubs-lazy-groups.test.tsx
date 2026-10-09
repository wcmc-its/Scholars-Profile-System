/**
 * #2213 — a closed year group on the profile renders only its summary; its
 * rows mount when the reader opens it. Rendering every row inside closed
 * <details> shipped 17-20 MB documents for the largest profiles.
 */
import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

vi.mock("@/components/profile/publication-row", () => ({
  PublicationRow: ({ pub }: { pub: { pmid: string } }) => <span data-testid={`row-${pub.pmid}`} />,
}));

import { PublicationsSection } from "@/components/profile/publications-section";
import type { ProfileClientPublication } from "@/lib/profile/client-publication";

function pub(pmid: string, year: number): ProfileClientPublication {
  return {
    pmid,
    title: `Paper ${pmid}`,
    year,
    publicationType: "Academic Article",
    authorship: { isFirst: false, isLast: false, isPenultimate: false },
    meshUis: [],
    wcmAuthors: [],
  } as unknown as ProfileClientPublication;
}

// Six 2025 papers meet the default-open target (5) on their own, so 2020 stays closed.
const PUBS = [
  ...Array.from({ length: 6 }, (_, i) => pub(`25${i}`, 2025)),
  pub("200", 2020),
  pub("201", 2020),
];

describe("PublicationsSection — lazy year groups (#2213)", () => {
  it("renders rows for the default-open group only", () => {
    render(<PublicationsSection publications={PUBS} />);
    expect(screen.getByTestId("row-250")).toBeTruthy();
    expect(screen.queryByTestId("row-200")).toBeNull();
    expect(screen.queryByTestId("row-201")).toBeNull();
  });

  it("mounts a closed group's rows when the reader opens it", () => {
    const { container } = render(<PublicationsSection publications={PUBS} />);
    const closed = [...container.querySelectorAll("details")].find((d) => !d.open)!;
    act(() => {
      closed.open = true;
      closed.dispatchEvent(new Event("toggle"));
    });
    expect(screen.getByTestId("row-200")).toBeTruthy();
    expect(screen.getByTestId("row-201")).toBeTruthy();
  });
});
