/**
 * Matcha report v2: `loadReportThemes`, the cached, fail-soft theme grouping. Invented data.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const { mockFindUnique, mockCreate, mockGenerate } = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockCreate: vi.fn(),
  mockGenerate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    read: { matchaReportTheme: { findUnique: mockFindUnique } },
    write: { matchaReportTheme: { create: mockCreate } },
  },
}));
vi.mock("ai", () => ({ generateObject: mockGenerate }));
vi.mock("@/lib/llm/client", () => ({ bedrockClient: () => (id: string) => id }));

import { conceptsHash, loadReportThemes } from "@/lib/api/matcha-report-themes";
import type { MatchaConcept } from "@/lib/api/matcha-contract";

const concept = (term: string, members: string[] = [term]): MatchaConcept =>
  ({ term, kind: "concept", members, centrality: 1, weightFactor: 1 }) as MatchaConcept;

const CONCEPTS = [concept("widgets", ["widgets", "widget assembly"]), concept("sprockets")];
const GOOD = { themes: [{ label: "Widgets & sprockets", terms: ["widgets", "sprockets"] }] };

afterEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockRestore();
});

describe("conceptsHash", () => {
  it("ignores concept order", () => {
    expect(conceptsHash(CONCEPTS)).toBe(conceptsHash([...CONCEPTS].reverse()));
    expect(conceptsHash(CONCEPTS)).not.toBe(conceptsHash([CONCEPTS[0]]));
  });
});

describe("loadReportThemes", () => {
  it("returns the saved row without calling the model", async () => {
    mockFindUnique.mockResolvedValue({ themes: GOOD.themes });
    expect(await loadReportThemes("h1", CONCEPTS)).toEqual(GOOD.themes);
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockFindUnique.mock.calls[0][0].where).toEqual({
      descriptionHash_conceptsHash: { descriptionHash: "h1", conceptsHash: conceptsHash(CONCEPTS) },
    });
  });

  it("calls once when missing, saves with db.write, and returns the value it has", async () => {
    mockFindUnique.mockResolvedValue(null);
    mockGenerate.mockResolvedValue({ object: GOOD });
    mockCreate.mockResolvedValue({});
    expect(await loadReportThemes("h1", CONCEPTS)).toEqual(GOOD.themes);
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        descriptionHash: "h1",
        conceptsHash: conceptsHash(CONCEPTS),
        themes: GOOD.themes,
      }),
    });
    // No re-read after the write.
    expect(mockFindUnique).toHaveBeenCalledTimes(1);
  });

  it("retries once on an invalid answer", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockFindUnique.mockResolvedValue(null);
    mockGenerate
      .mockResolvedValueOnce({ object: { themes: [{ label: "Only one", terms: ["widgets"] }] } })
      .mockResolvedValueOnce({ object: GOOD });
    expect(await loadReportThemes("h1", CONCEPTS)).toEqual(GOOD.themes);
    expect(mockGenerate).toHaveBeenCalledTimes(2);
  });

  it("gives up after two failures and saves nothing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockFindUnique.mockResolvedValue(null);
    mockGenerate.mockRejectedValue(new Error("bedrock down"));
    expect(await loadReportThemes("h1", CONCEPTS)).toBeNull();
    expect(mockGenerate).toHaveBeenCalledTimes(2);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("returns null when the read or the save fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockFindUnique.mockRejectedValue(new Error("db down"));
    expect(await loadReportThemes("h1", CONCEPTS)).toBeNull();

    mockFindUnique.mockResolvedValue(null);
    mockGenerate.mockResolvedValue({ object: GOOD });
    mockCreate.mockRejectedValue(new Error("write failed"));
    expect(await loadReportThemes("h1", CONCEPTS)).toBeNull();
  });

  it("treats a unique-key race on save as success", async () => {
    mockFindUnique.mockResolvedValue(null);
    mockGenerate.mockResolvedValue({ object: GOOD });
    mockCreate.mockRejectedValue(Object.assign(new Error("dup"), { code: "P2002" }));
    expect(await loadReportThemes("h1", CONCEPTS)).toEqual(GOOD.themes);
  });

  it("never calls the model with no concepts", async () => {
    expect(await loadReportThemes("h1", [])).toBeNull();
    expect(mockFindUnique).not.toHaveBeenCalled();
    expect(mockGenerate).not.toHaveBeenCalled();
  });
});
