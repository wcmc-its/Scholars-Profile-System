/**
 * Matcha contact in the panel (MATCHA_BRIEF):
 *  - "Email selected (BCC)" shows for a drafter only, enabled once a row is ticked;
 *  - its dialog is prefilled from the standard template, says who has no address, and its
 *    "Open in mail app" link is a mailto: with the officer in To and the researchers in Bcc;
 *  - the per-person "Email" replaces Contact for a drafter and opens the targeted review dialog
 *    for that one person (never a mailto carrying the brief's third-person angle);
 *  - addresses are looked up on click only.
 * fetch is stubbed and routed by URL + method.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { MatchaPanel } from "@/components/edit/matcha-panel";
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

const ANGLE = "Could run validation studies in an existing mouse model.";
const BRIEF: BriefWire = {
  cwid: "p1",
  generated: { why: "Works on obesity.", angle: ANGLE, topics: [], removedCount: 0 },
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

type Call = { url: string; method: string; body: Record<string, unknown> | null };

function stub(opts: { canEdit?: boolean; post?: Record<string, unknown> } = {}) {
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
              ? { ok: true, bullets: ["Your mouse models"], idea: "validation studies." }
              : { ok: true, pitch: "Northwind Bio wants appetite labs.", subject: "S" },
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
          ...(opts.post ?? {}),
        }),
      };
    }),
  );
  return calls;
}

const contactCalls = (calls: Call[]) => calls.filter((c) => c.url === "/api/edit/matcha/contacts");

async function search(matchaBrief = true) {
  render(<MatchaPanel matchaBrief={matchaBrief} />);
  fireEvent.change(screen.getByLabelText(/the ask/i), { target: { value: "obesity partners" } });
  fireEvent.click(screen.getByRole("button", { name: "Rank researchers" }));
  await screen.findByText("Person 01");
}

beforeEach(() => {
  window.localStorage.clear();
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: { href: "" },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Email selected (BCC)", () => {
  it("is disabled until a row is ticked, and resolves no address at render", async () => {
    const calls = stub();
    await search();
    const button = await screen.findByRole("button", { name: "Email selected (BCC)" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Shortlist Person 01" }));
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(contactCalls(calls)).toHaveLength(0);
  });

  it("is hidden for an observer", async () => {
    stub({ canEdit: false });
    await search();
    await screen.findByText("Works on obesity.");
    expect(screen.queryByRole("button", { name: "Email selected (BCC)" })).toBeNull();
  });

  it("is absent with the flag off", async () => {
    stub();
    await search(false);
    expect(screen.queryByRole("button", { name: "Email selected (BCC)" })).toBeNull();
  });

  it("opens a prefilled dialog and builds the Bcc mailto", async () => {
    const calls = stub();
    await search();
    for (const n of [1, 2, 3]) {
      fireEvent.click(screen.getByRole("checkbox", { name: `Shortlist Person 0${n}` }));
    }
    fireEvent.click(await screen.findByRole("button", { name: "Email selected (BCC)" }));
    const dialog = await screen.findByRole("dialog");
    expect(contactCalls(calls)).toHaveLength(1);
    expect(contactCalls(calls)[0].body).toEqual({
      submissionId: "sub-1",
      cwids: ["p1", "p2", "p3"],
    });

    const subject = within(dialog).getByLabelText("Subject") as HTMLInputElement;
    const body = within(dialog).getByLabelText("Body") as HTMLTextAreaElement;
    expect(subject.value).toBe("Possible industry collaboration: obesity therapeutics");
    expect(body.value).toContain(
      "because Northwind Bio is looking for Weill Cornell investigators",
    );
    expect(body.value).toContain("working on obesity therapeutics, and your work stood out.");
    expect(body.value.endsWith("Best regards,\nOlive Officer")).toBe(true);
    expect(within(dialog).getByText(/1 without an email on record/)).toBeTruthy();

    fireEvent.change(subject, { target: { value: "Edited subject" } });
    const link = within(dialog).getByRole("link", { name: "Open in mail app" });
    const href = link.getAttribute("href")!;
    expect(href.startsWith("mailto:officer@example.org?")).toBe(true);
    expect(href).toContain("bcc=p1@researcher.example.org,p2@researcher.example.org");
    expect(href).toContain("subject=Edited%20subject");
    expect(href).not.toContain("p3");
  });

  it("copies the addresses semicolon-separated", async () => {
    stub();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    await search();
    fireEvent.click(screen.getByRole("checkbox", { name: "Shortlist Person 01" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Shortlist Person 02" }));
    fireEvent.click(await screen.findByRole("button", { name: "Email selected (BCC)" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Copy addresses" }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        "p1@researcher.example.org; p2@researcher.example.org",
      ),
    );
    expect(await within(dialog).findByText(/Copied 2 addresses/)).toBeTruthy();
  });
});

describe("per-person Email", () => {
  it("replaces Contact for a drafter and opens the review dialog for that person", async () => {
    window.localStorage.setItem("sponsor-match-density", "detailed");
    const calls = stub();
    await search();
    await screen.findByText("Works on obesity.");
    expect(screen.queryAllByRole("button", { name: "Contact" })).toHaveLength(0);
    const buttons = screen.getAllByRole("button", { name: "Email" });
    expect(buttons).toHaveLength(3);
    expect(contactCalls(calls)).toHaveLength(0);

    fireEvent.click(buttons[0]);
    const dialog = await screen.findByRole("dialog", { name: "Email researcher" });
    await waitFor(() =>
      expect(contactCalls(calls)[0].body).toEqual({ submissionId: "sub-1", cwids: ["p1"] }),
    );
    const card = await within(dialog).findByRole("region");
    const preview = card.querySelector('[data-slot="matcha-targeted-preview"]') as HTMLElement;
    await waitFor(() => expect(within(preview).getByText("Your mouse models")).toBeTruthy());
    expect(preview.textContent).not.toContain(ANGLE);
    expect(window.location.href).toBe("");
  });

  it("lists the person under No email on file when they have no address", async () => {
    window.localStorage.setItem("sponsor-match-density", "detailed");
    stub();
    await search();
    fireEvent.click(screen.getAllByRole("button", { name: "Email" })[2]);
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("No email on file")).toBeTruthy();
    expect(within(dialog).queryByRole("region")).toBeNull();
  });

  it("an observer keeps the plain Contact button", async () => {
    window.localStorage.setItem("sponsor-match-density", "detailed");
    stub({ canEdit: false });
    await search();
    await screen.findByText("Works on obesity.");
    expect(screen.queryAllByRole("button", { name: "Email" })).toHaveLength(0);
    expect(screen.getAllByRole("button", { name: "Contact" }).length).toBeGreaterThan(0);
  });
});
