/**
 * #2655 — Bedrock prompt-caching call shape. `ai` (generateText), the Bedrock provider, and
 * the credential chain are mocked — NEVER invokes Bedrock or AWS. Per call site, asserts that
 * the cache point (`providerOptions.bedrock.cachePoint`) rides on the intended message(s) and
 * that the per-call variable part is LAST:
 *  - overview draft + biosketch draft: cache point on `system` AND on the directives + FACTS
 *    user message (the payload a same-params regenerate re-sends); the optional
 *    ADDITIONAL_INSTRUCTIONS block is a second, unmarked user message and is absent when the
 *    scholar typed none; the parts joined at their seam are the single-string user turn.
 *  - verify: cache point on `system` AND on the ALLOWED_FACTS user message; the DRAFT user
 *    message is last and unmarked; the two joined at their seam are the pre-split user turn.
 *  - the aux biosketch calls (product mapping, source attribution) and revise carry NO cache
 *    point — their system prompts are under the model minimum, so a mark would silently no-op.
 *  - the cv route's §15 research-summary call: the same draft shape as the overview generator
 *    (system + payload marks, the marked payload is the whole — and last — user message).
 * Output parsing is untouched: the mock text is what the generators parse, exactly as before.
 *
 * Byte-identity to the PRE-#2655 single-string turn is pinned, not assumed: `MASTER_SHA256`
 * holds the sha256 of what origin/master's `buildOverviewUserPrompt` / `buildBiosketchUserPrompt`
 * emit for the fixtures below (computed by running `git show origin/master:<file>` copies
 * through a scratch tsx script with these exact FACTS + params), so the seam-joined messages
 * are asserted against master's bytes, not just against the branch's own string builder.
 */
import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockGenerateText, mockAssembleFacts, mockBuildWcmCvBuffer } = vi.hoisted(() => ({
  mockGenerateText: vi.fn(),
  mockAssembleFacts: vi.fn(),
  mockBuildWcmCvBuffer: vi.fn(),
}));

vi.mock("ai", () => ({ generateText: mockGenerateText }));
vi.mock("@ai-sdk/amazon-bedrock", () => ({ createAmazonBedrock: () => () => ({}) }));
vi.mock("@aws-sdk/credential-providers", () => ({ fromNodeProviderChain: () => undefined }));
vi.mock("@/lib/llm/models", () => ({
  DEFAULT_GENERATE_MODEL: "test-model",
  modelAcceptsTemperature: () => false,
}));
// The cv route's non-LLM collaborators, stubbed to the happy path so POST reaches its one
// `generateText` call: flag on, request authorized + under the rate cap, one scholar with no
// pubs / mentees / clinical profile, facts = the shared FACTS fixture, docx builder inert.
vi.mock("@/lib/db", () => ({
  db: {
    read: {
      scholar: { findUnique: vi.fn(async () => ({ slug: "jane-q-researcher" })) },
      suppression: { findMany: vi.fn(async () => []) },
      publication: { findMany: vi.fn(async () => []) },
      appointment: { findMany: vi.fn(async () => []) },
    },
  },
}));
vi.mock("@/lib/edit/authz", () => ({ logEditDenial: vi.fn() }));
vi.mock("@/lib/edit/overview-authz", () => ({
  authorizeCvExport: vi.fn(async () => ({ ok: true, viaUnitAdminUnit: null })),
}));
vi.mock("@/lib/edit/overview-facts", () => ({ assembleOverviewFacts: mockAssembleFacts }));
vi.mock("@/lib/edit/overview-selection-store", () => ({
  loadOverviewSelectionDeltas: vi.fn(async () => ({})),
}));
vi.mock("@/lib/edit/request", async () => {
  const { NextResponse } = await import("next/server");
  return {
    readEditRequest: vi.fn(async () => ({
      ok: true,
      ctx: {
        session: { cwid: "self01", isSuperuser: false },
        realCwid: "self01",
        impersonatedCwid: null,
        body: { entityId: "self01" },
      },
    })),
    editError: (status: number, error: string) => NextResponse.json({ error }, { status }),
    editRateLimited: () => NextResponse.json({ error: "rate_limited" }, { status: 429 }),
    logEditFailure: vi.fn(),
  };
});
vi.mock("@/lib/edit/rate-limit", () => ({
  recordCvExportAttempt: vi.fn(async () => ({ allowed: true, count: 1, limit: 10 })),
}));
vi.mock("@/lib/api/profile", () => ({
  getScholarFullProfileBySlug: vi.fn(async () => ({
    slug: "jane-q-researcher",
    hasClinicalProfile: false,
    publications: [],
  })),
}));
vi.mock("@/lib/api/mentoring", () => ({
  getMenteesForMentor: vi.fn(async () => ({ mentees: [] })),
}));
vi.mock("@/lib/edit/cv-export", () => ({
  isCvEnabled: () => true,
  buildWcmCvBuffer: mockBuildWcmCvBuffer,
}));

