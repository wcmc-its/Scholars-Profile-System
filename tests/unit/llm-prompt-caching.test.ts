/**
 * #2655 — Bedrock prompt-caching call shape. `ai` (generateText), the Bedrock provider, and
 * the credential chain are mocked — NEVER invokes Bedrock or AWS. Per call site, asserts that
 * the cache point (`providerOptions.bedrock.cachePoint`) rides on the intended message(s) and
 * that the per-call variable part is LAST:
 *  - overview draft + biosketch draft: cache point on `system`; the user turn stays ONE plain
 *    string (its FACTS sit behind the per-call directives, so nothing after `system` is marked).
 *  - verify: cache point on `system` AND on the ALLOWED_FACTS user message; the DRAFT user
 *    message is last and unmarked; the two joined at their seam are the pre-split user turn.
 *  - the aux biosketch calls (product mapping, source attribution) and revise carry NO cache
 *    point — their system prompts are under the model minimum, so a mark would silently no-op.
 * Output parsing is untouched: the mock text is what the generators parse, exactly as before.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGenerateText } = vi.hoisted(() => ({ mockGenerateText: vi.fn() }));

vi.mock("ai", () => ({ generateText: mockGenerateText }));
vi.mock("@ai-sdk/amazon-bedrock", () => ({ createAmazonBedrock: () => () => ({}) }));
vi.mock("@aws-sdk/credential-providers", () => ({ fromNodeProviderChain: () => undefined }));
vi.mock("@/lib/llm/models", () => ({
  DEFAULT_GENERATE_MODEL: "test-model",
  modelAcceptsTemperature: () => false,
}));

import { BEDROCK_CACHE_POINT } from "@/lib/llm/client";
import { generateBiosketch } from "@/lib/edit/biosketch-generator";
import { normalizeBiosketchParams } from "@/lib/edit/biosketch-params";
import {
  buildGroundingReference,
  generateOverviewDraft,
  reviseDraftForGrounding,
  verifyDraftGrounding,
} from "@/lib/edit/overview-generator";
import type { OverviewFacts } from "@/lib/edit/overview-facts";
import { DEFAULT_OVERVIEW_PARAMS } from "@/lib/edit/overview-params";

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

describe("generateOverviewDraft — cache point on the system prompt only", () => {
  it("marks `system`; the user turn is one unmarked string; output is unchanged", async () => {
    mockGenerateText.mockResolvedValue({ text: PROSE });
    const out = await generateOverviewDraft(FACTS, DEFAULT_OVERVIEW_PARAMS);
    expect(out.draft).toContain(PROSE);

    const [call] = calls();
    expect(calls()).toHaveLength(1);
    expect(call.system).toEqual(CACHED_SYSTEM);
    expect(typeof call.prompt).toBe("string");
    expect(call.prompt).toContain("<FACTS>");
    expect(call.messages).toBeUndefined();
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
  // A v7 draft with two titled contributions, so the faithfulness pass verifies twice.
  const DRAFT = "1. TITLE: Alpha\n\nBody alpha.\n\n2. TITLE: Beta\n\nBody beta.";
  const PARAMS = normalizeBiosketchParams({ mode: "contributions", maxContributions: 5 });

  it("draft: marked system, string user turn; verify: both marks; product/source: unmarked", async () => {
    // The verify calls are the ones that send `messages`; everything else gets the draft text
    // (the aux calls parse it leniently and degrade, exactly as they would pre-#2655).
    mockGenerateText.mockImplementation(async (args: Call) => ({
      text: Array.isArray(args.messages) ? NO_UNGROUNDED : DRAFT,
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
    expect(typeof draft.prompt).toBe("string");
    expect(draft.prompt).toContain("<FACTS>");
    expect(draft.messages).toBeUndefined();

    const verifies = shapes.filter((c) => Array.isArray(c.messages));
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

    const aux = shapes.slice(1).filter((c) => !Array.isArray(c.messages));
    expect(aux).toHaveLength(2);
    for (const a of aux) {
      expect(typeof a.system).toBe("string");
      expect(typeof a.prompt).toBe("string");
    }
  });
});
