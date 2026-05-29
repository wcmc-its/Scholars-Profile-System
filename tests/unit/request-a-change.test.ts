/**
 * `lib/edit/request-a-change.ts` — the per-item "Request a change" routing
 * config (#160 UI follow-up). Pins the three-shape model + the operator's
 * routing decisions so a future edit can't silently break them.
 */
import { describe, expect, it } from "vitest";

import {
  REQUEST_A_CHANGE,
  getChangeConfig,
  resolveSelfServiceHref,
  type RequestAttribute,
} from "@/lib/edit/request-a-change";

const ATTRS = Object.keys(REQUEST_A_CHANGE) as RequestAttribute[];

describe("REQUEST_A_CHANGE — structure", () => {
  it("covers the six attributes, each with a heading and ≥1 issue", () => {
    expect(ATTRS.sort()).toEqual(
      ["appointments", "education", "funding", "name-title", "photo", "publications"].sort(),
    );
    for (const a of ATTRS) {
      expect(REQUEST_A_CHANGE[a].heading.length).toBeGreaterThan(0);
      expect(REQUEST_A_CHANGE[a].issues.length).toBeGreaterThan(0);
    }
  });

  it("issue ids are globally unique", () => {
    const ids = ATTRS.flatMap((a) => REQUEST_A_CHANGE[a].issues.map((i) => i.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every action is one of the three shapes with its required fields", () => {
    for (const a of ATTRS) {
      for (const { label, action } of REQUEST_A_CHANGE[a].issues) {
        expect(label.length).toBeGreaterThan(0);
        if (action.kind === "self-service") {
          expect(action.href).toMatch(/^https:\/\//);
          expect(action.tool.length).toBeGreaterThan(0);
          expect(action.instruction.length).toBeGreaterThan(0);
        } else if (action.kind === "route") {
          expect(action.email).toMatch(/@/);
          expect(action.sourceSystem.length).toBeGreaterThan(0);
        } else {
          expect(action.detail.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("routes only ever target the three approved mailboxes", () => {
    const allowed = new Set([
      "support@med.cornell.edu",
      "facultyaffairs@med.cornell.edu",
      "osra-operations@med.cornell.edu",
    ]);
    for (const a of ATTRS) {
      for (const { action } of REQUEST_A_CHANGE[a].issues) {
        if (action.kind === "route") expect(allowed.has(action.email)).toBe(true);
      }
    }
  });
});

describe("operator routing decisions", () => {
  const issue = (attr: RequestAttribute, id: string) =>
    REQUEST_A_CHANGE[attr].issues.find((i) => i.id === id)!;

  it("publication 'not mine' is self-service into Publication Manager — never a Hide", () => {
    const a = issue("publications", "publication-not-mine").action;
    expect(a.kind).toBe("self-service");
    if (a.kind === "self-service") {
      expect(a.href).toBe("https://reciter.weill.cornell.edu/");
      expect(a.instruction.toLowerCase()).toContain("reject");
    }
  });

  it("funding 'wrongly listed' routes to OSRA (cc scholars), not Hide", () => {
    const a = issue("funding", "funding-not-mine").action;
    expect(a.kind).toBe("route");
    if (a.kind === "route") {
      expect(a.email).toBe("osra-operations@med.cornell.edu");
      expect(a.cc).toBe("scholars@weill.cornell.edu");
    }
  });

  it("funding 'active but expired' explains the NCE grace instead of routing", () => {
    const a = issue("funding", "funding-active-expired").action;
    expect(a.kind).toBe("explain");
    if (a.kind === "explain") expect(a.detail.toLowerCase()).toContain("grace");
  });

  it("non-PubMed missing publication explains it's unsupported (no route)", () => {
    const a = issue("publications", "publication-missing-nonpubmed").action;
    expect(a.kind).toBe("explain");
  });

  it("publication metadata routes to ITS support (operator decision #2)", () => {
    const a = issue("publications", "publication-metadata-wrong").action;
    expect(a.kind === "route" && a.email).toBe("support@med.cornell.edu");
  });

  it("degrees + education route to Faculty Affairs; appointments to support", () => {
    expect((issue("name-title", "degrees-wrong").action as { email?: string }).email).toBe(
      "facultyaffairs@med.cornell.edu",
    );
    expect((issue("education", "education-wrong").action as { email?: string }).email).toBe(
      "facultyaffairs@med.cornell.edu",
    );
    expect((issue("appointments", "appointment-title-wrong").action as { email?: string }).email).toBe(
      "support@med.cornell.edu",
    );
  });

  it("name / email / photo / ORCID are self-service", () => {
    for (const [attr, id] of [
      ["name-title", "name-wrong"],
      ["name-title", "email-wrong"],
      ["name-title", "orcid-wrong"],
      ["photo", "photo-wrong"],
    ] as const) {
      expect(issue(attr, id).action.kind).toBe("self-service");
    }
  });
});

describe("helpers", () => {
  it("getChangeConfig returns the attribute's config", () => {
    expect(getChangeConfig("funding")).toBe(REQUEST_A_CHANGE.funding);
  });

  it("resolveSelfServiceHref substitutes {cwid} (ORCID), leaves other hrefs alone", () => {
    expect(resolveSelfServiceHref("https://reciter.weill.cornell.edu/manageprofile/{cwid}", "abc1001")).toBe(
      "https://reciter.weill.cornell.edu/manageprofile/abc1001",
    );
    expect(resolveSelfServiceHref("https://directory.weill.cornell.edu/x", "abc1001")).toBe(
      "https://directory.weill.cornell.edu/x",
    );
  });
});
