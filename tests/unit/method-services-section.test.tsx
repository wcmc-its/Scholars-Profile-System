/**
 * `components/edit/method-services-section.tsx` (with the real
 * `MethodFamilyPicker`): the list, the add / edit form, the family combobox,
 * the PMID paste feedback, the preview, remove-with-confirm, and where focus
 * lands after each. `fetch` is stubbed and routed by URL. Made-up units,
 * services and families only.
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

import { MethodServicesSection } from "@/components/edit/method-services-section";
import type { MethodServiceView } from "@/lib/method-services/validation";

const FAM = { supercategory: "evidence_synthesis", familyLabel: "Example review methods" };
const FAM_2 = { supercategory: "evidence_synthesis", familyLabel: "Example search methods" };
const OPTIONS = [
  { ...FAM, supercategoryLabel: "Evidence Synthesis", scholarCount: 48 },
  { ...FAM_2, supercategoryLabel: "Evidence Synthesis", scholarCount: 1 },
];

const SERVICE: MethodServiceView = {
  id: 5,
  entityType: "department",
  entityId: "DEPTA",
  name: "Example review service",
  url: "https://example.org/reviews",
  families: [FAM],
  supportedPmids: ["111", "222", "333"],
  excludedPmids: [],
  countStaffPapers: false,
  affiliationPhrases: [],
  coauthoredPmids: [], authorNames: [], nameMatchedPmids: [],
};

const fetchMock = vi.fn();
/** What the next POST to /api/edit/method-service answers. */
let writeResponse: { status: number; body: Record<string, unknown> };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  mockRefresh.mockReset();
  writeResponse = { status: 200, body: { ok: true, changed: true } };
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) =>
    String(url).startsWith("/api/edit/method-families")
      ? json({ ok: true, families: OPTIONS })
      : json(writeResponse.body, writeResponse.status),
  );
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function renderSection(
  over: Partial<React.ComponentProps<typeof MethodServicesSection>> = {},
) {
  return render(
    <MethodServicesSection
      entityType="department"
      entityId="DEPTA"
      unitName="Example Library"
      services={[SERVICE]}
      {...over}
    />,
  );
}

const writes = () =>
  fetchMock.mock.calls
    .filter(([url]) => url === "/api/edit/method-service")
    .map(([, init]) => JSON.parse((init as RequestInit).body as string));

const nameInput = () => screen.getByLabelText("Service name") as HTMLInputElement;
const urlInput = () => screen.getByLabelText(/^Service page/) as HTMLInputElement;
const picker = () => screen.getByRole("combobox", { name: /Methods this service supports/ }) as HTMLInputElement;
const pmidBox = () => screen.getByLabelText(/^Publications this service supported/) as HTMLTextAreaElement;
const phraseBox = () =>
  screen.getByLabelText(/^Affiliation text that identifies your unit’s authors in PubMed/) as HTMLTextAreaElement;
const form = () => within(screen.getByTestId("method-service-form"));
const isDirty = () => screen.getByTestId("unsaved-guard").getAttribute("data-dirty") === "true";

/** Type in the combobox and wait for the debounced search to list options. */
async function search(text: string) {
  picker().focus();
  fireEvent.change(picker(), { target: { value: text } });
  await waitFor(() => expect(picker().getAttribute("aria-expanded")).toBe("true"));
}

describe("MethodServicesSection: list", () => {
  it("has the section heading and help text", () => {
    renderSection();
    expect(screen.getByRole("heading", { level: 2, name: "Method services" }).id).toBe(
      "method-services-heading",
    );
    const help = screen.getByText(/Services this unit offers for a research method\./).textContent ?? "";
    // Says who manages it, and never that it is the unit's own to maintain.
    expect(help).toContain("Only a superuser can see or change this section");
    expect(help).not.toMatch(/your unit|your service/);
  });

  it("lists a service: name, safe new-tab link, family chips, supported-list count", () => {
    renderSection();
    const row = within(screen.getByTestId("method-service-5"));
    expect(row.getByText("Example review service")).toBeTruthy();
    const link = row.getByRole("link", { name: "https://example.org/reviews" });
    expect(link.getAttribute("href")).toBe("https://example.org/reviews");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(within(row.getByRole("list")).getByText("Example review methods")).toBeTruthy();
    expect(row.getByText("3 publications on the supported list")).toBeTruthy();
    expect(row.getByRole("button", { name: "Edit Example review service" })).toBeTruthy();
    expect(row.getByRole("button", { name: "Remove Example review service" })).toBeTruthy();
  });

  it("says '1 publication', and shows no count line for an empty supported list", () => {
    renderSection({
      services: [
        { ...SERVICE, supportedPmids: ["111"] },
        { ...SERVICE, id: 6, name: "Other service", supportedPmids: [] },
      ],
    });
    expect(screen.getByText("1 publication on the supported list")).toBeTruthy();
    expect(screen.queryByTestId("method-service-supported-6")).toBeNull();
  });

  it("builds neither the review link nor the collaboration counts (next PR)", () => {
    const { container } = renderSection();
    expect(container.textContent).not.toMatch(/Review publications/);
    expect(container.textContent).not.toMatch(/collaborations on the method page/);
    expect(container.textContent).not.toMatch(/Show them/);
  });

  it("shows an empty state", () => {
    renderSection({ services: [] });
    expect(screen.getByTestId("method-services-empty").textContent).toBe("No services listed yet.");
    expect(screen.queryByTestId("method-services-list")).toBeNull();
  });
});

