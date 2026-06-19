"use client";

/**
 * Cancer Center collaboration network — interactive tab (#1137).
 *
 * Fetches the whole graph payload once from the uncacheable route, lazily loads
 * `vis-network` (kept off the center page's initial bundle), and rebuilds the
 * DataSets in the browser on every control change via the pure helpers in
 * `lib/center-collaboration/graph.ts`. Controls: people↔program view, an axis
 * toggle (Publications / Grants / Both — #1137 Phase 2), program picker (one
 * program at a time), min co-pubs, year range, person search, hide-unconnected,
 * labels, down-weight-large-papers, re-layout, export PNG / standalone HTML. The
 * layout freezes once it settles (no perpetual jiggle).
 *
 * See `docs/cancer-center-collaboration-network-spec.md` §6 and
 * `docs/grant-coinvestigator-axis-handoff.md` §6.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Network as VisNetwork,
  Node as VisNode,
  Edge as VisEdge,
  Options,
} from "vis-network";
import type { DataSet } from "vis-data";
import { profilePath } from "@/lib/profile-url";
import {
  buildPeopleEdges,
  buildProgramEdges,
  countOmittedHyperauthored,
  nodeRadius,
  programKey,
  yearExtent,
  type EdgeBuildOptions,
} from "@/lib/center-collaboration/graph";
import {
  awardYearExtent,
  countUmbrellaExcluded,
  filterAwards,
  mergeAxisEdgesThresholded,
  type Relationship,
} from "@/lib/center-collaboration/grants";
import type { CenterCollaborationPayload } from "@/lib/center-collaboration/types";

type NodeItem = VisNode & { id: string | number };
type EdgeItem = VisEdge & { id: string };
type View = "people" | "program";
/** Which relationship axis to draw: publications, grants, or both overlaid. */
type Axis = "pubs" | "grants" | "both";

const MEMBER_CAP = 25;
const DEFAULT_MIN_YEAR = 2020;

/**
 * Edge colors for the "Both" overlay (handoff §6.2 option C): a pair that only
 * publishes together is neutral gray, only co-funds is gold, and BOTH is green —
 * the green ties are the analytically strongest collaborations.
 */
const EDGE_REL_COLOR: Record<Relationship, string> = {
  pub: "#94a3b8", // slate — publications only
  grant: "#E69F00", // gold — grants only
  both: "#009E73", // green — both (strong ties)
};

/** Union of two optional `[lo, hi]` extents (for the "Both" axis year slider). */
function unionExtent(
  a: [number, number] | null,
  b: [number, number] | null,
): [number, number] | null {
  if (!a) return b;
  if (!b) return a;
  return [Math.min(a[0], b[0]), Math.max(a[1], b[1])];
}

/** Default low year = 2020, clamped into the data's actual extent. */
function defaultYearLo(extent: [number, number]): number {
  return Math.max(extent[0], Math.min(extent[1], DEFAULT_MIN_YEAR));
}

