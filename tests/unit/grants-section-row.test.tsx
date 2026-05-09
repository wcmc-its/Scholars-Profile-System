/**
 * Issue #78 Wave C — render-path tests for the profile Funding row.
 *
 * Doesn't exhaustively test the toolbar/role-bucket logic (which predates
 * this issue); focuses on the new structured rendering paths added in
 * Wave C: SponsorAbbr eyebrow with raw fall-through, "via [direct]"
 * subaward annotation, Type pill, and MechanismAbbr in award numbers.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { GrantsSection } from "@/components/profile/grants-section";
import type { ProfilePayload } from "@/lib/api/profile";

type Grant = ProfilePayload["grants"][number];

beforeEach(() => {
  // The component fires /api/nih-resolve on mount; stub fetch so we don't
  // get unhandled-rejection warnings about missing network in jsdom.
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    }),
  );
});

const baseGrant: Grant = {
  title: "A study of test rendering for funding rows",
  role: "PI",
  funder: "NCI",
  startDate: "2023-01-01",
  endDate: "2028-12-31",
  isActive: true,
  awardNumber: "R01 CA245678",
  programType: "Grant",
  primeSponsor: "NCI",
  primeSponsorRaw: "National Cancer Institute",
  directSponsor: "NCI",
  directSponsorRaw: "National Cancer Institute",
  mechanism: "R01",
  nihIc: "NCI",
  isSubaward: false,
  coreProjectNum: "R01CA245678",
  applId: null,
  abstract: null,
  abstractSource: null,
  publications: [],
};

describe("GrantsSection row — eyebrow rendering", () => {
  it("renders the prime sponsor in verbose form (full canonical name)", () => {
    render(<GrantsSection grants={[baseGrant]} />);
    expect(screen.getByText("National Cancer Institute")).toBeTruthy();
  });

  it("renders the start–end year range alongside the sponsor", () => {
    render(<GrantsSection grants={[baseGrant]} />);
    expect(screen.getByText(/2023.*2028/)).toBeTruthy();
  });

  it("renders raw text (no <abbr>) when sponsor isn't in the canonical lookup", () => {
    const g: Grant = {
      ...baseGrant,
      primeSponsor: null,
      primeSponsorRaw: "Some Tiny Family Foundation",
      directSponsor: null,
      directSponsorRaw: "Some Tiny Family Foundation",
    };
    const { container } = render(<GrantsSection grants={[g]} />);
    expect(screen.getByText("Some Tiny Family Foundation")).toBeTruthy();
    // No <abbr> is rendered for unknown sponsors.
    const eyebrow = container.querySelector(".text-muted-foreground");
    expect(eyebrow?.querySelector("abbr")).toBeNull();
  });

  it("falls back to legacy `funder` when both structured fields are null", () => {
    const g: Grant = {
      ...baseGrant,
      primeSponsor: null,
      primeSponsorRaw: null,
      funder: "Legacy funder string from old ETL",
    };
    render(<GrantsSection grants={[g]} />);
    expect(screen.getByText("Legacy funder string from old ETL")).toBeTruthy();
  });
});

describe("GrantsSection row — subaward annotation", () => {
  it("renders 'via [direct]' when isSubaward is true and direct differs", () => {
    const g: Grant = {
      ...baseGrant,
      directSponsor: null,
      directSponsorRaw: "Duke University",
      isSubaward: true,
    };
    render(<GrantsSection grants={[g]} />);
    expect(screen.getByText(/via/i)).toBeTruthy();
    expect(screen.getByText("Duke University")).toBeTruthy();
  });

  it("does not render 'via' when direct sponsor equals prime", () => {
    render(<GrantsSection grants={[baseGrant]} />);
    expect(screen.queryByText(/via/i)).toBeNull();
  });

  it("does not render 'via' when isSubaward is false even if direct differs", () => {
    const g: Grant = {
      ...baseGrant,
      directSponsor: null,
      directSponsorRaw: "Different",
      isSubaward: false,
    };
    render(<GrantsSection grants={[g]} />);
    expect(screen.queryByText(/via/i)).toBeNull();
  });
});

describe("GrantsSection row — Type pill", () => {
  it("does not render a Type pill for plain Grant", () => {
    const { container } = render(<GrantsSection grants={[baseGrant]} />);
    // Only the role chip ("PI") should appear; no Type pill.
    expect(within(container).queryByText(/contract|fellowship|career|training|equipment|biopharma/i)).toBeNull();
  });

  it("renders a Type pill when programType is Contract with funding", () => {
    const g: Grant = { ...baseGrant, programType: "Contract with funding" };
    render(<GrantsSection grants={[g]} />);
    expect(screen.getByText("Contract")).toBeTruthy();
  });

  it("renders Fellowship / Career / Training / Equipment Type pills verbatim", () => {
    for (const pt of ["Fellowship", "Career", "Training", "Equipment"]) {
      const g: Grant = { ...baseGrant, programType: pt };
      const { unmount } = render(<GrantsSection grants={[g]} />);
      expect(screen.getByText(pt)).toBeTruthy();
      unmount();
    }
  });

  it("collapses 'BioPharma Alliance Agreement' to 'BioPharma Alliance'", () => {
    const g: Grant = {
      ...baseGrant,
      programType: "BioPharma Alliance Agreement",
    };
    render(<GrantsSection grants={[g]} />);
    expect(screen.getByText("BioPharma Alliance")).toBeTruthy();
  });
});

describe("GrantsSection row — award number rendering", () => {
  it("splits NIH awards into a MechanismAbbr + IC+serial", () => {
    render(<GrantsSection grants={[baseGrant]} />);
    const r01 = screen.getByText("R01");
    expect(r01.tagName.toLowerCase()).toBe("abbr");
    expect(r01.getAttribute("title")).toBe("Research Project Grant (R01)");
    // The remaining "CA245678" is rendered separately (no R01 prefix).
    expect(screen.getByText("CA245678")).toBeTruthy();
  });

  it("strips a leading support-flag + mechanism from the displayed serial", () => {
    const g: Grant = {
      ...baseGrant,
      awardNumber: "1R01CA245678-01A1",
      mechanism: "R01",
    };
    render(<GrantsSection grants={[g]} />);
    expect(screen.getByText("CA245678-01A1")).toBeTruthy();
  });

  it("renders the unmodified award number when mechanism is null (non-NIH)", () => {
    const g: Grant = {
      ...baseGrant,
      awardNumber: "OCRA-2024-091",
      mechanism: null,
      nihIc: null,
    };
    render(<GrantsSection grants={[g]} />);
    expect(screen.getByText("OCRA-2024-091")).toBeTruthy();
  });
});
