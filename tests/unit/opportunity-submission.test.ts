/**
 * Opportunity URL intake — lib units (`docs/opportunity-url-intake-spec.md`):
 *  - normalizeOpportunityUrl: https-only + canonicalization (the dedup key);
 *  - findDuplicate: corpus (raw-stored URLs) + queue layers, rejected items
 *    never block a resubmit;
 *  - putSubmission / listSubmissions: the SUBMISSION item contract shared with
 *    ReciterAI's drain (constant PK, time-ordered SK, snake_case attributes,
 *    collision condition) and the defensive read-side mapping.
 */
import { describe, expect, it, vi } from "vitest";

import {
  deleteSubmission,
  findDuplicate,
  getSubmission,
  isConditionalCheckFailed,
  isOpportunityIntakeEnabled,
  listSubmissions,
  normalizeOpportunityUrl,
  putSubmission,
  SUBMISSION_PK,
  suppressSubmission,
  type OpportunitySubmission,
} from "@/lib/edit/opportunity-submission";

describe("isOpportunityIntakeEnabled", () => {
  it("is on only for the literal 'on'", () => {
    expect(isOpportunityIntakeEnabled({ OPPORTUNITY_URL_INTAKE: "on" })).toBe(true);
    expect(isOpportunityIntakeEnabled({ OPPORTUNITY_URL_INTAKE: "true" })).toBe(false);
    expect(isOpportunityIntakeEnabled({})).toBe(false);
  });
});

describe("normalizeOpportunityUrl", () => {
  it("requires https", () => {
    expect(normalizeOpportunityUrl("http://skincancer.org/grants")).toEqual({
      ok: false,
      error: "https_required",
    });
    expect(normalizeOpportunityUrl("ftp://skincancer.org")).toEqual({
      ok: false,
      error: "https_required",
    });
  });

  it("rejects non-URLs, the empty string, and over-long input", () => {
    expect(normalizeOpportunityUrl("not a url")).toEqual({ ok: false, error: "invalid_url" });
    expect(normalizeOpportunityUrl("  ")).toEqual({ ok: false, error: "invalid_url" });
    expect(normalizeOpportunityUrl(`https://x.org/${"a".repeat(512)}`)).toEqual({
      ok: false,
      error: "invalid_url",
    });
  });

  it("canonicalizes host case, fragment, tracking params, and trailing slash", () => {
    const result = normalizeOpportunityUrl(
      "https://WWW.SkinCancer.org/about-us/research-grants/?utm_source=x&utm_campaign=y&fbclid=z#apply",
    );
    expect(result).toEqual({
      ok: true,
      normalized: "https://www.skincancer.org/about-us/research-grants",
    });
  });

  it("keeps meaningful query params and the root path", () => {
    expect(normalizeOpportunityUrl("https://grants.gov/search?oppId=359855&utm_medium=m")).toEqual(
      { ok: true, normalized: "https://grants.gov/search?oppId=359855" },
    );
    expect(normalizeOpportunityUrl("https://skincancer.org/")).toEqual({
      ok: true,
      normalized: "https://skincancer.org/",
    });
  });

  it("gives identical output for URL variants of the same page (the dedup key)", () => {
    const a = normalizeOpportunityUrl("https://skincancer.org/about-us/research-grants/");
    const b = normalizeOpportunityUrl("https://SKINCANCER.ORG/about-us/research-grants#top");
    expect(a).toEqual(b);
  });
});

function submission(overrides: Partial<OpportunitySubmission>): OpportunitySubmission {
  return {
    submissionId: "2026-07-06T12:00:00.000Z#ab12cd34",
    url: "https://x.org/grants",
    normalizedUrl: "https://x.org/grants",
    note: null,
    submittedBy: "flm4001",
    submittedAt: "2026-07-06T12:00:00.000Z",
    status: "pending",
    processedAt: null,
    producedOpportunityIds: [],
    rejectReason: null,
    ...overrides,
  };
}

