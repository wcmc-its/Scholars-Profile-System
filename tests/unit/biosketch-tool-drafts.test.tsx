/**
 * #2654 — the saved-drafts list on the /edit biosketch tab: label (inline edit → PATCH), Clone
 * (client-side prefill of the generate form, nothing sent), New (reset), and the staleness nudge
 * ("N publications added since this draft" → one click re-runs product suggestion ONLY, via the
 * deterministic `/suggest-pubs` route, never the generator).
 *
 * The generation row IS the draft, so everything here rides on the `/generations` GET shape plus
 * two request bodies: the PATCH that relabels a row and the generate POST that carries the label.
 * Assertions are scoped to the component root (`container`), never `document.body`. Native DOM
 * assertions (no jest-dom in `tests/setup.ts`).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";

import { BiosketchTool } from "@/components/edit/biosketch-tool";

const GENERATIONS = [
  {
    id: "gen-ps",
    mode: "personal_statement" as const,
    entries: [{ title: "", body: "My statement about CAR-T resistance." }],
    model: "us.anthropic.claude-opus-4-8",
    promptVersion: "v7",
    params: {
      mode: "personal_statement",
      maxContributions: 5,
      projectTitle: "Targeting CAR-T resistance",
      aims: "Aim 1. Define the resistance program.",
      emphasis: "clinical",
      instructions: "",
      promptVersion: "v7",
    },
    products: null,
    sources: null,
    createdByCwid: "scholar1",
    impersonatedCwid: null,
    label: "R01 resubmission",
    pubsAddedSince: 2,
    createdAt: "2026-07-20T12:00:00.000Z",
  },
  {
    id: "gen-c",
    mode: "contributions" as const,
    entries: [{ title: "Trial design", body: "We ran the first-in-human study." }],
    model: "us.anthropic.claude-opus-4-8",
    promptVersion: "v7",
    params: {
      mode: "contributions",
      maxContributions: 3,
      projectTitle: "",
      aims: "",
      emphasis: "",
      instructions: "",
      promptVersion: "v7",
    },
    products: null,
    sources: null,
    createdByCwid: "scholar1",
    impersonatedCwid: null,
    label: null,
    pubsAddedSince: 0,
    createdAt: "2026-07-18T12:00:00.000Z",
  },
];

const originalFetch = globalThis.fetch;
/** Every non-GET request the component sent, in order: `[url, method, body]`. */
let sent: Array<[string, string, Record<string, unknown>]>;
let patchStatus = 200;

beforeEach(() => {
  sent = [];
  patchStatus = 200;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (method !== "GET") sent.push([url, method, JSON.parse(String(init?.body ?? "{}"))]);
    if (url.includes("/api/edit/biosketch/generations")) {
      if (method === "PATCH") {
        const body = JSON.parse(String(init?.body));
        const label = String(body.label).trim();
        return patchStatus === 200
          ? new Response(JSON.stringify({ ok: true, id: body.generationId, label: label || null }))
          : new Response(JSON.stringify({ ok: false, error: "write_failed" }), { status: 500 });
      }
      return new Response(JSON.stringify({ ok: true, generations: GENERATIONS }));
    }
    if (url.includes("/api/edit/biosketch/suggest-pubs")) {
      return new Response(
        JSON.stringify({
          ok: true,
          pubs: [
            {
              pmid: "40000001",
              title: "A newer paper",
              venue: "J Clin",
              year: 2026,
              impact: null,
              overlap: 3,
              matchedTerms: ["resistance"],
            },
          ],
        }),
      );
    }
    // The generate POST is never reached by these tests' assertions past the request body.
    return new Response(JSON.stringify({ ok: false, error: "generation_failed" }), {
      status: 500,
    });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.clearAllMocks();
});

function renderTool() {
  return render(<BiosketchTool entityId="scholar1" canSeeCost={false} model="model-id" />);
}

const q = (root: HTMLElement, testId: string) =>
  root.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

async function findQ(root: HTMLElement, testId: string): Promise<HTMLElement> {
  await waitFor(() => expect(q(root, testId)).not.toBeNull());
  return q(root, testId) as HTMLElement;
}

