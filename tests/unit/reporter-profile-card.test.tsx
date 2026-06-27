/**
 * `components/edit/reporter-profile-card.tsx` — the RePORTER "Is this you?" card
 * (`REPORTER_MATCH_V2`). Renders pending K=2 matches (confirm / reject) + a
 * revocable confirmed-match history (incl. auto-locks).
 *
 * Governance assertion (the adversarial review WILL grep for it): the numeric
 * overlap K is PROJECTION-STARVED — it is not even on the props type, and nothing
 * resembling a score/overlap renders. The human recognizes grants by title.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

import { ReporterProfileCard } from "@/components/edit/reporter-profile-card";
import { REJECT_REASON_LABEL } from "@/lib/edit/reporter-profile";
import type {
  EditContextReporterProfileCandidate,
  EditContextReporterProfileConfirmed,
} from "@/lib/api/edit-context";

const pending = (
  p: Partial<EditContextReporterProfileCandidate> & Pick<EditContextReporterProfileCandidate, "candidateId">,
): EditContextReporterProfileCandidate => ({
  externalProfileId: 12345,
  candidateName: "Karuna Ganesh",
  candidateOrgs: "Memorial Sloan Kettering, Stanford University",
  grantCount: 3,
  sampleGrants: [{ title: "Plasticity in cancer metastasis", startYear: 2019, endYear: 2024 }],
  ...p,
});

const confirmed = (
  p: Partial<EditContextReporterProfileConfirmed> & Pick<EditContextReporterProfileConfirmed, "candidateId">,
): EditContextReporterProfileConfirmed => ({
  externalProfileId: 999,
  candidateName: "Joel Sheinfeld",
  candidateOrgs: "Memorial Sloan Kettering",
  grantCount: 1,
  sampleGrants: [{ title: "Germ cell tumor biology", startYear: 2015, endYear: 2020 }],
  reviewedAt: "2026-06-26",
  autolocked: true,
  ...p,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }));
});

describe("ReporterProfileCard", () => {
  it("renders a pending candidate with name, orgs, grant count, sample title + the CV purpose line", () => {
    render(<ReporterProfileCard cwid="aaa1" candidates={[pending({ candidateId: "rp-1" })]} />);
    expect(screen.getByText(/Karuna Ganesh/)).toBeTruthy();
    expect(screen.getByText(/Memorial Sloan Kettering/)).toBeTruthy();
    expect(screen.getByText(/Plasticity in cancer metastasis/)).toBeTruthy();
    // CV purpose line is required (spec §6.2).
    expect(screen.getByTestId("reporter-profile-cv-purpose").textContent).toMatch(/CV/);
    expect(screen.getByRole("button", { name: /Yes, these are mine/ })).toBeTruthy();
  });

  it("reveals the three enum reasons when 'Not me' is clicked (no free-text)", () => {
    render(<ReporterProfileCard cwid="aaa1" candidates={[pending({ candidateId: "rp-1" })]} />);
    fireEvent.click(screen.getByRole("button", { name: /^Not me$/ }));
    const reasons = screen.getByTestId("reporter-profile-reject-reasons");
    for (const label of Object.values(REJECT_REASON_LABEL)) {
      expect(within(reasons).getByText(label)).toBeTruthy();
    }
  });

  it("PROJECTION-STARVED: nothing resembling an overlap/score renders", () => {
    render(
      <ReporterProfileCard
        cwid="aaa1"
        candidates={[pending({ candidateId: "rp-1" })]}
        confirmed={[confirmed({ candidateId: "rp-2" })]}
      />,
    );
    expect(screen.queryByText(/overlap|\bscore\b|confidence|\bK\s*=/i)).toBeNull();
  });

  it("shows confirmed history with the auto-lock label + a revoke control", () => {
    render(
      <ReporterProfileCard cwid="aaa1" confirmed={[confirmed({ candidateId: "rp-2", autolocked: true })]} />,
    );
    const section = screen.getByTestId("reporter-profile-confirmed");
    expect(within(section).getByText(/Joel Sheinfeld/)).toBeTruthy();
    expect(within(section).getByText(/matched automatically/)).toBeTruthy();
    expect(within(section).getByRole("button", { name: /remove these/ })).toBeTruthy();
  });

  it("self mode confirms directly (POSTs to the confirm route)", async () => {
    render(<ReporterProfileCard cwid="aaa1" candidates={[pending({ candidateId: "rp-1" })]} />);
    fireEvent.click(screen.getByRole("button", { name: /Yes, these are mine/ }));
    expect(fetch).toHaveBeenCalledWith(
      "/api/edit/reporter-profile/rp-1/confirm",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("superuser mode nags before writing — clicking confirm opens a dialog, no immediate POST", () => {
    render(
      <ReporterProfileCard
        cwid="aaa1"
        mode="superuser"
        scholarName="Karuna Ganesh"
        candidates={[pending({ candidateId: "rp-1" })]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Yes, these are the scholar's/ }));
    expect(screen.getByText(/Confirm this match\?/)).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });
});
