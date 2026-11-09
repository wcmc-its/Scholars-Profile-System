/**
 * Matcha targeted messages in the panel — the "Email individually" review queue:
 *  - the action shows for a drafter only, enabled once a row is ticked;
 *  - its dialog drafts the pitch and subject on open, then one card per selected person with an
 *    address (rank order), and lists people without one under "No email on file";
 *  - a briefed person's second-person lines are drafted per person (and cached); the brief's
 *    third-person angle never reaches the message;
 *  - each message shows as a preview with real bullets and bold labels; Edit opens the text;
 *  - editing the pitch rewrites every card not edited by hand, never an edited one;
 *  - the Done tick toggles, and opening a card's mailto ticks it;
 *  - a mailto past the soft limit warns to use Copy.
 * fetch is stubbed and routed by URL + method. Invented people and organizations only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { MatchaPanel } from "@/components/edit/matcha-panel";
import { linesStorageKey, pitchStorageKey } from "@/components/edit/matcha-targeted-dialog";
import type { MatchaCandidate, MatchaConcept } from "@/lib/api/matcha-contract";
import type { BriefRecords, BriefWire } from "@/lib/edit/matcha-brief-types";

const CONCEPTS: MatchaConcept[] = [
  { term: "Obesity", kind: "concept", members: ["Obesity"], centrality: 0.9, weightFactor: 1 },
];

function pool(n: number): MatchaCandidate[] {
  return Array.from({ length: n }, (_, i) => ({
    cwid: `p${i + 1}`,
    name: `Person 0${i + 1}`,
    profileSlug: `slug-p${i + 1}`,
    title: "Professor",
    department: "Medicine",
    fusedScore: 0,
    contributions: [{ term: "Obesity", rank: i + 1 }],
    technologyCount: 0,
    searchEvidence: [
      {
        term: "__match__",
        evidence: { kind: "publications", strength: "tagged", text: "1 of 10 tagged", count: 1 },
        pubCount: 10,
        keyPaper: { descriptorUis: ["D_x"], contentQuery: "__match__" },
      },
    ],
  })) as MatchaCandidate[];
}

const EMPTY_RECORDS: BriefRecords = {
  funding: [],
  translation: [],
  secondaryAppointments: [],
  centers: [],
  methods: [],
  trialCount: 0,
};

const BRIEF: BriefWire = {
  cwid: "p1",
  generated: {
    why: "Works on obesity.",
    angle: "Could run validation studies in an existing mouse model.",
    angleRole: "Validation partner",
    topics: [{ concept: "Obesity", text: "Appetite circuits in diet models", sources: [] }],
    removedCount: 0,
  },
  edited: null,
  note: null,
  model: "m",
  draftedAt: "2026-11-01T12:00:00.000Z",
  updatedAt: "2026-11-01T12:00:00.000Z",
};

const DIRECTORY: Record<string, { name: string; email: string | null }> = {
  p1: { name: "Ada Person", email: "p1@researcher.example.org" },
  p2: { name: "Bea Person", email: "p2@researcher.example.org" },
  p3: { name: "Cy Person", email: null },
};

const PITCH = "Northwind Bio wants partners who study appetite regulation.";
const SUBJECT = "Northwind Bio collaboration: appetite research";
const LINES = {
  bullets: ["Your diet-induced obesity models", "Appetite circuit mapping"],
  idea: "appetite circuits in diet models.",
};

type Call = { url: string; method: string; body: Record<string, unknown> | null };

function stub(opts: { canEdit?: boolean; pitch?: string } = {}) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(init.body) : null;
      calls.push({ url, method, body });
      if (url === "/api/edit/matcha/contacts") {
        const cwids = (body as { cwids: string[] }).cwids;
        return {
          ok: true,
          json: async () => ({
            ok: true,
            contacts: cwids
              .filter((c) => DIRECTORY[c]?.email)
              .map((c) => ({ cwid: c, name: DIRECTORY[c].name, email: DIRECTORY[c].email })),
            missing: cwids
              .filter((c) => !DIRECTORY[c]?.email)
              .map((c) => ({ cwid: c, name: DIRECTORY[c]?.name ?? c })),
            officer: { name: "Olive Officer", email: "officer@example.org" },
          }),
        };
      }
      if (url === "/api/edit/matcha/pitch") {
        return {
          ok: true,
          json: async () =>
            body?.cwid
              ? { ok: true, ...LINES }
              : { ok: true, pitch: opts.pitch ?? PITCH, subject: SUBJECT },
        };
      }
      if (url.startsWith("/api/edit/matcha/brief") && method === "GET") {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            briefs: [BRIEF],
            records: { p1: EMPTY_RECORDS },
            canEdit: opts.canEdit ?? true,
          }),
        };
      }
      if (method === "GET") {
        return { ok: true, json: async () => ({ ok: true, submissions: [], scope: "own" }) };
      }
      return {
        ok: true,
        json: async () => ({
          ok: true,
          concepts: CONCEPTS,
          candidates: pool(3),
          submissionId: "sub-1",
          titleOverride: null,
          titleSummary: "obesity therapeutics",
          requester: "Northwind Bio",
        }),
      };
    }),
  );
  return calls;
}

const pitchCalls = (calls: Call[]) =>
  calls.filter((c) => c.url === "/api/edit/matcha/pitch" && !c.body?.cwid);
const linesCalls = (calls: Call[]) =>
  calls.filter((c) => c.url === "/api/edit/matcha/pitch" && c.body?.cwid);

async function search() {
  render(<MatchaPanel matchaBrief />);
  fireEvent.change(screen.getByLabelText(/the ask/i), { target: { value: "obesity partners" } });
  fireEvent.click(screen.getByRole("button", { name: "Rank researchers" }));
  await screen.findByText("Person 01");
}

/** Tick every person, open the queue, wait for the cards and the drafted pitch. */
async function openQueue(cwids = [1, 2, 3]) {
  await screen.findByText("Works on obesity.");
  for (const n of cwids) {
    fireEvent.click(screen.getByRole("checkbox", { name: `Shortlist Person 0${n}` }));
  }
  fireEvent.click(screen.getByRole("button", { name: "Email individually" }));
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByRole("region", { name: "Ada Person" });
  const pitch = within(dialog).getByLabelText("The pitch") as HTMLTextAreaElement;
  await waitFor(() => expect(pitch.disabled).toBe(false));
  return { dialog, pitch };
}

