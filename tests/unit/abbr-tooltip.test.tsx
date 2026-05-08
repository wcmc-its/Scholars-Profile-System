import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AbbrTooltip } from "@/components/ui/abbr-tooltip";
import { SponsorAbbr } from "@/components/ui/sponsor-abbr";
import { MechanismAbbr } from "@/components/ui/mechanism-abbr";

describe("AbbrTooltip", () => {
  it("renders the bare short text when expand is null (no tooltip wrapping)", () => {
    const { container } = render(<AbbrTooltip short="ZZZ" expand={null} />);
    expect(screen.getByText("ZZZ")).toBeTruthy();
    // No <abbr> wrapper, no tooltip role
    expect(container.querySelector("abbr")).toBeNull();
    expect(container.querySelector("[role='tooltip']")).toBeNull();
  });

  it("renders an <abbr> with title when an expansion is supplied", () => {
    render(<AbbrTooltip short="NCI" expand="National Cancer Institute" />);
    const abbr = screen.getByText("NCI");
    expect(abbr.tagName.toLowerCase()).toBe("abbr");
    expect(abbr.getAttribute("title")).toBe("National Cancer Institute");
  });

  it("wires aria-describedby to the tooltip element on focus", () => {
    render(<AbbrTooltip short="NCI" expand="National Cancer Institute" />);
    const abbr = screen.getByText("NCI");
    expect(abbr.getAttribute("aria-describedby")).toBeNull();

    fireEvent.focus(abbr);
    const describedby = abbr.getAttribute("aria-describedby");
    expect(describedby).toBeTruthy();

    const tooltip = document.getElementById(describedby!);
    expect(tooltip).toBeTruthy();
    expect(tooltip!.getAttribute("role")).toBe("tooltip");
    expect(tooltip!.textContent).toContain("National Cancer Institute");
  });
});

describe("SponsorAbbr", () => {
  it("looks up the canonical sponsor and renders an <abbr> with the full name", () => {
    render(<SponsorAbbr short="NCI" />);
    const abbr = screen.getByText("NCI");
    expect(abbr.tagName.toLowerCase()).toBe("abbr");
    expect(abbr.getAttribute("title")).toBe("National Cancer Institute");
  });

  it("renders bare text when the sponsor isn't in the lookup", () => {
    const { container } = render(<SponsorAbbr short="Bespoke Family Foundation" />);
    expect(container.querySelector("abbr")).toBeNull();
    expect(screen.getByText("Bespoke Family Foundation")).toBeTruthy();
  });
});

describe("MechanismAbbr", () => {
  it("looks up the canonical mechanism and renders an <abbr> with the expansion", () => {
    render(<MechanismAbbr code="R01" />);
    const abbr = screen.getByText("R01");
    expect(abbr.tagName.toLowerCase()).toBe("abbr");
    expect(abbr.getAttribute("title")).toBe("Research Project Grant (R01)");
  });

  it("renders bare text when the mechanism code isn't in the lookup", () => {
    const { container } = render(<MechanismAbbr code="Z99" />);
    expect(container.querySelector("abbr")).toBeNull();
    expect(screen.getByText("Z99")).toBeTruthy();
  });
});
