/**
 * #2652 — `SciencvWorksheet` (`components/edit/sciencv-worksheet.tsx`): the paste-ready SciENcv
 * page. Pins the contract the issue names: blocks in SciENcv field order, plain-text Copy whose
 * string is exactly what the counter counts, the session-local "copied" tick, one analytics
 * beacon per copy, the PMID handoff (comma-separated, blanks flagged and excluded, PubMed search),
 * the 15-honor picker, and the ORCID gap warning.
 *
 * Every assertion is scoped to the worksheet root (`container.querySelector`), never
 * `document.body`. Native DOM assertions (no jest-dom in `tests/setup.ts`).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, within } from "@testing-library/react";

import {
  appointmentLine,
  contributionText,
  educationLine,
  honorLine,
  productCitation,
  pubmedSearchUrl,
  SCIENCV_HONORS_MAX,
  SciencvWorksheet,
  type SciencvWorksheetProps,
} from "@/components/edit/sciencv-worksheet";
import {
  BIOSKETCH_CONTRIBUTION_MAX_CHARS,
  BIOSKETCH_STATEMENT_MAX_CHARS,
} from "@/lib/edit/biosketch-params";
import type { BiosketchProduct } from "@/lib/edit/biosketch-products";

function product(over: Partial<BiosketchProduct> = {}): BiosketchProduct {
  return {
    pmid: "11111111",
    title: "A grounded finding",
    venue: "J Test",
    year: 2024,
    contributionIndex: 1,
    why: "",
    ...over,
  };
}

function props(over: Partial<SciencvWorksheetProps> = {}): SciencvWorksheetProps {
  return {
    cwid: "abc1234",
    backHref: "/edit?attr=biosketch",
    scholar: {
      preferredName: "Pat Example",
      fullName: "Patricia Q. Example",
      orcid: "0000-0002-1825-0097",
      primaryTitle: "Associate Professor of Testing",
    },
    educations: [
      { degree: "PhD", institution: "Example University", field: "Biostatistics", year: 2010 },
    ],
    appointments: [
      {
        title: "Associate Professor",
        organization: "Example Dept",
        startDate: "2020-07-01",
        endDate: null,
      },
      {
        title: "Assistant Professor",
        organization: "Example Dept",
        startDate: "2014-07-01",
        endDate: "2020-06-30",
      },
    ],
    honors: [{ name: "Fellow", organization: "Example Society", year: 2022 }],
    generation: {
      id: "gen-1",
      mode: "contributions",
      entries: [
        { title: "Resistance mechanisms", body: "We studied resistance." },
        { title: "", body: "A second, heading-less contribution." },
      ],
      products: {
        related: [product(), product({ pmid: "", title: "No identifier here", year: 2019 })],
        otherSignificant: [product({ pmid: "22222222", title: "Other work", year: 2021 })],
        relatedFromAims: true,
      },
      createdAt: "2026-09-01T12:00:00.000Z",
    },
    ...over,
  };
}

/** jsdom's Blob has no `.text()`; the beacon body is `new Blob([json], …)` (the repo idiom),
 *  so a capturing Blob reads the payload back (same trick as search-nav-watchdog.test.tsx). */
class CapturingBlob {
  parts: string[];
  constructor(parts: string[]) {
    this.parts = parts;
  }
  text() {
    return Promise.resolve(this.parts.join(""));
  }
}

type WriteText = (text: string) => Promise<void>;
type SendBeacon = (url: string, body: CapturingBlob) => boolean;

/** A resolved clipboard + a beacon spy on `navigator`, restored per test. */
function stubNavigator() {
  const writeText = vi.fn<WriteText>(() => Promise.resolve());
  const sendBeacon = vi.fn<SendBeacon>(() => true);
  vi.stubGlobal("navigator", { clipboard: { writeText }, sendBeacon });
  vi.stubGlobal("Blob", CapturingBlob);
  return { writeText, sendBeacon };
}

