/**
 * lib/edit/request-change.ts — server-side recipient resolution + body
 * composition for the "Request a change" mailer (#160 Phase 2). The recipient
 * comes from the trusted config, never the client (recipient-tampering guard).
 */
import { describe, expect, it } from "vitest";

import {
  composeBody,
  isRequestAttribute,
  resolveRequestChange,
  subjectFor,
} from "@/lib/edit/request-change";

describe("isRequestAttribute", () => {
  it("accepts known attributes and rejects anything else", () => {
    expect(isRequestAttribute("education")).toBe(true);
    expect(isRequestAttribute("funding")).toBe(true);
    expect(isRequestAttribute("salary")).toBe(false);
    expect(isRequestAttribute(42)).toBe(false);
    expect(isRequestAttribute(undefined)).toBe(false);
  });
});

describe("resolveRequestChange", () => {
  it("resolves a route issue to the owning office", () => {
    const r = resolveRequestChange("education", "education-wrong");
    expect(r).toMatchObject({
      kind: "send",
      to: "ofa@med.cornell.edu",
      office: "Office of Faculty Affairs",
      sourceSystem: "ASMS",
      attributeLabel: "Education",
    });
  });

  it("carries the cc for an OSRA funding route", () => {
    const r = resolveRequestChange("funding", "funding-wrong");
    expect(r).toMatchObject({
      kind: "send",
      to: "osra-operations@med.cornell.edu",
      cc: "scholars@weill.cornell.edu",
    });
  });

  it("resolves an explain issue's fallbackEmail (funding NCE window)", () => {
    const r = resolveRequestChange("funding", "funding-active-expired");
    expect(r).toMatchObject({ kind: "send", to: "osra-operations@med.cornell.edu" });
  });

  it("returns no-send for a self-service issue", () => {
    expect(resolveRequestChange("name-title", "name-wrong")).toEqual({ kind: "no-send" });
  });

  it("returns no-send for a pure explain (non-PubMed publication)", () => {
    expect(resolveRequestChange("publications", "publication-missing-nonpubmed")).toEqual({
      kind: "no-send",
    });
  });

  it("returns no-send for an unknown issue id", () => {
    expect(resolveRequestChange("education", "not-an-issue")).toEqual({ kind: "no-send" });
  });
});

describe("subjectFor", () => {
  it("is the fixed attribute-scoped subject", () => {
    expect(subjectFor("Education")).toBe("Scholars profile correction — Education");
  });
});

describe("composeBody", () => {
  it("renders the structured Issue/Item/Source block + detail + signature", () => {
    const body = composeBody({
      issueLabel: "A degree, field, institution, or year is wrong",
      itemLabel: "Ph.D., Stanford",
      sourceSystem: "ASMS",
      detail: "The year should be 2009.",
      actorCwid: "self01",
      targetCwid: "self01",
    });
    expect(body).toContain("Issue: A degree, field, institution, or year is wrong");
    expect(body).toContain("Item: Ph.D., Stanford");
    expect(body).toContain("Source: ASMS");
    expect(body).toContain("The year should be 2009.");
    expect(body).toContain("— Sent from the WCM Scholars profile editor by self01.");
  });

  it("falls back to placeholders for a section-level request with no detail", () => {
    const body = composeBody({
      issueLabel: "My title is wrong",
      sourceSystem: "primary appointment",
      actorCwid: "self01",
      targetCwid: "self01",
    });
    expect(body).toContain("Item: (whole section)");
    expect(body).toContain("(no additional detail provided)");
  });

  it("names the target when a superuser acts on another scholar", () => {
    const body = composeBody({
      issueLabel: "An academic appointment is missing",
      actorCwid: "adm001",
      targetCwid: "scholar9",
    });
    expect(body).toContain("by adm001 on behalf of scholar9.");
  });

  it("collapses CRLF in the single-line fields (header/format guard)", () => {
    const body = composeBody({
      issueLabel: "ok",
      itemLabel: "line1\r\nBcc: evil@example.com",
      actorCwid: "self01",
      targetCwid: "self01",
    });
    expect(body).toContain("Item: line1 Bcc: evil@example.com");
    expect(body).not.toContain("\r");
  });
});
