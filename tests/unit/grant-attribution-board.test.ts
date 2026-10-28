/**
 * #3071 — the grant attribution board's pure parts: the evidence scale, the
 * row model for To review cards and decided rows, provenance and the decision
 * cell, and To review's filter and sort. Fixture people and awards are
 * invented.
 */
import { describe, expect, it } from "vitest";

import {
  decisionSummary,
  defaultSort,
  evidenceLevel,
  filterRows,
  fromQueueItem,
  levelTone,
  mainCue,
  provenance,
  scalePct,
  type BoardRow,
} from "@/lib/edit/grant-attribution-board";
import type { GrantAttributionItem } from "@/lib/edit/grant-attribution-queue";

const ITEM: GrantAttributionItem = {
  id: "rev-1",
  grantId: "reporter:zza0001:R01XX000001",
  unproven: false,
  cwid: "zza0001",
  slug: "pat-example",
  scholarName: "Pat Example, MD",
  scholarSurname: "Example",
  title: "Professor of Medicine",
  department: "Medicine",
  score: 0,
  band: "queue",
  cues: [
    { id: "middle_initial_conflict", weight: -1, reason: "initial" },
    { id: "prior_institution", weight: 2, reason: "trained" },
  ],
  award: {
    title: "A synthetic study",
    awardNumber: "5R01XX000001-02",
    coreProjectNum: "R01XX000001",
    activityCode: "R01",
    applId: 123,
    startYear: 2001,
    endYear: 2005,
    orgs: [{ name: "EXAMPLE UNIVERSITY", from: 2001, to: 2005 }],
    piNames: ["EXAMPLE, PAT Q", "SAMPLE, LEE"],
  },
  status: "pending",
  firstSeenAt: "2026-10-25T10:00:00.000Z",
  reopenedAt: null,
  decidedAt: null,
  decidedByName: null,
  rejectionReason: null,
  reporterName: "EXAMPLE, PAT Q",
  scholarNames: ["Pat Example"],
};

describe("the evidence scale", () => {
  it("reads the level off the score and which ways the cues point", () => {
    expect(evidenceLevel(2, [{ id: "pub_linked", weight: 4 }])).toBe("supports");
    // At the confirm line it supports, even with a cue against.
    expect(
      evidenceLevel(3, [
        { id: "pub_linked", weight: 6 },
        { id: "middle_initial_conflict", weight: -1 },
      ]),
    ).toBe("supports");
    expect(evidenceLevel(-1, [{ id: "name_rare", weight: 1 }])).toBe("leans-for");
    expect(
      evidenceLevel(0, [
        { id: "copi_coauthor", weight: 2 },
        { id: "middle_initial_conflict", weight: -1 },
      ]),
    ).toBe("mixed");
    expect(evidenceLevel(-2, [])).toBe("none");
    expect(evidenceLevel(-3, [{ id: "name_common", weight: -1 }])).toBe("against");
    expect(
      evidenceLevel(-6, [
        { id: "copi_coauthor", weight: 2 },
        { id: "timeline_impossible", weight: -6 },
      ]),
    ).toBe("against");
    // Above the hide line with only evidence against.
    expect(
      evidenceLevel(-1, [
        { id: "topic_mismatch", weight: 1 },
        { id: "x", weight: -2 },
      ]),
    ).toBe("mixed");
    expect(evidenceLevel(1, [{ id: "middle_initial_conflict", weight: -1 }])).toBe("leans-against");
    // Reviews stored before 2026-10-24 carry the named InfoEd cue at weight 0.
    expect(evidenceLevel(-2, [{ id: "infoed_other_wcm_pi_named", weight: 0 }])).toBe("against");
  });

  it("colors for slate, against amber, the rest neutral", () => {
    expect(levelTone("supports")).toBe("for");
    expect(levelTone("leans-for")).toBe("for");
    expect(levelTone("against")).toBe("against");
    expect(levelTone("leans-against")).toBe("against");
    expect(levelTone("mixed")).toBe("neutral");
    expect(levelTone("none")).toBe("neutral");
  });

  it("places the hide and confirm lines on a −8…+6 scale", () => {
    expect(scalePct(-2).toFixed(2)).toBe("42.86");
    expect(scalePct(2).toFixed(2)).toBe("71.43");
    expect(scalePct(-20)).toBe(2);
    expect(scalePct(20)).toBe(98);
  });

  it("defaults Confirmed to low to high, the others high to low", () => {
    expect(defaultSort("confirmed")).toBe("low");
    expect(defaultSort("pending")).toBe("high");
    expect(defaultSort("rejected")).toBe("high");
  });
});