describe("findDuplicate", () => {
  const corpus = [
    // stored raw — normalization must happen on the corpus side at compare time
    {
      opportunityId: "wcm_curated:hartwell-abc123",
      title: "Hartwell Award",
      sourceUrl: "https://WWW.hartwell.org/award/?utm_source=nl",
    },
  ];

  it("matches a corpus row whose raw URL normalizes to the submitted one", () => {
    const result = findDuplicate("https://www.hartwell.org/award", corpus, []);
    expect(result.opportunity).toEqual({
      opportunityId: "wcm_curated:hartwell-abc123",
      title: "Hartwell Award",
    });
    expect(result.submission).toBeNull();
  });

  it("matches pending and processed submissions but never rejected or suppressed ones", () => {
    const url = "https://x.org/grants";
    expect(
      findDuplicate(url, [], [submission({ status: "pending" })]).submission?.status,
    ).toBe("pending");
    expect(
      findDuplicate(url, [], [submission({ status: "processed" })]).submission?.status,
    ).toBe("processed");
    expect(findDuplicate(url, [], [submission({ status: "rejected" })]).submission).toBeNull();
    // suppression means "this was a mistake" — a deliberate resubmit must work
    expect(findDuplicate(url, [], [submission({ status: "suppressed" })]).submission).toBeNull();
  });

  it("returns empty-handed on a fresh URL", () => {
    expect(findDuplicate("https://fresh.org/rfa", corpus, [submission({})])).toEqual({
      opportunity: null,
      submission: null,
    });
  });
});

describe("putSubmission", () => {
  it("writes the SUBMISSION item contract (constant PK, time-ordered SK, snake_case)", async () => {
    const send = vi.fn().mockResolvedValue({});
    const now = new Date("2026-07-06T12:00:00.000Z");
    const result = await putSubmission(
      {
        url: "https://x.org/grants",
        normalizedUrl: "https://x.org/grants",
        note: "for Dr. A",
        submittedBy: "flm4001",
      },
      { ddb: { send }, now },
    );

    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0][0];
    expect(command.input.Item).toMatchObject({
      PK: SUBMISSION_PK,
      url: "https://x.org/grants",
      normalized_url: "https://x.org/grants",
      note: "for Dr. A",
      submitted_by: "flm4001",
      submitted_at: "2026-07-06T12:00:00.000Z",
      status: "pending",
    });
    expect(command.input.Item.SK).toMatch(/^2026-07-06T12:00:00\.000Z#[0-9a-f]{8}$/);
    expect(command.input.ConditionExpression).toBe("attribute_not_exists(SK)");
    expect(result.submissionId).toBe(command.input.Item.SK);
    expect(result.status).toBe("pending");
  });

  it("propagates a DynamoDB failure (the route maps it to 502)", async () => {
    const send = vi.fn().mockRejectedValue(new Error("denied"));
    await expect(
      putSubmission(
        { url: "https://x.org", normalizedUrl: "https://x.org", note: null, submittedBy: "a" },
        { ddb: { send } },
      ),
    ).rejects.toThrow("denied");
  });
});

describe("listSubmissions", () => {
  it("queries the SUBMISSION partition newest-first and maps drain-written fields", async () => {
    const send = vi.fn().mockResolvedValue({
      Items: [
        {
          PK: SUBMISSION_PK,
          SK: "2026-07-07T09:00:00.000Z#11111111",
          url: "https://y.org/rfa",
          normalized_url: "https://y.org/rfa",
          submitted_by: "flm4001",
          submitted_at: "2026-07-07T09:00:00.000Z",
          status: "processed",
          processed_at: "2026-07-08T02:00:00.000Z",
          produced_opportunity_ids: ["manual_url:y-award-abc123", 42],
        },
        {
          PK: SUBMISSION_PK,
          SK: "2026-07-06T12:00:00.000Z#22222222",
          url: "https://x.org/grants",
          normalized_url: "https://x.org/grants",
          submitted_by: "paa2013",
          submitted_at: "2026-07-06T12:00:00.000Z",
          status: "garbage-from-elsewhere",
        },
      ],
    });
    const result = await listSubmissions({ ddb: { send } });

    const query = send.mock.calls[0][0];
    expect(query.input.KeyConditionExpression).toBe("PK = :pk");
    expect(query.input.ExpressionAttributeValues).toEqual({ ":pk": SUBMISSION_PK });
    expect(query.input.ScanIndexForward).toBe(false);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      submissionId: "2026-07-07T09:00:00.000Z#11111111",
      status: "processed",
      processedAt: "2026-07-08T02:00:00.000Z",
      // non-string array entries are dropped, not crashed on
      producedOpportunityIds: ["manual_url:y-award-abc123"],
    });
    // an unknown status degrades to pending rather than lying about an outcome
    expect(result[1].status).toBe("pending");
  });

  it("maps the SPS-written suppressed status through", async () => {
    const send = vi.fn().mockResolvedValue({
      Items: [
        {
          PK: SUBMISSION_PK,
          SK: "2026-07-07T09:00:00.000Z#33333333",
          url: "https://z.org/rfa",
          status: "suppressed",
        },
      ],
    });
    const result = await listSubmissions({ ddb: { send } });
    expect(result[0].status).toBe("suppressed");
  });
});

