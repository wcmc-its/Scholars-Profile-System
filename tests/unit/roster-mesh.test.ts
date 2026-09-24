/**
 * Unit Page v2 — roster TOPICS chips loader (lib/api/roster-mesh.ts). One
 * OpenSearch `ids` query per roster page (never per row), explicit fail-fast
 * transport options, legacy `string[]` coercion, cap at 3, and a fail-soft
 * empty map on error. Fake cwids and generic MeSH labels only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const searchMock = vi.fn();
vi.mock("@/lib/search", () => ({
  PEOPLE_INDEX: "scholars-people",
  searchClient: () => ({ search: searchMock }),
}));

import {
  attachTopMesh,
  loadTopMeshForMembers,
  ROSTER_ROW_MESH_CAP,
  withTopMesh,
} from "@/lib/api/roster-mesh";

type SearchParams = {
  index: string;
  body: {
    query: { ids: { values: string[] } };
    _source: string[];
    size: number;
    track_total_hits: boolean;
  };
};

function respond(hits: Array<{ _id: string; _source?: Record<string, unknown> }>) {
  return { body: { hits: { hits } } };
}

const cwid = (i: number) => `tst${String(i).padStart(4, "0")}`;

describe("loadTopMeshForMembers", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    searchMock.mockReset();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it("makes no call for an empty cwid list", async () => {
    const out = await loadTopMeshForMembers([]);
    expect(out.size).toBe(0);
    expect(searchMock).not.toHaveBeenCalled();
  });

  it("issues exactly ONE ids query for a 20-member page, deduped + sorted", async () => {
    searchMock.mockResolvedValue(respond([]));
    const cwids = Array.from({ length: 20 }, (_, i) => cwid(20 - i));
    await loadTopMeshForMembers([...cwids, cwid(3)]);
    expect(searchMock).toHaveBeenCalledTimes(1);
    const [params, opts] = searchMock.mock.calls[0] as [SearchParams, Record<string, unknown>];
    expect(params.index).toBe("scholars-people");
    expect(params.body.query.ids.values).toEqual([...cwids].sort());
    expect(params.body._source).toEqual(["topMeshTerms"]);
    expect(params.body.size).toBe(20);
    expect(params.body.track_total_hits).toBe(false);
    expect(typeof opts.requestTimeout).toBe("number");
    expect(opts.maxRetries).toBe(0);
  });

  it("chunks more than 1000 ids into sequential queries of 1000", async () => {
    searchMock.mockResolvedValue(respond([]));
    await loadTopMeshForMembers(Array.from({ length: 1500 }, (_, i) => cwid(i)));
    expect(searchMock).toHaveBeenCalledTimes(2);
    const sizes = searchMock.mock.calls.map(
      (c) => (c[0] as SearchParams).body.query.ids.values.length,
    );
    expect(sizes).toEqual([1000, 500]);
  });

  it("maps _id to chips, caps at 3, coerces legacy strings, drops empty labels", async () => {
    searchMock.mockResolvedValue(
      respond([
        {
          _id: "tst0001",
          _source: {
            topMeshTerms: [
              { ui: "D000001", label: "Alpha" },
              { ui: "D000002", label: "" },
              { ui: "D000003", label: "Beta" },
              { ui: "D000004", label: "Gamma" },
              { ui: "D000005", label: "Delta" },
            ],
          },
        },
        { _id: "tst0002", _source: { topMeshTerms: ["Legacy term"] } },
        { _id: "tst0003", _source: {} },
      ]),
    );
    const out = await loadTopMeshForMembers(["tst0001", "tst0002", "tst0003"]);
    expect(ROSTER_ROW_MESH_CAP).toBe(3);
    expect(out.get("tst0001")).toEqual([
      { ui: "D000001", label: "Alpha" },
      { ui: "D000003", label: "Beta" },
      { ui: "D000004", label: "Gamma" },
    ]);
    expect(out.get("tst0002")).toEqual([{ ui: null, label: "Legacy term" }]);
    expect(out.has("tst0003")).toBe(false);
  });

  it("resolves to an empty map (no throw) and warns once on an OpenSearch error", async () => {
    searchMock.mockRejectedValue(new Error("connect ECONNREFUSED"));
    const out = await loadTopMeshForMembers(["tst0001"]);
    expect(out.size).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("withTopMesh / attachTopMesh", () => {
  beforeEach(() => searchMock.mockReset());

  it("leaves a hit's keys unchanged when it has no terms", () => {
    const hit = { cwid: "tst0009", preferredName: "Test Person" };
    const [out] = withTopMesh([hit], new Map());
    expect(Object.keys(out)).toEqual(["cwid", "preferredName"]);
  });

  it("attaches topMesh with one lookup and skips external members", async () => {
    searchMock.mockResolvedValue(
      respond([{ _id: "tst0001", _source: { topMeshTerms: [{ ui: "D000001", label: "Alpha" }] } }]),
    );
    const out = await attachTopMesh([
      { cwid: "tst0001" },
      { cwid: "ext0001", isExternal: true as const },
    ]);
    expect(searchMock).toHaveBeenCalledTimes(1);
    expect((searchMock.mock.calls[0][0] as SearchParams).body.query.ids.values).toEqual([
      "tst0001",
    ]);
    expect(out[0]).toEqual({ cwid: "tst0001", topMesh: [{ ui: "D000001", label: "Alpha" }] });
    expect(out[1]).not.toHaveProperty("topMesh");
  });
});
