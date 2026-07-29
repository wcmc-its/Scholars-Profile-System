/**
 * Issue #78 Wave C — render-path tests for the profile Funding row.
 *
 * Doesn't exhaustively test the toolbar/role-bucket logic (which predates
 * this issue); focuses on the new structured rendering paths added in
 * Wave C: SponsorAbbr eyebrow with raw fall-through, "via [direct]"
 * subaward annotation, Type pill, and MechanismAbbr in award numbers.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
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

afterEach(() => {
  // Restore the fetch stub each test so it can't leak into a later file if
  // file isolation is ever relaxed (#660).
  vi.unstubAllGlobals();
});

const baseGrant: Grant = {
  title: "A study of test rendering for funding rows",
  role: "PI",
  funder: "NCI",
  source: "InfoEd",
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
  isMultiPi: false,
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

describe("GrantsSection row — RePORTER provenance marker", () => {
  it("renders a 'via NIH RePORTER' marker when a member's source is RePORTER", () => {
    const g: Grant = { ...baseGrant, source: "RePORTER" };
    render(<GrantsSection grants={[g]} />);
    expect(screen.getByText(/via NIH RePORTER/i)).toBeTruthy();
  });

  it("does not render the RePORTER marker for InfoEd-sourced grants", () => {
    render(<GrantsSection grants={[baseGrant]} />);
    expect(screen.queryByText(/via NIH RePORTER/i)).toBeNull();
  });
});

/** The row's role pill. `tracking-wider` is the pill's own utility — the Type
 *  pill next to the eyebrow uses `tracking-wide`, so this can't collide. */
function rolePillText(container: HTMLElement): string {
  return container.querySelector(".tracking-wider")?.textContent ?? "";
}

describe("GrantsSection row — MPI relabelling of the contact PI", () => {
  // InfoEd flags only the CONTACT PI as `PI`, so the role alone can't say the
  // award is multiple-PI. `isMultiPi` (≥2 distinct WCM PD/PIs on the project) is
  // what turns that pill into MPI; a `Co-PI` row needs no flag at all.
  it("renders 'PI' for a contact PI on a single-PI award", () => {
    const { container } = render(<GrantsSection grants={[baseGrant]} />);
    expect(rolePillText(container)).toBe("PI");
  });

  it("renders 'MPI' for a contact PI once isMultiPi is set", () => {
    const g: Grant = { ...baseGrant, role: "PI", isMultiPi: true };
    const { container } = render(<GrantsSection grants={[g]} />);
    expect(rolePillText(container)).toBe("MPI");
  });

  it("renders 'MPI' for a PI-Subaward contact PI on a multi-PI award", () => {
    const sub: Grant = { ...baseGrant, role: "PI-Subaward", isMultiPi: false };
    const { container: plain } = render(<GrantsSection grants={[sub]} />);
    expect(rolePillText(plain)).toBe("Sub-PI");

    const { container: mpi } = render(
      <GrantsSection grants={[{ ...sub, isMultiPi: true }]} />,
    );
    expect(rolePillText(mpi)).toBe("MPI");
  });

  it("renders 'MPI' for a Co-PI even without isMultiPi (role alone suffices)", () => {
    // The contact PI is at another institution, so there is only one WCM row and
    // no second cwid to count — the flag is false and the pill must still read MPI.
    const g: Grant = { ...baseGrant, role: "Co-PI", isMultiPi: false };
    const { container } = render(<GrantsSection grants={[g]} />);
    expect(rolePillText(container)).toBe("MPI");
  });

  it("passes the flag to the TOOLTIP too, not just the pill label", () => {
    // Two helpers read the flag at the render site; wiring only the label would
    // leave a pill reading MPI whose tooltip still said "Principal Investigator".
    const { container } = render(
      <GrantsSection grants={[{ ...baseGrant, role: "PI", isMultiPi: true }]} />,
    );
    const trigger = container.querySelector(".tracking-wider")!.parentElement!;
    fireEvent.focus(trigger); // Radix opens the tooltip on focus.
    expect(
      screen.getAllByText("Multiple Principal Investigator (contact PD/PI)").length,
    ).toBeGreaterThan(0);
  });

  it("leaves a Co-I on a multi-PI project reading 'Co-I'", () => {
    // `isMultiPi` is a PROJECT fact carried by every row of the project — it must
    // never promote a non-PI role.
    const g: Grant = { ...baseGrant, role: "Co-I", isMultiPi: true };
    const { container } = render(<GrantsSection grants={[g]} />);
    expect(rolePillText(container)).toBe("Co-I");
  });
});

describe("GrantsSection — MPI role tab", () => {
  /** The tab button carrying `label`, or undefined when the tab is hidden
   *  (~:220 hides a zero-count tab). */
  function tab(label: string): HTMLElement | undefined {
    return screen
      .queryAllByRole("button")
      .find((b) => b.textContent?.startsWith(label));
  }

  const contactPiOnMpi: Grant = {
    ...baseGrant,
    role: "PI",
    isMultiPi: true,
    title: "Contact PI on a multiple-PI award",
    awardNumber: "R01 CA245678",
    coreProjectNum: "R01CA245678",
  };
  const nonContactPi: Grant = {
    ...baseGrant,
    role: "Co-PI",
    isMultiPi: true,
    title: "Non-contact PD/PI on another award",
    awardNumber: "R01 HL111111",
    coreProjectNum: "R01HL111111",
  };

  it("counts both a Co-PI row and a contact PI on a multi-PI award", () => {
    render(<GrantsSection grants={[contactPiOnMpi, nonContactPi]} />);
    expect(tab("MPI")?.textContent).toBe("MPI2");
    // The contact PI keeps its PI standing, so the PI tab still counts it.
    expect(tab("PI")?.textContent).toBe("PI1");
  });

  it("returns exactly those rows when the MPI tab is selected", () => {
    const soloPi: Grant = {
      ...baseGrant,
      role: "PI",
      isMultiPi: false,
      title: "Sole PI award",
      awardNumber: "R01 AI222222",
      coreProjectNum: "R01AI222222",
    };
    render(<GrantsSection grants={[contactPiOnMpi, nonContactPi, soloPi]} />);
    fireEvent.click(tab("MPI")!);
    expect(screen.getByText("Contact PI on a multiple-PI award")).toBeTruthy();
    expect(screen.getByText("Non-contact PD/PI on another award")).toBeTruthy();
    expect(screen.queryByText("Sole PI award")).toBeNull();
  });

  it("hides the MPI tab entirely when nothing is multi-PI", () => {
    render(<GrantsSection grants={[baseGrant]} />);
    expect(tab("MPI")).toBeUndefined();
  });

  it("does not sweep a Co-I on a multi-PI project into the MPI tab", () => {
    const coI: Grant = {
      ...baseGrant,
      role: "Co-I",
      isMultiPi: true,
      title: "Co-I on a multiple-PI award",
      awardNumber: "R01 DK333333",
      coreProjectNum: "R01DK333333",
    };
    render(<GrantsSection grants={[contactPiOnMpi, coI]} />);
    expect(tab("MPI")?.textContent).toBe("MPI1");
    fireEvent.click(tab("MPI")!);
    expect(screen.queryByText("Co-I on a multiple-PI award")).toBeNull();
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