describe("getSubmission", () => {
  it("targets one sort key with a Query (stays inside the LeadingKeys pin)", async () => {
    const send = vi.fn().mockResolvedValue({
      Items: [
        {
          PK: SUBMISSION_PK,
          SK: "2026-07-06T12:00:00.000Z#ab12cd34",
          url: "https://x.org/grants",
          status: "pending",
        },
      ],
    });
    const result = await getSubmission("2026-07-06T12:00:00.000Z#ab12cd34", { ddb: { send } });

    const query = send.mock.calls[0][0];
    expect(query.input.KeyConditionExpression).toBe("PK = :pk AND SK = :sk");
    expect(query.input.ExpressionAttributeValues).toEqual({
      ":pk": SUBMISSION_PK,
      ":sk": "2026-07-06T12:00:00.000Z#ab12cd34",
    });
    expect(result?.status).toBe("pending");
  });

  it("returns null for a missing item", async () => {
    const send = vi.fn().mockResolvedValue({ Items: [] });
    expect(await getSubmission("nope", { ddb: { send } })).toBeNull();
  });
});

describe("deleteSubmission", () => {
  it("Deletes the item, condition-pinned to pending/rejected", async () => {
    const send = vi.fn().mockResolvedValue({});
    await deleteSubmission("2026-07-06T12:00:00.000Z#ab12cd34", { ddb: { send } });

    const command = send.mock.calls[0][0];
    expect(command.input.Key).toEqual({
      PK: SUBMISSION_PK,
      SK: "2026-07-06T12:00:00.000Z#ab12cd34",
    });
    expect(command.input.ConditionExpression).toBe(
      "attribute_exists(SK) AND #s IN (:pending, :rejected)",
    );
    expect(command.input.ExpressionAttributeNames).toEqual({ "#s": "status" });
  });

  it("propagates a DynamoDB failure", async () => {
    const send = vi.fn().mockRejectedValue(new Error("denied"));
    await expect(deleteSubmission("sk", { ddb: { send } })).rejects.toThrow("denied");
  });
});

describe("suppressSubmission", () => {
  it("sets status/suppressed_at/suppressed_by, condition-pinned to processed", async () => {
    const send = vi.fn().mockResolvedValue({});
    const now = new Date("2026-07-09T15:00:00.000Z");
    await suppressSubmission(
      "2026-07-06T12:00:00.000Z#ab12cd34",
      { suppressedBy: "flm4001" },
      { ddb: { send }, now },
    );

    const command = send.mock.calls[0][0];
    expect(command.input.UpdateExpression).toBe(
      "SET #s = :suppressed, suppressed_at = :at, suppressed_by = :by",
    );
    expect(command.input.ConditionExpression).toBe("attribute_exists(SK) AND #s = :processed");
    expect(command.input.ExpressionAttributeValues).toEqual({
      ":suppressed": "suppressed",
      ":processed": "processed",
      ":at": "2026-07-09T15:00:00.000Z",
      ":by": "flm4001",
    });
  });
});

describe("isConditionalCheckFailed", () => {
  it("recognizes only the conditional-check error name", () => {
    const conditional = new Error("The conditional request failed");
    conditional.name = "ConditionalCheckFailedException";
    expect(isConditionalCheckFailed(conditional)).toBe(true);
    expect(isConditionalCheckFailed(new Error("denied"))).toBe(false);
    expect(isConditionalCheckFailed("string")).toBe(false);
  });
});
