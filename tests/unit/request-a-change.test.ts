/**
 * `lib/edit/request-a-change.ts` — the "Request a Change" routing config
 * (#160 UI follow-up). Structural invariants the picker UI relies on, so a
 * future D6 edit (filling destinations) can't silently break the shape.
 */
import { describe, expect, it } from "vitest";

import {
  REQUEST_A_CHANGE,
  getChangeConfig,
  isRouteResolved,
  type RequestAttribute,
} from "@/lib/edit/request-a-change";

const ATTRS = Object.keys(REQUEST_A_CHANGE) as RequestAttribute[];

describe("REQUEST_A_CHANGE — structure", () => {
  it("covers the six editor attributes", () => {
    expect(ATTRS.sort()).toEqual(
      ["appointments", "education", "funding", "name-title", "photo", "publications"].sort(),
    );
  });

  it("every attribute has a heading and at least one issue", () => {
    for (const attr of ATTRS) {
      const cfg = REQUEST_A_CHANGE[attr];
      expect(cfg.heading.length).toBeGreaterThan(0);
      expect(cfg.issues.length).toBeGreaterThan(0);
    }
  });

  it("issue ids are globally unique (they map 1:1 to D6 scenarios)", () => {
    const ids = ATTRS.flatMap((a) => REQUEST_A_CHANGE[a].issues.map((i) => i.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every request issue has office + sourceSystem + destination; every hide issue has a note", () => {
    for (const attr of ATTRS) {
      for (const issue of REQUEST_A_CHANGE[attr].issues) {
        expect(issue.label.length).toBeGreaterThan(0);
        if (issue.action.kind === "request") {
          expect(issue.action.route.office.length).toBeGreaterThan(0);
          expect(issue.action.route.sourceSystem.length).toBeGreaterThan(0);
          expect(issue.action.route.destination).toBeDefined();
        } else {
          expect(issue.action.note.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("read-only attributes (name-title, photo) offer only 'request' issues — no Hide", () => {
    for (const attr of ["name-title", "photo"] as const) {
      expect(REQUEST_A_CHANGE[attr].issues.every((i) => i.action.kind === "request")).toBe(true);
    }
  });

  it("editable attributes each steer at least one issue to in-app Hide", () => {
    for (const attr of ["education", "appointments", "funding", "publications"] as const) {
      expect(REQUEST_A_CHANGE[attr].issues.some((i) => i.action.kind === "hide")).toBe(true);
    }
  });
});

describe("helpers", () => {
  it("getChangeConfig returns the attribute's config", () => {
    expect(getChangeConfig("funding")).toBe(REQUEST_A_CHANGE.funding);
  });

  it("isRouteResolved is false while destinations are pending (pre-D6)", () => {
    // The whole map ships pending — every request route is unresolved today.
    const allRequestRoutes = ATTRS.flatMap((a) =>
      REQUEST_A_CHANGE[a].issues
        .filter((i) => i.action.kind === "request")
        .map((i) => (i.action as { kind: "request"; route: Parameters<typeof isRouteResolved>[0] }).route),
    );
    expect(allRequestRoutes.every((r) => !isRouteResolved(r))).toBe(true);
  });

  it("isRouteResolved is true for a supplied destination", () => {
    expect(
      isRouteResolved({ office: "OSRA", sourceSystem: "InfoEd", destination: { type: "email", address: "x@y.edu" } }),
    ).toBe(true);
  });
});
