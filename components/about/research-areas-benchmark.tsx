"use client";

/**
 * /about/research-areas body: ported from the approved mockup
 * (Projects/Scholars-Profile-System/mockups/Interactive webpage for ReciterAI).
 * Everything renders from one benchmark snapshot; SSR gives the full initial
 * state, so the summary, gaps and method read without JS.
 */
import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { BenchmarkLinks, BenchmarkSnapshot, SnapshotEntry } from "@/lib/benchmark";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type Snap = BenchmarkSnapshot;
type Area = Snap["areas"][number];
type Unit = Snap["units"][number];
type Ref = Snap["references"][number];
type Pair = Snap["pairs"][number];
type Cell = Snap["unit_cells"][number];
type BadgeVariant = "default" | "secondary" | "outline" | "destructive";

const SHORT: Record<string, string> = {
  exact: "exact match",
  area_broader: "contains it",
  area_narrower: "part of it",
  overlap: "partial overlap",
};
const HOW: Record<string, string> = {
  exact: "Exact match",
  area_broader: "Contained in a broader area",
  area_narrower: "Covered by narrower areas",
  overlap: "Partial overlap",
  none: "Not represented",
  covered: "Home unit of an area",
  low_volume: "Aligned, under 25 papers",
  not_covered: "No area concentrated here",
  no_papers: "No scored papers",
  out_of_scope: "Out of scope",
};
const HOWV: Record<string, BadgeVariant> = {
  exact: "default",
  area_broader: "secondary",
  area_narrower: "secondary",
  overlap: "outline",
  none: "destructive",
  covered: "default",
  low_volume: "outline",
  not_covered: "destructive",
  no_papers: "outline",
  out_of_scope: "outline",
};
const FR: Record<string, string> = {
  B: "CARE Strategic Plan",
  C1: "NIH Institute or Center",
  C2: "NIH RCDC category",
};
const SRC: [string, string][] = [
  ["all", "All"],
  ["department", "Departments"],
  ["division", "Divisions"],
  ["B", "CARE plan"],
  ["C1", "NIH ICs"],
  ["C2", "NIH RCDC"],
];

// ponytail: gap explanations are transcribed from the 2026-10-10 methods
// README, keyed by id. A later snapshot that adds ids falls through to the
// generic text / "Other" groups below; move these into the snapshot JSON if
// they start drifting.
const LOWNOTE: Record<string, string> = {
  melanoma_skin_cancer: "Strongest unit is Dermatology, on fewer than 25 papers.",
  sleep_medicine_circadian_biology:
    "Strongest unit is Pulmonary Medicine, on fewer than 25 papers.",
  autoimmune_rheumatologic_disease:
    "The directory feed has no rheumatology unit. Weill Cornell rheumatology sits largely at HSS.",
  environmental_planetary_health:
    "Strongest units are Emergency Medicine and General Internal Medicine, on fewer than 25 papers.",
  research_infrastructure_workforce: "Strongest unit is the Library, on fewer than 25 papers.",
};
const NOIC: [string, string[]][] = [
  [
    "Methods and quantitative fields",
    [
      "biostatistics_quantitative_sciences",
      "epidemiology_population_health",
      "health_economics",
      "single_cell_spatial_biology",
    ],
  ],
  [
    "Care delivery and policy",
    [
      "health_services_policy",
      "digital_health_telemedicine",
      "primary_care_general_medicine",
      "medical_education_workforce",
    ],
  ],
  ["Cross-organ specialties", ["surgery_perioperative_medicine", "pathology_laboratory_medicine"]],
  [
    "Cross-disease biology",
    ["gene_cell_therapy", "stem_cell_regenerative_medicine", "microbiome_research"],
  ],
  ["Bioethics", ["bioethics_medical_humanities"]],
];
const RCDCG: [string, "real" | "structural", string, string[]][] = [
  [
    "Violence research",
    "real",
    "These are real gaps in Weill Cornell’s map relative to NIH’s.",
    ["rcdc_301", "rcdc_290", "rcdc_291", "rcdc_285", "rcdc_286", "rcdc_128"],
  ],
  [
    "Broad behavioral and social science",
    "real",
    "These are real gaps in Weill Cornell’s map relative to NIH’s.",
    ["rcdc_28", "rcdc_30"],
  ],
  [
    "Rare syndromes too small for their own area",
    "structural",
    "Each is narrower than any area the taxonomy would plausibly hold.",
    ["rcdc_172", "rcdc_304", "rcdc_55", "rcdc_311"],
  ],
  [
    "Administrative categories",
    "structural",
    "NIH tracks these for reporting; they are not fields of inquiry.",
    ["rcdc_224", "rcdc_130", "rcdc_18"],
  ],
];

