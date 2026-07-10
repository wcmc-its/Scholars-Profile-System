/**
 * Render-path tests for the CTL technologies profile section:
 *   - the "Overview" disclosure (absent when null, two-toggle reveal when set)
 *   - the "POC DATA" chip (only when hasPocData)
 *   - the >5-row <details> expander (hidden at exactly 5)
 *
 * The section is a server component; TechnologyOverview is its one client
 * island. Both render fine under jsdom — "use client" is inert in tests.
 */
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { TechnologiesSection } from "@/components/profile/technologies-section";
import type { ProfilePayload } from "@/lib/api/profile";

type Technology = ProfilePayload["technologies"][number];

const tech = (over: Partial<Technology> = {}): Technology => ({
  reference: null,
  title: "A Test Technology",
  url: "https://innovation.weill.cornell.edu/industry-investors-partners/technology-portfolio/test",
  patentStatus: null,
  pmids: [],
  overview: null,
  hasPocData: false,
  ...over,
});

/** n rows with distinct urls (the row key) and titles. */
const techs = (n: number): Technology[] =>
  Array.from({ length: n }, (_, i) =>
    tech({
      title: `Technology ${i + 1}`,
      url: `https://innovation.weill.cornell.edu/industry-investors-partners/technology-portfolio/t${i + 1}`,
    }),
  );

describe("TechnologiesSection — Overview disclosure", () => {
  const overview = "A concise licensable overview used for testing the disclosure.";

  it("renders no Overview trigger when overview is null", () => {
    render(<TechnologiesSection technologies={[tech({ overview: null })]} />);
    expect(screen.queryByRole("button", { name: "Overview" })).toBeNull();
  });

  it("reveals a clamped panel with Show more when Overview is clicked", () => {
    render(<TechnologiesSection technologies={[tech({ overview })]} />);
    const trigger = screen.getByRole("button", { name: "Overview" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(overview)).toBeNull();

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const para = screen.getByText(overview);
    expect(para.className).toContain("line-clamp-3");
    expect(para.className).toContain("whitespace-pre-line");
    expect(screen.getByRole("button", { name: "Show more" }).getAttribute("aria-expanded")).toBe(
      "false",
    );
  });

  it("Show more removes the clamp and flips to Show less", () => {
    render(<TechnologiesSection technologies={[tech({ overview })]} />);
    fireEvent.click(screen.getByRole("button", { name: "Overview" }));
    const showMore = screen.getByRole("button", { name: "Show more" });
    fireEvent.click(showMore);
    expect(showMore.textContent).toBe("Show less");
    expect(showMore.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(overview).className).not.toContain("line-clamp-");
  });
});

describe("TechnologiesSection — Overview bullet form", () => {
  // Bullet-form overview: one bullet per newline (the ETL join), as CTL's
  // bullet pages store it. Rendered as a real <ul>, not a run-on paragraph.
  const bullets = ["The Technology: alpha", "PoC Data: beta", "gamma", "delta"];
  const overview = bullets.join("\n");

  it("renders a bulleted <ul>, previewing the first three then revealing the rest", () => {
    const { container } = render(<TechnologiesSection technologies={[tech({ overview })]} />);
    fireEvent.click(screen.getByRole("button", { name: "Overview" }));

    const list = container.querySelector("ul.list-disc");
    expect(list).not.toBeNull();
    // Collapsed: first three bullets only, no run-on <p>.
    expect(within(list as HTMLElement).getAllByRole("listitem")).toHaveLength(3);
    expect(within(list as HTMLElement).getByText("The Technology: alpha")).toBeTruthy();
    expect(within(list as HTMLElement).queryByText("delta")).toBeNull();

    const showMore = screen.getByRole("button", { name: "Show more" });
    fireEvent.click(showMore);
    expect(within(list as HTMLElement).getAllByRole("listitem")).toHaveLength(4);
    expect(within(list as HTMLElement).getByText("delta")).toBeTruthy();
    expect(showMore.textContent).toBe("Show less");
  });

  it("shows no toggle when the list fits the preview (<= 3 bullets)", () => {
    const { container } = render(
      <TechnologiesSection technologies={[tech({ overview: "one\ntwo\nthree" })]} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Overview" }));
    expect(container.querySelectorAll("ul.list-disc li")).toHaveLength(3);
    expect(screen.queryByRole("button", { name: /Show more|Show less/ })).toBeNull();
  });
});

describe("TechnologiesSection — POC DATA chip", () => {
  it("renders the PoC Data chip only when hasPocData is true", () => {
    const { rerender } = render(
      <TechnologiesSection technologies={[tech({ hasPocData: false })]} />,
    );
    expect(screen.queryByText("PoC Data")).toBeNull();

    rerender(<TechnologiesSection technologies={[tech({ hasPocData: true })]} />);
    expect(screen.getByText("PoC Data")).toBeTruthy();
  });
});

describe("TechnologiesSection — row cap", () => {
  it("shows no expander at exactly 5 technologies", () => {
    const { container } = render(<TechnologiesSection technologies={techs(5)} />);
    expect(container.querySelector("details")).toBeNull();
    expect(screen.queryByText(/Show \d+ more/)).toBeNull();
    expect(screen.getByText("Technology 5")).toBeTruthy();
  });

  it("collapses the remainder into a <details> when there are more than 5", () => {
    const { container } = render(<TechnologiesSection technologies={techs(7)} />);
    const details = container.querySelector("details");
    expect(details).not.toBeNull();
    const summary = within(details as HTMLElement).getByText("Show 2 more technologies");
    expect(summary.tagName).toBe("SUMMARY");
    // The 6th and 7th rows live inside the <details>, not the head list.
    expect(within(details as HTMLElement).getByText("Technology 6")).toBeTruthy();
    expect(within(details as HTMLElement).getByText("Technology 7")).toBeTruthy();
  });

  it("uses the singular when exactly one row overflows", () => {
    render(<TechnologiesSection technologies={techs(6)} />);
    expect(screen.getByText("Show 1 more technology")).toBeTruthy();
  });
});
