import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

describe("Alert primitive", () => {
  it("defaults to the info variant (polite live region)", () => {
    render(
      <Alert>
        <AlertTitle>Heads up</AlertTitle>
        <AlertDescription>Body text.</AlertDescription>
      </Alert>,
    );
    const alert = screen.getByRole("alert");
    expect(alert.getAttribute("data-variant")).toBe("info");
    expect(alert.getAttribute("aria-live")).toBe("polite");
    expect(screen.getByText("Heads up")).toBeTruthy();
    expect(screen.getByText("Body text.")).toBeTruthy();
  });

  it("destructive variant flips aria-live to assertive", () => {
    render(
      <Alert variant="destructive">
        <AlertTitle>Save failed</AlertTitle>
        <AlertDescription>Please try again.</AlertDescription>
      </Alert>,
    );
    const alert = screen.getByRole("alert");
    expect(alert.getAttribute("data-variant")).toBe("destructive");
    expect(alert.getAttribute("aria-live")).toBe("assertive");
  });

  it("data-slot attributes are stable on the three children", () => {
    render(
      <Alert variant="info">
        <AlertTitle>T</AlertTitle>
        <AlertDescription>D</AlertDescription>
      </Alert>,
    );
    expect(document.querySelector('[data-slot="alert"]')).toBeTruthy();
    expect(document.querySelector('[data-slot="alert-title"]')).toBeTruthy();
    expect(document.querySelector('[data-slot="alert-description"]')).toBeTruthy();
  });

  it("merges a caller className with the base classes", () => {
    render(
      <Alert className="bespoke-class" variant="info">
        <AlertTitle>T</AlertTitle>
      </Alert>,
    );
    const alert = screen.getByRole("alert");
    expect(alert.className).toContain("bespoke-class");
    expect(alert.className).toContain("rounded-md");
  });
});
