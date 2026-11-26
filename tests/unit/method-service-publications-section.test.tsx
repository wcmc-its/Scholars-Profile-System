/**
 * `components/edit/method-service-publications-section.tsx`: the Method
 * services section as a unit's own editor gets it (the supported-publications
 * box with its save button, and "Review publications" with "Not ours" /
 * "Undo"), and the switch that hands a superuser the whole editor instead.
 * `fetch` is stubbed and routed by method. Made-up units, services and
 * families only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const { mockRefresh } = vi.hoisted(() => ({ mockRefresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: mockRefresh }),
}));

// The guard's history / beforeunload plumbing is covered by its own tests; here
// it only reports the `dirty` flag the section hands it.
vi.mock("@/components/edit/unsaved-changes-guard", () => ({
  UnsavedChangesGuard: ({ dirty }: { dirty: boolean }) => (
    <span data-testid="unsaved-guard" data-dirty={String(dirty)} />
  ),
}));

import {
  MethodServicePublicationsSection,
  MethodServicesForViewerSection,
} from "@/components/edit/method-service-publications-section";
import type {
  MethodServicePublicationsView,
  MethodServiceView,
} from "@/lib/method-services/validation";

const FAM = { supercategory: "evidence_synthesis", familyLabel: "Example review methods" };

const SERVICE: MethodServicePublicationsView = {
  id: 5,
  entityType: "department",
  entityId: "DEPTA",
  name: "Example review service",
  url: "https://example.org/reviews",
  families: [FAM],
  supportedPmids: ["111", "222"],
  excludedPmids: ["444"],
  countStaffPapers: false,
  coauthoredPmids: [],
  nameMatchedPmids: [],
};
const OTHER: MethodServicePublicationsView = {
  ...SERVICE,
  id: 6,
  name: "Example search service",
  url: "https://example.org/searches",
  supportedPmids: [],
  excludedPmids: [],
};
const FULL: MethodServiceView = { ...SERVICE, affiliationPhrases: [], authorNames: [] };

const pub = (pmid: string, over: Record<string, unknown> = {}) => ({
  pmid,
  title: `Example paper ${pmid}`,
  journal: "Example Journal",
  year: 2024,
  kind: "support",
  reason: "supported",
  methods: [FAM.familyLabel],
  inDefaultView: true,
  ...over,
});
const REVIEW = {
  collaborations: 0,
  support: 1,
  supportedListed: 2,
  supportedOnPage: 1,
  perMethod: [],
  marked: [pub("111")],
  excluded: [pub("444", { kind: null, reason: null })],
};

const fetchMock = vi.fn();
/** What the next POST to /api/edit/method-service answers. */
let writeResponse: { status: number; body: Record<string, unknown> };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  mockRefresh.mockReset();
  writeResponse = { status: 200, body: { ok: true, changed: true, service: SERVICE } };
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
    init?.method === "POST"
      ? json(writeResponse.body, writeResponse.status)
      : json({ ok: true, review: REVIEW }),
  );
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const renderSection = (services: MethodServicePublicationsView[] = [SERVICE]) =>
  render(<MethodServicePublicationsSection unitName="Example Library" services={services} />);

const writes = () =>
  fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")
    .map(([, init]) => JSON.parse((init as RequestInit).body as string));
const row = (id = 5) => within(screen.getByTestId(`method-service-${id}`));
const pmidBox = (id = 5) =>
  row(id).getByLabelText(/^Publications this service supported/) as HTMLTextAreaElement;
const saveButton = (id = 5) => row(id).getByRole("button", { name: /^Save publications for/ });
const isDirty = () => screen.getByTestId("unsaved-guard").getAttribute("data-dirty") === "true";