describe("a To review card", () => {
  it("orders the cues strongest first and picks the main reason", () => {
    const row = fromQueueItem(ITEM, null);
    expect(row.cues.map((c) => c.id)).toEqual(["prior_institution", "middle_initial_conflict"]);
    expect(mainCue(row)?.id).toBe("prior_institution");
    expect(row.level).toBe("mixed");
    expect(row.scholar.sortName).toBe("Example, Pat");
    expect(row.scholar.sub).toBe("Professor of Medicine · Medicine");
  });

  it("is new or reopened only after the previous run ended", () => {
    const since = "2026-10-20T00:00:00.000Z";
    expect(fromQueueItem(ITEM, since).changed).toBe("new");
    expect(fromQueueItem(ITEM, "2026-10-26T00:00:00.000Z").changed).toBeNull();
    expect(fromQueueItem({ ...ITEM, reopenedAt: "2026-10-25T11:00:00.000Z" }, since).changed).toBe(
      "reopened",
    );
    // An Unproven award's date is its latest scoring: never "new".
    expect(fromQueueItem({ ...ITEM, unproven: true, id: ITEM.grantId }, since).changed).toBeNull();
    expect(provenance(fromQueueItem(ITEM, since))).toBe("New this run");
  });

  it("says it is off the profile, and how a nothing-found award moves on its own", () => {
    expect(decisionSummary(fromQueueItem(ITEM, null))).toEqual({
      title: "Not decided",
      note: "Off the profile until a curator decides.",
    });
    expect(decisionSummary(fromQueueItem({ ...ITEM, cues: [], score: -2 }, null)).note).toBe(
      "Off the profile. Rechecked weekly; moves to Confirmed on its own if evidence turns up.",
    );
    expect(
      decisionSummary(
        fromQueueItem(
          {
            ...ITEM,
            reopenedAt: "2026-10-25T11:00:00.000Z",
            decidedAt: "2026-10-01T00:00:00.000Z",
            decidedByName: "Kim Curator",
          },
          null,
        ),
      ).note,
    ).toBe(
      "Reopened: the evidence changed after a decision by Kim Curator, which stands until this is decided again.",
    );
  });
});

describe("a decided row", () => {
  const base = fromQueueItem(ITEM, null);
  const decided = (over: Partial<BoardRow>): BoardRow => ({
    ...base,
    tab: "confirmed",
    by: "auto",
    ...over,
  });

  it("names who placed it and when, quietly", () => {
    expect(provenance(decided({ when: "2026-10-23T12:00:00.000Z", was: "hidden" }))).toBe(
      "Automatic · Oct 23 · was hidden",
    );
    expect(provenance(decided({ by: "curator", when: "2026-10-28T12:00:00.000Z" }))).toBe(
      "Curator · Oct 28",
    );
    expect(provenance(decided({ when: null, stillHidden: true }))).toBe(
      "Automatic · still hidden until the next run",
    );
  });

  it("says what can still move it", () => {
    expect(decisionSummary(decided({ when: "2026-10-27T12:00:00.000Z" }))).toEqual({
      title: "Confirmed automatically · Oct 27",
      note: "On the profile. Can move if the weekly check finds evidence against.",
    });
    expect(
      decisionSummary(
        decided({
          tab: "rejected",
          by: "curator",
          decidedByName: "Kim Curator",
          rejectionReason: "Outside the scholar's career",
          when: "2026-10-28T12:00:00.000Z",
        }),
      ),
    ).toEqual({
      title: "Marked not this person by Kim Curator · Oct 28",
      note: "Off the profile. Reason: Outside the scholar's career. Won’t change on its own.",
    });
    expect(decisionSummary(decided({ tab: "rejected", when: null })).note).toBe(
      "Off the profile. Can move if the weekly check finds evidence for.",
    );
  });

  it("takes the main reason from the side that placed it", () => {
    expect(mainCue(decided({ tab: "rejected" }))?.id).toBe("middle_initial_conflict");
    expect(mainCue(decided({ tab: "confirmed" }))?.id).toBe("prior_institution");
  });
});

describe("To review's filters", () => {
  const rows: BoardRow[] = [
    fromQueueItem(ITEM, "2026-10-20T00:00:00.000Z"),
    fromQueueItem(
      {
        ...ITEM,
        id: "rev-2",
        scholarName: "Lee Sample, PhD",
        score: -2,
        cues: [],
        firstSeenAt: "2026-10-01T00:00:00.000Z",
        award: { ...ITEM.award, title: "Another study", piNames: ["SAMPLE, LEE"] },
        reporterName: "SAMPLE, LEE",
      },
      "2026-10-20T00:00:00.000Z",
    ),
  ];
  const base = { q: "", level: "all", by: "all", changed: false, sort: "high" } as const;

  it("filters by search, level and change, and sorts", () => {
    expect(filterRows(rows, base).map((r) => r.id)).toEqual(["rev-1", "rev-2"]);
    expect(filterRows(rows, { ...base, sort: "low" }).map((r) => r.id)).toEqual(["rev-2", "rev-1"]);
    expect(filterRows(rows, { ...base, sort: "name" }).map((r) => r.id)).toEqual([
      "rev-1",
      "rev-2",
    ]);
    expect(filterRows(rows, { ...base, level: "none" }).map((r) => r.id)).toEqual(["rev-2"]);
    expect(filterRows(rows, { ...base, changed: true }).map((r) => r.id)).toEqual(["rev-1"]);
    expect(filterRows(rows, { ...base, q: "another" }).map((r) => r.id)).toEqual(["rev-2"]);
    // PIs as RePORTER prints them are searchable.
    expect(filterRows(rows, { ...base, q: "example, pat" }).map((r) => r.id)).toEqual(["rev-1"]);
  });
});
