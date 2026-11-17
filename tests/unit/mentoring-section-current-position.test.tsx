/**
 * The public Mentoring chip's "Now: …" line — the mentor-entered current
 * position of a mentee. Rendered only when set, and as plain text.
 * Synthetic names only — this repo is public.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/scholars/alex-mentor",
  useSearchParams: () => new URLSearchParams(),
}));

import { MentoringSection } from "@/components/scholar/mentoring-section";
import type { MenteeChip } from "@/lib/api/mentoring";

function chip(over: Partial<MenteeChip>): MenteeChip {
  return {
    cwid: "rel2002",
    fullName: "Rowan Ellis",
    programType: "PhD",
    programName: null,
    graduationYear: 2021,
    appointmentRange: null,
    copublicationCount: 0,
    copublicationPreview: [],
    identityImageEndpoint: "",
    manualOnly: false,
    currentPosition: null,
    scholar: null,
    ...over,
  };
}

function renderSection(mentees: MenteeChip[]) {
  return render(
    <MentoringSection mentees={mentees} mentorCwid="abc1001" mentorSlug="alex-mentor" />,
  );
}

describe("MentoringSection — mentee current position", () => {
  it("renders 'Now: …' under the subtitle when the mentor entered one", () => {
    renderSection([chip({ currentPosition: "Assistant Professor, Example University" })]);
    expect(screen.getByText("Now: Assistant Professor, Example University")).toBeTruthy();
  });

  it("renders no 'Now:' line when it is unset", () => {
    renderSection([chip({})]);
    expect(screen.getByText("Rowan Ellis")).toBeTruthy();
    expect(screen.queryByText(/Now:/)).toBeNull();
  });

  it("renders markup in the text literally, never as HTML", () => {
    const { container } = renderSection([chip({ currentPosition: "<b>Fellow</b>" })]);
    expect(screen.getByText("Now: <b>Fellow</b>")).toBeTruthy();
    expect(container.querySelector("b")).toBeNull();
  });
});