describe("MethodServicePublicationsSection: what a unit's editor sees", () => {
  it("has the heading and the help text that says who does what", () => {
    renderSection();
    expect(screen.getByRole("heading", { level: 2, name: "Method services" }).id).toBe(
      "method-services-heading",
    );
    expect(
      screen.getByText(
        "A Scholars administrator connects your unit to a method. You keep the list of publications your unit supported up to date here.",
      ),
    ).toBeTruthy();
  });

  it("lists each service with its name, link and methods as read-only text", () => {
    renderSection([SERVICE, OTHER]);
    expect(row().getByText("Example review service")).toBeTruthy();
    const link = row().getByRole("link", { name: "https://example.org/reviews" });
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(within(row().getByRole("list", { name: /^Methods for/ })).getByText(FAM.familyLabel)).toBeTruthy();
    expect(row(6).getByText("Example search service")).toBeTruthy();
  });

  it("the only controls are each service's publications box, its save button and its review toggle", async () => {
    renderSection([SERVICE, OTHER]);
    await waitFor(() => expect(screen.getAllByRole("button", { name: /^Review publications/ })).toHaveLength(2));
    const buttons = screen.getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent);
    expect(buttons.sort()).toEqual(
      [
        "Review publications for Example review service",
        "Review publications for Example search service",
        "Save publications for Example review service",
        "Save publications for Example search service",
      ].sort(),
    );
    // Two text boxes, both the PMID list. No name, link, methods, phrases or names field.
    expect(screen.getAllByRole("textbox")).toEqual([pmidBox(5), pmidBox(6)]);
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByTestId("method-service-form")).toBeNull();
    expect(screen.queryByText("Add a service")).toBeNull();
    expect(screen.queryByRole("button", { name: /^(Edit|Remove)/ })).toBeNull();
    expect(screen.queryByLabelText(/Affiliation text/)).toBeNull();
    expect(screen.queryByLabelText(/Authors from your unit/)).toBeNull();
  });

  it("shows the stored supported list in the box", () => {
    renderSection();
    expect(pmidBox().value).toBe("111\n222");
  });
});

