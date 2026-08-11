/**
 * CancerCenterCollabReportCard — list/detail shell (REPORTS index, click to
 * open, "All reports" to go back) wrapping the Collaboration & Cancer-
 * Relevance report:
 *  - REMOVE / ADD (collaborator + relevant) / ADD (recruit) bucket rows
 *    correctly, and recruit EXCLUDES anyone already in collaborator+relevant
 *    (the exclusivity fix from the post-merge review);
 *  - each section/threshold carries an info-hover affordance.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

import { CancerCenterCollabReportCard } from "@/components/edit/cancer-center-collab-report-card";

const ROWS = [
  // REMOVE: current member, zero collaboration.
  { cwid: "m1", surname: "Removeperson", givenName: "R", primaryDepartment: "Onc", totalPapersPostCutoff: 10, collaborationsWithCenter: 0, cancerRelatedPapers: 1, isCurrentMember: true, currentProgramCode: "P1" },
  // ADD collaborator + relevant: clears both (default thresholds: collab count>=2, relevance count>=3).
  { cwid: "c1", surname: "Collabrelevant", givenName: "C", primaryDepartment: "Med", totalPapersPostCutoff: 10, collaborationsWithCenter: 3, cancerRelatedPapers: 5, isCurrentMember: false, currentProgramCode: null },
  // ADD recruit: clears relevance only.
  { cwid: "c2", surname: "Recruitperson", givenName: "R2", primaryDepartment: "Med", totalPapersPostCutoff: 10, collaborationsWithCenter: 0, cancerRelatedPapers: 4, isCurrentMember: false, currentProgramCode: null },
  // Neither: clears nothing.
  { cwid: "c3", surname: "Neitherperson", givenName: "N", primaryDepartment: "Med", totalPapersPostCutoff: 10, collaborationsWithCenter: 1, cancerRelatedPapers: 1, isCurrentMember: false, currentProgramCode: null },
];

function mockFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ generatedAt: "2026-08-10T00:00:00Z", rows: ROWS }) })),
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("CancerCenterCollabReportCard", () => {
  it("lands on the report list, not the report itself", () => {
    mockFetch();
    render(<CancerCenterCollabReportCard centerCode="meyer_cancer_center" />);
    expect(screen.getByText("Collaboration & Cancer-Relevance")).toBeTruthy();
    expect(screen.queryByText(/active member, zero collaboration/)).toBeNull();
  });

  it("opens the report on click and buckets rows correctly, with recruit exclusive of collaborator+relevant", async () => {
    mockFetch();
    render(<CancerCenterCollabReportCard centerCode="meyer_cancer_center" />);
    fireEvent.click(screen.getByText("Collaboration & Cancer-Relevance"));
    await waitFor(() => expect(screen.getByText(/REMOVE/)).toBeTruthy());

    const removeSection = screen.getByText(/REMOVE/).closest("section")!;
    expect(within(removeSection).getByText(/Removeperson/)).toBeTruthy();

    const collabSection = screen.getByText(/collaborator \+ relevant/).closest("section")!;
    expect(within(collabSection).getByText(/Collabrelevant/)).toBeTruthy();
    expect(within(collabSection).queryByText(/Recruitperson/)).toBeNull();
    expect(within(collabSection).queryByText(/Neitherperson/)).toBeNull();

    const recruitSection = screen.getByText(/ADD — recruit/).closest("section")!;
    expect(within(recruitSection).getByText(/Recruitperson/)).toBeTruthy();
    // The exclusivity fix: someone who already clears both bars appears ONLY
    // under collaborator+relevant, not also here.
    expect(within(recruitSection).queryByText(/Collabrelevant/)).toBeNull();
    expect(within(recruitSection).queryByText(/Neitherperson/)).toBeNull();
  });

  it("returns to the list via 'All reports'", async () => {
    mockFetch();
    render(<CancerCenterCollabReportCard centerCode="meyer_cancer_center" />);
    fireEvent.click(screen.getByText("Collaboration & Cancer-Relevance"));
    await waitFor(() => expect(screen.getByText(/REMOVE/)).toBeTruthy());
    fireEvent.click(screen.getByText(/All reports/));
    expect(screen.getByText("Collaboration & Cancer-Relevance")).toBeTruthy();
    expect(screen.queryByText(/active member, zero collaboration/)).toBeNull();
  });

  it("gives every section and threshold an info-hover affordance", async () => {
    mockFetch();
    render(<CancerCenterCollabReportCard centerCode="meyer_cancer_center" />);
    fireEvent.click(screen.getByText("Collaboration & Cancer-Relevance"));
    await waitFor(() => expect(screen.getByText(/REMOVE/)).toBeTruthy());
    expect(screen.getByLabelText(/About REMOVE/)).toBeTruthy();
    expect(screen.getByLabelText(/About ADD — collaborator \+ relevant/)).toBeTruthy();
    expect(screen.getByLabelText(/About ADD — recruit/)).toBeTruthy();
    expect(screen.getByLabelText(/About the Collaboration threshold/)).toBeTruthy();
    expect(screen.getByLabelText(/About the Cancer-relevance threshold/)).toBeTruthy();
  });

  it("each section's table filters and sorts client-side", async () => {
    mockFetch();
    render(<CancerCenterCollabReportCard centerCode="meyer_cancer_center" />);
    fireEvent.click(screen.getByText("Collaboration & Cancer-Relevance"));
    await waitFor(() => expect(screen.getByText(/REMOVE/)).toBeTruthy());

    const removeSection = screen.getByText(/REMOVE/).closest("section")!;
    // REMOVE has one row (Removeperson) — filtering it out of existence proves
    // the filter box is wired to this section's own rows, not a global list.
    fireEvent.change(within(removeSection).getByLabelText(/Filter rows/), {
      target: { value: "nobody-matches-this" },
    });
    expect(within(removeSection).queryByText(/Removeperson/)).toBeNull();
    expect(within(removeSection).getByText(/No rows match/)).toBeTruthy();

    // Sorting by Papers (desc) in the collaborator+relevant section: only one
    // row there in this fixture, so just confirm the control doesn't blow up
    // and the row survives the re-sort.
    const collabSection = screen.getByText(/collaborator \+ relevant/).closest("section")!;
    fireEvent.change(within(collabSection).getByLabelText(/Sort rows by/), {
      target: { value: "papers" },
    });
    expect(within(collabSection).getByText(/Collabrelevant/)).toBeTruthy();
  });
});