describe("MethodServicesSection: form", () => {
  it("labels every control and starts as 'Add a service'", () => {
    renderSection();
    expect(form().getByRole("heading", { level: 3, name: "Add a service" })).toBeTruthy();
    expect(nameInput().value).toBe("");
    expect(urlInput().type).toBe("url");
    expect(picker()).toBeTruthy();
    expect(pmidBox().value).toBe("");
    expect(screen.getByRole("checkbox", { name: /Also count publications co-authored by people in our unit/ })).toBeTruthy();
    expect(screen.getByText(/Leave off if only some of your unit works on this service\./)).toBeTruthy();
    expect(screen.getByText(/Add PMIDs for work you supported without authorship/)).toBeTruthy();
    expect(phraseBox().value).toBe("");
    const hint = document.getElementById(phraseBox().getAttribute("aria-describedby")!)!;
    expect(hint.textContent).toMatch(/catches staff who are not faculty and people who have left/);
    expect(screen.getByText(/one phrase per line/)).toBeTruthy();
  });

  it("defaults the staff-papers checkbox off for a department and on for a core", () => {
    const dept = renderSection();
    expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe("false");
    dept.unmount();
    renderSection({ entityType: "core", entityId: "77", services: [] });
    expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe("true");
  });

  it("previews the public block with the unit's name and literal N and M", () => {
    renderSection();
    const preview = screen.getByTestId("method-service-preview");
    expect(screen.getByText("How it will appear on the method page")).toBeTruthy();
    expect(preview.textContent).toContain("WCM services for this method");
    expect(preview.textContent).toContain("Offered by the Example Library");
    expect(preview.textContent).toContain(
      "The Example Library collaborated on N and supported S of the M publications listed here.",
    );
    fireEvent.change(nameInput(), { target: { value: "Data consultations" } });
    expect(preview.textContent).toContain("Data consultations ↗");
    expect(screen.getByText(/worked out from the unit’s people, the supported list, the affiliation\s+text and the author names/)).toBeTruthy();
  });

  it("does not double the article for a unit named 'The …'", () => {
    renderSection({ unitName: "The Example Institute" });
    expect(screen.getByTestId("method-service-preview").textContent).toContain(
      "Offered by the Example Institute",
    );
  });

  it("reports the parsed PMID count and the rejected tokens as you type", () => {
    renderSection();
    const count = screen.getByTestId("method-service-pmids-count");
    expect(count.getAttribute("aria-live")).toBe("polite");
    expect(count.textContent).toBe("");
    fireEvent.change(pmidBox(), { target: { value: "111, PMID: 222\nabc 111 12x" } });
    expect(count.textContent).toBe("2 PMIDs recognised. Not a PMID, left out: abc, 12x.");
    expect(pmidBox().getAttribute("aria-describedby")).toContain("method-service-pmids-count");
    fireEvent.change(pmidBox(), { target: { value: "111" } });
    expect(count.textContent).toBe("1 PMID recognised.");
  });

  it("blocks more than 5000 PMIDs with an error on the field, and sends nothing", async () => {
    renderSection();
    fireEvent.change(nameInput(), { target: { value: "X" } });
    fireEvent.change(urlInput(), { target: { value: "https://example.org" } });
    await search("exa");
    fireEvent.keyDown(picker(), { key: "ArrowDown" });
    fireEvent.keyDown(picker(), { key: "Enter" });
    const block = Array.from({ length: 5001 }, (_, i) => String(i + 1)).join("\n");
    fireEvent.change(pmidBox(), { target: { value: block } });
    expect(screen.getByTestId("method-service-pmids-count").textContent).toContain("The limit is 5,000.");
    fireEvent.click(form().getByRole("button", { name: "Add service" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Use 5,000 PMIDs or fewer.");
    expect(pmidBox().getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(pmidBox());
    expect(writes()).toEqual([]);
  });

  it("validates before sending: each error is tied to its field and focus goes to the first", () => {
    renderSection();
    fireEvent.change(urlInput(), { target: { value: "http://example.org" } });
    fireEvent.click(form().getByRole("button", { name: "Add service" }));
    expect(writes()).toEqual([]);

    const name = nameInput();
    expect(name.getAttribute("aria-invalid")).toBe("true");
    const nameError = document.getElementById(name.getAttribute("aria-describedby")!)!;
    expect(nameError.getAttribute("role")).toBe("alert");
    expect(nameError.textContent).toBe("Enter a name for the service.");

    const urlError = document.getElementById(urlInput().getAttribute("aria-describedby")!)!;
    expect(urlError.textContent).toMatch(/valid https:\/\/ web address/);

    const famError = document.getElementById(picker().getAttribute("aria-describedby")!)!;
    expect(famError.textContent).toBe("Pick at least one method.");
    expect(picker().getAttribute("aria-invalid")).toBe("true");

    expect(document.activeElement).toBe(name);

    // Fixing a field clears its error.
    fireEvent.change(name, { target: { value: "X" } });
    expect(name.getAttribute("aria-invalid")).toBeNull();
  });
});

describe("MethodServicesSection: family combobox", () => {
  it("searches after typing, lists matches with supercategory and scholar count", async () => {
    renderSection({ services: [] });
    expect(picker().getAttribute("aria-expanded")).toBe("false");
    fireEvent.change(picker(), { target: { value: "e" } });
    await search("exa");
    expect(fetchMock).toHaveBeenCalledWith("/api/edit/method-families?q=exa", expect.anything());
    // One character never searched.
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes("method-families"))).toHaveLength(1);
    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      "Example review methodsEvidence Synthesis · 48 scholars",
      "Example search methodsEvidence Synthesis · 1 scholar",
    ]);
    expect(picker().getAttribute("aria-controls")).toBe(screen.getByRole("listbox").id);
  });

  it("ArrowDown / ArrowUp move the active option, Enter adds it as a chip", async () => {
    renderSection({ services: [] });
    await search("exa");
    fireEvent.keyDown(picker(), { key: "ArrowDown" });
    fireEvent.keyDown(picker(), { key: "ArrowDown" });
    const active = picker().getAttribute("aria-activedescendant")!;
    expect(document.getElementById(active)!.textContent).toContain("Example search methods");
    expect(document.getElementById(active)!.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(picker(), { key: "ArrowUp" });
    fireEvent.keyDown(picker(), { key: "Enter" });

    const chips = within(screen.getByRole("list", { name: "Selected methods" }));
    expect(chips.getByText("Example review methods")).toBeTruthy();
    expect(picker().value).toBe("");
    expect(picker().getAttribute("aria-expanded")).toBe("false");
  });

  it("does not offer a family that is already picked", async () => {
    renderSection({ services: [] });
    await search("exa");
    fireEvent.mouseDown(screen.getAllByRole("option")[0]);
    await search("exam");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Example search methodsEvidence Synthesis · 1 scholar",
    ]);
  });

  it("Escape closes the list and keeps what was typed", async () => {
    renderSection({ services: [] });
    await search("exa");
    fireEvent.keyDown(picker(), { key: "Escape" });
    expect(picker().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryAllByRole("option")).toEqual([]);
    expect(picker().value).toBe("exa");
  });

  it("Enter with nothing active neither adds nor submits the form", async () => {
    renderSection({ services: [] });
    await search("exa");
    fireEvent.keyDown(picker(), { key: "Enter" });
    expect(screen.queryByRole("list", { name: "Selected methods" })).toBeNull();
    expect(writes()).toEqual([]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a chip's labelled button removes it and hands focus back to the search box", async () => {
    renderSection({ services: [] });
    await search("exa");
    fireEvent.mouseDown(screen.getAllByRole("option")[0]);
    fireEvent.click(screen.getByRole("button", { name: "Remove Example review methods" }));
    expect(screen.queryByRole("list", { name: "Selected methods" })).toBeNull();
    expect(document.activeElement).toBe(picker());
  });

  it("says so when nothing matches or the search fails", async () => {
    fetchMock.mockImplementation(async () => json({ ok: true, families: [] }));
    renderSection({ services: [] });
    await search("zzz");
    expect(screen.getByText("No matching methods.").getAttribute("role")).toBe("status");
    fetchMock.mockImplementation(async () => json({ ok: false, error: "not_curator" }, 403));
    fireEvent.change(picker(), { target: { value: "zzzz" } });
    expect(await screen.findByText("Search failed. Try again.")).toBeTruthy();
  });

  it("does not open the list when the answer lands after focus has moved on", async () => {
    renderSection({ services: [] });
    picker().focus();
    fireEvent.change(picker(), { target: { value: "exa" } });
    // Tab away before the debounce and the fetch finish.
    fireEvent.blur(picker());
    pmidBox().focus();
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/edit/method-families"))).toBe(true),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(picker().getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("listbox", { hidden: true }).hidden).toBe(true);
    // The matches were kept: coming back to the field shows them.
    fireEvent.focus(picker());
    expect(picker().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });

  it("a failed search that lands after focus has moved on stays closed too", async () => {
    fetchMock.mockImplementation(async () => {
      throw new Error("network");
    });
    renderSection({ services: [] });
    picker().focus();
    fireEvent.change(picker(), { target: { value: "exa" } });
    fireEvent.blur(picker());
    pmidBox().focus();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(picker().getAttribute("aria-expanded")).toBe("false");
    fireEvent.focus(picker());
    expect(screen.getByText("Search failed. Try again.").className).not.toContain("sr-only");
  });
});

describe("MethodServicesSection: add", () => {
  it("creates the service, lists it, announces it, refreshes, and focuses the new row", async () => {
    const created: MethodServiceView = {
      id: 9,
      entityType: "department",
      entityId: "DEPTA",
      name: "Data consultations",
      url: "https://example.org/data",
      families: [FAM_2],
      supportedPmids: ["111", "222"],
      excludedPmids: [],
      countStaffPapers: true,
      affiliationPhrases: ["Example Health Sciences Library", "Example Library"],
      coauthoredPmids: ["111"], authorNames: [], nameMatchedPmids: [],
    };
    writeResponse = { status: 200, body: { ok: true, changed: true, service: created } };
    renderSection();
    fireEvent.change(phraseBox(), {
      target: { value: " Example  Health Sciences Library \n\nExample Library\n" },
    });

    fireEvent.change(nameInput(), { target: { value: "  Data consultations " } });
    fireEvent.change(urlInput(), { target: { value: "https://example.org/data" } });
    await search("exa");
    fireEvent.mouseDown(screen.getByRole("option", { name: /Example search methods/ }));
    fireEvent.change(pmidBox(), { target: { value: "111\n222, nope" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(form().getByRole("button", { name: "Add service" }));

    await waitFor(() => expect(screen.getByTestId("method-service-9")).toBeTruthy());
    expect(writes()).toEqual([
      {
        op: "create",
        entityType: "department",
        entityId: "DEPTA",
        name: "Data consultations",
        url: "https://example.org/data",
        families: [FAM_2],
        supportedPmids: ["111", "222"],
        countStaffPapers: true,
        affiliationPhrases: ["Example Health Sciences Library", "Example Library"],
        authorNames: [],
      },
    ]);
    // Never the server's own field.
    expect(writes()[0]).not.toHaveProperty("coauthoredPmids");
    expect(screen.queryByTestId("method-service-warning")).toBeNull();
    expect(phraseBox().value).toBe("");
    // Sorted by name: "Data…" before "Example…".
    const ids = [...screen.getByTestId("method-services-list").children].map((li) =>
      li.getAttribute("data-testid"),
    );
    expect(ids).toEqual(["method-service-9", "method-service-5"]);
    expect(screen.getByText("Added Data consultations.").getAttribute("role")).toBe("status");
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    // The form is clean again and focus is on the saved row.
    expect(nameInput().value).toBe("");
    expect(pmidBox().value).toBe("");
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Edit Data consultations" })),
    );
  });

  it("puts a server field error on its field and keeps the draft", async () => {
    writeResponse = { status: 400, body: { ok: false, error: "unknown_family", field: "families" } };
    renderSection({ services: [] });
    fireEvent.change(nameInput(), { target: { value: "X" } });
    fireEvent.change(urlInput(), { target: { value: "https://example.org" } });
    await search("exa");
    fireEvent.mouseDown(screen.getAllByRole("option")[0]);
    fireEvent.click(form().getByRole("button", { name: "Add service" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/no longer has a public page/);
    expect(picker().getAttribute("aria-describedby")).toBe(alert.id);
    expect(document.activeElement).toBe(picker());
    expect(nameInput().value).toBe("X");
    expect(mockRefresh).not.toHaveBeenCalled();
    expect(screen.queryByTestId("method-services-list")).toBeNull();
  });

  it("shows a form-level alert for a failure with no field (403, network)", async () => {
    writeResponse = { status: 403, body: { ok: false, error: "not_superuser" } };
    renderSection({ services: [] });
    fireEvent.change(nameInput(), { target: { value: "X" } });
    fireEvent.change(urlInput(), { target: { value: "https://example.org" } });
    await search("exa");
    fireEvent.mouseDown(screen.getAllByRole("option")[0]);
    fireEvent.click(form().getByRole("button", { name: "Add service" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /Only a superuser can change method services/,
    );
  });
});

describe("MethodServicesSection: the unit's author names", () => {
  const authorBox = () =>
    screen.getByLabelText(/^Authors from your unit, as PubMed lists them/) as HTMLTextAreaElement;
  const WITH_NAME: MethodServiceView = {
    ...SERVICE,
    authorNames: ["Rivera Stone B"],
    coauthoredPmids: ["111"],
    nameMatchedPmids: ["111"],
  };

  it("sits under the affiliation phrases, with its hint", () => {
    renderSection();
    expect(
      phraseBox().compareDocumentPosition(authorBox()) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(document.getElementById("method-service-authors-hint")!.textContent).toBe(
      "Family name then first initial, for example Rivera Stone B. Use this for people whose affiliation is written differently from paper to paper.",
    );
    expect(authorBox().getAttribute("aria-describedby")).toBe("method-service-authors-hint");
  });

  it("Edit loads the stored names, one per line, and a change makes the form dirty", () => {
    renderSection({ services: [{ ...WITH_NAME, authorNames: ["Rivera Stone B", "Okafor C"] }] });
    fireEvent.click(screen.getByRole("button", { name: "Edit Example review service" }));
    expect(authorBox().value).toBe("Rivera Stone B\nOkafor C");
    expect(isDirty()).toBe(false);
    fireEvent.change(authorBox(), { target: { value: "Okafor C" } });
    expect(isDirty()).toBe(true);
  });

  it("sends the names, one per line, and never the server's own lists", async () => {
    writeResponse = { status: 200, body: { ok: true, changed: true, service: WITH_NAME } };
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "Edit Example review service" }));
    fireEvent.change(authorBox(), { target: { value: " Rivera  Stone B \n\nOkafor C\n" } });
    fireEvent.click(form().getByRole("button", { name: "Save changes" }));
    await screen.findByText("Saved Example review service.");
    expect(writes()).toEqual([{ op: "update", id: 5, authorNames: ["Rivera Stone B", "Okafor C"] }]);
  });

  it("sends the stored names again on a save that changes nothing, so the check carries on", async () => {
    writeResponse = { status: 200, body: { ok: true, changed: false, service: WITH_NAME } };
    renderSection({ services: [WITH_NAME] });
    fireEvent.click(screen.getByRole("button", { name: "Edit Example review service" }));
    fireEvent.click(form().getByRole("button", { name: "Save changes" }));
    await screen.findByText("Saved Example review service.");
    expect(writes()).toEqual([{ op: "update", id: 5, authorNames: ["Rivera Stone B"] }]);
  });

  it("refuses a name with no initial before sending, on its own field", () => {
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "Edit Example review service" }));
    fireEvent.change(authorBox(), { target: { value: "Rivera Stone" } });
    fireEvent.click(form().getByRole("button", { name: "Save changes" }));
    expect(writes()).toEqual([]);
    expect(authorBox().getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById("method-service-authors-error")!.textContent).toBe(
      "Each name needs a family name then a first initial, for example Rivera Stone B.",
    );
    expect(document.activeElement).toBe(authorBox());
  });

  it("a server error on authorNames lands on that field", async () => {
    writeResponse = { status: 400, body: { ok: false, error: "too_many_author_names", field: "authorNames" } };
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "Edit Example review service" }));
    fireEvent.change(authorBox(), { target: { value: "Okafor C" } });
    fireEvent.click(form().getByRole("button", { name: "Save changes" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Use 50 names or fewer.");
    expect(alert.id).toBe("method-service-authors-error");
  });
});

describe("MethodServicesSection: affiliation text and the PubMed check", () => {
  const WITH_PHRASE: MethodServiceView = {
    ...SERVICE,
    affiliationPhrases: ["Example Health Sciences Library"],
    coauthoredPmids: ["111"],
  };

  it("Edit loads the stored phrases, one per line", () => {
    renderSection({
      services: [{ ...WITH_PHRASE, affiliationPhrases: ["Example Health Sciences Library", "Example Library"] }],
    });
    fireEvent.click(screen.getByRole("button", { name: "Edit Example review service" }));
    expect(phraseBox().value).toBe("Example Health Sciences Library\nExample Library");
    expect(isDirty()).toBe(false);
    fireEvent.change(phraseBox(), { target: { value: "Example Library" } });
    expect(isDirty()).toBe(true);
  });

  it("refuses a phrase that is too short before sending, on its own field", () => {
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "Edit Example review service" }));
    fireEvent.change(phraseBox(), { target: { value: "ab" } });
    fireEvent.click(form().getByRole("button", { name: "Save changes" }));
    expect(writes()).toEqual([]);
    expect(phraseBox().getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById("method-service-phrases-error")!.textContent).toBe(
      "Each phrase needs at least 3 characters.",
    );
    expect(document.activeElement).toBe(phraseBox());
  });

  it("a server error on affiliationPhrases lands on that field", async () => {
    writeResponse = { status: 400, body: { ok: false, error: "too_many_phrases", field: "affiliationPhrases" } };
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "Edit Example review service" }));
    fireEvent.change(phraseBox(), { target: { value: "Example Library" } });
    fireEvent.click(form().getByRole("button", { name: "Save changes" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Use 10 phrases or fewer.");
    expect(alert.id).toBe("method-service-phrases-error");
  });

  it("shows the warning when the save went through but PubMed could not be checked", async () => {
    writeResponse = {
      status: 200,
      body: { ok: true, changed: true, warning: "pubmed_unavailable", service: { ...WITH_PHRASE, coauthoredPmids: [] } },
    };
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "Edit Example review service" }));
    fireEvent.change(phraseBox(), { target: { value: "Example Health Sciences Library" } });
    fireEvent.click(form().getByRole("button", { name: "Save changes" }));
    const warning = await screen.findByTestId("method-service-warning");
    expect(warning.textContent).toBe("Could not check PubMed for co-authors; try saving again");
    // The save itself succeeded.
    expect(screen.getByText("Saved Example review service.")).toBeTruthy();
    expect(writes()).toEqual([
      { op: "update", id: 5, affiliationPhrases: ["Example Health Sciences Library"] },
    ]);
  });

  it("says how far the PubMed check has got when a long list needs another save", async () => {
    writeResponse = {
      status: 200,
      body: {
        ok: true,
        changed: true,
        warning: "pubmed_incomplete",
        pubmed: { checked: 1800, total: 3200 },
        service: WITH_PHRASE,
      },
    };
    renderSection({ services: [WITH_PHRASE] });
    fireEvent.click(screen.getByRole("button", { name: "Edit Example review service" }));
    fireEvent.click(form().getByRole("button", { name: "Save changes" }));
    const warning = await screen.findByTestId("method-service-warning");
    expect(warning.textContent).toBe(
      "Checked PubMed for co-authors on 1,800 of 3,200 supported publications so far; save again to check the rest",
    );
  });

  it("saving again re-sends the unchanged phrases, which is what asks PubMed again, and clears the warning", async () => {
    writeResponse = {
      status: 200,
      body: { ok: true, changed: false, warning: "pubmed_unavailable", service: WITH_PHRASE },
    };
    renderSection({ services: [WITH_PHRASE] });
    fireEvent.click(screen.getByRole("button", { name: "Edit Example review service" }));
    fireEvent.click(form().getByRole("button", { name: "Save changes" }));
    await screen.findByTestId("method-service-warning");

    writeResponse = { status: 200, body: { ok: true, changed: true, service: WITH_PHRASE } };
    fireEvent.click(screen.getByRole("button", { name: "Edit Example review service" }));
    fireEvent.click(form().getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(screen.queryByTestId("method-service-warning")).toBeNull());
    expect(writes()).toEqual([
      { op: "update", id: 5, affiliationPhrases: ["Example Health Sciences Library"] },
      { op: "update", id: 5, affiliationPhrases: ["Example Health Sciences Library"] },
    ]);
  });

  it("a service with no phrases sends none when something else changes", async () => {
    writeResponse = { status: 200, body: { ok: true, changed: true, service: { ...SERVICE, name: "Renamed" } } };
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "Edit Example review service" }));
    fireEvent.change(nameInput(), { target: { value: "Renamed" } });
    fireEvent.click(form().getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(screen.getByText("Saved Renamed.")).toBeTruthy());
    expect(writes()).toEqual([{ op: "update", id: 5, name: "Renamed" }]);
  });

  it("clearing the phrases sends the empty list", async () => {
    writeResponse = {
      status: 200,
      body: { ok: true, changed: true, service: { ...WITH_PHRASE, affiliationPhrases: [], coauthoredPmids: [] } },
    };
    renderSection({ services: [WITH_PHRASE] });
    fireEvent.click(screen.getByRole("button", { name: "Edit Example review service" }));
    fireEvent.change(phraseBox(), { target: { value: "  \n" } });
    fireEvent.click(form().getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(screen.getByText("Saved Example review service.")).toBeTruthy());
    expect(writes()).toEqual([{ op: "update", id: 5, affiliationPhrases: [] }]);
  });
});

