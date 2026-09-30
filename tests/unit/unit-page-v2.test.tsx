/**
 * Unit Page v2 (department + center redesign) — the shared hero pieces
 * (`components/shared/unit-hero.tsx`), the text variant of `UnitWebsiteLink`,
 * and the restyled shared `Spotlight` (trailing-period tidy, full-title
 * tooltip, spotlight author-chip variant, per-card rules).
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { UnitResearchAreas, UnitStatsLine, UnitSubunitChips } from "@/components/shared/unit-hero";
import { UnitWebsiteLink } from "@/components/shared/unit-website-link";
import { Spotlight } from "@/components/shared/spotlight";
import { PublicationModalProvider } from "@/components/publication/publication-modal";
import type { SpotlightData } from "@/lib/api/spotlight";

describe("UnitWebsiteLink — text variant", () => {
  it("renders the visible label as the link name, opening in a new tab", () => {
    render(
      <UnitWebsiteLink
        url="https://example.test/dept"
        unitName="Medicine"
        variant="text"
        label="Department website"
      />,
    );
    const link = screen.getByRole("link", { name: "Department website" });
    expect(link.getAttribute("href")).toBe("https://example.test/dept");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("renders nothing without a url (dark by default)", () => {
    const { container } = render(
      <UnitWebsiteLink url={null} unitName="Medicine" variant="text" label="Department website" />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("keeps the icon variant's '{unit} website' accessible label by default", () => {
    render(<UnitWebsiteLink url="https://example.test/div" unitName="Cardiology" />);
    expect(screen.getByRole("link", { name: "Cardiology website" })).toBeTruthy();
  });
});

describe("UnitSubunitChips", () => {
  it("renders an '{N} divisions' heading with id=subunits and counted chip links", () => {
    const { container } = render(
      <UnitSubunitChips
        noun={["division", "divisions"]}
        ariaLabel="Divisions"
        chips={[
          {
            key: "a",
            label: "Cardiology",
            href: "/departments/medicine/divisions/cardiology",
            count: 241,
          },
          {
            key: "b",
            label: "Immunology",
            href: "/departments/medicine/divisions/immunology",
            count: null,
          },
        ]}
      />,
    );
    const heading = container.querySelector("#subunits");
    expect(heading?.textContent).toBe("2 divisions");
    const chip = screen.getByRole("link", { name: /Cardiology/ });
    expect(chip.getAttribute("href")).toBe("/departments/medicine/divisions/cardiology");
    expect(chip.textContent).toBe("Cardiology241");
    // Unknown count → no number rendered.
    expect(screen.getByRole("link", { name: "Immunology" }).textContent).toBe("Immunology");
  });

  it("renders nothing with no chips", () => {
    const { container } = render(
      <UnitSubunitChips noun={["program", "programs"]} ariaLabel="Programs" chips={[]} />,
    );
    expect(container.innerHTML).toBe("");
  });
});

describe("UnitResearchAreas", () => {
  it("links each pill to its topic page, with the count", () => {
    render(
      <UnitResearchAreas
        areas={[
          {
            topicId: "t1",
            topicLabel: "Cardiovascular Disease",
            topicSlug: "cardio",
            pubCount: 1566,
          },
        ]}
        basePath="/departments/example"
        unitShort="Example"
        membersNoun="faculty"
      />,
    );
    expect(screen.getByText("Top research areas")).toBeTruthy();
    const pill = screen.getByRole("link", { name: /Cardiovascular Disease/ });
    expect(pill.getAttribute("href")).toBe("/topics/cardio");
    expect(pill.textContent).toContain("1,566");
  });
});

describe("UnitStatsLine", () => {
  it("renders each stat as a link with muted dot separators", () => {
    const { container } = render(
      <UnitStatsLine
        stats={[
          { value: 2652, label: "scholars", href: "/departments/medicine#people" },
          { value: 14, label: "divisions", href: "#subunits" },
        ]}
      />,
    );
    expect(screen.getByRole("link", { name: "2,652 scholars" }).getAttribute("href")).toBe(
      "/departments/medicine#people",
    );
    expect(screen.getByRole("link", { name: "14 divisions" }).getAttribute("href")).toBe(
      "#subunits",
    );
    expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(1);
  });

  it("renders the fallback when no stat survives", () => {
    render(<UnitStatsLine stats={[]} fallback={<span>Membership data pending</span>} />);
    expect(screen.getByText("Membership data pending")).toBeTruthy();
  });
});

describe("Spotlight (shared) — variant=\"unit\" vs default", () => {
  const data: SpotlightData = {
    totalCount: 33591,
    viewAllHref: "/departments/medicine?tab=publications#tab-content",
    cards: [
      {
        pmid: "111",
        kicker: "Immunology & Inflammation",
        kickerHref: "/topics/immunology",
        title:
          "Synthetic cells select example signals to establish a test fixture.",
        journal: "Nature",
        year: 2022,
        pubmedUrl: null,
        doi: null,
        authors: [
          {
            name: "Pat Q Tester",
            cwid: "tst9001",
            slug: "pat-tester",
            identityImageEndpoint: "",
            isFirst: false,
            isLast: true,
            roleCategory: null,
          },
          {
            name: "Sam R Example",
            cwid: "tst9002",
            slug: "sam-example",
            identityImageEndpoint: "",
            isFirst: false,
            isLast: false,
            roleCategory: null,
          },
        ],
      },
    ],
  };

  function renderSpotlight() {
    return render(
      <PublicationModalProvider>
        <Spotlight data={data} variant="unit" />
      </PublicationModalProvider>,
    );
  }

  function renderDefaultSpotlight() {
    return render(
      <PublicationModalProvider>
        <Spotlight data={data} />
      </PublicationModalProvider>,
    );
  }

  it("strips the title's trailing period and puts the full title in title=", () => {
    renderSpotlight();
    const title = screen.getByRole("button", {
      name: "Synthetic cells select example signals to establish a test fixture",
    });
    expect(title.textContent?.endsWith("fixture")).toBe(true);
    expect(title.getAttribute("title")).toBe(
      "Synthetic cells select example signals to establish a test fixture.",
    );
  });

  it("keeps the kicker link and the view-all link copy", () => {
    renderSpotlight();
    expect(
      screen.getByRole("link", { name: "Immunology & Inflammation" }).getAttribute("href"),
    ).toBe("/topics/immunology");
    expect(screen.getByRole("link", { name: "View all 33,591 publications →" })).toBeTruthy();
  });

  it("uses the spotlight chip variant: senior author featured (coral), co-author plain", () => {
    renderSpotlight();
    const senior = screen.getByRole("link", { name: /Pat Q Tester/ });
    const co = screen.getByRole("link", { name: /Sam R Example/ });
    expect(senior.className).toContain("border-apollo-coral-tint-border");
    expect(co.className).toContain("border-apollo-border-strong");
    expect(co.className).toContain("h-7");
  });

  it("draws a left rule on every card and pins the venue line to the bottom", () => {
    const { container } = renderSpotlight();
    const article = container.querySelector("article")!;
    expect(article.className).toContain("border-l");
    expect(screen.getByText(/Nature/).closest("div")!.className).toContain("mt-auto");
  });

  it("default (topic / methods pages): keeps the original cream surface, title and chips", () => {
    const { container } = renderDefaultSpotlight();
    const section = container.querySelector("section")!;
    expect(section.className).toContain("bg-[#f5f3ee]");
    expect(section.className).not.toContain("bg-apollo-surface-2");
    // No trailing-period tidy, no full-title tooltip.
    const title = screen.getByRole("button", {
      name: "Synthetic cells select example signals to establish a test fixture.",
    });
    expect(title.hasAttribute("title")).toBe(false);
    // Site-wide default author chip, not the 28px spotlight chip.
    const co = screen.getByRole("link", { name: /Sam R Example/ });
    expect(co.className).not.toContain("h-7");
    expect(co.className).toContain("text-xs");
    // First card has no left rule; single card caps its width.
    const article = container.querySelector("article")!;
    expect(article.className).toContain("md:border-l-0");
    expect(article.parentElement!.className).toContain("md:max-w-[600px]");
    // Original view-all link styling (bottom-border, secondary text).
    const viewAll = screen.getByRole("link", { name: "View all 33,591 publications →" });
    expect(viewAll.className).toContain("border-b-[0.5px]");
    expect(screen.getByText(/Nature/).closest("div")!.className).not.toContain("mt-auto");
  });

  it("unit: restyled surface and auto-fit grid", () => {
    const { container } = renderSpotlight();
    const section = container.querySelector("section")!;
    expect(section.className).toContain("bg-apollo-surface-2");
    expect(section.className).not.toContain("bg-[#f5f3ee]");
    expect(container.querySelector("article")!.parentElement!.className).toContain(
      "minmax(260px,1fr)",
    );
  });
});