export function CenterCollaborationTab({ centerSlug }: { centerSlug: string }) {
  const [payload, setPayload] = useState<CenterCollaborationPayload | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  // Controls
  const [view, setView] = useState<View>("people");
  // Relationship axis (#1137 Phase 2). Only shown when the payload carries the
  // grant axis (`grantAxis` sub-flag on); otherwise the tab is pubs-only Phase 1.
  const [axis, setAxis] = useState<Axis>("pubs");
  // Grant-axis filters. Both default ON: exclude umbrella/infrastructure awards
  // (the §4 clique problem) and keep only currently-active awards.
  const [excludeUmbrella, setExcludeUmbrella] = useState(true);
  const [activeOnly, setActiveOnly] = useState(true);
  const [minCoPubs, setMinCoPubs] = useState(2);
  // Which program's network to show in the people view: a program key, or "all"
  // (every program at once, within-program edges only). Defaults to the first
  // program once the payload loads (one program at a time).
  const [selectedProgram, setSelectedProgram] = useState<string>("all");
  // On by default: unconnected members get flung to the periphery by repulsion,
  // which blows up the bounding box so the auto-fit zooms way out. Hiding them
  // keeps the frame on the actual collaboration core.
  const [hideUnconnected, setHideUnconnected] = useState(true);
  const [showLabels, setShowLabels] = useState(true);
  const [newman, setNewman] = useState(false);
  const [yearLo, setYearLo] = useState<number | null>(null);
  const [yearHi, setYearHi] = useState<number | null>(null);
  const [search, setSearch] = useState("");

  // vis refs
  const containerRef = useRef<HTMLDivElement | null>(null);
  const networkRef = useRef<VisNetwork | null>(null);
  const nodesDsRef = useRef<DataSet<NodeItem> | null>(null);
  const edgesDsRef = useRef<DataSet<EdgeItem> | null>(null);
  const [graphReady, setGraphReady] = useState(false);

  // --- fetch payload ---------------------------------------------------------
  useEffect(() => {
    let alive = true;
    setStatus("loading");
    fetch(`/api/centers/${encodeURIComponent(centerSlug)}/collaboration`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<CenterCollaborationPayload>;
      })
      .then((data) => {
        if (!alive) return;
        setPayload(data);
        // Year bounds follow the active axis — set by the extent effect below.
        // Open on the first program (one program at a time).
        if (data.programs.length > 0) {
          setSelectedProgram(programKey(data.programs[0].code));
        }
        setStatus("ready");
      })
      .catch(() => {
        if (alive) setStatus("error");
      });
    return () => {
      alive = false;
    };
  }, [centerSlug]);

  // Year extent follows the active axis: publications use the paper years, grants
  // use the award spans, "both" the union — so the slider bounds always match.
  const extent = useMemo(() => {
    if (!payload) return null;
    const pub = yearExtent(payload.papers);
    const grant = awardYearExtent(payload.awards);
    if (axis === "grants") return grant;
    if (axis === "both") return unionExtent(pub, grant);
    return pub;
  }, [payload, axis]);
  // Reset the year window to the axis default whenever the extent changes (load
  // or axis switch). Keyed on `extent`, which only changes with payload/axis.
  useEffect(() => {
    if (extent) {
      setYearLo(defaultYearLo(extent));
      setYearHi(extent[1]);
    }
  }, [extent]);
  const fullYearRange =
    !extent || (yearLo === extent[0] && yearHi === extent[1]);

  // Program key → color / label, from the payload legend.
  const programMeta = useMemo(() => {
    const color = new Map<string, string>();
    const label = new Map<string, string>();
    for (const p of payload?.programs ?? []) {
      color.set(programKey(p.code), p.color);
      label.set(programKey(p.code), p.label);
    }
    return { color, label };
  }, [payload]);

  // --- create the network once the payload + container exist -----------------
  useEffect(() => {
    if (!payload || !containerRef.current) return;
    let destroyed = false;
    let network: VisNetwork | null = null;

    void import("vis-network/standalone").then((vis) => {
      if (destroyed || !containerRef.current) return;
      const nodesDs = new vis.DataSet<NodeItem>([]);
      const edgesDs = new vis.DataSet<EdgeItem>([]);
      nodesDsRef.current = nodesDs;
      edgesDsRef.current = edgesDs;
      network = new vis.Network(
        containerRef.current,
        { nodes: nodesDs, edges: edgesDs },
        baseOptions(),
      );
      networkRef.current = network;
      network.on("click", (params: { nodes: Array<string | number> }) => {
        const id = params.nodes[0];
        if (typeof id !== "number") return; // people view only (program ids are strings)
        const node = payload.nodes[id];
        if (node?.slug) window.open(profilePath(node.slug), "_blank", "noopener");
      });
      // Persistent: when the layout settles (initial load or any rebuild),
      // FREEZE physics so it stops moving and can't drift out of view, THEN fit
      // to the final positions so the whole network is framed (not a sub-area).
      network.on("stabilizationIterationsDone", () => {
        network?.setOptions({ physics: { enabled: false } });
        network?.fit({ animation: false });
      });
      setGraphReady(true);
    });

    return () => {
      destroyed = true;
      setGraphReady(false);
      network?.destroy();
      networkRef.current = null;
      nodesDsRef.current = null;
      edgesDsRef.current = null;
    };
    // Re-create only when the payload changes; data rebuilds re-stabilize via
    // the data effect below, never by recreating the network.
  }, [payload]);

  // --- build the vis nodes/edges for the current controls --------------------
  const computed = useMemo(() => {
    const empty = {
      nodes: [] as NodeItem[],
      edges: [] as EdgeItem[],
      omitted: 0,
      umbrellaExcluded: 0,
      shown: 0,
    };
    if (!payload) return empty;

    const wantPub = axis === "pubs" || axis === "both";
    const wantGrant =
      payload.grantAxis && (axis === "grants" || axis === "both");
    const yearRange: [number | null, number | null] | undefined = fullYearRange
      ? undefined
      : [yearLo, yearHi];
    const programOf = (idx: number) => payload.nodes[idx]?.programCode ?? null;

    // People view never draws cross-program links (that's the Programs rollup);
    // sizing + edges are within-program for both "one program" and "all".
    const baseOpts: EdgeBuildOptions = {
      newman,
      maxMembersPerPaper: MEMBER_CAP,
      withinProgramOnly: true,
      programOf,
    };
    // Papers keep the builder's point-in-time year filter. Awards are pre-filtered
    // here (umbrella / active / year-overlap), then fed with no further year filter.
    const pubOpts: EdgeBuildOptions = { ...baseOpts, yearRange };
    const filteredAwards = wantGrant
      ? filterAwards(payload.awards, { excludeUmbrella, activeOnly, yearRange })
      : [];

    const omitted = wantPub
      ? countOmittedHyperauthored(payload.papers, pubOpts)
      : 0;
    const umbrellaExcluded =
      wantGrant && excludeUmbrella
        ? countUmbrellaExcluded(payload.awards, { activeOnly, yearRange })
        : 0;

    // ---------------------------- PROGRAM ROLLUP ----------------------------
    if (view === "program") {
      const pub = wantPub
        ? buildProgramEdges(payload.papers, programOf, { yearRange })
        : { edges: [], internal: new Map<string, number>() };
      const grant = wantGrant
        ? buildProgramEdges(filteredAwards, programOf, {})
        : { edges: [], internal: new Map<string, number>() };

      const visNodes: NodeItem[] = [];
      for (const p of payload.programs) {
        const key = programKey(p.code);
        const pubInternal = pub.internal.get(key) ?? 0;
        const grantInternal = grant.internal.get(key) ?? 0;
        visNodes.push({
          id: key,
          label: p.label,
          color: p.color,
          shape: "dot",
          size: nodeRadius(pubInternal + grantInternal, { rMin: 16, k: 2.4, rMax: 70 }),
          title: programTitle(p.label, pubInternal, grantInternal, axis),
        });
      }
      const visibleKeys = new Set(visNodes.map((n) => n.id));
      const visEdges: EdgeItem[] =
        axis === "both"
          ? mergeAxisEdgesThresholded(pub.edges, grant.edges, minCoPubs)
              .filter((e) => visibleKeys.has(e.a) && visibleKeys.has(e.b))
              .map((e) => ({
                id: `${e.a}|${e.b}`,
                from: e.a,
                to: e.b,
                width: 1 + Math.min(12, Math.max(e.pubWeight, e.grantWeight) / 3),
                color: EDGE_REL_COLOR[e.rel],
                title: crossProgramTitle(e.pubWeight, e.grantWeight),
              }))
          : (axis === "grants" ? grant.edges : pub.edges)
              .filter(
                (e) =>
                  e.weight >= minCoPubs &&
                  visibleKeys.has(e.a) &&
                  visibleKeys.has(e.b),
              )
              .map((e) => ({
                id: `${e.a}|${e.b}`,
                from: e.a,
                to: e.b,
                width: 1 + Math.min(12, e.weight / 3),
                title:
                  axis === "grants"
                    ? `${e.weight} cross-program shared grant${e.weight === 1 ? "" : "s"}`
                    : `${e.weight} cross-program co-authored papers`,
              }));
      return {
        nodes: visNodes,
        edges: visEdges,
        omitted,
        umbrellaExcluded,
        shown: visNodes.length,
      };
    }

    // ------------------------------ PEOPLE VIEW -----------------------------
    // Per-node degree from the SHOWN (thresholded) edges, so "hide unconnected"
    // and node size stay consistent with what's drawn. For "both", the threshold
    // is applied AFTER merging both axes (mergeAxisEdgesThresholded) — identical
    // to the program rollup — so a pub-heavy / single-grant pair still classifies
    // as "both" (green) instead of being downgraded to a single-axis tie.
    const degree = new Array<number>(payload.nodes.length).fill(0);
    type RawEdge = { a: number; b: number; width: number; color?: string; title: string };
    let rawEdges: RawEdge[];
    if (axis === "both") {
      const pubAll = wantPub ? buildPeopleEdges(payload.papers, pubOpts) : [];
      const grantAll = wantGrant ? buildPeopleEdges(filteredAwards, baseOpts) : [];
      const merged = mergeAxisEdgesThresholded(pubAll, grantAll, minCoPubs);
      for (const e of merged) {
        degree[e.a] += 1;
        degree[e.b] += 1;
      }
      rawEdges = merged.map((e) => ({
        a: e.a,
        b: e.b,
        width: 1 + Math.min(8, e.strength),
        color: EDGE_REL_COLOR[e.rel],
        title: pairTitle(e.pubWeight, e.grantWeight),
      }));
    } else {
      const edges = (
        axis === "grants"
          ? buildPeopleEdges(filteredAwards, baseOpts)
          : buildPeopleEdges(payload.papers, pubOpts)
      ).filter((e) => e.weight >= minCoPubs);
      for (const e of edges) {
        degree[e.a] += 1;
        degree[e.b] += 1;
      }
      rawEdges = edges.map((e) => ({
        a: e.a,
        b: e.b,
        width: 1 + Math.min(8, e.strength),
        title:
          axis === "grants"
            ? `${e.weight} shared grant${e.weight === 1 ? "" : "s"}`
            : `${e.weight} co-authored publication${e.weight === 1 ? "" : "s"}`,
      }));
    }

    const visNodes: NodeItem[] = [];
    for (const n of payload.nodes) {
      const key = programKey(n.programCode);
      if (selectedProgram !== "all" && key !== selectedProgram) continue;
      if (hideUnconnected && degree[n.i] === 0) continue;
      visNodes.push({
        id: n.i,
        label: showLabels ? n.name : undefined,
        color: programMeta.color.get(key) ?? "#9AA0A6",
        shape: "dot",
        size: nodeRadius(degree[n.i], { rMin: 6, k: 3, rMax: 30 }),
        title: nodeTitle(
          n.name,
          programMeta.label.get(key) ?? "Unclassified",
          n.pubCount,
          degree[n.i],
          axis,
        ),
      });
    }
    const visibleIds = new Set(visNodes.map((n) => n.id));
    const visEdges: EdgeItem[] = rawEdges
      .filter((e) => visibleIds.has(e.a) && visibleIds.has(e.b))
      .map((e) => ({
        id: `${e.a}-${e.b}`,
        from: e.a,
        to: e.b,
        width: e.width,
        ...(e.color ? { color: e.color } : {}),
        title: e.title,
      }));
    return {
      nodes: visNodes,
      edges: visEdges,
      omitted,
      umbrellaExcluded,
      shown: visNodes.length,
    };
  }, [
    payload,
    view,
    axis,
    excludeUmbrella,
    activeOnly,
    minCoPubs,
    selectedProgram,
    hideUnconnected,
    showLabels,
    newman,
    yearLo,
    yearHi,
    fullYearRange,
    programMeta,
  ]);

  // Push computed data into the live DataSets.
  useEffect(() => {
    if (!graphReady) return;
    const nodesDs = nodesDsRef.current;
    const edgesDs = edgesDsRef.current;
    if (!nodesDs || !edgesDs) return;
    edgesDs.clear();
    nodesDs.clear();
    nodesDs.add(computed.nodes);
    edgesDs.add(computed.edges);
    // Re-run the stabilization burn-in for the new data; the persistent
    // `stabilizationIterationsDone` handler freezes + fits to the FINAL layout.
    // Do NOT fit() here — fitting mid-motion is what framed only a sub-area.
    const net = networkRef.current;
    if (net) {
      net.setOptions({ physics: { enabled: true } });
      net.stabilize();
    }
  }, [graphReady, computed]);

  // Focus a searched member (people view only). Uses the live vis selection so
  // it does not rebuild/refit the graph on every keystroke.
  useEffect(() => {
    if (!graphReady || view !== "people") return;
    const q = search.trim().toLowerCase();
    if (!q) return;
    const node = payload?.nodes.find((n) => n.name.toLowerCase().includes(q));
    if (node && networkRef.current) {
      networkRef.current.selectNodes([node.i]);
      networkRef.current.focus(node.i, { scale: 1.1, animation: true });
    }
  }, [search, graphReady, view, payload]);

  const resetAll = useCallback(() => {
    setView("people");
    setAxis("pubs");
    setExcludeUmbrella(true);
    setActiveOnly(true);
    setMinCoPubs(2);
    setSelectedProgram(
      payload && payload.programs.length > 0
        ? programKey(payload.programs[0].code)
        : "all",
    );
    setHideUnconnected(true);
    setShowLabels(true);
    setNewman(false);
    setSearch("");
    // Reset year to the publication extent (axis resets to "pubs"). Explicit so a
    // Reset while already on the pubs axis still restores the default window.
    const pubExtent = payload ? yearExtent(payload.papers) : null;
    if (pubExtent) {
      setYearLo(defaultYearLo(pubExtent));
      setYearHi(pubExtent[1]);
    }
  }, [payload]);

  // Re-run the layout and re-frame (the data effect also does this on any
  // control change; this is the manual "shake / re-fit" button).
  const relayout = useCallback(() => {
    const net = networkRef.current;
    if (!net) return;
    net.setOptions({ physics: { enabled: true } });
    net.stabilize();
  }, []);

  const exportPng = useCallback(() => {
    const net = networkRef.current as unknown as
      | { canvas?: { frame?: { canvas?: HTMLCanvasElement } } }
      | null;
    const canvas = net?.canvas?.frame?.canvas;
    if (!canvas) return;
    const a = document.createElement("a");
    a.href = canvas.toDataURL("image/png");
    a.download = `${centerSlug}-collaboration.png`;
    a.click();
  }, [centerSlug]);

  const exportHtml = useCallback(() => {
    if (!payload) return;
    const html = buildStandaloneHtml(
      payload.center.name,
      computed.nodes,
      computed.edges,
      baseOptions(),
    );
    const blob = new Blob([html], { type: "text/html" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${centerSlug}-collaboration.html`;
    a.click();
    URL.revokeObjectURL(a.href);
  }, [payload, computed, centerSlug]);

  if (status === "loading") {
    return <p className="py-10 text-sm text-[var(--color-text-tertiary)]">Loading collaboration network…</p>;
  }
  if (status === "error") {
    return <p className="py-10 text-sm text-[var(--color-text-tertiary)]">Could not load the collaboration network. Please try again.</p>;
  }
  if (
    !payload ||
    payload.nodes.length === 0 ||
    (payload.papers.length === 0 && payload.awards.length === 0)
  ) {
    return (
      <p className="py-10 text-sm text-[var(--color-text-tertiary)]">
        Not enough co-authorship data yet to draw a collaboration network for this center.
      </p>
    );
  }

  const labelCls = "flex items-center gap-1.5 text-xs text-[var(--color-text-secondary)]";
  const ctrlCls =
    "rounded border border-[var(--color-border)] bg-white px-2 py-1 text-xs text-[var(--color-text-primary)]";

  return (
    <div className="space-y-3">
      {/* Control bar */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface,#fafafa)] p-3">
        <div className="inline-flex overflow-hidden rounded border border-[var(--color-border)]">
          {(["people", "program"] as View[]).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={`px-2.5 py-1 text-xs ${view === v ? "bg-[var(--color-accent-slate)] text-white" : "bg-white text-[var(--color-text-secondary)]"}`}
            >
              {v === "people" ? "People" : "Programs"}
            </button>
          ))}
        </div>

        {/* Axis toggle (#1137 Phase 2) — only when the payload carries the grant axis. */}
        {payload.grantAxis && (
          <div className="inline-flex items-center gap-1.5">
            <span className="text-xs text-[var(--color-text-tertiary)]">Ties:</span>
            <div className="inline-flex overflow-hidden rounded border border-[var(--color-border)]">
              {(["pubs", "grants", "both"] as Axis[]).map((a) => (
                <button
                  key={a}
                  type="button"
                  onClick={() => setAxis(a)}
                  title={
                    a === "pubs"
                      ? "Co-authorship ties (shared publications)"
                      : a === "grants"
                        ? "Co-investigation ties (shared grant awards)"
                        : "Both axes overlaid — gray = publications only, gold = grants only, green = both"
                  }
                  className={`px-2.5 py-1 text-xs ${axis === a ? "bg-[var(--color-accent-slate)] text-white" : "bg-white text-[var(--color-text-secondary)]"}`}
                >
                  {a === "pubs" ? "Publications" : a === "grants" ? "Grants" : "Both"}
                </button>
              ))}
            </div>
          </div>
        )}

        <label className={labelCls}>
          {axis === "grants" ? "Min shared grants" : axis === "both" ? "Min shared" : "Min co-pubs"}
          <input
            type="range"
            min={1}
            max={10}
            value={minCoPubs}
            onChange={(e) => setMinCoPubs(Number(e.target.value))}
          />
          <span className="tabular-nums">{minCoPubs}</span>
        </label>

        {extent && (
          <label className={labelCls}>
            Years
            <input
              type="number"
              className={`${ctrlCls} w-16`}
              min={extent[0]}
              max={yearHi ?? extent[1]}
              value={yearLo ?? extent[0]}
              onChange={(e) => setYearLo(Number(e.target.value))}
            />
            –
            <input
              type="number"
              className={`${ctrlCls} w-16`}
              min={yearLo ?? extent[0]}
              max={extent[1]}
              value={yearHi ?? extent[1]}
              onChange={(e) => setYearHi(Number(e.target.value))}
            />
          </label>
        )}

        {view === "people" && (
          <input
            type="search"
            placeholder="Find a member…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className={`${ctrlCls} w-40`}
          />
        )}

        {view === "people" && (
          <label className={labelCls}>
            <input type="checkbox" checked={hideUnconnected} onChange={(e) => setHideUnconnected(e.target.checked)} />
            Hide unconnected members
          </label>
        )}
        {view === "people" && (
          <label className={labelCls}>
            <input type="checkbox" checked={showLabels} onChange={(e) => setShowLabels(e.target.checked)} />
            Labels
          </label>
        )}

        {/* Grant-axis filters (#1137 Phase 2) — only on the grant / both axes. */}
        {(axis === "grants" || axis === "both") && (
          <>
            <label
              className={labelCls}
              title="Exclude umbrella / infrastructure awards — center & training grants (P30/P50/U54/UL1…) that link many members who share funding but don't co-investigate."
            >
              <input type="checkbox" checked={excludeUmbrella} onChange={(e) => setExcludeUmbrella(e.target.checked)} />
              Exclude center &amp; training grants
            </label>
            <label className={labelCls} title="Show only currently-active awards (end date in the future).">
              <input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} />
              Active grants only
            </label>
          </>
        )}

        <label className={labelCls} title="Down-weight large groups so a big consortium paper / award doesn't dominate the layout (Newman 1/(k-1)).">
          <input type="checkbox" checked={newman} onChange={(e) => setNewman(e.target.checked)} />
          Down-weight large {axis === "grants" ? "awards" : axis === "both" ? "groups" : "papers"}
        </label>

        <div className="ml-auto flex items-center gap-2">
          <button type="button" onClick={relayout} className={ctrlCls}>Re-layout</button>
          <button type="button" onClick={exportPng} className={ctrlCls}>Download PNG</button>
          <button type="button" onClick={exportHtml} className={ctrlCls}>Download HTML</button>
          <button type="button" onClick={resetAll} className={ctrlCls}>Reset</button>
        </div>
      </div>

      {/* Program picker — one program at a time (people view). Doubles as the
          color key. In the Programs rollup view it is just a static legend. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
        <span className="text-[var(--color-text-tertiary)]">
          {view === "people" ? "Show program:" : "Programs:"}
        </span>
        {view === "people" && (
          <button
            type="button"
            onClick={() => setSelectedProgram("all")}
            className={`rounded-full border px-2 py-0.5 ${
              selectedProgram === "all"
                ? "border-[var(--color-accent-slate)] font-medium text-[var(--color-accent-slate)]"
                : "border-[var(--color-border)] text-[var(--color-text-secondary)]"
            }`}
          >
            All programs
          </button>
        )}
        {payload.programs.map((p) => {
          const key = programKey(p.code);
          const selected = view === "people" && selectedProgram === key;
          const interactive = view === "people";
          return (
            <button
              key={key}
              type="button"
              disabled={!interactive}
              onClick={interactive ? () => setSelectedProgram(key) : undefined}
              className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 ${
                selected
                  ? "border-[var(--color-accent-slate)] font-medium"
                  : "border-transparent"
              } ${interactive ? "" : "cursor-default"}`}
            >
              <span className="inline-block h-3 w-3 rounded-full" style={{ backgroundColor: p.color }} />
              <span>{p.label}</span>
            </button>
          );
        })}
      </div>

      {/* Edge key — the "Both" overlay colors edges by relationship type (§6.2 C). */}
      {axis === "both" && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--color-text-tertiary)]">
          <span>Edges:</span>
          {(
            [
              ["both", "Publications + grants"],
              ["grant", "Grants only"],
              ["pub", "Publications only"],
            ] as [Relationship, string][]
          ).map(([rel, label]) => (
            <span key={rel} className="inline-flex items-center gap-1.5">
              <span
                className="inline-block h-[3px] w-5 rounded-full"
                style={{ backgroundColor: EDGE_REL_COLOR[rel] }}
              />
              {label}
            </span>
          ))}
        </div>
      )}

      {/* Graph */}
      <div
        ref={containerRef}
        className="h-[640px] w-full rounded-md border border-[var(--color-border)] bg-white"
      />

      <p className="text-[11px] text-[var(--color-text-tertiary)]">
        {computed.shown.toLocaleString()} {view === "people" ? "members" : "programs"} shown · node size ={" "}
        {axis === "grants"
          ? "within-program co-investigators"
          : axis === "both"
            ? "within-program collaborators"
            : "within-program co-authors"}{" "}
        · edge thickness ={" "}
        {axis === "grants" ? "shared grants" : axis === "both" ? "tie strength" : "shared publications"}
        {view === "people" && (
          <> · links are within-program (cross-program collaboration is in the Programs view)</>
        )}
        {computed.omitted > 0 && (
          <> · {computed.omitted.toLocaleString()} paper{computed.omitted === 1 ? "" : "s"} with &gt;{MEMBER_CAP} center authors omitted from links</>
        )}
        {computed.umbrellaExcluded > 0 && (
          <> · {computed.umbrellaExcluded.toLocaleString()} umbrella award{computed.umbrellaExcluded === 1 ? "" : "s"} (P30/P50/UL1…) excluded</>
        )}
        . Click a member to open their profile.
      </p>
    </div>
  );
}

