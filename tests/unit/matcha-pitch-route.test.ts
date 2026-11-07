/**
 * `/api/edit/matcha/pitch` — the targeted-message pitch:
 *  - 404 unless BOTH `MATCHA` and `MATCHA_BRIEF` are on;
 *  - superuser/developer only (the brief-drafting gate) — an observer gets 403, no Bedrock;
 *  - the submission must be in the caller's scope;
 *  - the ask is re-read from the SAVED search, the officer's requester correction winning;
 *  - the post-check strips email addresses, phone numbers and URLs and caps the length.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const { mockReadEditRequest, mockLogEditDenial, mockSubFindUnique, mockSubFindMany, mockGenerate } =
  vi.hoisted(() => ({
    mockReadEditRequest: vi.fn(),
    mockLogEditDenial: vi.fn(),
    mockSubFindUnique: vi.fn(),
    mockSubFindMany: vi.fn(),
    mockGenerate: vi.fn(),
  }));

vi.mock("@/lib/db", () => ({
  db: {
    read: {
      sponsorMatchSubmission: { findUnique: mockSubFindUnique, findMany: mockSubFindMany },
    },
  },
}));
vi.mock("@/lib/edit/request", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/edit/request")>()),
  readEditRequest: mockReadEditRequest,
}));
vi.mock("@/lib/edit/authz", () => ({ logEditDenial: mockLogEditDenial }));
vi.mock("ai", () => ({ generateText: mockGenerate }));
vi.mock("@/lib/llm/client", () => ({ bedrockClient: () => (id: string) => ({ id }) }));

import { POST } from "@/app/api/edit/matcha/pitch/route";
import { PITCH_MAX_WORDS, postCheckPitch } from "@/lib/api/matcha-pitch";

const devSession = { cwid: "dev1", isSuperuser: false, isDeveloper: true };
function req(session: Record<string, unknown>, body: Record<string, unknown>) {
  mockReadEditRequest.mockResolvedValue({
    ok: true,
    ctx: {
      session,
      effective: session,
      realCwid: session.cwid,
      impersonatedCwid: null,
      requestId: "req-1",
      body,
    },
  });
  return {} as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MATCHA = "on";
  process.env.MATCHA_BRIEF = "on";
  mockSubFindUnique.mockResolvedValue({
    description: "Example Pharma seeks labs studying gut hormones. Contact jo@example.com.",
    descriptionHash: "h1",
    requesterOverride: null,
  });
  mockSubFindMany.mockImplementation(async (args: { select: Record<string, boolean> }) =>
    args.select.resultKey
      ? [{ id: "r1", resultKey: "sponsor:spine:v4:h1" }]
      : [
          {
            id: "r1",
            result: {
              concepts: [{ term: "Gut hormones" }],
              candidates: [],
              requester: "Example Pharma",
            },
          },
        ],
  );
  mockGenerate.mockResolvedValue({
    text: "Example Pharma wants partners who study gut hormones and appetite.",
  });
});

async function json(r: Response) {
  return (await r.json()) as Record<string, unknown>;
}

describe("POST /api/edit/matcha/pitch", () => {
  it("404s when MATCHA_BRIEF is off", async () => {
    process.env.MATCHA_BRIEF = "off";
    expect((await POST(req(devSession, { submissionId: "s1" }))).status).toBe(404);
    expect(mockReadEditRequest).not.toHaveBeenCalled();
  });

  it("refuses an observer (403), logs it, and never calls the model", async () => {
    const observer = { cwid: "obs1", isSuperuser: false, isDeveloper: false, isObserver: true };
    const r = await POST(req(observer, { submissionId: "s1" }));
    expect(r.status).toBe(403);
    expect(mockLogEditDenial).toHaveBeenCalledOnce();
    expect(mockSubFindUnique).not.toHaveBeenCalled();
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("400s on a missing submissionId", async () => {
    expect((await POST(req(devSession, {}))).status).toBe(400);
  });

  it("looks the submission up through the scope predicate; a miss is 404 with no model call", async () => {
    // `matchaSubmissionScope` leaves a developer unscoped (the gate admits only superuser /
    // developer), so the where is the id alone; a submission outside scope reads as not found.
    mockSubFindUnique.mockResolvedValue(null);
    const r = await POST(req(devSession, { submissionId: "other" }));
    expect(r.status).toBe(404);
    expect(mockSubFindUnique.mock.calls[0][0].where).toEqual({ id: "other" });
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("drafts from the SAVED ask and returns the post-checked pitch", async () => {
    const r = await POST(req(devSession, { submissionId: "s1" }));
    expect(r.status).toBe(200);
    expect(await json(r)).toEqual({
      ok: true,
      pitch: "Example Pharma wants partners who study gut hormones and appetite.",
    });
    const prompt = mockGenerate.mock.calls[0][0].messages[0].content as string;
    expect(prompt).toContain("REQUESTER: Example Pharma");
    expect(prompt).toContain("- Gut hormones");
    expect(prompt).toContain("seeks labs studying gut hormones");
  });

  it("uses the officer's requester correction over the model's", async () => {
    mockSubFindUnique.mockResolvedValue({
      description: "x",
      descriptionHash: "h1",
      requesterOverride: "Corrected Labs",
    });
    await POST(req(devSession, { submissionId: "s1" }));
    expect(mockGenerate.mock.calls[0][0].messages[0].content).toContain(
      "REQUESTER: Corrected Labs",
    );
  });

  it("tells the model to name no organization when the search has no requester", async () => {
    mockSubFindMany.mockResolvedValue([]);
    await POST(req(devSession, { submissionId: "s1" }));
    expect(mockGenerate.mock.calls[0][0].messages[0].content).toContain(
      "REQUESTER: (none: do not name any organization)",
    );
  });

  it("strips email, phone and URL from the model's text", async () => {
    mockGenerate.mockResolvedValue({
      text: "The partner seeks gut-hormone labs. Write to jo.doe@example.com or call (212) 555-0100, see https://example.com/rfp for more.",
    });
    const body = await json(await POST(req(devSession, { submissionId: "s1" })));
    expect(body.pitch).toBe("The partner seeks gut-hormone labs. Write to or call, see for more.");
  });

  it("500s when the model call fails", async () => {
    mockGenerate.mockRejectedValue(new Error("bedrock down"));
    expect((await POST(req(devSession, { submissionId: "s1" }))).status).toBe(500);
  });
});

describe("postCheckPitch", () => {
  it("removes phone formats, www links and dollar amounts", () => {
    expect(
      postCheckPitch(
        "Budget $250,000 or $1.5M. Call +1 212.555.0100 or 212-555-0100, www.example.org.",
      ),
    ).toBe("Budget or. Call or,.");
    expect(postCheckPitch("See https://example.org/rfp. Then apply.")).toBe("See. Then apply.");
  });

  it("caps at the word limit, cutting back to a whole sentence", () => {
    const sentence = "One two three four five six seven eight nine ten.";
    const out = postCheckPitch(Array.from({ length: 12 }, () => sentence).join(" "));
    expect(out.split(" ").length).toBeLessThanOrEqual(PITCH_MAX_WORDS);
    expect(out.split(" ").length).toBe(90);
    expect(out.endsWith(".")).toBe(true);
  });

  it("hard-cuts a single run-on sentence at the word limit", () => {
    const out = postCheckPitch(Array.from({ length: 150 }, (_, i) => `w${i}`).join(" "));
    expect(out.split(" ")).toHaveLength(PITCH_MAX_WORDS);
  });

  it("leaves a clean pitch untouched", () => {
    expect(postCheckPitch("  The partner wants   imaging experts. ")).toBe(
      "The partner wants imaging experts.",
    );
  });
});