/** The beacon payload of the nth call, parsed. */
async function beaconPayload(
  sendBeacon: ReturnType<typeof vi.fn<SendBeacon>>,
  n = 0,
): Promise<Record<string, unknown>> {
  const blob = sendBeacon.mock.calls[n]![1];
  return JSON.parse(await blob.text()) as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SciencvWorksheet — layout", () => {
  it("renders the blocks in SciENcv field order", () => {
    stubNavigator();
    const { container } = render(<SciencvWorksheet {...props()} />);
    const root = container.querySelector('[data-testid="sciencv-worksheet"]')!;
    const ids = Array.from(root.querySelectorAll("section[data-testid^='ws-block-']")).map((el) =>
      el.getAttribute("data-testid")!.replace("ws-block-", ""),
    );
    expect(ids).toEqual([
      "identity",
      "education",
      "appointments",
      "products",
      "statement",
      "contributions",
      "honors",
    ]);
  });

  it("repeats the own-voice warning above both narrative blocks", () => {
    stubNavigator();
    const { container } = render(<SciencvWorksheet {...props()} />);
    const root = container.querySelector('[data-testid="sciencv-worksheet"]')!;
    const statement = root.querySelector('[data-testid="ws-block-statement"]')!;
    const contributions = root.querySelector('[data-testid="ws-block-contributions"]')!;
    expect(statement.querySelector('[data-testid="biosketch-ai-warning"]')).not.toBeNull();
    expect(contributions.querySelector('[data-testid="biosketch-ai-warning"]')).not.toBeNull();
  });

  it("warns when no ORCID iD is on file", () => {
    stubNavigator();
    const { container } = render(
      <SciencvWorksheet {...props({ scholar: { ...props().scholar, orcid: null } })} />,
    );
    const root = container.querySelector('[data-testid="sciencv-worksheet"]')!;
    expect(root.querySelector('[data-testid="ws-orcid-missing"]')).not.toBeNull();
    // Nothing to copy — the ORCID Copy is disabled rather than copying "".
    const btn = root.querySelector<HTMLButtonElement>('[data-testid="ws-copy-identity.orcid"]')!;
    expect(btn.disabled).toBe(true);
  });

  it("a Personal Statement draft fills the statement block and empties the others", () => {
    stubNavigator();
    const { container } = render(
      <SciencvWorksheet
        {...props({
          generation: {
            id: "gen-2",
            mode: "personal_statement",
            entries: [{ title: "", body: "My statement." }],
            products: null,
            createdAt: "2026-09-01T12:00:00.000Z",
          },
        })}
      />,
    );
    const root = container.querySelector('[data-testid="sciencv-worksheet"]')!;
    const text = root.querySelector<HTMLTextAreaElement>('[data-testid="ws-text-statement"]')!;
    expect(text.value).toBe("My statement.");
    expect(root.querySelector('[data-testid="ws-count-statement"]')!.textContent).toContain(
      `13/${BIOSKETCH_STATEMENT_MAX_CHARS.toLocaleString()}`,
    );
    expect(root.querySelector('[data-testid="ws-narrative-contribution.1"]')).toBeNull();
    expect(root.querySelector('[data-testid="ws-products-related"]')).toBeNull();
  });
});

