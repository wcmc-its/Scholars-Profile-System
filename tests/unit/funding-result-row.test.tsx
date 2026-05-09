/**
 * Issue #78 Wave D — render-path tests for the search Funding result row.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { FundingResultRow } from "@/components/search/funding-result-row";
import type { FundingHit } from "@/lib/api/search-funding";

const baseHit: FundingHit = {
  projectId: "ACCT-1234",
  title: "PARP inhibitor combination in BRCA-mutant ovarian cancer",
  primeSponsor: "NCI",
  primeSponsorRaw: "National Cancer Institute",
  directSponsor: null,
  isSubaward: false,
  programType: "Grant",
  mechanism: "R01",
  nihIc: "NCI",
  awardNumber: "R01 CA245678",
  startDate: "2023-01-01",
  endDate: "2028-12-31",
  isActive: true,
  status: "active",
  isMultiPi: false,
  people: [
    {
      cwid: "tt1001",
      slug: "alice-author",
      preferredName: "Alice Author, MD",
      role: "PI",
      identityImageEndpoint: "https://example.com/tt1001.png",
    },
  ],
  totalPeople: 1,
  department: "Medicine",
  pubCount: 0,
  abstract: null,
  applId: null,
  publications: [],
  coreProjectNum: null,
};

describe("FundingResultRow — basics", () => {
  it("renders the title", () => {
    render(<FundingResultRow hit={baseHit} />);
    expect(
      screen.getByText(/PARP inhibitor combination in BRCA-mutant ovarian cancer/),
    ).toBeTruthy();
  });

  it("renders prime sponsor in verbose form (full canonical name)", () => {
    render(<FundingResultRow hit={baseHit} />);
    expect(screen.getByText("National Cancer Institute")).toBeTruthy();
  });

  it("renders the start–end year range", () => {
    render(<FundingResultRow hit={baseHit} />);
    expect(screen.getByText(/2023.*2028/)).toBeTruthy();
  });

  it("renders the lead PI as a chip linking to the profile", () => {
    render(<FundingResultRow hit={baseHit} />);
    const link = screen.getByRole("link", { name: /Alice Author, MD/ });
    expect(link.getAttribute("href")).toBe("/scholars/alice-author");
  });
});

describe("FundingResultRow — pills", () => {
  it("does not render Multi-PI when isMultiPi is false", () => {
    render(<FundingResultRow hit={baseHit} />);
    expect(screen.queryByText("Multi-PI")).toBeNull();
  });

  it("renders Multi-PI pill when the project is multi-PI", () => {
    render(<FundingResultRow hit={{ ...baseHit, isMultiPi: true }} />);
    expect(screen.getByText("Multi-PI")).toBeTruthy();
  });

  it("does not render a Type pill for plain Grant", () => {
    const { container } = render(<FundingResultRow hit={baseHit} />);
    expect(container.textContent?.includes("Contract")).toBe(false);
    expect(container.textContent?.includes("Fellowship")).toBe(false);
  });

  it("renders a Type pill for non-Grant program types", () => {
    render(
      <FundingResultRow
        hit={{ ...baseHit, programType: "Contract with funding" }}
      />,
    );
    expect(screen.getByText("Contract")).toBeTruthy();
  });

  it("renders an Active status badge for active grants", () => {
    render(<FundingResultRow hit={baseHit} />);
    expect(screen.getByText("Active")).toBeTruthy();
  });

  it("renders an Ending soon badge for grants in the ending-soon window", () => {
    render(<FundingResultRow hit={{ ...baseHit, status: "ending_soon" }} />);
    expect(screen.getByText("Ending soon")).toBeTruthy();
  });
});

describe("FundingResultRow — people row", () => {
  const ManyPeople: FundingHit = {
    ...baseHit,
    people: [
      { cwid: "p1", slug: "a", preferredName: "A", role: "PI", identityImageEndpoint: "" },
      { cwid: "p2", slug: "b", preferredName: "B", role: "PI", identityImageEndpoint: "" },
      { cwid: "p3", slug: "c", preferredName: "C", role: "Co-I", identityImageEndpoint: "" },
      { cwid: "p4", slug: "d", preferredName: "D", role: "Co-I", identityImageEndpoint: "" },
      { cwid: "p5", slug: "e", preferredName: "E", role: "Co-I", identityImageEndpoint: "" },
      { cwid: "p6", slug: "f", preferredName: "F", role: "Co-I", identityImageEndpoint: "" },
    ],
    totalPeople: 6,
    isMultiPi: true,
  };

  it("caps visible people at 4 and shows '+N more' for the remainder", () => {
    render(<FundingResultRow hit={ManyPeople} />);
    expect(screen.getByText("+2 more")).toBeTruthy();
  });
});

describe("FundingResultRow — subaward", () => {
  it("renders 'via [direct]' only when isSubaward and direct is populated", () => {
    render(
      <FundingResultRow
        hit={{
          ...baseHit,
          isSubaward: true,
          directSponsor: "Duke University",
        }}
      />,
    );
    expect(screen.getByText(/via/i)).toBeTruthy();
    expect(screen.getByText("Duke University")).toBeTruthy();
  });

  it("does not render 'via' on non-subaward grants", () => {
    render(<FundingResultRow hit={baseHit} />);
    expect(screen.queryByText(/via/i)).toBeNull();
  });
});

describe("FundingResultRow — award identifier", () => {
  it("splits NIH awards into MechanismAbbr + serial", () => {
    render(<FundingResultRow hit={baseHit} />);
    const r01 = screen.getByText("R01");
    expect(r01.tagName.toLowerCase()).toBe("abbr");
    expect(r01.getAttribute("title")).toBe("Research Project Grant (R01)");
    expect(screen.getByText("CA245678")).toBeTruthy();
  });

  it("renders non-NIH award numbers verbatim", () => {
    render(
      <FundingResultRow
        hit={{
          ...baseHit,
          mechanism: null,
          nihIc: null,
          awardNumber: "OCRA-2024-091",
        }}
      />,
    );
    expect(screen.getByText("OCRA-2024-091")).toBeTruthy();
  });
});