describe("MethodServicesSection: edit", () => {
  it("Edit loads the service into the form and moves focus to the name", () => {
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "Edit Example review service" }));
    expect(form().getByRole("heading", { level: 3, name: "Edit Example review service" })).toBeTruthy();
    expect(nameInput().value).toBe("Example review service");
    expect(urlInput().value).toBe("https://example.org/reviews");
    expect(within(screen.getByRole("list", { name: "Selected methods" })).getByText("Example review methods")).toBeTruthy();
    expect(pmidBox().value).toBe("111\n222\n333");
    expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe("false");
    expect(form().getByRole("button", { name: "Save changes" })).toBeTruthy();
    expect(document.activeElement).toBe(nameInput());
  });

  it("sends only what changed, then updates the row and returns focus to it", async () => {
    writeResponse = {
      status: 200,
      body: { ok: true, changed: true, service: { ...SERVICE, name: "Renamed service", supportedPmids: ["111"] } },
    };
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "Edit Example review service" }));
    fireEvent.change(nameInput(), { target: { value: "Renamed service" } });
    fireEvent.change(pmidBox(), { target: { value: "111" } });
    fireEvent.click(form().getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(screen.getByText("Saved Renamed service.")).toBeTruthy());
    expect(writes()).toEqual([{ op: "update", id: 5, name: "Renamed service", supportedPmids: ["111"] }]);
    const row = within(screen.getByTestId("method-service-5"));
    expect(row.getByText("Renamed service")).toBeTruthy();
    expect(row.getByText("1 publication on the supported list")).toBeTruthy();
    expect(form().getByRole("heading", { level: 3, name: "Add a service" })).toBeTruthy();
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Edit Renamed service" })),
    );
  });

  it("Cancel drops the edit and returns focus to that row's Edit button", async () => {
    renderSection();
    const edit = screen.getByRole("button", { name: "Edit Example review service" });
    fireEvent.click(edit);
    fireEvent.change(nameInput(), { target: { value: "Changed my mind" } });
    fireEvent.click(form().getByRole("button", { name: "Cancel" }));
    expect(nameInput().value).toBe("");
    expect(form().getByRole("heading", { level: 3, name: "Add a service" })).toBeTruthy();
    expect(writes()).toEqual([]);
    await waitFor(() => expect(document.activeElement).toBe(edit));
  });
});