describe("BiosketchTool — saved drafts list (#2654)", () => {
  it("leads the tab with the drafts list, label as headline, date fallback when unlabeled", async () => {
    const { container } = renderTool();
    const panel = await findQ(container, "biosketch-versions-panel");
    // The list precedes the generate controls in document order.
    const controls = container.querySelector('[data-slot="biosketch-generate-controls"]');
    expect(controls).not.toBeNull();
    expect(panel.compareDocumentPosition(controls as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(q(container, "biosketch-version-label-gen-ps")?.textContent).toBe("R01 resubmission");
    // The unlabeled headline is the artifact noun alone — the date lives once, on the
    // meta line below, instead of being stated twice in the same row.
    expect(q(container, "biosketch-version-label-gen-c")?.textContent).toBe("Contributions draft");
    expect(q(container, "biosketch-version-actor-gen-c")?.textContent).toContain("Jul 18, 2026");
    // One list, open by default — the rows are visible without a click. A labelled row carries
    // a mode pill, since the list mixes both modes.
    expect(panel.hasAttribute("open")).toBe(true);
    expect(q(container, "biosketch-version-gen-ps")?.textContent).toContain("Personal statement");
  });

  it("Add label → inline input → Save PATCHes the row and updates it in place", async () => {
    const { container } = renderTool();
    fireEvent.click(await findQ(container, "biosketch-version-label-edit-gen-c"));
    const input = (await findQ(
      container,
      "biosketch-version-label-input-gen-c",
    )) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  K08 application  " } });
    fireEvent.click(q(container, "biosketch-version-label-save-gen-c") as HTMLElement);

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual([
      "/api/edit/biosketch/generations",
      "PATCH",
      { generationId: "gen-c", label: "  K08 application  " },
    ]);
    await waitFor(() =>
      expect(q(container, "biosketch-version-label-gen-c")?.textContent).toBe("K08 application"),
    );
    expect(q(container, "biosketch-version-label-input-gen-c")).toBeNull();
  });

  it("a failed label save keeps the input open and surfaces the shared error", async () => {
    patchStatus = 500;
    const { container } = renderTool();
    fireEvent.click(await findQ(container, "biosketch-version-label-edit-gen-c"));
    fireEvent.change(await findQ(container, "biosketch-version-label-input-gen-c"), {
      target: { value: "x" },
    });
    fireEvent.click(q(container, "biosketch-version-label-save-gen-c") as HTMLElement);
    const alert = await findQ(container, "biosketch-error");
    expect(alert.textContent).toContain("We couldn't save that label just now.");
    expect(q(container, "biosketch-version-label-input-gen-c")).not.toBeNull();
  });

  it("Clone prefills mode, title, aims, emphasis and a '(copy)' label, sends nothing", async () => {
    const { container } = renderTool();
    fireEvent.click(await findQ(container, "biosketch-version-clone-gen-ps"));

    // Personal Statement mode is restored, so the required title/aims fields are on screen and
    // carry the cloned row's project framing.
    const title = (await findQ(container, "biosketch-project-title")) as HTMLInputElement;
    expect(title.value).toBe("Targeting CAR-T resistance");
    expect((q(container, "biosketch-aims") as HTMLTextAreaElement).value).toBe(
      "Aim 1. Define the resistance program.",
    );
    expect((q(container, "biosketch-emphasis") as HTMLInputElement).value).toBe("clinical");
    expect((q(container, "biosketch-label") as HTMLInputElement).value).toBe(
      "R01 resubmission (copy)",
    );
    const notice = q(container, "biosketch-cloned-from")?.textContent ?? "";
    expect(notice).toContain(
      "Cloned from the personal statement generated Jul 20, 2026 (R01 resubmission)",
    );
    expect(notice).toContain("The statement and related products are drafted fresh.");
    expect(sent).toHaveLength(0);
  });

  it("a contributions Clone says the contributions and products are drafted fresh", async () => {
    const { container } = renderTool();
    fireEvent.click(await findQ(container, "biosketch-version-clone-gen-c"));
    const notice = (await findQ(container, "biosketch-cloned-from")).textContent ?? "";
    expect(notice).toContain("Cloned from the contributions draft generated Jul 18, 2026.");
    expect(notice).toContain(
      "The contributions and products are drafted fresh from these settings.",
    );
    expect(notice).not.toContain("The statement and related products");
    // Unlabeled source → no "(copy)" label is minted.
    expect((q(container, "biosketch-label") as HTMLInputElement).value).toBe("");
  });

  it("View draft clears the clone notice — it names the form's source, not the draft on screen", async () => {
    const { container } = renderTool();
    fireEvent.click(await findQ(container, "biosketch-version-clone-gen-ps"));
    await findQ(container, "biosketch-cloned-from");
    fireEvent.click(q(container, "biosketch-version-view-gen-c") as HTMLElement);

    await waitFor(() => expect(q(container, "biosketch-cloned-from")).toBeNull());
    // The unrelated draft is what's on screen now.
    expect(q(container, "biosketch-entry-text-0")?.textContent).toContain(
      "We ran the first-in-human study.",
    );
    // The form steps aside while a draft is on screen; closing the draft brings it back with
    // the cloned settings untouched — only the notice went.
    expect(q(container, "biosketch-project-title")).toBeNull();
    fireEvent.click(q(container, "biosketch-change-settings") as HTMLElement);
    expect(((await findQ(container, "biosketch-project-title")) as HTMLInputElement).value).toBe(
      "Targeting CAR-T resistance",
    );
  });

  it("View draft says WHICH draft is on screen and moves focus to the result heading", async () => {
    const { container } = renderTool();
    fireEvent.click(await findQ(container, "biosketch-version-view-gen-ps"));
    const ctx = await findQ(container, "biosketch-result-context");
    // The card mounts below the form; the header names the saved draft (label + date) so the
    // reader isn't left guessing whether this is a fresh run or the row they clicked.
    expect(ctx.textContent).toContain("Saved draft “R01 resubmission”, generated Jul 20, 2026.");
    await waitFor(() => expect(document.activeElement?.id).toBe("biosketch-result-heading"));
    // An unlabeled draft still gets the date.
    fireEvent.click(q(container, "biosketch-version-view-gen-c") as HTMLElement);
    await waitFor(() =>
      expect(q(container, "biosketch-result-context")?.textContent).toContain(
        "Saved draft, generated Jul 18, 2026.",
      ),
    );
  });

  it("the generate POST carries the (edited) label and the cloned params", async () => {
    const { container } = renderTool();
    fireEvent.click(await findQ(container, "biosketch-version-clone-gen-ps"));
    await findQ(container, "biosketch-project-title");
    fireEvent.change(q(container, "biosketch-project-title") as HTMLElement, {
      target: { value: "New application title" },
    });
    fireEvent.change(q(container, "biosketch-label") as HTMLElement, {
      target: { value: "R01 A1" },
    });
    fireEvent.click(q(container, "biosketch-generate") as HTMLElement);

    await waitFor(() => expect(sent.some(([u]) => u.includes("/generate"))).toBe(true));
    const [, , body] = sent.find(([u]) => u.includes("/generate")) as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(body.entityId).toBe("scholar1");
    expect(body.label).toBe("R01 A1");
    expect(body.params).toMatchObject({
      mode: "personal_statement",
      projectTitle: "New application title",
      aims: "Aim 1. Define the resistance program.",
      emphasis: "clinical",
    });
  });

  it("Generate with a Personal Statement missing its required inputs validates instead of firing", async () => {
    const { container } = renderTool();
    // Clone a personal statement, then empty the title so the form is incomplete.
    fireEvent.click(await findQ(container, "biosketch-version-clone-gen-ps"));
    await findQ(container, "biosketch-project-title");
    fireEvent.change(q(container, "biosketch-project-title") as HTMLElement, {
      target: { value: "" },
    });

    // The button is PRESSABLE — the gate is enforced on click, not by disabling it.
    const button = q(container, "biosketch-generate") as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);

    // Nothing was sent, and the field says what is wrong.
    expect(sent.some(([u]) => u.includes("/generate"))).toBe(false);
    const err = await findQ(container, "biosketch-project-title-error");
    expect(err.textContent).toContain("Add the title");
    const title = q(container, "biosketch-project-title") as HTMLInputElement;
    expect(title.getAttribute("aria-invalid")).toBe("true");
    expect(title.getAttribute("aria-describedby")).toBe("biosketch-project-title-error");

    // Filling it in clears the message without another click.
    fireEvent.change(title, { target: { value: "A new title" } });
    await waitFor(() => expect(q(container, "biosketch-project-title-error")).toBeNull());
  });

  it("New draft (on the result bar) closes the draft and resets the form and label", async () => {
    const { container } = renderTool();
    fireEvent.click(await findQ(container, "biosketch-version-clone-gen-ps"));
    await findQ(container, "biosketch-cloned-from");
    fireEvent.click(q(container, "biosketch-version-view-gen-c") as HTMLElement);
    fireEvent.click(await findQ(container, "biosketch-new-draft"));

    await waitFor(() => expect(q(container, "biosketch-result")).toBeNull());
    expect(q(container, "biosketch-cloned-from")).toBeNull();
    expect((q(container, "biosketch-label") as HTMLInputElement).value).toBe("");
    // Back to the default Contributions mode — the Personal Statement fields are gone.
    expect(q(container, "biosketch-project-title")).toBeNull();
  });

  it("nudge renders only where publications were added, and its click re-runs suggestion only", async () => {
    const { container } = renderTool();
    const stale = await findQ(container, "biosketch-version-stale-gen-ps");
    // "added": the count keys on `publication_author.created_at` (#2668), set once on create.
    expect(stale.textContent).toContain("2 publications added since this draft");
    expect(q(container, "biosketch-version-stale-gen-c")).toBeNull();

    fireEvent.click(q(container, "biosketch-version-suggest-gen-ps") as HTMLElement);
    await waitFor(() => expect(sent).toHaveLength(1));
    const [url, method, body] = sent[0];
    expect(url).toBe("/api/edit/biosketch/suggest-pubs");
    expect(method).toBe("POST");
    expect(body.entityId).toBe("scholar1");
    // The draft's own text is the statement: title, aims and the entries — no generator call.
    expect(String(body.statement)).toContain("Targeting CAR-T resistance");
    expect(String(body.statement)).toContain("Aim 1. Define the resistance program.");
    expect(String(body.statement)).toContain("My statement about CAR-T resistance.");
    expect(sent.some(([u]) => u.includes("/generate"))).toBe(false);

    // The ranked list lands under THAT row.
    const row = q(container, "biosketch-version-gen-ps") as HTMLElement;
    await waitFor(() => expect(q(row, "biosketch-suggested-pubs")).not.toBeNull());
    expect(q(row, "biosketch-suggested-pub-40000001")).not.toBeNull();
    expect(
      q(q(container, "biosketch-version-gen-c") as HTMLElement, "biosketch-suggested-pubs"),
    ).toBeNull();
  });
});