describe("SciencvWorksheet — copy", () => {
  it("copies heading + body for a contribution and counts that same string", async () => {
    const { writeText, sendBeacon } = stubNavigator();
    const { container } = render(<SciencvWorksheet {...props()} />);
    const root = container.querySelector('[data-testid="sciencv-worksheet"]')!;
    const expected = "Resistance mechanisms\n\nWe studied resistance.";
    expect(root.querySelector('[data-testid="ws-count-contribution.1"]')!.textContent).toContain(
      `${expected.length}/${BIOSKETCH_CONTRIBUTION_MAX_CHARS.toLocaleString()}`,
    );
    await act(async () => {
      fireEvent.click(root.querySelector('[data-testid="ws-copy-contribution.1"]')!);
    });
    expect(writeText).toHaveBeenCalledWith(expected);
    // The tick is session-local and stays — no timer reset — so progress is visible.
    const btn = root.querySelector('[data-testid="ws-copy-contribution.1"]')!;
    expect(btn.textContent).toContain("Copied");
    // One beacon per copy, naming the block.
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(sendBeacon.mock.calls[0]![0]).toBe("/api/analytics");
    const payload = await beaconPayload(sendBeacon);
    expect(payload.event).toBe("biosketch_worksheet_copy");
    expect(payload.surface).toBe("contribution.1");
    expect(payload.cwid).toBe("abc1234");
  });

  it("the narrative is editable and the count + copy follow the edit (live)", async () => {
    const { writeText } = stubNavigator();
    const { container } = render(<SciencvWorksheet {...props()} />);
    const root = container.querySelector('[data-testid="sciencv-worksheet"]')!;
    const text = root.querySelector<HTMLTextAreaElement>('[data-testid="ws-text-contribution.2"]')!;
    fireEvent.change(text, { target: { value: "Rewritten in my own voice." } });
    expect(root.querySelector('[data-testid="ws-count-contribution.2"]')!.textContent).toContain(
      `26/${BIOSKETCH_CONTRIBUTION_MAX_CHARS.toLocaleString()}`,
    );
    await act(async () => {
      fireEvent.click(root.querySelector('[data-testid="ws-copy-contribution.2"]')!);
    });
    expect(writeText).toHaveBeenCalledWith("Rewritten in my own voice.");
  });

  it("flags an over-limit narrative", () => {
    stubNavigator();
    const long = "x".repeat(BIOSKETCH_CONTRIBUTION_MAX_CHARS + 1);
    const { container } = render(
      <SciencvWorksheet
        {...props({
          generation: { ...props().generation, entries: [{ title: "", body: long }] },
        })}
      />,
    );
    const root = container.querySelector('[data-testid="sciencv-worksheet"]')!;
    expect(root.querySelector('[data-testid="ws-count-contribution.1"]')!.textContent).toContain(
      "over the NIH limit",
    );
  });

  it("leaves the tick off and sends no beacon when the clipboard rejects", async () => {
    const writeText = vi.fn<WriteText>(() => Promise.reject(new Error("denied")));
    const sendBeacon = vi.fn<SendBeacon>(() => true);
    vi.stubGlobal("navigator", { clipboard: { writeText }, sendBeacon });
    const { container } = render(<SciencvWorksheet {...props()} />);
    const root = container.querySelector('[data-testid="sciencv-worksheet"]')!;
    await act(async () => {
      fireEvent.click(root.querySelector('[data-testid="ws-copy-education"]')!);
    });
    expect(root.querySelector('[data-testid="ws-copy-education"]')!.textContent).not.toContain(
      "Copied",
    );
    expect(sendBeacon).not.toHaveBeenCalled();
  });
});

describe("SciencvWorksheet — PMID handoff", () => {
  it("copies comma-separated PMIDs per list and combined, skipping blanks", async () => {
    const { writeText } = stubNavigator();
    const { container } = render(<SciencvWorksheet {...props()} />);
    const root = container.querySelector('[data-testid="sciencv-worksheet"]')!;
    await act(async () => {
      fireEvent.click(root.querySelector('[data-testid="ws-copy-products.related.pmids"]')!);
    });
    expect(writeText).toHaveBeenLastCalledWith("11111111");
    await act(async () => {
      fireEvent.click(root.querySelector('[data-testid="ws-copy-products.all.pmids"]')!);
    });
    expect(writeText).toHaveBeenLastCalledWith("11111111, 22222222");
  });

  it("flags a product with no PMID and links a PubMed search over the rest", () => {
    stubNavigator();
    const { container } = render(<SciencvWorksheet {...props()} />);
    const root = container.querySelector('[data-testid="sciencv-worksheet"]')!;
    expect(root.querySelector('[data-testid="ws-product-nopmid-related-1"]')).not.toBeNull();
    expect(root.querySelector('[data-testid="ws-product-nopmid-related-0"]')).toBeNull();
    const related = root.querySelector('[data-testid="ws-products-related"]')!;
    const link = within(related as HTMLElement).getByRole("link", { name: /Open in PubMed/ });
    expect(link.getAttribute("href")).toBe(pubmedSearchUrl(["11111111"]));
  });
});