/** People-view node tooltip — axis-aware (pubs show the publication count; the
 *  grant/both axes describe co-investigators / collaborators). */
function nodeTitle(
  name: string,
  program: string,
  pubCount: number,
  degree: number,
  axis: Axis,
): string {
  if (axis === "grants") {
    return `${name}\n${program} · ${degree} program co-investigator${degree === 1 ? "" : "s"} shown`;
  }
  if (axis === "both") {
    return `${name}\n${program} · ${pubCount} publications · ${degree} collaborator${degree === 1 ? "" : "s"} shown`;
  }
  return `${name}\n${program} · ${pubCount} publications · ${degree} program co-author${degree === 1 ? "" : "s"} shown`;
}

/** People-view edge tooltip for the "Both" overlay — names whichever ties exist. */
function pairTitle(pubWeight: number, grantWeight: number): string {
  const parts: string[] = [];
  if (pubWeight > 0)
    parts.push(`${pubWeight} co-authored publication${pubWeight === 1 ? "" : "s"}`);
  if (grantWeight > 0)
    parts.push(`${grantWeight} shared grant${grantWeight === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

/** Program-rollup node tooltip — axis-aware within-program counts. */
function programTitle(
  label: string,
  pubInternal: number,
  grantInternal: number,
  axis: Axis,
): string {
  if (axis === "grants") {
    return `${label}\n${grantInternal} within-program shared grant${grantInternal === 1 ? "" : "s"}`;
  }
  if (axis === "both") {
    return `${label}\n${pubInternal} within-program papers · ${grantInternal} within-program grants`;
  }
  return `${label}\n${pubInternal} within-program co-authored papers`;
}

/** Program-rollup edge tooltip for the "Both" overlay. */
function crossProgramTitle(pubWeight: number, grantWeight: number): string {
  const parts: string[] = [];
  if (pubWeight > 0)
    parts.push(`${pubWeight} cross-program paper${pubWeight === 1 ? "" : "s"}`);
  if (grantWeight > 0)
    parts.push(`${grantWeight} cross-program grant${grantWeight === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

function baseOptions(): Options {
  return {
    autoResize: true,
    height: "100%",
    width: "100%",
    // The Kamada-Kawai pre-layout is slow and erratic above ~100 nodes (and vis
    // disables it there anyway); skip it so barnesHut owns the layout.
    layout: { improvedLayout: false },
    physics: {
      enabled: true,
      solver: "barnesHut",
      barnesHut: {
        gravitationalConstant: -3500, // gentle repulsion → compact, fits in view
        centralGravity: 0.8, // strong center pull → tight ball, everyone in frame
        springLength: 70,
        springConstant: 0.06,
        damping: 0.55, // high damping → settles fast, no perpetual jiggle
        avoidOverlap: 0.5, // still separate overlapping nodes
      },
      maxVelocity: 30,
      minVelocity: 0.75, // declare "settled" sooner
      stabilization: { enabled: true, iterations: 600, updateInterval: 25, fit: true },
    },
    nodes: {
      shape: "dot",
      font: { size: 12, color: "#1f2933" },
      borderWidth: 1,
      color: { border: "#ffffff" },
    },
    edges: {
      color: { color: "#cbd5e1", highlight: "#64748b", opacity: 0.7 },
      smooth: false,
    },
    interaction: {
      hover: true,
      tooltipDelay: 120,
      hideEdgesOnDrag: true,
      navigationButtons: false,
      keyboard: false,
    },
  };
}

/** Self-contained, offline-openable HTML — the slide-ready legacy deliverable. */
function buildStandaloneHtml(
  title: string,
  nodes: NodeItem[],
  edges: EdgeItem[],
  options: Options,
): string {
  const data = { nodes, edges, options };
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)} — collaboration network</title>
<script src="https://unpkg.com/vis-network/standalone/umd/vis-network.min.js"></script>
<style>
  body { font: 14px/1.4 -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; color: #1f2933; }
  h1 { font-size: 18px; margin: 16px 20px 4px; }
  #net { height: 88vh; border-top: 1px solid #e5e7eb; }
</style>
</head>
<body>
<h1>${escapeHtml(title)} — collaboration network</h1>
<div id="net"></div>
<script>
  var data = ${json};
  var nodes = new vis.DataSet(data.nodes);
  var edges = new vis.DataSet(data.edges);
  new vis.Network(document.getElementById("net"), { nodes: nodes, edges: edges }, data.options);
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}
