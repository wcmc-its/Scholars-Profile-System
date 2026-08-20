/**
 * `/edit/grant-matcha` selected view — the mockup-4 opportunity frame (matcha-admin Phase 3b).
 *
 * Unlike grant-matcha-panel-url.test.tsx (which mocks opportunity-browse to pin URL wiring),
 * this suite renders the REAL shared module, because the behavior under test IS what the rail
 * and clamped synopsis render from the detail payload. Three things are load-bearing:
 *
 * - every rail row is always present, a missing value showing the muted dash — an officer must
 *   be able to tell "not recorded" from "not shown", and nothing may be invented;
 * - the header carries the appeal pill + source pill but NO StageBadge — appealByStage covers
 *   career stage; StageBadge was an ungoverned one-off and deliberately did not come along;
 * - the caution slot stays exactly #2494's: the askNote paragraph here, the thin-match amber
 *   banner inside MatchaPanel itself. This surface adds no second banner (no role="status"),
 *   and never consumes the structured matcher's abstain signal.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";

const searchParams = { value: new URLSearchParams("opp=abc") };

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/edit/grant-matcha",
  useSearchParams: () => searchParams.value,
}));

/** `autoRun` per mount — pins the askNote caution suppressing the auto-run. */
const panelMounts: Array<{ autoRun?: boolean }> = [];

vi.mock("@/components/edit/matcha-panel", () => ({
  MatchaPanel: ({ autoRun }: { autoRun?: boolean }) => {
    panelMounts.push({ autoRun });
    return <div data-testid="matcha-panel" />;
  },
}));

import { GrantMatchaPanel } from "@/components/edit/grant-matcha-panel";

const DAY_MS = 86_400_000;

/** A full detail payload — every rail field populated (the mockup-4 happy path). */
const FULL_PAYLOAD = {
  title: "K99/R00 Pathway to Independence Award",
  sponsor: "NCI",
  source: "wcm_curated",
  synopsis: "Supports outstanding postdoctoral researchers transitioning to independence.",
  sourceUrl: "https://grants.example.gov/k99",
  openDate: "2099-08-01",
  dueDate: "2099-10-12",
  awardFloor: 100000,
  awardCeiling: 250000,
  estimatedFunding: 2000000,
  numberOfAwards: 8,
  cfdaList: ["93.398"],
  eligibilityFlags: ["faculty_eligible", "postdoc_eligible"],
  eligibility: {},
  appealByStage: { postdoc: 0.9, early: 0.85, senior: 0.1 },
};

function stubDetailFetch(payload: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => payload })),
  );
}

async function renderSelected(payload: Record<string, unknown>) {
  stubDetailFetch(payload);
  const result = render(<GrantMatchaPanel />);
  await waitFor(() => expect(screen.getByTestId("opportunity-fact-rail")).toBeTruthy());
  return result;
}

describe("GrantMatchaPanel — mockup-4 opportunity frame (?opp= selected view)", () => {
  beforeEach(() => {
    searchParams.value = new URLSearchParams("opp=abc");
    panelMounts.length = 0;
    vi.unstubAllGlobals();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("renders every rail fact from the detail payload", async () => {
    await renderSelected(FULL_PAYLOAD);

    const rail = within(screen.getByTestId("opportunity-fact-rail"));
    expect(rail.getByText("Award").nextElementSibling?.textContent).toBe("$100,000–$250,000");
    expect(rail.getByText("Est. total funding").nextElementSibling?.textContent).toBe(
      "$2,000,000",
    );
    expect(rail.getByText("Awards").nextElementSibling?.textContent).toBe("~8");
    expect(rail.getByText("Opens").nextElementSibling?.textContent).toBe("Aug 1, 2099");
    expect(rail.getByText("Due").nextElementSibling?.textContent).toBe("Oct 12, 2099");
    expect(rail.getByText("CFDA").nextElementSibling?.textContent).toBe("93.398");
    // Nothing missing, so no dashes anywhere in the rail.
    expect(rail.queryByText("—")).toBeNull();

    const link = rail.getByRole("link", { name: /More information/ });
    expect(link.getAttribute("href")).toBe("https://grants.example.gov/k99");

    // Header: appeal pill + source pill (mockup line 2), Matcha seeded and auto-run.
    expect(screen.getByTestId("matcha-appeal-badge").textContent).toBe(
      "Best fit: Postdoc, Early career",
    );
    expect(screen.getByText("WCM curated")).toBeTruthy();
    expect(panelMounts).toEqual([{ autoRun: true }]);
  });

  it("renders the muted dash for every missing value, and no invented link", async () => {
    await renderSelected({
      ...FULL_PAYLOAD,
      source: null,
      sourceUrl: null,
      openDate: null,
      dueDate: null,
      awardFloor: null,
      awardCeiling: null,
      estimatedFunding: null,
      numberOfAwards: null,
      cfdaList: [],
      appealByStage: undefined,
    });

    const rail = within(screen.getByTestId("opportunity-fact-rail"));
    // All six rows still render — a dash apiece, never a dropped row or a made-up value.
    for (const label of ["Award", "Est. total funding", "Awards", "Opens", "Due", "CFDA"]) {
      expect(rail.getByText(label)).toBeTruthy();
    }
    expect(rail.getAllByText("—")).toHaveLength(6);
    expect(rail.queryByRole("link")).toBeNull();
    expect(screen.queryByTestId("matcha-appeal-badge")).toBeNull();
  });

  it("tones an imminent deadline amber", async () => {
    const soon = new Date(Date.now() + 10 * DAY_MS).toISOString().slice(0, 10);
    await renderSelected({ ...FULL_PAYLOAD, dueDate: soon });

    const due = within(screen.getByTestId("opportunity-fact-rail")).getByText("Due");
    expect(due.nextElementSibling?.className).toContain("text-apollo-amber");
  });

  it("clamps a long synopsis at three lines behind Show more", async () => {
    const { container } = await renderSelected({
      ...FULL_PAYLOAD,
      synopsis: "Supports outstanding postdoctoral researchers. ".repeat(12).trim(),
    });

    expect(container.querySelector("p.line-clamp-3")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show more" })).toBeTruthy();
  });

  it("ports no StageBadge — appealByStage is the only career-stage read", async () => {
    await renderSelected(FULL_PAYLOAD);
    expect(screen.queryByText(/stage fit/i)).toBeNull();
  });

  it("keeps the caution slot #2494's: askNote suppresses the auto-run, no second banner", async () => {
    await renderSelected({
      ...FULL_PAYLOAD,
      eligibilityFlags: ["student_only"],
      eligibility: { career_stages: ["graduate_student"] },
    });

    expect(
      screen.getByText(/No Weill Cornell faculty PI can hold this award/).textContent,
    ).toContain("graduate student");
    expect(panelMounts).toEqual([{ autoRun: false }]);
    // The amber thin-match caution lives INSIDE MatchaPanel (assessMatchSignal); this
    // surface adds no banner of its own and never reads the abstain floor.
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByTestId("matcha-thin-signal")).toBeNull();
  });
});