describe("SciencvWorksheet — honors picker", () => {
  const many = Array.from({ length: SCIENCV_HONORS_MAX + 2 }, (_, i) => ({
    name: `Honor ${i + 1}`,
    organization: "Org",
    year: 2026 - i,
  }));

  it("shows no picker at or under the cap", () => {
    stubNavigator();
    const { container } = render(<SciencvWorksheet {...props()} />);
    const root = container.querySelector('[data-testid="sciencv-worksheet"]')!;
    expect(root.querySelector('[data-testid="ws-block-honors"] input[type="checkbox"]')).toBeNull();
  });

  it("over the cap: the newest 15 are preselected, the rest disabled, and Copy takes the selection", async () => {
    const { writeText } = stubNavigator();
    const { container } = render(<SciencvWorksheet {...props({ honors: many })} />);
    const root = container.querySelector('[data-testid="sciencv-worksheet"]')!;
    const boxes = root.querySelectorAll<HTMLInputElement>(
      '[data-testid="ws-block-honors"] input[type="checkbox"]',
    );
    expect(boxes.length).toBe(SCIENCV_HONORS_MAX + 2);
    expect(boxes[0]!.checked).toBe(true);
    expect(boxes[SCIENCV_HONORS_MAX]!.checked).toBe(false);
    expect(boxes[SCIENCV_HONORS_MAX]!.disabled).toBe(true);
    // Uncheck one, and the 16th becomes selectable.
    fireEvent.click(boxes[0]!);
    expect(boxes[SCIENCV_HONORS_MAX]!.disabled).toBe(false);
    fireEvent.click(boxes[SCIENCV_HONORS_MAX]!);
    await act(async () => {
      fireEvent.click(root.querySelector('[data-testid="ws-copy-honors"]')!);
    });
    const copied = writeText.mock.calls.at(-1)![0].split("\n");
    expect(copied.length).toBe(SCIENCV_HONORS_MAX);
    expect(copied[0]).toBe(honorLine(many[1]!));
    expect(copied.at(-1)).toBe(honorLine(many[SCIENCV_HONORS_MAX]!));
  });
});

describe("SciencvWorksheet — plain-text lines", () => {
  it("formats each record the way it should paste", () => {
    expect(
      educationLine({ degree: "PhD", institution: "U", field: "Biostatistics", year: 2010 }),
    ).toBe("U — PhD, Biostatistics (2010)");
    expect(educationLine({ degree: "MD", institution: "U", field: null, year: null })).toBe(
      "U — MD",
    );
    expect(
      appointmentLine({
        title: "Professor",
        organization: "Dept",
        startDate: "2020-07-01",
        endDate: null,
      }),
    ).toBe("2020–present  Professor, Dept");
    expect(
      appointmentLine({
        title: "Fellow",
        organization: "Dept",
        startDate: null,
        endDate: "2015-06-30",
      }),
    ).toBe("?–2015  Fellow, Dept");
    expect(honorLine({ name: "Fellow", organization: "Soc", year: 2022 })).toBe(
      "2022  Fellow, Soc",
    );
    expect(honorLine({ name: "Fellow", organization: "Soc", year: null })).toBe("Fellow, Soc");
    expect(productCitation(product({ title: "Ends with a period." }))).toBe(
      "Ends with a period. J Test. 2024. PMID: 11111111",
    );
    expect(productCitation(product({ pmid: "", venue: null, year: null }))).toBe(
      "A grounded finding.",
    );
    expect(contributionText({ title: "", body: "Body" })).toBe("Body");
    expect(contributionText({ title: "T", body: "Body" })).toBe("T\n\nBody");
    expect(pubmedSearchUrl(["1", "2"])).toBe(
      "https://pubmed.ncbi.nlm.nih.gov/?term=1%5Bpmid%5D%20OR%202%5Bpmid%5D",
    );
  });
});