describe("MethodServicesSection: remove", () => {
  it("asks first; Cancel in the dialog deletes nothing", async () => {
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "Remove Example review service" }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByText("Remove this service?")).toBeTruthy();
    expect(dialog.getByText(/“Example review service” will no longer be listed/)).toBeTruthy();
    expect(writes()).toEqual([]);
    fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(writes()).toEqual([]);
    expect(screen.getByTestId("method-service-5")).toBeTruthy();
  });

  it("confirming deletes the row, announces it, refreshes, and moves focus to the form", async () => {
    writeResponse = { status: 200, body: { ok: true, id: 5, changed: true } };
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "Remove Example review service" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove" }));

    await waitFor(() => expect(screen.queryByTestId("method-service-5")).toBeNull());
    expect(writes()).toEqual([{ op: "delete", id: 5 }]);
    expect(screen.getByTestId("method-services-empty")).toBeTruthy();
    expect(screen.getByText("Removed Example review service.").getAttribute("role")).toBe("status");
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(document.activeElement).toBe(nameInput()));
  });

  it("a failed delete keeps the row and says so", async () => {
    writeResponse = { status: 500, body: { ok: false, error: "write_failed" } };
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "Remove Example review service" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/weren’t saved/);
    expect(screen.getByTestId("method-service-5")).toBeTruthy();
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});

