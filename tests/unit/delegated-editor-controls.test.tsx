/**
 * A delegated editor — a proxy, a unit admin, or a content editor (who edits in
 * unit-admin mode) — acts for the scholar without being them or an
 * administrator. The write routes refuse it a whole-profile hide, the scholar's
 * own hides, mentee / dataset hides and a non-superuser's View-as writes, so
 * those controls must not render for it (they used to, and 403'd).
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

import { DatasetsCard } from "@/components/edit/datasets-card";
import { FundingCard } from "@/components/edit/funding-card";
import { MenteesCard } from "@/components/edit/mentees-card";
import { ViewAsButton } from "@/components/edit/view-as-button";
import { VisibilityCard } from "@/components/edit/visibility-card";
import type { EditContextDataset, EditContextGrant, EditContextMentee } from "@/lib/api/edit-context";

const grant = (over: Partial<EditContextGrant>): EditContextGrant => ({
  externalId: "g1",
  title: "A grant",
  role: "Principal Investigator",
  source: "InfoEd",
  funderLabel: "NIH",
  startYear: 2018,
  endYear: 2022,
  isActive: false,
  state: "shown",
  suppressionId: null,
  ...over,
});

const mentee = (over: Partial<EditContextMentee>): EditContextMentee => ({
  externalId: "self01:m1",
  name: "Jordan Mentee",
  subtitle: "Immunology (PhD)",
  state: "shown",
  suppressionId: null,
  ...over,
});

const dataset = (over: Partial<EditContextDataset>): EditContextDataset => ({
  datasetId: "ds-1",
  repository: "GEO",
  accessionOrDoi: "GSE12345",
  resourceType: "Dataset",
  dataType: "RNA-seq",
  depositYear: 2023,
  accessModel: "open",
  confidence: "high",
  title: null,
  provenance: "fulltext-scan",
  pmids: ["36711842"],
  authorPosition: "first",
  state: "shown",
  suppressionId: null,
  hiddenAt: null,
  ...over,
});

describe("EntityPanel (via FundingCard / MenteesCard) — delegated", () => {
  const grants = [
    grant({ externalId: "g1" }),
    grant({ externalId: "g2", title: "Self-hidden", state: "hidden_by_self", suppressionId: "s2" }),
  ];

  it("a delegated editor still hides a grant, but gets no Show on the scholar's own hide", () => {
    const { container } = render(
      <FundingCard cwid="sch001" mode="superuser" scholarName="Jane" grants={grants} delegated />,
    );
    const shown = within(container.querySelector('[data-testid="grant-row-g1"]') as HTMLElement);
    expect(shown.getByRole("checkbox")).toBeTruthy();
    const selfHidden = within(container.querySelector('[data-testid="grant-row-g2"]') as HTMLElement);
    expect(selfHidden.queryByRole("button", { name: /show/i })).toBeNull();
  });

  it("without the flag the Show stays (a superuser may undo the scholar's hide)", () => {
    const { container } = render(
      <FundingCard cwid="sch001" mode="superuser" scholarName="Jane" grants={grants} />,
    );
    const selfHidden = within(container.querySelector('[data-testid="grant-row-g2"]') as HTMLElement);
    expect(selfHidden.getByRole("button", { name: /show/i })).toBeTruthy();
  });

  it("a delegated editor gets no hide controls on the mentee roster at all", () => {
    const { container } = render(
      <MenteesCard
        cwid="sch001"
        mode="superuser"
        scholarName="Jane"
        mentees={[mentee({}), mentee({ externalId: "self01:m2", name: "Robin Hidden", state: "hidden_by_self", suppressionId: "s" })]}
        delegated
      />,
    );
    const panel = within(container);
    expect(panel.queryAllByRole("checkbox")).toHaveLength(0);
    expect(panel.queryByRole("button", { name: /show/i })).toBeNull();
    expect(panel.getByText("Jordan Mentee")).toBeTruthy();
  });
});

describe("DatasetsCard — readOnly", () => {
  it("lists deposits with no Hide / Not mine / Restore", () => {
    const { container } = render(
      <DatasetsCard
        cwid="sch001"
        mode="superuser"
        scholarName="Jane"
        datasets={[dataset({}), dataset({ datasetId: "ds-2", state: "hidden_by_self", suppressionId: "s" })]}
        readOnly
      />,
    );
    expect(container.querySelector('[data-testid="dataset-row-ds-1"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="dataset-hide-ds-1"]')).toBeNull();
    expect(container.querySelector('[data-testid="dataset-notmine-ds-1"]')).toBeNull();
    expect(container.querySelector('[data-testid="dataset-show-ds-2"]')).toBeNull();
  });
});

describe("VisibilityCard — profileControls={false}", () => {
  it("shows the whole-profile status with no Hide / restore control", () => {
    const { container } = render(
      <VisibilityCard
        cwid="sch001"
        suppression={{ ownRow: { id: "sup-self", reason: "privacy" }, adminRow: null }}
        scholarName="Jane Doe"
        mode="self"
        thirdPerson
        profileControls={false}
      />,
    );
    expect(container.querySelector('[data-testid="visibility-status-only"]')?.textContent).toContain(
      "hidden from the public",
    );
    expect(container.querySelector('[data-testid="visibility-hide"]')).toBeNull();
    expect(container.querySelector('[data-testid="visibility-revoke-self"]')).toBeNull();
  });
});

describe("ViewAsButton — readOnly", () => {
  it("a non-superuser's confirm says read-only, not 'edit as'", () => {
    render(<ViewAsButton targetCwid="t1" targetName="Terrie Wheeler" readOnly />);
    fireEvent.click(screen.getByTestId("view-as-t1"));
    expect(screen.getByText(/Read-only: you can look, but not save changes/)).toBeTruthy();
    expect(screen.queryByText(/browse and edit as/)).toBeNull();
  });
});