describe("MethodServicePublicationsSection: saving the supported list", () => {
  it("posts an update that carries op, id and supportedPmids, and nothing else", async () => {
    renderSection();
    fireEvent.change(pmidBox(), { target: { value: "111, 333\nPMID: 555" } });
    writeResponse.body = { ok: true, changed: true, service: { ...SERVICE, supportedPmids: ["111", "333", "555"] } };
    fireEvent.click(saveButton());
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({ op: "update", id: 5, supportedPmids: ["111", "333", "555"] });
    expect(await screen.findByText("Saved the publications for Example review service.")).toBeTruthy();
    expect(pmidBox().value).toBe("111\n333\n555");
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it("counts what was recognised and names what was left out", () => {
    renderSection();
    fireEvent.change(pmidBox(), { target: { value: "111 abc 222" } });
    expect(screen.getByTestId("method-service-pmids-count-5").textContent).toBe(
      "2 PMIDs recognised. Not a PMID, left out: abc.",
    );
  });

  it("saves one service's list without touching another's", async () => {
    renderSection([SERVICE, OTHER]);
    fireEvent.change(pmidBox(6), { target: { value: "777" } });
    writeResponse.body = { ok: true, changed: true, service: { ...OTHER, supportedPmids: ["777"] } };
    fireEvent.click(saveButton(6));
    await waitFor(() => expect(writes()).toEqual([{ op: "update", id: 6, supportedPmids: ["777"] }]));
    expect(pmidBox(5).value).toBe("111\n222");
  });

  it("shows the PubMed warning of a save that could not finish the check", async () => {
    renderSection();
    writeResponse.body = {
      ok: true,
      changed: true,
      service: SERVICE,
      warning: "pubmed_incomplete",
      pubmed: { checked: 1, total: 2 },
    };
    fireEvent.click(saveButton());
    expect((await screen.findByTestId("method-service-warning")).textContent).toMatch(
      /1 of 2 supported publications so far; save again/,
    );
  });

  it("a refused save says so under the box, and keeps what was typed", async () => {
    renderSection();
    fireEvent.change(pmidBox(), { target: { value: "111\n999" } });
    writeResponse = { status: 403, body: { ok: false, error: "not_superuser" } };
    fireEvent.click(saveButton());
    expect((await row().findByRole("alert")).textContent).toMatch(/You can’t change this service’s publications/);
    expect(pmidBox().value).toBe("111\n999");
    expect(isDirty()).toBe(true);
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});

describe("MethodServicePublicationsSection: the unsaved-changes guard", () => {
  it("is clean at first, dirty once a box is typed in, and clean again after the save", async () => {
    renderSection([SERVICE, OTHER]);
    expect(isDirty()).toBe(false);
    fireEvent.change(pmidBox(6), { target: { value: "777" } });
    expect(isDirty()).toBe(true);
    writeResponse.body = { ok: true, changed: true, service: { ...OTHER, supportedPmids: ["777"] } };
    fireEvent.click(saveButton(6));
    await waitFor(() => expect(isDirty()).toBe(false));
  });

  it("is clean again when the text is put back as it was", () => {
    renderSection();
    fireEvent.change(pmidBox(), { target: { value: "111\n222\n333" } });
    expect(isDirty()).toBe(true);
    fireEvent.change(pmidBox(), { target: { value: "111\n222" } });
    expect(isDirty()).toBe(false);
  });

  it("stays dirty for one service's unsaved box after another's save", async () => {
    renderSection([SERVICE, OTHER]);
    fireEvent.change(pmidBox(5), { target: { value: "111" } });
    fireEvent.change(pmidBox(6), { target: { value: "777" } });
    writeResponse.body = { ok: true, changed: true, service: { ...OTHER, supportedPmids: ["777"] } };
    fireEvent.click(saveButton(6));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(pmidBox(5).value).toBe("111");
    expect(isDirty()).toBe(true);
  });
});

describe("MethodServicePublicationsSection: Review publications", () => {
  async function openReview() {
    renderSection();
    fireEvent.click(await row().findByRole("button", { name: /^Review publications/ }));
    return within(await screen.findByTestId("method-service-review-5"));
  }

  it("Not ours posts an exclude for that PMID", async () => {
    const panel = await openReview();
    fireEvent.click(panel.getByRole("button", { name: "Not ours: Example paper 111" }));
    await waitFor(() => expect(writes()).toEqual([{ op: "exclude", id: 5, pmid: "111" }]));
    expect(await screen.findByText("PMID 111 no longer counts for the Example Library.")).toBeTruthy();
  });

  it("Undo posts a restore for that PMID", async () => {
    const panel = await openReview();
    fireEvent.click(panel.getByRole("button", { name: "Undo, count it again: Example paper 444" }));
    await waitFor(() => expect(writes()).toEqual([{ op: "restore", id: 5, pmid: "444" }]));
    expect(await screen.findByText("PMID 444 counts again.")).toBeTruthy();
  });
});

describe("MethodServicesForViewerSection: which half", () => {
  it("manage: the superuser's whole editor, with the add form", () => {
    render(
      <MethodServicesForViewerSection
        entityType="department"
        entityId="DEPTA"
        unitName="Example Library"
        methodServices={{ mode: "manage", services: [FULL] }}
      />,
    );
    expect(screen.getByTestId("method-service-form")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove Example review service" })).toBeTruthy();
    expect(screen.getByLabelText(/^Affiliation text/)).toBeTruthy();
  });

  it("publications: the unit editor's half, with none of that", () => {
    render(
      <MethodServicesForViewerSection
        entityType="department"
        entityId="DEPTA"
        unitName="Example Library"
        methodServices={{ mode: "publications", services: [SERVICE] }}
      />,
    );
    expect(screen.queryByTestId("method-service-form")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Remove/ })).toBeNull();
    expect(saveButton()).toBeTruthy();
  });
});
