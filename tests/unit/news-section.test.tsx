import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { NewsSection } from "@/components/profile/news-section";

type NewsProp = Parameters<typeof NewsSection>[0]["news"];

const item = (excerpt: string | null) =>
  ({
    url: "https://news.weill.cornell.edu/news/2026/07/a",
    title: "Awards and honors",
    excerpt,
    thumbnailUrl: null,
    publishedAt: "2026-07-16",
  }) as unknown as NewsProp[number];

describe("NewsSection excerpt (#2245)", () => {
  it("does not render an excerpt with no letters or digits", () => {
    const { container } = render(<NewsSection news={[item("...")]} />);
    expect(container.querySelector("p")).toBeNull();
  });

  it("renders a real excerpt", () => {
    const { container } = render(<NewsSection news={[item("Awards for July.")]} />);
    expect(container.querySelector("p")?.textContent).toBe("Awards for July.");
  });
});