const f1 = (x: number) => (Math.round(x * 10) / 10).toFixed(1);
const csvq = (v: unknown) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
function download(name: string, text: string, type = "text/csv") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function scrollToId(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

const H2 = "text-[22px] font-semibold";
const RULE = <div aria-hidden className="h-[3px] w-10 bg-[var(--apollo-maroon)]" />;
const LEAD = "max-w-[720px] text-[15px] leading-relaxed text-[var(--apollo-ink-2)]";
const CARD =
  "rounded-[var(--apollo-radius-card)] border border-[var(--apollo-border)] bg-[var(--apollo-surface)] shadow-[var(--apollo-shadow-card)]";
const TH =
  "px-3.5 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-[var(--apollo-ink-2)]";
const H4 = "text-[13px] font-semibold uppercase tracking-wider text-[var(--apollo-ink-2)]";
const REVIEW = (
  <span className="border-b border-dashed border-[var(--apollo-amber)] text-xs text-[var(--apollo-amber)]">
    added on review
  </span>
);

function MaybeLink({
  href,
  children,
  className,
}: {
  href?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return href ? (
    <a href={href} className={className}>
      {children}
    </a>
  ) : (
    <span className={className}>{children}</span>
  );
}

function Section({
  id,
  title,
  children,
  className = "",
}: {
  id: string;
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-h`}
      className={`flex scroll-mt-20 flex-col gap-4 ${className}`}
    >
      <div className="flex flex-col gap-2">
        <h2 id={`${id}-h`} className={H2}>
          {title}
        </h2>
        {RULE}
      </div>
      {children}
    </section>
  );
}

type Entry = {
  src: string;
  source: string;
  entry: string;
  detail: string;
  howKey: string;
  basis: string;
  reps: { label: string; href?: string; rel: string; review: boolean }[];
};

function cellStyle(c: Cell | undefined, th: { lift: number; min_papers: number }) {
  if (!c || c.lift < 1)
    return { bg: "var(--apollo-surface-2)", fg: "transparent", g: "", k: "fewer than expected" };
  if (c.lift < th.lift)
    return {
      bg: "var(--apollo-slate-tint)",
      fg: "transparent",
      g: "",
      k: "somewhat more than expected",
    };
  if (c.n < th.min_papers)
    return {
      bg: "var(--apollo-amber-tint)",
      fg: "var(--apollo-amber)",
      g: "○",
      k: "aligned, under 25 papers",
    };
  const bg =
    c.lift >= 8
      ? "var(--apollo-slate)"
      : c.lift >= 4
        ? "color-mix(in oklch, var(--apollo-slate) 78%, white)"
        : "color-mix(in oklch, var(--apollo-slate) 55%, white)";
  return { bg, fg: "#fff", g: "●", k: "home unit" };
}

export function ResearchAreasBenchmark({
  snap: s,
  snapshots,
  links,
}: {
  snap: Snap;
  snapshots: SnapshotEntry[];
  links: BenchmarkLinks;
}) {
  const router = useRouter();
  const latest = snapshots[0].date;
  const isOld = s.snapshot_date !== latest;
  const H = s.headline;
  const th = s.corpus.home_threshold;
  const month = new Date(`${s.snapshot_date}T12:00:00`).toLocaleString("en-US", {
    month: "long",
    year: "numeric",
  });

  const d = useMemo(() => {
    const area = Object.fromEntries(s.areas.map((a) => [a.id, a])) as Record<string, Area>;
    const unit = Object.fromEntries(s.units.map((u) => [u.id, u])) as Record<string, Unit>;
    const ref = Object.fromEntries(s.references.map((r) => [`${r.frame}|${r.id}`, r])) as Record<
      string,
      Ref
    >;
    const pByArea: Record<string, Pair[]> = {};
    const pByRef: Record<string, Pair[]> = {};
    for (const p of s.pairs) {
      (pByArea[p.area] ??= []).push(p);
      (pByRef[`${p.frame}|${p.ref}`] ??= []).push(p);
    }
    const cByArea: Record<string, Cell[]> = {};
    const cByUnit: Record<string, Cell[]> = {};
    const cell: Record<string, Cell> = {};
    for (const c of s.unit_cells) {
      (cByArea[c.area] ??= []).push(c);
      (cByUnit[c.unit] ??= []).push(c);
      cell[`${c.area}|${c.unit}`] = c;
    }
    const entries: Entry[] = [];
    for (const u of s.units) {
      const top = [...(cByUnit[u.id] ?? [])].sort((a, b) => b.lift - a.lift).slice(0, 4);
      entries.push({
        src: u.level,
        source: `WCM ${u.level}`,
        entry: u.name,
        detail: u.id,
        howKey: u.status,
        basis: "publication data",
        reps: top.map((c) => ({
          label: area[c.area]?.label ?? c.area,
          href: links.areas[c.area],
          rel: `${f1(c.lift)}× expected · ${c.n} papers`,
          review: false,
        })),
      });
    }
    for (const r of s.references) {
      const ps = pByRef[`${r.frame}|${r.id}`] ?? [];
      const detail =
        r.frame === "B"
          ? `${r.detail.pillar}: ${r.detail.section}`
          : r.frame === "C2"
            ? `FY2025 $${(r.detail.fy2025_musd ?? 0).toLocaleString()}M`
            : r.id;
      const basis = !r.in_scope
        ? (r.note ?? "out of scope")
        : ps.length
          ? [...new Set(ps.map((p) => (p.source === "gap_review" ? "gap review" : p.source)))]
              .sort()
              .join(" + ")
          : "both runs and gap review: none";
      entries.push({
        src: r.frame,
        source: FR[r.frame],
        entry: r.name,
        detail,
        howKey: r.best,
        basis,
        reps: ps.map((p) => ({
          label: area[p.area]?.label ?? p.area,
          href: links.areas[p.area],
          rel: SHORT[p.relation],
          review: p.source === "gap_review",
        })),
      });
    }
    const areasSorted = [...s.areas].sort((a, b) => a.label.localeCompare(b.label));
    return { area, unit, ref, pByArea, pByRef, cByArea, cell, entries, areasSorted };
  }, [s, links]);

  // ---- entry lookup
  const [entryQ, setEntryQ] = useState("");
  const [entrySrc, setEntrySrc] = useState("all");
  const [entryHow, setEntryHow] = useState("all");
  const [entryLimit, setEntryLimit] = useState(25);
  const q = entryQ.trim().toLowerCase();
  const fe = d.entries.filter(
    (e) =>
      (entrySrc === "all" || e.src === entrySrc) &&
      (entryHow === "all" || e.howKey === entryHow) &&
      (!q ||
        e.entry.toLowerCase().includes(q) ||
        e.detail.toLowerCase().includes(q) ||
        e.reps.some((r) => r.label.toLowerCase().includes(q))),
  );
  const order = Object.keys(HOW);
  const howKeys = [
    ...new Set(
      d.entries.filter((e) => entrySrc === "all" || e.src === entrySrc).map((e) => e.howKey),
    ),
  ].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const go = (src: string) => {
    setEntrySrc(src);
    setEntryHow("all");
    setEntryQ("");
    setEntryLimit(25);
    scrollToId("entries");
  };

  // ---- area lookup
  const [areaQ, setAreaQ] = useState("");
  const [areaSel, setAreaSel] = useState(d.areasSorted[0]?.id);
  const aq = areaQ.trim().toLowerCase();
  const A = d.area[areaSel] ?? d.areasSorted[0];
  const homeCells = (d.cByArea[A.id] ?? [])
    .filter((c) => c.lift >= th.lift)
    .sort((a, b) => b.lift - a.lift)
    .slice(0, 8);
  const aPairs = d.pByArea[A.id] ?? [];
  const noIc = NOIC.find((g) => g[1].includes(A.id));
  const frames: [string, string, string][] = [
    [
      "B",
      "CARE Strategic Plan",
      "No CARE plan item. The plan names capabilities, not research domains, so most areas have no counterpart.",
    ],
    [
      "C1",
      "NIH Institutes & Centers",
      noIc
        ? `No NIH Institute or Center. ${noIc[0]} are not how NIH organizes its ICs.`
        : "No NIH Institute or Center.",
    ],
    [
      "C2",
      "NIH RCDC categories",
      "No RCDC category. RCDC is a disease-and-condition scheme, and this area is a discipline or method.",
    ],
  ];
  const openArea = (id: string) => {
    setAreaSel(id);
    setAreaQ("");
    scrollToId("areas");
  };

  // ---- heatmap
  const [level, setLevel] = useState<"department" | "division">("department");
  const [hm, setHm] = useState<{ r: number; c: number } | null>(null);
  const cols = useMemo(
    () => s.units.filter((u) => u.level === level).sort((a, b) => a.name.localeCompare(b.name)),
    [s, level],
  );
  const rows = d.areasSorted;
  const shortName = (u: Unit) => (level === "division" ? u.name.replace(/^.*? \/ /, "") : u.name);
  const hmCell =
    hm && rows[hm.r] && cols[hm.c] ? d.cell[`${rows[hm.r].id}|${cols[hm.c].id}`] : undefined;
  const hmKey = (e: React.KeyboardEvent) => {
    const move = (
      { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] } as Record<
        string,
        number[]
      >
    )[e.key];
    const r = hm?.r ?? 0;
    const c = hm?.c ?? 0;
    if (move) {
      e.preventDefault();
      setHm({
        r: Math.max(0, Math.min(rows.length - 1, r + move[0])),
        c: Math.max(0, Math.min(cols.length - 1, c + move[1])),
      });
    } else if (e.key === "Enter" && hm) openArea(rows[r].id);
  };

  // ---- gaps
  const low = s.areas.filter((a) => a.unit_status !== "home");
  const unitsNo = s.units.filter((u) => u.status !== "covered");
  const noC1 = s.areas.filter((a) => a.best.C1 === "none");
  const noC2 = d.areasSorted.filter((a) => a.best.C2 === "none");
  const rcdcNone = s.references.filter((r) => r.frame === "C2" && r.best === "none");
  const groupedRcdc = new Set(RCDCG.flatMap((g) => g[3]));
  const groupedNoIc = new Set(NOIC.flatMap((g) => g[1]));
  type GapItem = { label: string; href?: string; meta?: string };
  type GapGroup = {
    name: string;
    kind: string;
    variant: BadgeVariant;
    why: string;
    items: GapItem[];
  };
  const real = { kind: "Real gap", variant: "destructive" as const };
  const structural = { kind: "Structural difference", variant: "secondary" as const };
  const thin = { kind: "Too thin to call", variant: "outline" as const };
  const aItem = (a: Area): GapItem => ({ label: a.label, href: links.areas[a.id] });
  const rItem = (r: Ref): GapItem => ({
    label: r.name,
    meta: ` · $${(r.detail.fy2025_musd ?? 0).toLocaleString()}M`,
  });
  const uItem = (u: Unit): GapItem => ({ label: u.name, href: links.units[u.id] });
  const gaps: { title: string; count: string; groups: GapGroup[] }[] = [
    {
      title: "Areas with no home unit",
      count: `${low.length} of ${s.areas.length} areas`,
      groups: [
        {
          name: "Low volume",
          ...thin,
          why: "Each area’s strongest unit is the expected one, but on fewer than 25 papers, so it counts as neither a pass nor a gap.",
          items: low.map((a) => ({
            ...aItem(a),
            meta: LOWNOTE[a.id]
              ? ` · ${LOWNOTE[a.id].replace(/, on fewer than 25 papers\.|\.$/g, "").replace(/^Strongest units? (is|are) /, "")}`
              : "",
          })),
        },
      ],
    },
    {
      title: "Units that aren’t the home of any area",
      count: `${unitsNo.filter((u) => u.level === "department").length} departments, ${unitsNo.filter((u) => u.level === "division").length} divisions`,
      groups: [
        {
          name: "Low volume",
          ...thin,
          why: "The unit’s top area is the expected one but on fewer than 25 papers. Most are Pediatrics subspecialties.",
          items: unitsNo.filter((u) => u.status === "low_volume").map(uItem),
        },
        {
          name: "No scored papers",
          kind: "Corpus coverage",
          variant: "outline",
          why: "No active scholar with a primary appointment here has a first- or last-author article from 2020 on in the scored corpus.",
          items: unitsNo.filter((u) => u.status !== "low_volume").map(uItem),
        },
      ],
    },
    {
      title: "Areas with no NIH Institute or Center",
      count: `${noC1.length} of ${s.areas.length} areas`,
      groups: [
        ...NOIC.map(([name, ids]) => ({
          name,
          ...structural,
          why: "NIH organizes its ICs by disease, organ or population, so method and practice fields don’t get one.",
          items: ids.filter((i) => d.area[i]?.best.C1 === "none").map((i) => aItem(d.area[i])),
        })),
        {
          name: "Other",
          kind: "Not classified",
          variant: "outline" as const,
          why: "The methods README lists these without assigning them to a group.",
          items: noC1.filter((a) => !groupedNoIc.has(a.id)).map(aItem),
        },
      ].filter((g) => g.items.length),
    },
    {
      title: "Areas with no RCDC category",
      count: `${noC2.length} of ${s.areas.length} areas`,
      groups: [
        {
          name: "Disciplines and methods",
          ...structural,
          why: "RCDC is a disease-and-condition scheme, and these are disciplines or methods.",
          items: noC2.map(aItem),
        },
      ],
    },
    {
      title: "RCDC categories with no area",
      count: `${rcdcNone.length} of ${H.C2.categories_total} categories`,
      groups: [
        ...RCDCG.map(([name, k, why, ids]) => ({
          name,
          ...(k === "real" ? real : structural),
          why,
          items: ids
            .map((i) => d.ref[`C2|${i}`])
            .filter((r) => r && r.best === "none")
            .map(rItem),
        })),
        {
          name: "Other unmatched categories",
          kind: "Not classified",
          variant: "outline" as const,
          why: "The methods README lists these without assigning them to a group.",
          items: rcdcNone.filter((r) => !groupedRcdc.has(r.id)).map(rItem),
        },
      ].filter((g) => g.items.length),
    },
  ];

  const sc = s.spot_check;
  const spotText =
    sc.rate != null && sc.agree != null
      ? sc.method === "automated"
        ? `A further independent AI run, separate from the mapping runs, checked a random ${sc.sample} of the ${s.pairs.length} final matches and agreed with ${sc.agree} (${Math.round(sc.rate * 100)}%). In the ${sc.sample - sc.agree} it disputed, the match was right but the relation type was too strong. No person has reviewed the matches.`
        : `A reviewer checked a random ${sc.sample} of the final matches and agreed with ${sc.agree} (${Math.round(sc.rate * 100)}%).`
      : "No person has reviewed these matches. Every match carries the one-line rationale behind it, shown in the area lookup and included in the downloads, so readers can judge each one.";

  const cards = [
    {
      eyebrow: "WCM departments & divisions",
      num: H.A.areas_with_home,
      den: H.A.areas_total,
      metric: "areas have a home unit",
      takeaway: `${H.A.departments_covered} of ${H.A.departments_total} departments are the home of at least one area. The other ${H.A.areas_low_volume} areas have an aligned unit with too few papers to call.`,
      src: "department",
    },
    {
      eyebrow: "CARE Strategic Plan",
      num: H.B.items_matched,
      den: H.B.items_in_scope,
      metric: "scientific items match an area",
      takeaway: `The plan names capabilities such as AI, imaging and clinical research rather than research domains, so it corroborates the map only weakly. ${H.B.areas_matched} of ${H.A.areas_total} areas touch it.`,
      src: "B",
    },
    {
      eyebrow: "NIH Institutes & Centers",
      num: H.C1.ics_matched,
      den: H.C1.ics_total,
      metric: "grant-funding ICs match an area",
      takeaway: `${H.C1.areas_matched} of ${H.A.areas_total} areas map to an IC. The ${H.A.areas_total - H.C1.areas_matched} that don’t are methods and cross-cutting fields NIH doesn’t organize ICs around.`,
      src: "C1",
    },
    {
      eyebrow: "NIH RCDC categories",
      num: H.C2.categories_matched,
      den: H.C2.categories_total,
      metric: "spending categories fall under an area",
      takeaway: `${H.C2.areas_matched} of ${H.A.areas_total} areas match a category, ${H.C2.areas_exact} of them exactly.`,
      src: "C2",
    },
  ];

  const hrefFor = (date: string) =>
    date === latest ? "/about/research-areas" : `/about/research-areas/${date}`;

  return (
    <main className="mx-auto box-border flex w-full max-w-[1120px] flex-col gap-14 px-6 pt-7 pb-16 text-[var(--apollo-ink)]">
      <section aria-label="Introduction" className="flex flex-col gap-4">
        <nav aria-label="Breadcrumb" className="text-muted-foreground flex gap-1.5 text-[13px]">
          <Link href="/about" className="underline underline-offset-2">
            About
          </Link>
          <span aria-hidden>/</span>
          <span>Research areas compared</span>
        </nav>
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div className="flex max-w-[720px] flex-col gap-3">
            <h1 className="text-[32px] leading-tight font-semibold text-balance">
              How our research areas compare with outside reference points
            </h1>
            <p className="text-base leading-relaxed text-pretty text-[var(--apollo-ink-2)]">
              Scholars describes each person&apos;s work with research areas derived from their
              publications. This page compares those {H.A.areas_total} areas with Weill
              Cornell&apos;s departments and divisions, the CARE Strategic Plan 2026–2029, and
              NIH&apos;s Institutes, Centers and spending categories. For background on how the site
              works, see{" "}
              <Link href="/about#research-areas" className="underline underline-offset-2">
                About Scholars
              </Link>
              .
            </p>
          </div>
          <div className="flex min-w-[220px] flex-col gap-1.5">
            <span
              id="snap-label"
              className="text-muted-foreground text-xs font-semibold tracking-wider uppercase"
            >
              Snapshot
            </span>
            <Select value={s.snapshot_date} onValueChange={(v) => router.push(hrefFor(v))}>
              <SelectTrigger
                aria-labelledby="snap-label"
                className="w-[220px] bg-[var(--apollo-surface)]"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {snapshots.map((x, i) => (
                  <SelectItem key={x.date} value={x.date}>
                    {x.date}
                    {i === 0 ? " (current)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        {isOld && (
          <Alert>
            <AlertDescription>
              <span>
                This is the {s.snapshot_date} snapshot. The current one is{" "}
                <Link href="/about/research-areas" className="underline underline-offset-2">
                  {latest}
                </Link>
                .
              </span>
            </AlertDescription>
          </Alert>
        )}
        <nav
          aria-label="On this page"
          className="flex flex-wrap gap-x-[18px] gap-y-1.5 border-y border-[var(--apollo-border)] py-3 text-sm [&_a]:underline [&_a]:underline-offset-2"
        >
          <a href="#summary">Summary</a>
          <a href="#entries">Look up a department or NIH entry</a>
          <a href="#areas">Look up a research area</a>
          <a href="#heatmap">Departments heatmap</a>
          <a href="#gaps">Gaps</a>
          <a href="#method">How this was done</a>
        </nav>
      </section>

      <Section id="summary" title="Summary">
        <p className={LEAD}>
          As of {month}, the research-area map lines up well with Weill Cornell&apos;s departments
          and with both NIH schemes. The CARE plan is too coarse to test it.
        </p>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-4">
          {cards.map((c) => (
            <div key={c.src} className={`${CARD} flex flex-col gap-2.5 p-5`}>
              <div className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">
                {c.eyebrow}
              </div>
              <div className="flex flex-wrap items-baseline gap-1.5">
                <span className="text-[34px] leading-none font-semibold tabular-nums">{c.num}</span>
                <span className="text-[15px] text-[var(--apollo-ink-2)]">of {c.den}</span>
              </div>
              <div className="text-sm font-semibold">{c.metric}</div>
              <p className="flex-1 text-sm leading-normal text-pretty text-[var(--apollo-ink-2)]">
                {c.takeaway}
              </p>
              <Button
                variant="link"
                size="sm"
                className="h-auto self-start px-0"
                onClick={() => go(c.src)}
              >
                See these entries →
              </Button>
            </div>
          ))}
        </div>
        <div
          aria-label="How to read relations"
          className="flex flex-col gap-2.5 rounded-[10px] border border-[var(--apollo-border-strong)] bg-[var(--apollo-surface-2)] px-5 py-4"
        >
          <div className="text-[13px] font-semibold">
            How to read matches. Relations are stated from the research area&apos;s side.
          </div>
          <dl className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-x-5 gap-y-2 text-[13px] leading-snug">
            {[
              ["exact match", "same field"],
              ["contains it", "the entry sits inside the area"],
              ["part of it", "the area sits inside the entry"],
              ["partial overlap", "they share some ground"],
            ].map(([t, dd]) => (
              <div key={t}>
                <dt className="inline font-semibold">{t}</dt>
                <dd className="inline text-[var(--apollo-ink-2)]"> · {dd}</dd>
              </div>
            ))}
            <div>
              <dt className="inline border-b border-dashed border-[var(--apollo-amber)] font-semibold">
                added on review
              </dt>
              <dd className="inline text-[var(--apollo-ink-2)]">
                {" "}
                · found only by the gap review, may be discounted
              </dd>
            </div>
          </dl>
        </div>
      </Section>

      <Section id="entries" title="Look up a department or NIH entry">
        <p className={LEAD}>
          Every department, division, CARE plan item, NIH Institute or Center and RCDC category, and
          the research areas that represent it.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <div className="max-w-[360px] flex-[1_1_260px]">
            <Input
              type="search"
              placeholder="Search entries or areas"
              aria-label="Search entries"
              value={entryQ}
              onChange={(e) => {
                setEntryQ(e.target.value);
                setEntryLimit(25);
              }}
              className="bg-[var(--apollo-surface)]"
            />
          </div>
          <div role="group" aria-label="Source" className="flex flex-wrap gap-1.5">
            {SRC.map(([k, l]) => (
              <Button
                key={k}
                size="sm"
                variant={entrySrc === k ? "apollo" : "outline"}
                aria-pressed={entrySrc === k}
                onClick={() => {
                  setEntrySrc(k);
                  setEntryHow("all");
                  setEntryLimit(25);
                }}
              >
                {l}
              </Button>
            ))}
          </div>
          <Select
            value={entryHow}
            onValueChange={(v) => {
              setEntryHow(v);
              setEntryLimit(25);
            }}
          >
            <SelectTrigger
              aria-label="How represented"
              className="w-[230px] bg-[var(--apollo-surface)]"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any representation</SelectItem>
              {howKeys.map((k) => (
                <SelectItem key={k} value={k}>
                  {HOW[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="text-muted-foreground flex flex-wrap items-center justify-between gap-3 text-[13px]">
          <span aria-live="polite">
            Showing {Math.min(entryLimit, fe.length)} of {fe.length} entries
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const h = [
                "source",
                "entry",
                "detail",
                "how_represented",
                "match_basis",
                "represented_by",
              ];
              download(
                `research-areas-crosswalk-${s.snapshot_date}-filtered.csv`,
                [h.join(",")]
                  .concat(
                    fe.map((e) =>
                      [
                        e.source,
                        e.entry,
                        e.detail,
                        HOW[e.howKey],
                        e.basis,
                        e.reps
                          .map((r) => `${r.label} (${r.rel}${r.review ? ", added on review" : ""})`)
                          .join("; "),
                      ]
                        .map(csvq)
                        .join(","),
                    ),
                  )
                  .join("\n"),
              );
            }}
          >
            Download CSV
          </Button>
        </div>
        <div className="overflow-x-auto rounded-[10px] border border-[var(--apollo-border)] bg-[var(--apollo-surface)]">
          <table className="w-full min-w-[760px] border-collapse text-sm">
            <thead>
              <tr className="bg-[var(--apollo-surface-2)]">
                <th scope="col" className={`${TH} w-[130px]`}>
                  Source
                </th>
                <th scope="col" className={TH}>
                  Entry
                </th>
                <th scope="col" className={`${TH} w-[170px]`}>
                  How represented
                </th>
                <th scope="col" className={TH}>
                  Matching areas
                </th>
                <th scope="col" className={`${TH} w-[130px]`}>
                  Match basis
                </th>
              </tr>
            </thead>
            <tbody>
              {fe.slice(0, entryLimit).map((e) => (
                <tr
                  key={`${e.src}|${e.detail}|${e.entry}`}
                  className="border-t border-[var(--apollo-border)] align-top"
                >
                  <td className="px-3.5 py-3 text-[13px] text-[var(--apollo-ink-2)]">{e.source}</td>
                  <th scope="row" className="px-3.5 py-3 text-left font-semibold">
                    <div>{e.entry}</div>
                    <div className="text-muted-foreground mt-0.5 text-xs font-normal">
                      {e.detail}
                    </div>
                  </th>
                  <td className="px-3.5 py-3">
                    <Badge variant={HOWV[e.howKey]} className="text-left whitespace-normal">
                      {HOW[e.howKey]}
                    </Badge>
                  </td>
                  <td className="px-3.5 py-3">
                    <div className="flex flex-col gap-1 text-[13px] leading-snug">
                      {e.reps.map((r) => (
                        <div
                          key={r.label + r.rel}
                          className="flex flex-wrap items-baseline gap-x-2 gap-y-1"
                        >
                          <MaybeLink href={r.href} className="underline underline-offset-2">
                            {r.label}
                          </MaybeLink>
                          <span className="text-[var(--apollo-ink-2)]">{r.rel}</span>
                          {r.review && REVIEW}
                        </div>
                      ))}
                      {!e.reps.length && (
                        <span className="text-muted-foreground">
                          {e.howKey === "out_of_scope"
                            ? "Operational, not a research domain"
                            : "No matching area"}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-3.5 py-3 text-[13px] text-[var(--apollo-ink-2)]">{e.basis}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!fe.length && (
            <div className="text-muted-foreground p-6 text-center text-sm">
              No entries match these filters.
            </div>
          )}
        </div>
        {fe.length > entryLimit && (
          <div className="flex justify-center">
            <Button variant="outline" onClick={() => setEntryLimit(entryLimit + 25)}>
              Show 25 more
            </Button>
          </div>
        )}
      </Section>

      <Section id="areas" title="Look up a research area">
        <p className={LEAD}>
          Pick an area to see its home units and its counterparts in the CARE plan and both NIH
          schemes.
        </p>
        <div className="flex flex-wrap items-start gap-5">
          <div className="flex max-w-[340px] flex-[1_1_260px] flex-col gap-2.5">
            <Input
              type="search"
              placeholder={`Filter ${s.areas.length} areas`}
              aria-label="Filter research areas"
              value={areaQ}
              onChange={(e) => setAreaQ(e.target.value)}
              className="bg-[var(--apollo-surface)]"
            />
            <div className="flex max-h-[560px] flex-col overflow-y-auto rounded-[10px] border border-[var(--apollo-border)] bg-[var(--apollo-surface)]">
              {d.areasSorted
                .filter((a) => !aq || a.label.toLowerCase().includes(aq))
                .map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    aria-pressed={a.id === A.id}
                    onClick={() => setAreaSel(a.id)}
                    className={`flex cursor-pointer justify-between gap-2.5 border-b border-[var(--apollo-border)] px-3.5 py-2 text-left text-sm hover:bg-[var(--apollo-surface-2)] focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--apollo-ring)] ${
                      a.id === A.id ? "bg-[var(--apollo-rail)] font-semibold" : ""
                    }`}
                  >
                    <span>{a.label}</span>
                    <span className="text-muted-foreground text-xs tabular-nums">{a.papers}</span>
                  </button>
                ))}
            </div>
          </div>
          <div
            aria-live="polite"
            className={`${CARD} flex min-w-0 flex-[999_1_420px] flex-col gap-[22px] p-6`}
          >
            <div className="flex flex-col gap-1.5">
              <div className="flex flex-wrap items-baseline justify-between gap-2.5">
                <h3 className="text-[22px] font-semibold">{A.label}</h3>
                {links.areas[A.id] && (
                  <a href={links.areas[A.id]} className="text-sm underline underline-offset-2">
                    Topic page →
                  </a>
                )}
              </div>
              <div className="text-sm text-[var(--apollo-ink-2)]">
                {A.papers} papers in the scored corpus · largest share in {A.largest_dept}
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <h4 className={H4}>Home units</h4>
              <p className="text-[13px] leading-normal text-[var(--apollo-ink-2)]">
                Units where this area&apos;s papers are at least twice as common as the unit&apos;s
                size would predict.
              </p>
              {homeCells.map((c) => {
                const u = d.unit[c.unit];
                const home = c.n >= th.min_papers;
                return (
                  <div
                    key={c.unit}
                    className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-[var(--apollo-border)] py-1.5 text-sm"
                  >
                    <MaybeLink
                      href={links.units[c.unit]}
                      className="flex-[1_1_220px] font-semibold"
                    >
                      {u?.name ?? c.unit}
                    </MaybeLink>
                    <span className="text-[var(--apollo-ink-2)] tabular-nums">
                      {f1(c.lift)}× expected · {c.n} papers
                    </span>
                    <Badge variant={home ? "default" : "outline"}>
                      {home ? "Home" : "Under 25 papers"}
                    </Badge>
                  </div>
                );
              })}
              {!homeCells.length && (
                <div className="text-sm text-[var(--apollo-ink-2)]">
                  No unit has a lift of 2 or more for this area.
                </div>
              )}
              {A.unit_status === "low_volume" && (
                <div className="rounded-lg bg-[var(--apollo-surface-2)] px-3 py-2 text-[13px] text-[var(--apollo-ink-2)]">
                  {LOWNOTE[A.id] ?? "Aligned unit, but under 25 papers."}
                </div>
              )}
            </div>
            {frames.map(([k, title, empty]) => {
              const items = aPairs.filter((p) => p.frame === k);
              return (
                <div key={k} className="flex flex-col gap-2">
                  <h4 className={H4}>{title}</h4>
                  {items.map((p) => (
                    <div
                      key={p.ref}
                      className="flex flex-col gap-0.5 border-b border-[var(--apollo-border)] py-1.5 text-sm"
                    >
                      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                        <span className="font-semibold">
                          {d.ref[`${k}|${p.ref}`]?.name ?? p.ref}
                        </span>
                        <span className="text-[var(--apollo-ink-2)]">{SHORT[p.relation]}</span>
                        {p.source === "gap_review" && REVIEW}
                      </div>
                      <div className="text-muted-foreground text-[13px] leading-snug">
                        {p.rationale}
                      </div>
                    </div>
                  ))}
                  {!items.length && (
                    <div className="text-sm text-[var(--apollo-ink-2)]">{empty}</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </Section>

      <Section id="heatmap" title="Departments heatmap">
        <p className={LEAD}>
          Each cell compares how many of an area&apos;s papers come from a unit with what you&apos;d
          expect from the unit&apos;s size alone. This ratio is called lift: 1× is what you&apos;d
          expect, and 3× means three times as many papers as expected. A unit is an area&apos;s home
          when it has at least {th.lift}× the expected share, on at least {th.min_papers} papers.
          Hover a cell, or focus the grid and use the arrow keys, to read its values. Select a cell
          to open that area above.
        </p>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div role="group" aria-label="Unit level" className="flex gap-1.5">
            {(
              [
                ["department", "Departments"],
                ["division", "Divisions"],
              ] as const
            ).map(([k, l]) => (
              <Button
                key={k}
                size="sm"
                variant={level === k ? "apollo" : "outline"}
                aria-pressed={level === k}
                onClick={() => {
                  setLevel(k);
                  setHm(null);
                }}
              >
                {l}
              </Button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3.5 text-xs text-[var(--apollo-ink-2)]">
            <span className="flex items-center gap-1.5">
              <span className="size-3.5 rounded-[3px] border border-[var(--apollo-border)] bg-[var(--apollo-surface-2)]" />
              under 1× expected
            </span>
            <span className="flex items-center gap-1.5">
              <span className="size-3.5 rounded-[3px] border border-[var(--apollo-slate-tint-border)] bg-[var(--apollo-slate-tint)]" />
              1–2×
            </span>
            <span className="flex items-center gap-1.5">
              <span className="grid size-3.5 place-items-center rounded-[3px] border border-[var(--apollo-amber)] bg-[var(--apollo-amber-tint)] text-[9px] text-[var(--apollo-amber)]">
                ○
              </span>
              2× or more, under 25 papers
            </span>
            <span className="flex items-center gap-1.5">
              {[55, 78, 100].map((p) => (
                <span
                  key={p}
                  className="grid size-3.5 place-items-center rounded-[3px] text-[9px] text-white"
                  style={{
                    background:
                      p === 100
                        ? "var(--apollo-slate)"
                        : `color-mix(in oklch, var(--apollo-slate) ${p}%, white)`,
                  }}
                >
                  {p === 55 ? "●" : ""}
                </span>
              ))}
              home unit: 2–4×, 4–8×, 8× or more
            </span>
          </div>
        </div>
        <div
          aria-live="polite"
          className="flex min-h-11 flex-wrap items-baseline gap-x-3.5 gap-y-1 rounded-lg border border-[var(--apollo-border)] bg-[var(--apollo-surface)] px-3.5 py-2.5 text-sm"
        >
          {hm && rows[hm.r] && cols[hm.c] ? (
            <>
              <span className="font-semibold">
                {rows[hm.r].label} × {cols[hm.c].name}
              </span>
              <span className="text-[var(--apollo-ink-2)] tabular-nums">
                {hmCell
                  ? `${hmCell.n} papers · ${(hmCell.share * 100).toFixed(1)}% of the area's papers · ${f1(hmCell.lift)}× expected (lift) · ${cellStyle(hmCell, th).k}`
                  : "No papers from this unit"}
              </span>
            </>
          ) : (
            <>
              <span className="font-semibold">Hover or focus a cell</span>
              <span className="text-[var(--apollo-ink-2)]">Values appear here.</span>
            </>
          )}
        </div>
        <div className="relative max-h-[640px] overflow-auto rounded-[10px] border border-[var(--apollo-border)] bg-[var(--apollo-surface)]">
          <div
            role="grid"
            aria-label={`Lift by research area and ${level}. Use arrow keys to move between cells.`}
            aria-activedescendant={hm ? `hm-${hm.r}-${hm.c}` : undefined}
            tabIndex={0}
            onKeyDown={hmKey}
            onFocus={() => !hm && setHm({ r: 0, c: 0 })}
            onMouseOver={(e) => {
              const t = (e.target as HTMLElement).closest<HTMLElement>("[data-r]");
              if (t) setHm({ r: Number(t.dataset.r), c: Number(t.dataset.c) });
            }}
            onClick={(e) => {
              const t = (e.target as HTMLElement).closest<HTMLElement>("[data-r]");
              if (t) openArea(rows[Number(t.dataset.r)].id);
            }}
            className="inline-block min-w-full outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--apollo-ring)]"
          >
            <div role="row" className="sticky top-0 z-[2] flex bg-[var(--apollo-surface)]">
              <div
                role="columnheader"
                className="text-muted-foreground sticky left-0 z-[3] box-border flex w-60 flex-none items-end border-b border-[var(--apollo-border)] bg-[var(--apollo-surface)] px-3 pb-2 text-xs"
              >
                Research area
              </div>
              {cols.map((u, ci) => (
                <div
                  key={u.id}
                  role="columnheader"
                  className="box-border flex w-6 flex-none items-end justify-center border-b border-[var(--apollo-border)] pb-2"
                  style={{
                    height: level === "division" ? 250 : 240,
                    background: hm?.c === ci ? "var(--apollo-rail)" : "var(--apollo-surface)",
                  }}
                >
                  <MaybeLink
                    href={links.units[u.id]}
                    className="rotate-180 text-xs whitespace-nowrap text-[var(--apollo-ink)] no-underline [writing-mode:vertical-rl]"
                  >
                    <span title={u.name}>{shortName(u)}</span>
                  </MaybeLink>
                </div>
              ))}
            </div>
            {rows.map((a, ri) => (
              <div key={a.id} role="row" className="flex">
                <div
                  role="rowheader"
                  className="sticky left-0 z-[1] box-border flex h-6 w-60 flex-none items-center overflow-hidden border-r border-[var(--apollo-border)] px-3 text-xs text-ellipsis whitespace-nowrap"
                  style={{
                    background: hm?.r === ri ? "var(--apollo-rail)" : "var(--apollo-surface)",
                  }}
                >
                  <MaybeLink
                    href={links.areas[a.id]}
                    className="overflow-hidden text-ellipsis text-[var(--apollo-ink)] no-underline"
                  >
                    {a.label}
                  </MaybeLink>
                </div>
                {cols.map((u, ci) => {
                  const c = d.cell[`${a.id}|${u.id}`];
                  const cs = cellStyle(c, th);
                  const on = hm?.r === ri && hm?.c === ci;
                  return (
                    <div
                      key={u.id}
                      id={`hm-${ri}-${ci}`}
                      role="gridcell"
                      data-r={ri}
                      data-c={ci}
                      aria-label={`${a.label}, ${u.name}: ${c ? `${f1(c.lift)} times expected, ${c.n} papers` : "no papers"}`}
                      className="box-border grid size-6 flex-none cursor-pointer place-items-center rounded border-2 border-[var(--apollo-surface)] text-[9px]"
                      style={{
                        background: cs.bg,
                        color: cs.fg,
                        outline: on ? "2px solid var(--apollo-ring)" : "none",
                        outlineOffset: -1,
                      }}
                    >
                      {cs.g}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
        <p className="text-muted-foreground text-[13px]">
          The same values are listed per area in{" "}
          <a href="#areas" className="underline underline-offset-2">
            Look up a research area
          </a>{" "}
          and can be downloaded below.
        </p>
        <div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const out = [
                ["area", "unit_level", "unit", "unit_name", "papers", "share", "lift"].join(","),
              ];
              for (const a of rows)
                for (const u of cols) {
                  const c = d.cell[`${a.id}|${u.id}`];
                  if (c)
                    out.push(
                      [a.label, u.level, u.id, u.name, c.n, c.share, c.lift].map(csvq).join(","),
                    );
                }
              download(`research-areas-${level}-lift-${s.snapshot_date}.csv`, out.join("\n"));
            }}
          >
            Download heatmap CSV
          </Button>
        </div>
      </Section>

      <Section id="gaps" title="Gaps" className="gap-5">
        <p className={LEAD}>
          Every place the map and the references don&apos;t line up. A{" "}
          <strong>structural difference</strong> means the two schemes are organized differently. A{" "}
          <strong>real gap</strong> means a field the reference names has no area on our map.
        </p>
        {gaps.map((g) => (
          <div
            key={g.title}
            className="flex flex-col gap-3.5 rounded-[var(--apollo-radius-card)] border border-[var(--apollo-border)] bg-[var(--apollo-surface)] px-6 py-5"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
              <h3 className="text-[17px] font-semibold">{g.title}</h3>
              <span className="text-muted-foreground text-[13px]">{g.count}</span>
            </div>
            {g.groups.map((gr) => (
              <div key={gr.name} className="grid gap-2 border-t border-[var(--apollo-border)] pt-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold">{gr.name}</span>
                  <Badge variant={gr.variant}>{gr.kind}</Badge>
                </div>
                <p className="max-w-[760px] text-sm leading-normal text-[var(--apollo-ink-2)]">
                  {gr.why}
                </p>
                <ul className="flex flex-wrap gap-1.5">
                  {gr.items.map((i) => (
                    <li
                      key={i.label}
                      className="rounded-full border border-[var(--apollo-border)] bg-[var(--apollo-surface-2)] px-2.5 py-[3px] text-[13px]"
                    >
                      <MaybeLink href={i.href} className="text-[var(--apollo-ink)] no-underline">
                        {i.label}
                      </MaybeLink>
                      <span className="text-muted-foreground">{i.meta}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ))}
      </Section>

      <Section id="method" title="How this was done" className="max-w-[760px]">
        <div className="flex flex-col gap-3 text-[15px] leading-relaxed">
          <p>
            <strong>Departments and divisions</strong> come straight from publication data, with no
            judgement involved. For each area we count papers (academic articles from 2020 on with a
            Weill Cornell faculty member as first or last author) by the primary unit of each
            author. A unit is an area&apos;s home when the area&apos;s papers are at least twice as
            common there as the unit&apos;s size would predict (a &ldquo;lift&rdquo; of {th.lift} or
            more), on at least {th.min_papers} papers. The result barely moves when the thresholds
            change.
          </p>
          <p>
            <strong>The CARE plan and NIH comparisons</strong> need judgement. Two independent AI
            mapping runs (Claude, each in a fresh context) matched areas to reference entries, one
            working entry by entry and the other area by area. Neither saw the other&apos;s answers,
            and both were told that &ldquo;no counterpart&rdquo; is a valid answer. A third run
            decided every disagreement, and a fourth re-checked everything still unmatched. Matches
            found only by that last review are marked {REVIEW}.
          </p>
          <p>
            <strong>Review.</strong> {spotText}
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <h3 className="text-[15px] font-semibold">Agreement between the two mapping runs</h3>
          <div className="overflow-x-auto rounded-[10px] border border-[var(--apollo-border)] bg-[var(--apollo-surface)]">
            <table className="w-full min-w-[520px] border-collapse text-sm">
              <thead>
                <tr className="bg-[var(--apollo-surface-2)] text-xs">
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    Reference
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">
                    Positive agreement
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">
                    Disagreements decided
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">
                    Added on review
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">
                    Final matches
                  </th>
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    ["B", "CARE Strategic Plan"],
                    ["C1", "NIH Institutes & Centers"],
                    ["C2", "NIH RCDC categories"],
                  ] as const
                ).map(([k, n]) => {
                  const a = s.agreement[k];
                  return (
                    <tr key={k} className="border-t border-[var(--apollo-border)] tabular-nums">
                      <th scope="row" className="px-3 py-2 text-left font-semibold">
                        {n}
                      </th>
                      <td className="px-3 py-2 text-right">
                        {Math.round(a.positive_agree * 100)}%
                      </td>
                      <td className="px-3 py-2 text-right">{a.adjudicated}</td>
                      <td className="px-3 py-2 text-right">{a.gap_review_added}</td>
                      <td className="px-3 py-2 text-right">{a.final_pairs}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-muted-foreground text-[13px] leading-normal">
            Positive agreement is the share of matches both runs proposed. Most area–entry
            combinations are unrelated, so it is a stricter measure than overall agreement.
          </p>
        </div>
        <div className="flex flex-col gap-1.5 text-sm [&_a]:underline [&_a]:underline-offset-2">
          <h3 className="text-[15px] font-semibold">Full audit trail</h3>
          <a href={s.methods_url}>Methods README, with prompts and code</a>
          <a href={s.crosswalk_url}>Crosswalk CSV for this snapshot</a>
          <a href={s.outputs_url}>Raw outputs</a>
          <div className="mt-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                download(
                  `benchmark-${s.snapshot_date}.json`,
                  JSON.stringify(s, null, 1),
                  "application/json",
                )
              }
            >
              Download snapshot JSON
            </Button>
          </div>
        </div>
        <p className="text-muted-foreground text-[13px]">
          Snapshot {s.snapshot_date} · {s.taxonomy_version} ·{" "}
          <Link href="/about" className="underline underline-offset-2">
            Back to About
          </Link>
        </p>
      </Section>
    </main>
  );
}
