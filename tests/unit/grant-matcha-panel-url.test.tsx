/**
 * `/edit/grant-matcha` — the opportunity selection lives in the URL, not component state.
 *
 * Two things are load-bearing: with no `?opp=` the page is the SAME browse table
 * `/edit/find-researchers` renders (not a second bespoke picker), and with `?opp=<id>` the panel
 * seeds Matcha from the DETAIL route — the only route that carries `synopsis`. Both are pinned
 * here because a regression to component state would still "work" by clicking while silently
 * breaking the deep link the officer is meant to paste into Teams.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";

const searchParams = { value: new URLSearchParams("") };

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/edit/grant-matcha",
  useSearchParams: () => searchParams.value,
}));

vi.mock("@/components/edit/find-researchers", () => ({
  BrowseList: ({ hrefFor }: { hrefFor: (id: string) => string }) => (
    <a href={hrefFor("wcm_curated:abc")}>browse table</a>
  ),
}));

/**
 * Records every MOUNT, because the real panel's `autoRun` is a mount-only effect: one mount is
 * one Bedrock extraction plus a retained submission row. Mounting with the wrong seed is not a
 * cosmetic flicker, it is a billed ask against the wrong grant.
 */
const mounted: string[] = [];

vi.mock("@/components/edit/matcha-panel", () => ({
  MatchaPanel: ({ initialDescription }: { initialDescription?: string }) => {
    useEffect(() => {
      mounted.push(initialDescription ?? "");
      // Empty deps mirrors the real panel's mount-only `autoRun` — that is the behaviour under test.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return <div data-testid="matcha-panel">{initialDescription}</div>;
  },
}));

import { GrantMatchaPanel } from "@/components/edit/grant-matcha-panel";

describe("GrantMatchaPanel — ?opp= URL state", () => {
  beforeEach(() => {
    searchParams.value = new URLSearchParams("");
    mounted.length = 0;
    vi.unstubAllGlobals();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("renders the shared browse table, and no Matcha, with no ?opp=", () => {
    render(<GrantMatchaPanel />);
    const link = screen.getByRole("link", { name: "browse table" });
    // The row href is what makes the selection deep-linkable.
    expect(link.getAttribute("href")).toBe("/edit/grant-matcha?opp=wcm_curated%3Aabc");
    expect(screen.queryByTestId("matcha-panel")).toBeNull();
  });

  it("fetches the detail route for ?opp= and seeds Matcha from title + synopsis", async () => {
    searchParams.value = new URLSearchParams("opp=abc");
    const requested: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        requested.push(url);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            title: "Outstanding New Environmental Scientist",
            sponsor: "NIH",
            synopsis: "Supports early-stage investigators studying environmental exposures.",
            eligibilityFlags: ["faculty_eligible"],
            eligibility: { career_stages: ["early_career_faculty"] },
          }),
        };
      }),
    );

    render(<GrantMatchaPanel />);
    await waitFor(() => expect(screen.getByTestId("matcha-panel")).toBeTruthy());

    // The DETAIL route — the list route omits synopsis.
    expect(requested).toEqual(["/api/opportunities/abc"]);
    expect(screen.getByTestId("matcha-panel").textContent).toBe(
      "Outstanding New Environmental Scientist\n\nSupports early-stage investigators studying environmental exposures.",
    );
    expect(screen.queryByRole("link", { name: "browse table" })).toBeNull();
    // No appealByStage on this payload — no badge.
    expect(screen.queryByTestId("matcha-appeal-badge")).toBeNull();
  });

  it("surfaces appealByStage as a badge when the opportunity carries it", async () => {
    searchParams.value = new URLSearchParams("opp=abc");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          title: "Harry Weaver Neuroscience Scholar Award",
          sponsor: "National MS Society",
          synopsis: "Supports early-career neuroscience investigators.",
          eligibilityFlags: ["faculty_eligible"],
          eligibility: {},
          appealByStage: { early: 0.9, senior: 0.1 },
        }),
      })),
    );

    render(<GrantMatchaPanel />);
    await waitFor(() => expect(screen.getByTestId("matcha-appeal-badge")).toBeTruthy());
    expect(screen.getByTestId("matcha-appeal-badge").textContent).toBe("Best fit: Early career");
  });

  it("never mounts Matcha with the previous opportunity's seed when ?opp= changes", async () => {
    const synopsisOf = (id: string) => `Synopsis ${id} about vascular biology and imaging.`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const id = url.split("/").pop() ?? "";
        return {
          ok: true,
          status: 200,
          json: async () => ({
            title: `Opportunity ${id}`,
            sponsor: "NIH",
            synopsis: synopsisOf(id),
            eligibilityFlags: [],
            eligibility: {},
          }),
        };
      }),
    );

    searchParams.value = new URLSearchParams("opp=A");
    const { rerender } = render(<GrantMatchaPanel />);
    await waitFor(() => expect(screen.getByTestId("matcha-panel")).toBeTruthy());

    searchParams.value = new URLSearchParams("opp=B");
    rerender(<GrantMatchaPanel />);
    await waitFor(() =>
      expect(screen.getByTestId("matcha-panel").textContent).toContain("Opportunity B"),
    );

    // Two selections, two asks. A third entry — or an "Opportunity A" seed landing under B —
    // means the panel mounted against stale state and billed an ask for the wrong grant.
    expect(mounted).toEqual([
      `Opportunity A\n\n${synopsisOf("A")}`,
      `Opportunity B\n\n${synopsisOf("B")}`,
    ]);
  });
});
