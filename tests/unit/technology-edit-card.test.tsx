/**
 * `components/edit/technology-edit-card.tsx` — the read-only "Available
 * technologies" panel. CTL owns these inventions (the Center for Technology
 * Licensing); the panel mirrors the public profile section and carries the "not
 * editable" treatment + a CTL contact note. There is no hide/show or write path.
 */
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { TechnologyEditCard } from "@/components/edit/technology-edit-card";
import type { EditContextTechnology } from "@/lib/api/edit-context";

const tech = (over: Partial<EditContextTechnology> = {}): EditContextTechnology => ({
  url: "https://innovation.weill.cornell.edu/technology-portfolio/widget",
  title: "A Licensable Widget",
  reference: null,
  patentStatus: null,
  pmids: [],
  overview: null,
  hasPocData: false,
  ...over,
});

const TECHS: EditContextTechnology[] = [
  tech({
    title: "A Licensable Widget",
    url: "https://innovation.weill.cornell.edu/technology-portfolio/widget",
    reference: "11166",
    patentStatus: "US Application Filed",
    pmids: ["31508198"],
    hasPocData: true,
  }),
  tech({
    title: "A Second Invention",
    url: "https://innovation.weill.cornell.edu/technology-portfolio/second",
  }),
];

describe("TechnologyEditCard — read-only CTL technologies", () => {
  it("renders each technology with its title link + chips + PMID + reference", () => {
    render(
      <TechnologyEditCard cwid="self01" mode="self" scholarName="Alex Self" technologies={TECHS} />,
    );
    // Both rows render.
    const first = screen.getByRole("link", { name: "A Licensable Widget" });
    expect(first.getAttribute("href")).toBe(
      "https://innovation.weill.cornell.edu/technology-portfolio/widget",
    );
    expect(first.getAttribute("target")).toBe("_blank");
    expect(first.getAttribute("rel")).toContain("noopener");
    expect(screen.getByText("A Second Invention")).toBeTruthy();
    // Patent-status + PoC chips, the PMID link, and the reference number.
    expect(screen.getByText("US Application Filed")).toBeTruthy();
    expect(screen.getByText("PoC Data")).toBeTruthy();
    const pmid = screen.getByRole("link", { name: "PMID 31508198" });
    expect(pmid.getAttribute("href")).toBe("https://pubmed.ncbi.nlm.nih.gov/31508198/");
    expect(screen.getByText("11166")).toBeTruthy();
  });

  it("shows the not-editable treatment + a CTL contact note, and NO hide/show/write control", () => {
    render(
      <TechnologyEditCard cwid="self01" mode="self" scholarName="Alex Self" technologies={TECHS} />,
    );
    expect(screen.getByText("This section is not editable.")).toBeTruthy();
    // Scoped to the footer note (the phrase also appears in the intro copy).
    expect(screen.getByText(/Managed by the Center for Technology Licensing/)).toBeTruthy();
    const contact = screen.getByRole("link", { name: "enterpriseinnovation@med.cornell.edu" });
    expect(contact.getAttribute("href")).toBe("mailto:enterpriseinnovation@med.cornell.edu");
    // Read-only: no hide/show/save button, no Request a Change dialog.
    expect(screen.queryByRole("button", { name: /hide/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /show|save/i })).toBeNull();
    expect(screen.queryByTestId("request-a-change-toggle")).toBeNull();
  });

  it("reveals the Overview via the existing TechnologyOverview expander when overview is set", () => {
    render(
      <TechnologyEditCard
        cwid="self01"
        mode="self"
        scholarName="Alex Self"
        technologies={[tech({ overview: "A concise licensable overview for testing." })]}
      />,
    );
    // Collapsed by default; the "Overview" trigger reveals the text.
    const trigger = screen.getByRole("button", { name: "Overview" });
    expect(screen.queryByText("A concise licensable overview for testing.")).toBeNull();
    fireEvent.click(trigger);
    expect(screen.getByText("A concise licensable overview for testing.")).toBeTruthy();
  });

  it("renders no Overview trigger when a technology has no overview", () => {
    render(
      <TechnologyEditCard
        cwid="self01"
        mode="self"
        scholarName="Alex Self"
        technologies={[tech({ overview: null })]}
      />,
    );
    expect(screen.queryByRole("button", { name: "Overview" })).toBeNull();
  });

  it("reframes the intro copy to the scholar's name for a superuser", () => {
    render(
      <TechnologyEditCard
        cwid="other7"
        mode="superuser"
        scholarName="Alex Other"
        technologies={TECHS}
      />,
    );
    const panel = document.querySelector('[data-slot="technologies-panel"]');
    expect(panel?.textContent).toContain("Alex Other's");
    expect(panel?.textContent).not.toContain("of your that");
  });
});