import { BEDROCK_CACHE_POINT } from "@/lib/llm/client";
import { buildBiosketchUserPrompt, generateBiosketch } from "@/lib/edit/biosketch-generator";
import { normalizeBiosketchParams } from "@/lib/edit/biosketch-params";
import {
  buildGroundingReference,
  buildOverviewUserPrompt,
  generateOverviewDraft,
  overviewSystemPromptFor,
  reviseDraftForGrounding,
  verifyDraftGrounding,
} from "@/lib/edit/overview-generator";
import type { OverviewFacts } from "@/lib/edit/overview-facts";
import { DEFAULT_OVERVIEW_PARAMS } from "@/lib/edit/overview-params";
import { POST as cvPost } from "@/app/api/edit/cv/route";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** sha256 of origin/master's single-string user turns for the fixtures in this file. */
const MASTER_SHA256 = {
  overviewNoSteering: "3c9c7331ae003c698842b009fdfad173cd732abbe25531407ae9a6d043dc2eaf",
  overviewSteering: "f6e7079e3cdaca17e7eb0406b0818d7cfe0178db45031c7b81b7e1de8070f7d2",
  biosketchNoSteering: "6b0905eb04a0285a47d024a6bf48de1bb2b832b803768bf2b40f135b35ae47d5",
  biosketchSteering: "7e0b5e240dcf6b8e443ef36c80806fe637247c467d4377c4d00b34eb8e8d9607",
};

const FACTS: OverviewFacts = {
  name: "Jane Q. Researcher",
  title: "Professor of Medicine",
  department: "Medicine",
  topics: [{ label: "Gene therapy", rationale: "AAV vectors" }],
  representativePublications: [
    {
      pmid: "1",
      title: "AAV biodistribution after CSF delivery",
      venue: "Nature",
      year: 2023,
      impact: 90,
      synopsis: "Vectors distribute 60-90% systemically.",
      impactJustification: "highly cited",
      topicRationale: "central to AAV safety",
      authorPosition: "last",
    },
  ],
  publicationCount: 120,
  yearsActive: { first: 2001, last: 2024 },
  activeGrants: [],
  education: [],
  titles: [],
  methods: [],
  facultyMetrics: null,
  existingBio: null,
} as unknown as OverviewFacts;

const PROSE = "Jane Q. Researcher studies AAV biodistribution.";
const NO_UNGROUNDED = '{"ungrounded": []}';

type Message = { role: string; content: string; providerOptions?: unknown };
type Call = { system?: unknown; prompt?: unknown; messages?: Message[] };
const calls = () => mockGenerateText.mock.calls.map((c) => c[0] as Call);