/** The card's message text, switching the card from preview to Edit first. */
function message(dialog: HTMLElement, name: string): HTMLTextAreaElement {
  const card = within(dialog).getByRole("region", { name });
  const edit = within(card).queryByRole("button", { name: "Edit" });
  if (edit) fireEvent.click(edit);
  return within(card).getByLabelText(`Message to ${name}`) as HTMLTextAreaElement;
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Email individually — the action", () => {
  it("is disabled until a row is ticked, and calls nothing at render", async () => {
    const calls = stub();
    await search();
    const button = await screen.findByRole("button", { name: "Email individually" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Shortlist Person 01" }));
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(pitchCalls(calls)).toHaveLength(0);
  });

  it("is hidden for an observer", async () => {
    stub({ canEdit: false });
    await search();
    await screen.findByText("Works on obesity.");
    expect(screen.queryByRole("button", { name: "Email individually" })).toBeNull();
  });
});

describe("Email individually — the review queue", () => {
  it("drafts the pitch, builds one card per addressable person in rank order, lists the rest", async () => {
    const calls = stub();
    await search();
    const { dialog, pitch } = await openQueue();
    expect(pitchCalls(calls)).toHaveLength(1);
    expect(pitchCalls(calls)[0].body).toEqual({ submissionId: "sub-1" });
    expect(pitch.value).toBe(PITCH);
    expect((within(dialog).getByLabelText("Subject") as HTMLInputElement).value).toBe(SUBJECT);
    // Lines are drafted for the briefed person only.
    await waitFor(() => expect(linesCalls(calls)).toHaveLength(1));
    expect(linesCalls(calls)[0].body).toEqual({ submissionId: "sub-1", cwid: "p1" });
    expect(window.localStorage.getItem(linesStorageKey("sub-1", "p1"))).toBe(JSON.stringify(LINES));

    const cards = within(dialog).getAllByRole("region");
    expect(cards.map((c) => c.getAttribute("aria-label"))).toEqual(["Ada Person", "Bea Person"]);
    expect(within(cards[0]).getByText("p1@researcher.example.org")).toBeTruthy();

    // The preview: real list items and the bold label.
    const preview = await waitFor(() => {
      const el = cards[0].querySelector('[data-slot="matcha-targeted-preview"]') as HTMLElement;
      expect(within(el).getAllByRole("listitem")).toHaveLength(2);
      return el;
    });
    expect(within(preview).getByText("Why I thought of you:").tagName).toBe("STRONG");

    const ada = message(dialog, "Ada Person").value;
    expect(ada).toBe(
      [
        "Dear Dr. Person,",
        PITCH,
        "Why I thought of you:\n• Your diet-induced obesity models\n• Appetite circuit mapping",
        "One idea to discuss: appetite circuits in diet models.",
        "Would you be open to a brief conversation? I'm happy to share more details.",
        "Best regards,\nOlive Officer",
      ].join("\n\n"),
    );
    // The brief's third-person angle never goes into the message.
    expect(ada).not.toContain("Validation partner");

    // Bea has no brief: no Why lines, and the card says so.
    const bea = message(dialog, "Bea Person").value;
    expect(bea).toContain(PITCH);
    expect(bea).not.toContain("Why I thought of you");
    expect(within(cards[1]).getByText("No brief — draft one for a personal line")).toBeTruthy();
    expect(within(cards[0]).queryByText(/No brief/)).toBeNull();

    const missing = dialog.querySelector('[data-slot="matcha-targeted-missing"]') as HTMLElement;
    expect(within(missing).getByText("No email on file")).toBeTruthy();
    expect(within(missing).getByText("Cy Person")).toBeTruthy();

    const link = within(cards[0]).getByRole("link", { name: "Open in mail app" });
    expect(link.getAttribute("href")!.startsWith("mailto:p1@researcher.example.org?")).toBe(true);
    expect(link.getAttribute("href")).not.toContain("bcc=");
    expect(link.getAttribute("href")).toContain(`subject=${encodeURIComponent(SUBJECT)}`);
  });

  it("a pitch edit rewrites unedited cards only, and is cached for this search", async () => {
    stub();
    await search();
    const { dialog, pitch } = await openQueue([1, 2]);
    fireEvent.change(message(dialog, "Bea Person"), { target: { value: "My own words." } });
    fireEvent.change(pitch, { target: { value: "An edited pitch." } });
    expect(message(dialog, "Ada Person").value).toContain("An edited pitch.");
    expect(message(dialog, "Ada Person").value).not.toContain(PITCH);
    expect(message(dialog, "Bea Person").value).toBe("My own words.");
    expect(JSON.parse(window.localStorage.getItem(pitchStorageKey("sub-1"))!)).toEqual({
      pitch: "An edited pitch.",
      subject: SUBJECT,
    });
  });

  it("reopening uses the cached pitch instead of drafting again", async () => {
    window.localStorage.setItem(
      pitchStorageKey("sub-1"),
      JSON.stringify({ pitch: "Kept from last time.", subject: "Kept subject" }),
    );
    window.localStorage.setItem(linesStorageKey("sub-1", "p1"), JSON.stringify(LINES));
    const calls = stub();
    await search();
    const { pitch } = await openQueue([1]);
    expect(pitch.value).toBe("Kept from last time.");
    expect(pitchCalls(calls)).toHaveLength(0);
    expect(linesCalls(calls)).toHaveLength(0);
  });

  it("Done toggles by hand, and opening the mailto ticks it", async () => {
    stub();
    await search();
    const { dialog } = await openQueue([1, 2]);
    const [ada, bea] = within(dialog).getAllByRole("region");
    const adaDone = within(ada).getByRole("checkbox", { name: "Done" }) as HTMLInputElement;
    const beaDone = within(bea).getByRole("checkbox", { name: "Done" }) as HTMLInputElement;
    expect(adaDone.checked).toBe(false);
    fireEvent.click(adaDone);
    expect(adaDone.checked).toBe(true);
    fireEvent.click(adaDone);
    expect(adaDone.checked).toBe(false);

    const link = within(bea).getByRole("link", { name: "Open in mail app" });
    link.addEventListener("click", (e) => e.preventDefault());
    fireEvent.click(link);
    expect(beaDone.checked).toBe(true);
    expect(within(dialog).getByText(/1 of 2 done/)).toBeTruthy();
  });

  it("warns to use Copy when a mailto passes the soft limit", async () => {
    stub();
    await search();
    const { dialog } = await openQueue([1, 2]);
    expect(dialog.querySelector('[data-slot="matcha-targeted-too-long"]')).toBeNull();
    fireEvent.change(message(dialog, "Ada Person"), { target: { value: "word ".repeat(400) } });
    const [ada, bea] = within(dialog).getAllByRole("region");
    expect(within(ada).getByText("Too long for some mail apps — use Copy.")).toBeTruthy();
    expect(within(bea).queryByText(/Too long/)).toBeNull();
  });

  it("shows the pitch's word count and warns past 70 words", async () => {
    stub();
    await search();
    const { dialog, pitch } = await openQueue([1]);
    const count = dialog.querySelector('[data-slot="matcha-pitch-words"]') as HTMLElement;
    expect(count.textContent).toBe("8 words");
    fireEvent.change(pitch, { target: { value: "word ".repeat(71) } });
    expect(count.textContent).toBe("71 words · over 70; shorter reads better");
  });

  it("Copy puts plain text on the clipboard where there is no ClipboardItem", async () => {
    stub();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await search();
    const { dialog } = await openQueue([1]);
    const [ada] = within(dialog).getAllByRole("region");
    fireEvent.click(within(ada).getByRole("button", { name: "Copy" }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(message(dialog, "Ada Person").value),
    );
    expect(await within(ada).findByText(/^Copied/)).toBeTruthy();
  });
});