describe("MethodServicesSection: unsaved changes", () => {
  it("is clean until something is entered, and clean again after Cancel", () => {
    renderSection();
    expect(isDirty()).toBe(false);
    fireEvent.change(nameInput(), { target: { value: "Half typed" } });
    expect(isDirty()).toBe(true);
    fireEvent.click(form().getByRole("button", { name: "Cancel" }));
    expect(isDirty()).toBe(false);
  });

  it("each add-form field makes it dirty: URL, a picked family, PMIDs, the checkbox", async () => {
    renderSection({ services: [] });
    fireEvent.change(urlInput(), { target: { value: "https://" } });
    expect(isDirty()).toBe(true);
    fireEvent.change(urlInput(), { target: { value: "" } });
    expect(isDirty()).toBe(false);

    fireEvent.change(pmidBox(), { target: { value: "123" } });
    expect(isDirty()).toBe(true);
    fireEvent.change(pmidBox(), { target: { value: "" } });
    expect(isDirty()).toBe(false);

    fireEvent.click(screen.getByRole("checkbox"));
    expect(isDirty()).toBe(true);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(isDirty()).toBe(false);

    await search("exa");
    fireEvent.mouseDown(screen.getAllByRole("option")[0]);
    expect(isDirty()).toBe(true);
  });

  it("an opened edit is clean until a field differs from the stored row", () => {
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "Edit Example review service" }));
    expect(isDirty()).toBe(false);
    fireEvent.change(nameInput(), { target: { value: "Example review service 2" } });
    expect(isDirty()).toBe(true);
    fireEvent.change(nameInput(), { target: { value: "Example review service" } });
    expect(isDirty()).toBe(false);
  });

  it("is clean again after a successful save", async () => {
    writeResponse = {
      status: 200,
      body: { ok: true, changed: true, service: { ...SERVICE, name: "Renamed service" } },
    };
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "Edit Example review service" }));
    fireEvent.change(nameInput(), { target: { value: "Renamed service" } });
    expect(isDirty()).toBe(true);
    fireEvent.click(form().getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(screen.getByText("Saved Renamed service.")).toBeTruthy());
    expect(isDirty()).toBe(false);
  });

  it("Edit over a half-filled add form asks first; Cancel keeps the draft", async () => {
    renderSection();
    fireEvent.change(nameInput(), { target: { value: "Half typed new service" } });
    fireEvent.click(screen.getByRole("button", { name: "Edit Example review service" }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByText("Discard your unsaved changes?")).toBeTruthy();
    expect(nameInput().value).toBe("Half typed new service");
    fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(nameInput().value).toBe("Half typed new service");
    expect(form().getByRole("heading", { level: 3, name: "Add a service" })).toBeTruthy();
  });

  it("confirming the discard loads the row into the form and focuses the name", async () => {
    renderSection();
    fireEvent.change(nameInput(), { target: { value: "Half typed new service" } });
    fireEvent.click(screen.getByRole("button", { name: "Edit Example review service" }));
    const dialog = within(await screen.findByRole("dialog"));
    fireEvent.click(dialog.getByRole("button", { name: "Discard and edit" }));
    await waitFor(() => expect(nameInput().value).toBe("Example review service"));
    expect(form().getByRole("heading", { level: 3, name: "Edit Example review service" })).toBeTruthy();
    expect(isDirty()).toBe(false);
    expect(writes()).toEqual([]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("pressing Edit again on the row being edited keeps what was typed", () => {
    renderSection();
    const edit = screen.getByRole("button", { name: "Edit Example review service" });
    fireEvent.click(edit);
    fireEvent.change(nameInput(), { target: { value: "Mid edit" } });
    fireEvent.click(edit);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(nameInput().value).toBe("Mid edit");
    expect(document.activeElement).toBe(nameInput());
  });
});