/** A `system` option that carries the cache point on the (static) system prompt. */
const CACHED_SYSTEM = {
  role: "system",
  content: expect.any(String),
  providerOptions: BEDROCK_CACHE_POINT,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("BEDROCK_CACHE_POINT", () => {
  it("is the provider's message-level cache checkpoint option", () => {
    expect(BEDROCK_CACHE_POINT).toEqual({ bedrock: { cachePoint: { type: "default" } } });
  });
});

describe("generateOverviewDraft — cache points on the system prompt AND the FACTS payload", () => {
  it("marks `system` + the payload; no steering → one user message; output is unchanged", async () => {
    mockGenerateText.mockResolvedValue({ text: PROSE });
    const out = await generateOverviewDraft(FACTS, DEFAULT_OVERVIEW_PARAMS);
    expect(out.draft).toContain(PROSE);

    const [call] = calls();
    expect(calls()).toHaveLength(1);
    expect(call.system).toEqual(CACHED_SYSTEM);
    expect(call.prompt).toBeUndefined();
    expect(call.messages).toEqual([
      {
        role: "user",
        content: expect.stringMatching(/<FACTS>[\s\S]*<\/FACTS>$/),
        providerOptions: BEDROCK_CACHE_POINT,
      },
    ]);
    // With no steering note the marked payload IS the whole single-string user turn —
    // and that turn is byte-for-byte what origin/master's builder emitted.
    expect(call.messages![0].content).toBe(buildOverviewUserPrompt(FACTS, DEFAULT_OVERVIEW_PARAMS));
    expect(sha256(call.messages![0].content)).toBe(MASTER_SHA256.overviewNoSteering);
  });

  it("steering note → a second, unmarked user message; joined at the seam = the string turn", async () => {
    mockGenerateText.mockResolvedValue({ text: PROSE });
    const params = { ...DEFAULT_OVERVIEW_PARAMS, instructions: "Mention the AAV work first." };
    await generateOverviewDraft(FACTS, params);

    const [call] = calls();
    const messages = call.messages!;
    expect(messages).toHaveLength(2);
    expect(messages[0].providerOptions).toBe(BEDROCK_CACHE_POINT);
    expect(messages[0].content).not.toContain("<ADDITIONAL_INSTRUCTIONS>");
    expect(messages[1]).toEqual({
      role: "user",
      content: expect.stringContaining("<ADDITIONAL_INSTRUCTIONS>\nMention the AAV work first.\n"),
    });
    expect(messages[1]).not.toHaveProperty("providerOptions");
    const joined = `${messages[0].content}\n\n${messages[1].content}`;
    expect(joined).toBe(buildOverviewUserPrompt(FACTS, params));
    expect(sha256(joined)).toBe(MASTER_SHA256.overviewSteering);
  });

  it("the payload is byte-identical across a same-params regenerate; only steering moves", async () => {
    mockGenerateText.mockResolvedValue({ text: PROSE });
    await generateOverviewDraft(FACTS, DEFAULT_OVERVIEW_PARAMS);
    await generateOverviewDraft(FACTS, DEFAULT_OVERVIEW_PARAMS);
    await generateOverviewDraft(FACTS, { ...DEFAULT_OVERVIEW_PARAMS, instructions: "Shorter." });
    const [a, b, c] = calls();
    expect(a.system).toEqual(b.system);
    expect(a.messages![0]).toEqual(b.messages![0]);
    // A steering note changes NOTHING before the second cache point.
    expect(c.messages![0]).toEqual(a.messages![0]);
    expect(c.messages).toHaveLength(2);
  });
});

describe("verifyDraftGrounding — cache point after system AND after the reference", () => {
  it("marks `system` + the ALLOWED_FACTS message; the DRAFT message is last and unmarked", async () => {
    mockGenerateText.mockResolvedValue({ text: NO_UNGROUNDED });
    expect(await verifyDraftGrounding(FACTS, PROSE)).toEqual([]);

    const [call] = calls();
    expect(call.system).toEqual(CACHED_SYSTEM);
    expect(call.prompt).toBeUndefined();
    const messages = call.messages!;
    expect(messages).toHaveLength(2);

    expect(messages[0]).toEqual({
      role: "user",
      content: expect.stringContaining("</ALLOWED_FACTS>"),
      providerOptions: BEDROCK_CACHE_POINT,
    });
    expect(messages[0].content).not.toContain("<DRAFT>");

    expect(messages[1]).toEqual({
      role: "user",
      content: `Here is the DRAFT to fact-check:\n\n<DRAFT>\n${PROSE}\n</DRAFT>`,
    });
    expect(messages[1]).not.toHaveProperty("providerOptions");

    // Joined at the seam (one blank line, as the original single string had), the two blocks
    // ARE the pre-split user turn — same words, same order.
    expect(`${messages[0].content}\n\n${messages[1].content}`).toBe(
      [
        "Here is the REFERENCE of ALLOWED FACTS. It is the only permitted source.",
        "",
        "<ALLOWED_FACTS>",
        buildGroundingReference(FACTS),
        "</ALLOWED_FACTS>",
        "",
        "Here is the DRAFT to fact-check:",
        "",
        "<DRAFT>",
        PROSE,
        "</DRAFT>",
      ].join("\n"),
    );
  });

  it("the reference block is identical across drafts of the same scholar (the cacheable prefix)", async () => {
    mockGenerateText.mockResolvedValue({ text: NO_UNGROUNDED });
    await verifyDraftGrounding(FACTS, "Draft one.");
    await verifyDraftGrounding(FACTS, "Draft two, quite different.");
    const [a, b] = calls();
    expect(a.system).toEqual(b.system);
    expect(a.messages![0]).toEqual(b.messages![0]);
    expect(a.messages![1].content).not.toBe(b.messages![1].content);
  });
});

describe("reviseDraftForGrounding — no cache point (system prompt is under the model minimum)", () => {
  it("sends a plain string system + prompt", async () => {
    mockGenerateText.mockResolvedValue({ text: "Revised." });
    await reviseDraftForGrounding(PROSE, [{ span: "AAV", category: "entity", reason: "" }]);
    const [call] = calls();
    expect(typeof call.system).toBe("string");
    expect(typeof call.prompt).toBe("string");
  });
});

describe("generateBiosketch — cache points on the draft + verify; none on the aux calls", () => {
  // A v7 draft with two titled contributions, so the faithfulness pass verifies twice. Pinned
  // to v7: under the v8 default the payload ends with the product-reference block, not </FACTS>.
  const DRAFT = "1. TITLE: Alpha\n\nBody alpha.\n\n2. TITLE: Beta\n\nBody beta.";
  const PARAMS = normalizeBiosketchParams({
    mode: "contributions",
    maxContributions: 5,
    promptVersion: "v7",
  });

  /** A verify call is the one whose LAST user message carries the DRAFT block. */
  const isVerify = (c: Call) => Boolean(c.messages?.at(-1)?.content.includes("<DRAFT>"));

  it("draft: system + payload marks; verify: both marks; product/source: unmarked", async () => {
    // The verify calls answer with the grounding verdict; everything else gets the draft text
    // (the aux calls parse it leniently and degrade, exactly as they would pre-#2655).
    mockGenerateText.mockImplementation(async (args: Call) => ({
      text: isVerify(args) ? NO_UNGROUNDED : DRAFT,
    }));
    const out = await generateBiosketch(FACTS, PARAMS, { faithfulnessPass: true });
    // Byte-identical parse of the mock draft — the change is call shape only.
    expect(out.entries).toEqual([
      { title: "Alpha", body: "Body alpha." },
      { title: "Beta", body: "Body beta." },
    ]);
    expect(out.removed).toEqual([]);

    const shapes = calls();
    // 1 draft + 2 verify (one per contribution) + product mapping + source attribution.
    expect(shapes).toHaveLength(5);

    const [draft] = shapes;
    expect(draft.system).toEqual(CACHED_SYSTEM);
    expect(draft.prompt).toBeUndefined();
    // No steering note → the marked directives + FACTS payload is the whole user turn.
    expect(draft.messages).toEqual([
      {
        role: "user",
        content: buildBiosketchUserPrompt(FACTS, PARAMS, { groundsImpact: true }),
        providerOptions: BEDROCK_CACHE_POINT,
      },
    ]);
    expect(draft.messages![0].content).toMatch(
      /^Mode: Contributions to Science\.\n[\s\S]*<\/FACTS>$/,
    );
    expect(sha256(draft.messages![0].content)).toBe(MASTER_SHA256.biosketchNoSteering);

    const verifies = shapes.filter(isVerify);
    expect(verifies).toHaveLength(2);
    for (const v of verifies) {
      expect(v.system).toEqual(CACHED_SYSTEM);
      expect(v.messages![0].providerOptions).toBe(BEDROCK_CACHE_POINT);
      expect(v.messages![1]).not.toHaveProperty("providerOptions");
      expect(v.messages!.at(-1)!.content).toContain("<DRAFT>");
    }
    // The two verifies share their whole cacheable prefix (system + reference); only the
    // trailing DRAFT block differs.
    expect(verifies[0].messages![0]).toEqual(verifies[1].messages![0]);

    const aux = shapes.slice(1).filter((c) => !isVerify(c));
    expect(aux).toHaveLength(2);
    for (const a of aux) {
      expect(typeof a.system).toBe("string");
      expect(typeof a.prompt).toBe("string");
    }
  });

  it("steering note → second unmarked user message after the payload mark; seam-joined = string turn", async () => {
    mockGenerateText.mockImplementation(async (args: Call) => ({
      text: isVerify(args) ? NO_UNGROUNDED : DRAFT,
    }));
    const params = normalizeBiosketchParams({
      mode: "contributions",
      maxContributions: 5,
      promptVersion: "v7",
      instructions: "Lead with the vector-safety work.",
    });
    await generateBiosketch(FACTS, params, { faithfulnessPass: false });

    const [draft] = calls();
    const messages = draft.messages!;
    expect(messages).toHaveLength(2);
    expect(messages[0].providerOptions).toBe(BEDROCK_CACHE_POINT);
    expect(messages[0].content).toMatch(/<\/FACTS>$/);
    expect(messages[1]).toEqual({
      role: "user",
      content: expect.stringContaining(
        "<ADDITIONAL_INSTRUCTIONS>\nLead with the vector-safety work.\n",
      ),
    });
    expect(messages[1]).not.toHaveProperty("providerOptions");
    const joined = `${messages[0].content}\n\n${messages[1].content}`;
    expect(joined).toBe(buildBiosketchUserPrompt(FACTS, params, { groundsImpact: true }));
    expect(sha256(joined)).toBe(MASTER_SHA256.biosketchSteering);
  });
});

describe("POST /api/edit/cv — the §15 research-summary call carries the same draft shape", () => {
  it("marks `system` + the FACTS payload; the marked payload is the whole, last user message", async () => {
    mockAssembleFacts.mockResolvedValue(FACTS);
    mockGenerateText.mockResolvedValue({ text: PROSE });
    mockBuildWcmCvBuffer.mockResolvedValue(Buffer.from("docx"));

    const res = await cvPost(
      new NextRequest("http://localhost/api/edit/cv", {
        method: "POST",
        body: JSON.stringify({ entityId: "self01" }),
      }),
    );
    expect(res.status).toBe(200);
    // The generated prose reached the docx builder unchanged — the route did not fall back.
    expect(mockBuildWcmCvBuffer).toHaveBeenCalledWith(
      expect.objectContaining({ researchSummary: PROSE }),
    );

    const [call] = calls();
    expect(calls()).toHaveLength(1);
    expect(call.prompt).toBeUndefined();
    // The route's fixed params: default version, third person, extended band, no steering.
    const params = {
      ...DEFAULT_OVERVIEW_PARAMS,
      voice: "third" as const,
      length: "extended" as const,
    };
    expect(call.system).toEqual({
      role: "system",
      content: overviewSystemPromptFor(params.promptVersion),
      providerOptions: BEDROCK_CACHE_POINT,
    });
    expect(call.messages).toEqual([
      {
        role: "user",
        content: buildOverviewUserPrompt(FACTS, params),
        providerOptions: BEDROCK_CACHE_POINT,
      },
    ]);
    // No steering message exists on this path, so the marked payload is last and ends at the
    // FACTS seam — nothing sits after the second cache point.
    expect(call.messages!.at(-1)!.content).toMatch(/<\/FACTS>$/);
    expect(call.messages!.at(-1)!.content).not.toContain("<ADDITIONAL_INSTRUCTIONS>");
  });
});
