/**
 * #2215 — the "similar spellings" notice the People / Publications tabs render
 * when `result.typoFallback` is true.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { TypoFallbackNotice } from "@/components/search/typo-fallback-notice";

describe("TypoFallbackNotice", () => {
  it("names the query and says the list is similar spellings, as a status region", () => {
    render(<TypoFallbackNotice query="  oncolgy " noun="publications" />);
    const notice = screen.getByRole("status");
    expect(notice.textContent).toBe(
      "No exact matches for “oncolgy” — showing publications with similar spellings.",
    );
  });

  it("uses the tab's noun", () => {
    render(<TypoFallbackNotice query="Harrigton" noun="people" />);
    expect(screen.getByTestId("typo-fallback-notice").textContent).toContain(
      "showing people with similar spellings",
    );
  });
});
