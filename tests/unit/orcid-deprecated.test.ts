/**
 * Deprecated (merged) ORCID records. ORCID answers a deprecated iD with a 3xx
 * that names the primary iD; `fetch` used to follow it, so the deprecated iD was
 * scored with the primary's emails, affiliations and works (prod 2026-10-25:
 * 0000-0002-7215-6827 showed "Verified email" from its primary's record).
 * Covers the redirect parse, `orcidGet` refusing to follow, and the evidence
 * ETL moving each pair to the primary iD. Ids are from that prod case.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { substituteDeprecated } from "@/etl/orcid-evidence/index";
import {
  fetchRecord,
  OrcidDeprecatedError,
  OrcidHttpError,
  primaryFromRedirect,
} from "@/etl/orcid-registry/orcid-api";

const DEPRECATED = "0000-0002-7215-6827";
const PRIMARY = "0000-0003-2907-6175";
const BODY = JSON.stringify({
  "response-code": 301,
  "developer-message": `301 Moved Permanently: This account is deprecated. Please refer to account: https://orcid.org/${PRIMARY}. ORCID https://orcid.org/${DEPRECATED}`,
  "error-code": 9007,
});

describe("primaryFromRedirect", () => {
  it("takes the primary from the body, skipping the requested iD", () => {
    expect(
      primaryFromRedirect(`https://pub.orcid.org/v3.0/${DEPRECATED}/record`, null, BODY),
    ).toEqual({ deprecated: DEPRECATED, primary: PRIMARY });
  });

  it("prefers the Location header when it names another iD", () => {
    expect(
      primaryFromRedirect(
        `https://pub.orcid.org/v3.0/${DEPRECATED}/record`,
        `https://pub.orcid.org/v3.0/${PRIMARY}/record`,
        "",
      ),
    ).toEqual({ deprecated: DEPRECATED, primary: PRIMARY });
  });

  it("returns a null primary when nothing but the requested iD appears", () => {
    expect(
      primaryFromRedirect(
        `https://pub.orcid.org/v3.0/${DEPRECATED}/record`,
        null,
        `see ${DEPRECATED}`,
      ),
    ).toEqual({ deprecated: DEPRECATED, primary: null });
  });
});

describe("fetchRecord on a deprecated iD", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("does not follow the redirect and throws OrcidDeprecatedError with the primary", async () => {
    const fetchMock = vi.fn(async () => new Response(BODY, { status: 301 }));
    vi.stubGlobal("fetch", fetchMock);
    const err = await fetchRecord(DEPRECATED).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrcidDeprecatedError);
    expect(err).toBeInstanceOf(OrcidHttpError);
    expect((err as OrcidDeprecatedError).primary).toBe(PRIMARY);
    expect((err as OrcidDeprecatedError).status).toBe(301);
    expect(fetchMock).toHaveBeenCalledTimes(1); // not retried
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.redirect).toBe("manual");
  });
});

describe("substituteDeprecated", () => {
  const dep = new Map<string, string | null>([[DEPRECATED, PRIMARY]]);

  it("moves the pair to the primary iD", () => {
    const r = substituteDeprecated([{ cwid: "esc4003", orcid: DEPRECATED }], dep, new Set());
    expect(r).toEqual({ pairs: [{ cwid: "esc4003", orcid: PRIMARY }], replaced: 1, dropped: 0 });
  });

  it("does not duplicate a primary that is already a candidate", () => {
    const r = substituteDeprecated(
      [
        { cwid: "esc4003", orcid: DEPRECATED },
        { cwid: "esc4003", orcid: PRIMARY },
      ],
      dep,
      new Set(),
    );
    expect(r.pairs).toEqual([{ cwid: "esc4003", orcid: PRIMARY }]);
  });

  it("drops the pair when the scholar dismissed the primary", () => {
    const r = substituteDeprecated(
      [{ cwid: "esc4003", orcid: DEPRECATED }],
      dep,
      new Set([`esc4003|${PRIMARY}`]),
    );
    expect(r).toEqual({ pairs: [], replaced: 0, dropped: 1 });
  });

  it("drops a deprecated iD with no named primary, or whose primary is deprecated too", () => {
    const none = substituteDeprecated(
      [{ cwid: "a", orcid: DEPRECATED }],
      new Map([[DEPRECATED, null]]),
      new Set(),
    );
    expect(none.pairs).toEqual([]);
    const chain = substituteDeprecated(
      [{ cwid: "a", orcid: DEPRECATED }],
      new Map<string, string | null>([
        [DEPRECATED, PRIMARY],
        [PRIMARY, "0000-0002-1825-0097"],
      ]),
      new Set(),
    );
    expect(chain.pairs).toEqual([]);
  });

  it("leaves pairs with live iDs untouched", () => {
    const live = { cwid: "b", orcid: "0000-0002-1825-0097" };
    expect(substituteDeprecated([live], dep, new Set()).pairs).toEqual([live]);
  });
});
