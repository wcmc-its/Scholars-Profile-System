/** lib/edit/servicenow.ts — config gate + the token-then-create exchange (#520). */
import { afterEach, describe, expect, it, vi } from "vitest";

import { createScholarProfileRequest, serviceNowConfig } from "@/lib/edit/servicenow";
import { REQUEST_A_CHANGE, REQUEST_DETAIL_MAX } from "@/lib/edit/request-a-change";
import { composeBody, resolveRequestChange } from "@/lib/edit/request-change";

const ENV = {
  REQUEST_CHANGE_SERVICENOW: "on",
  SERVICENOW_BASE: "https://example.service-now.com/",
  SERVICENOW_CLIENT_ID: "id",
  SERVICENOW_CLIENT_SECRET: "s3cret",
};
const CFG = serviceNowConfig(ENV)!;
const REQ = {
  requestType: "option_change" as const,
  requestor: "abc1001",
  details: "line 1\nline 2",
  watchList: ["adm001"],
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const TOKEN = () => json(200, { access_token: "tok", expires_in: 1799 });
const CREATED = { result: { Message: "ok", Request: "REQ0000001", RITM: "RITM0000002" } };

function stub(...responses: Response[]) {
  const fn = vi.fn<typeof fetch>();
  for (const r of responses) fn.mockResolvedValueOnce(r);
  vi.stubGlobal("fetch", fn);
  return fn;
}
afterEach(() => vi.unstubAllGlobals());

describe("serviceNowConfig", () => {
  it("is null when off, incomplete, or pointed at a non-ServiceNow host", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(CFG.base).toBe("https://example.service-now.com");
    expect(serviceNowConfig({ ...ENV, REQUEST_CHANGE_SERVICENOW: "off" })).toBeNull();
    expect(log).not.toHaveBeenCalled(); // off is not a misconfiguration
    expect(serviceNowConfig({ ...ENV, SERVICENOW_CLIENT_SECRET: "" })).toBeNull();
    for (const SERVICENOW_BASE of [
      "http://example.service-now.com",
      "https://example.com",
      "https://example.service-now.com.evil.com",
      "https://evil.com/.service-now.com",
    ]) {
      expect(serviceNowConfig({ ...ENV, SERVICENOW_BASE })).toBeNull();
    }
    expect(log).toHaveBeenCalledTimes(5);
    expect(JSON.stringify(log.mock.calls)).not.toContain("s3cret");
    log.mockRestore();
  });
});

describe("createScholarProfileRequest", () => {
  it("gets a token, then files the request and returns both numbers", async () => {
    const fn = stub(TOKEN(), json(200, CREATED));
    expect(await createScholarProfileRequest(CFG, REQ)).toEqual({
      request: "REQ0000001",
      ritm: "RITM0000002",
    });
    expect(String(fn.mock.calls[0][0])).toBe("https://example.service-now.com/oauth_token.do");
    expect(Object.fromEntries(fn.mock.calls[0][1]!.body as URLSearchParams)).toEqual({
      grant_type: "client_credentials",
      client_id: "id",
      client_secret: "s3cret",
    });
    for (const [, i] of fn.mock.calls) expect(i!.signal).toBeInstanceOf(AbortSignal);
    const init = fn.mock.calls[1][1]!;
    expect(init.redirect).toBe("error");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body as string)).toEqual({
      request_type: "option_change",
      requestor: "abc1001",
      details: "line 1\nline 2",
      watch_list: "adm001",
    });
  });

  it("sends the request type it was given", async () => {
    const fn = stub(TOKEN(), json(200, CREATED));
    await createScholarProfileRequest(CFG, { ...REQ, requestType: "option_general" });
    expect(JSON.parse(fn.mock.calls[1][1]!.body as string).request_type).toBe("option_general");
  });

  it("omits watch_list when the scholar files for themselves", async () => {
    const fn = stub(TOKEN(), json(200, CREATED));
    await createScholarProfileRequest(CFG, { ...REQ, watchList: [] });
    expect(JSON.parse(fn.mock.calls[1][1]!.body as string)).not.toHaveProperty("watch_list");
  });

  it("throws ServiceNow's reason on a 400, without retrying", async () => {
    const fn = stub(
      TOKEN(),
      json(400, { error: { message: "Bad Request", detail: "CWID is invalid" }, status: "failure" }),
    );
    await expect(createScholarProfileRequest(CFG, REQ)).rejects.toThrow(/400: CWID is invalid/);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws on a rejected token and never leaks the secret", async () => {
    const fn = stub(json(401, { error: "server_error", error_description: "access_denied" }));
    const err = await createScholarProfileRequest(CFG, REQ).catch((e: Error) => e);
    expect((err as Error).message).toContain("access_denied");
    expect((err as Error).message).not.toContain("s3cret");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("throws when a 200 lacks the RITM, or the body isn't JSON", async () => {
    stub(TOKEN(), json(200, { result: { Message: "ok", Request: "REQ0000001" } }));
    await expect(createScholarProfileRequest(CFG, REQ)).rejects.toThrow(/RITM missing/);
    stub(TOKEN(), new Response("<html>", { status: 200 }));
    await expect(createScholarProfileRequest(CFG, REQ)).rejects.toThrow();
  });

  it("refuses over-long details before any network call", async () => {
    const fn = stub();
    await expect(
      createScholarProfileRequest(CFG, { ...REQ, details: "x".repeat(4001) }),
    ).rejects.toThrow(/too long/);
    expect(fn).not.toHaveBeenCalled();
  });
});

it("every ITS Support issue fits 4,000 characters with the longest detail and a long item", () => {
  let ticketable = 0;
  for (const [attribute, cfg] of Object.entries(REQUEST_A_CHANGE)) {
    for (const issue of cfg.issues) {
      const r = resolveRequestChange(attribute as keyof typeof REQUEST_A_CHANGE, issue.id);
      if (r.kind !== "send" || !r.ticketable) continue;
      ticketable++;
      const body = composeBody({
        attribute: attribute as keyof typeof REQUEST_A_CHANGE,
        targetCwid: "abcdefgh1001",
        targetName: "N".repeat(120),
        issueLabel: r.issueLabel,
        itemLabel: "i".repeat(700),
        sourceSystem: r.sourceSystem,
        detail: "d".repeat(REQUEST_DETAIL_MAX),
        actorCwid: "adm001",
        actorName: "A".repeat(120),
      });
      expect(body.length).toBeLessThanOrEqual(4000);
    }
  }
  expect(ticketable).toBe(18);
});
