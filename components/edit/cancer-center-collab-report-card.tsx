/**
 * CancerCenterCollabReportCard — the Cancer Center Reports tab
 * (`2026-08-10-cancer-center-collaboration-recommendations-v2-cancer-
 * relevance-plan.md`), under the `reports` attribute of `/edit/center/[code]`
 * (data-driven "has a program taxonomy" gate, same as Programs/NCI Table 2A).
 *
 * A small list/detail shell — `REPORTS` below is the index of everything this
 * tab can show; today there's exactly one. Click a report to open it, "All
 * reports" to go back. Adding a second report is: one more `REPORTS` entry +
 * one more component, not a rewrite of this shell.
 *
 * `CollabCancerRelevanceReport` reads the precomputed `CenterCollabCandidate`
 * table (weekly ETL) via `/api/edit/center/[code]/collab-report` — one fetch,
 * no MeSH matching or DB work at request time. Three sections, all derived
 * client-side from the same loaded rows:
 *   REMOVE                        — current member, zero collaboration. Fixed,
 *                                    not slider-driven (unchanged from v1).
 *   ADD (collaborator + relevant) — non-member, clears BOTH the collaboration
 *                                    AND cancer-relevance bar (AND-gated).
 *   ADD (recruit)                 — non-member, clears the cancer-relevance
 *                                    bar alone AND does NOT already clear the
 *                                    collaboration bar (exclusive of the row
 *                                    above — "not yet connected" is the point).
 * Two threshold controls (collaboration, cancer-relevance), each a
 * percentage/raw-count mode toggle + slider, drive both ADD sections. Each
 * section and control carries a (?) hover explaining the logic in place.
 *
 * Advisory only — no writes. A human applies any recommendation through the
 * existing `/edit` roster editor.
 */
"use client";

import * as React from "react";
import { Download, HelpCircle } from "lucide-react";

import { EditPanel } from "@/components/edit/edit-panel";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { HoverTooltip } from "@/components/ui/hover-tooltip";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ADD_THRESHOLD, pct } from "@/lib/center-collaboration/recommendations-core";
import type { TopicDetail } from "@/lib/cancer-taxonomy";

/** (?) icon that reveals `text` on hover/focus — the "explain the logic here"
 *  affordance next to each section heading / threshold control. */
function InfoHover({ text, label }: { text: string; label: string }) {
  return (
    <HoverTooltip text={text} wide>
      <button
        type="button"
        aria-label={label}
        className="inline-flex size-4 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
      >
        <HelpCircle className="size-3.5" />
      </button>
    </HoverTooltip>
  );
}

type Row = {
  cwid: string;
  surname: string;
  givenName: string;
  primaryDepartment: string;
  totalPapersPostCutoff: number;
  collaborationsWithCenter: number;
  cancerRelatedPapers: number;
  isCurrentMember: boolean;
  currentProgramCode: string | null;
};

type LoadedState = { generatedAt: string | null; rows: Row[] };

type Mode = "percent" | "count";

/** Does `row` clear a threshold on `count` (out of `totalPapersPostCutoff`)? */
function clears(row: Row, count: number, mode: Mode, value: number): boolean {
  return mode === "percent" ? pct(count, row.totalPapersPostCutoff) >= value : count >= value;
}

function ThresholdControl({
  label,
  info,
  mode,
  onModeChange,
  value,
  onValueChange,
  max,
}: {
  label: string;
  info: string;
  mode: Mode;
  onModeChange: (m: Mode) => void;
  value: number;
  onValueChange: (v: number) => void;
  max: number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="inline-flex items-center gap-1 font-medium">
        {label}:
        <InfoHover text={info} label={`About the ${label} threshold`} />
      </span>
      <select
        value={mode}
        onChange={(e) => {
          const next = e.target.value as Mode;
          onModeChange(next);
          if (next === "percent") onValueChange(Math.min(value, 100));
        }}
        className="rounded border border-input bg-background px-1.5 py-0.5 text-xs"
      >
        <option value="count">raw count</option>
        <option value="percent">percentage</option>
      </select>
      <input
        type="range"
        min={0}
        max={mode === "percent" ? 100 : max}
        value={value}
        onChange={(e) => onValueChange(Number(e.target.value))}
        className="w-32"
      />
      <span className="w-12 tabular-nums text-muted-foreground">
        {value}
        {mode === "percent" ? "%" : ""}
      </span>
    </div>
  );
}

function SectionHeading({ text, info }: { text: string; info: string }) {
  return (
    <h3 className="mb-2 inline-flex items-center gap-1.5 text-sm font-semibold">
      {text}
      <InfoHover text={info} label={`About ${text}`} />
    </h3>
  );
}

type TaxonomySummary = {
  topics: TopicDetail[];
  totalRelevant: number;
  ruleCount: number;
  meshRelease: string | null;
};

const RULESET_URL = "https://github.com/wcmc-its/Scholars-Profile-System/blob/master/docs/cancer-taxonomy-ruleset.csv";
const GENERATOR_DOC_URL =
  "https://github.com/wcmc-its/Scholars-Profile-System/blob/master/docs/cancer-taxonomy-generator.md";

/** Section header inside the modal's prose — plain weight, no (?) hover
 *  (unlike `SectionHeading` above, which is for the report's own collapsible
 *  sections). */
function ModalSectionHeading({ children }: { children: React.ReactNode }) {
  return <h3 className="text-sm font-semibold text-foreground">{children}</h3>;
}

/**
 * "How cancer-relevance is determined" — states the two independent axes
 * (cancer-relevant at all vs. which topic) as separate callouts, the
 * subtree-matching mechanism, why an experimental-model paper loses its site
 * topic, why a defined/versioned method matters for NCI CCSG reporting, and
 * a collapsible list of every topic bucket with a live descriptor
 * count + sample. Fetched lazily (only once the dialog opens) from
 * `/api/edit/cancer-center-mesh-taxonomy`, which builds this from the SAME
 * `topicsByUi` lookup the weekly ETL step and CSV export match against — so
 * this can't show a broader or narrower set than what's actually counted.
 *
 * The left-border accent colors (WCM red for "is it relevant at all", amber
 * for "which topic") are the first hardcoded brand colors in this app — no
 * existing `--primary`/token maps to WCM red today, so they're arbitrary-
 * value Tailwind classes local to this component rather than a new global
 * token, matching this component's existing utility-class-only pattern.
 */
function MeshLogicModal() {
  const [open, setOpen] = React.useState(false);
  const [data, setData] = React.useState<TaxonomySummary | null>(null);
  const [error, setError] = React.useState(false);
  const [listOpen, setListOpen] = React.useState(false);

  React.useEffect(() => {
    if (!open || data || error) return;
    (async () => {
      try {
        const res = await fetch("/api/edit/cancer-center-mesh-taxonomy");
        if (!res.ok) {
          setError(true);
          return;
        }
        setData(await res.json());
      } catch {
        setError(true);
      }
    })();
  }, [open, data, error]);

  // "unassigned" is a real bucket (a relevant descriptor with no site/cc-
  // topic) but isn't a disease-site OR a cross-cutting cc- bucket itself —
  // excluded from both counts below so the intro prose's "N site buckets
  // plus M cc- buckets" stays literally additive.
  const siteCount = data?.topics.filter((t) => !t.topic.startsWith("cc-") && t.topic !== "unassigned").length;
  const ccCount = data?.topics.filter((t) => t.topic.startsWith("cc-")).length;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <HelpCircle className="size-3.5" aria-hidden />
          How cancer-relevance is determined
        </button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>How cancer-relevance is determined</DialogTitle>
          <DialogDescription>
            {data
              ? `${data.totalRelevant} cancer-relevant descriptors from ${data.ruleCount} ruleset rows${
                  data.meshRelease ? ` · Resolved against ${data.meshRelease}` : ""
                }`
              : " "}
          </DialogDescription>
        </DialogHeader>

        <p className="text-sm text-muted-foreground">
          A paper counts toward this report&apos;s cancer-relevance axis when at least one of its MeSH terms is in
          the cancer taxonomy. The taxonomy is generated, not hand-picked: a checked-in ruleset of MeSH subtree
          rules is expanded against the full National Library of Medicine descriptor release into a complete,
          provenanced list.
        </p>
        <p className="text-sm text-muted-foreground">
          It answers two independent questions, and they should not be collapsed into one.
        </p>

        <div className="grid gap-3.5">
          <div className="rounded-md border border-border border-l-[3px] border-l-[#9d2235] p-4">
            <p className="mb-1 font-medium text-foreground">Is it cancer-relevant at all?</p>
            <p className="text-sm text-muted-foreground">
              All of MeSH&apos;s C04 (Neoplasms) subtree, minus <code className="text-xs">Cysts</code> and{" "}
              <code className="text-xs">Hamartoma</code>, which are non-neoplastic despite living there, plus
              curated non-C04 headings covering therapeutics, cancer control, tumor biology, and cancer-gene
              concepts. A few individual terms are readmitted against an exclusion — Dermoid Cyst, Tuberous
              Sclerosis, Cowden syndrome. This is the count the report keys on.
            </p>
          </div>
          <div className="rounded-md border border-border border-l-[3px] border-l-[#d97706] p-4">
            <p className="mb-1 font-medium text-foreground">Which topic does it belong to?</p>
            <p className="text-sm text-muted-foreground">
              A separate facet: {siteCount ?? "~25"} disease-site buckets plus {ccCount ?? "six"} cross-cutting{" "}
              <code className="text-xs">cc-</code> buckets. A descriptor can carry several topics, and can
              legitimately carry none — a cancer-relevant paper with no site-specific angle,{" "}
              <code className="text-xs">Carcinoma</code> itself for instance, is{" "}
              <code className="text-xs">unassigned</code> rather than a data gap. Topic counts do not sum to a
              total.
            </p>
          </div>
        </div>

        <ModalSectionHeading>Matching runs down the tree</ModalSectionHeading>
        <p className="text-sm text-muted-foreground">
          MeSH encodes every biomedical concept as a dotted tree number — <code className="text-xs">C04.588.180</code>{" "}
          for Breast Neoplasms — reading left to right from broad to specific. A subtree rule admits its anchor and
          everything beneath it, so a paper matches on any descendant term, not only on an exact hit against the
          named heading.
        </p>

        <ModalSectionHeading>Experimental models are relevant, but not to a site</ModalSectionHeading>
        <p className="text-sm text-muted-foreground">
          <code className="text-xs">Liver Neoplasms, Experimental</code> sits under both{" "}
          <code className="text-xs">Liver Neoplasms</code> and{" "}
          <code className="text-xs">Neoplasms, Experimental</code>. The generator strips the site topic from
          anything caught by the model-system sweep and routes it to{" "}
          <code className="text-xs">cc-experimental-models</code> only. A mouse-model paper is cancer research; it
          is not a liver cancer paper in the sense this report means.
        </p>

        <ModalSectionHeading>Why a defined method at all</ModalSectionHeading>
        <p className="text-sm text-muted-foreground">
          NCI treats cancer-relatedness as a matter of flexible interpretation and lets each center choose its own
          method, so long as that method is rigorous, described, and defensible in peer review. A generated
          taxonomy with a checked-in ruleset and a version pinned to both the ruleset and the MeSH release is what
          makes this one answerable: any count here traces back to the rule that produced it.
        </p>
        <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-sm">
          <a
            href="https://grants.nih.gov/grants/guide/pa-files/PAR-25-444.html"
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            CCSG announcement, Cancer Focus ↗
          </a>
          <a
            href="https://cancercenters.cancer.gov/sites/default/files/FAQsCCSG.pdf"
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            CCSG FAQ ↗
          </a>
          <a
            href="https://cancercenters.cancer.gov/sites/default/files/CCSGDataGuide.pdf"
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            CCSG Data Guide ↗
          </a>
        </div>

        <ModalSectionHeading>Changing it is a pull request</ModalSectionHeading>
        <p className="text-sm text-muted-foreground">
          The ruleset is checked-in data applied WCM-wide, not a per-center setting. Narrowing it to one
          center&apos;s scope means editing <code className="text-xs">docs/cancer-taxonomy-ruleset.csv</code>, and
          the working discipline there is to size a candidate rule against real WCM publication counts before
          adopting or rejecting it.
        </p>

        {error && <p className="text-sm text-destructive">Failed to load.</p>}
        {!error && !data && <p className="text-sm text-muted-foreground">Loading…</p>}

        {data && (
          <div className="flex flex-wrap items-center justify-between gap-4 border-t border-border pt-4">
            <div className="flex flex-col gap-1.5 text-sm">
              <a href={GENERATOR_DOC_URL} target="_blank" rel="noreferrer" className="font-medium underline">
                How the taxonomy is generated ↗
              </a>
              <a href={RULESET_URL} target="_blank" rel="noreferrer" className="font-medium underline">
                The full ruleset, all {data.ruleCount} rows ↗
              </a>
            </div>
            <button
              type="button"
              onClick={() => setListOpen((v) => !v)}
              className="min-w-[172px] whitespace-nowrap rounded-md border border-input px-3.5 py-1.5 text-sm text-foreground hover:bg-muted"
            >
              {listOpen ? "Hide topic buckets" : "View topic buckets"}
            </button>
          </div>
        )}

        {data && listOpen && (
          <div className="max-h-[420px] overflow-y-auto border-t border-border">
            <p className="px-1 py-3 text-xs text-muted-foreground">
              Every topic bucket, with a live count and a sample of the descriptors that carry it. The complete
              list of admitted descriptors and the note behind each rule live in the ruleset.
            </p>
            <ul className="divide-y divide-border text-sm">
              {data.topics.map((t) => (
                <li key={t.topic} className="flex gap-5 py-3">
                  <div className="w-[190px] shrink-0">
                    <p className="font-medium text-foreground">{t.topic}</p>
                  </div>
                  <p className="flex-1 text-muted-foreground">
                    {t.descriptorCount} descriptor{t.descriptorCount === 1 ? "" : "s"}
                    {t.exampleDescriptors.length > 0 && <>, including {t.exampleDescriptors.join(", ")}</>}
                    {t.descriptorCount > t.exampleDescriptors.length &&
                      ` (+${t.descriptorCount - t.exampleDescriptors.length} more)`}
                    .{" "}
                    <a href={RULESET_URL} target="_blank" rel="noreferrer" className="whitespace-nowrap underline">
                      Rules for this bucket ↗
                    </a>
                  </p>
                </li>
              ))}
            </ul>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

type SortKey = "name" | "department" | "papers" | "collab" | "relevant";

const SORTERS: Record<SortKey, (a: Row, b: Row) => number> = {
  name: (a, b) => `${a.givenName} ${a.surname}`.localeCompare(`${b.givenName} ${b.surname}`),
  department: (a, b) => a.primaryDepartment.localeCompare(b.primaryDepartment),
  papers: (a, b) => b.totalPapersPostCutoff - a.totalPapersPostCutoff,
  collab: (a, b) => b.collaborationsWithCenter - a.collaborationsWithCenter,
  relevant: (a, b) => b.cancerRelatedPapers - a.cancerRelatedPapers,
};

const TH_CLASS = "sticky top-0 z-10 bg-background py-1.5 pr-2";

/** A section's row list, filterable/sortable client-side — sections can run to 100+
 *  rows (a full-time-faculty-wide candidate pool), so a plain static table read as
 *  unnavigable. `ScrollArea` bounds each section's own height (same `md:h-[60vh]`
 *  convention as `publications-card.tsx`/`highlights-card.tsx`) with a sticky header,
 *  instead of every section stacking into one very long page. */
function RowTable({
  rows,
  centerCode,
  extraCol,
}: {
  rows: Row[];
  centerCode: string;
  extraCol?: (r: Row) => React.ReactNode;
}) {
  const [query, setQuery] = React.useState("");
  const [sort, setSort] = React.useState<SortKey>("name");

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    const pool = q
      ? rows.filter(
          (r) =>
            `${r.givenName} ${r.surname}`.toLowerCase().includes(q) ||
            r.primaryDepartment.toLowerCase().includes(q),
        )
      : rows;
    return [...pool].sort(SORTERS[sort]);
  }, [rows, query, sort]);

  if (rows.length === 0) return <p className="text-sm text-muted-foreground">None at this threshold.</p>;

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by name or department…"
          aria-label="Filter rows by name or department"
          className="h-8 max-w-56 text-xs"
        />
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          Sort
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="rounded border border-input bg-background px-1.5 py-0.5 text-xs text-foreground"
            aria-label="Sort rows by"
          >
            <option value="name">Name</option>
            <option value="department">Department</option>
            <option value="papers">Papers</option>
            <option value="collab">Collab.</option>
            <option value="relevant">Cancer-Related</option>
          </select>
        </label>
        <span className="text-xs text-muted-foreground">
          {filtered.length} of {rows.length}
        </span>
      </div>
      {filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground">No rows match &ldquo;{query}&rdquo;.</p>
      ) : (
        <ScrollArea className="md:h-[60vh]">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[600px] border-collapse text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className={TH_CLASS}>Name</th>
                  <th className={TH_CLASS}>Department</th>
                  <th className={`${TH_CLASS} text-right`}>Papers</th>
                  <th className={`${TH_CLASS} text-right`}>Collab.</th>
                  <th className={`${TH_CLASS} text-right`}>Cancer-Related</th>
                  {extraCol && <th className={TH_CLASS}>Program</th>}
                  <th className={TH_CLASS}>
                    <span className="sr-only">Download</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr key={r.cwid} className="border-b border-border/50">
                    <td className="py-1.5 pr-2">
                      {r.givenName} {r.surname}
                    </td>
                    <td className="py-1.5 pr-2">{r.primaryDepartment}</td>
                    <td className="py-1.5 pr-2 text-right">{r.totalPapersPostCutoff}</td>
                    <td className="py-1.5 pr-2 text-right">
                      {r.collaborationsWithCenter} ({pct(r.collaborationsWithCenter, r.totalPapersPostCutoff)}%)
                    </td>
                    <td className="py-1.5 pr-2 text-right">
                      {r.cancerRelatedPapers} ({pct(r.cancerRelatedPapers, r.totalPapersPostCutoff)}%)
                    </td>
                    {extraCol && <td className="py-1.5 pr-2">{extraCol(r)}</td>}
                    <td className="py-1.5 pr-2">
                      <a
                        href={`/api/edit/center/${encodeURIComponent(centerCode)}/collab-report/export?cwid=${encodeURIComponent(r.cwid)}`}
                        aria-label={`Download ${r.givenName} ${r.surname}'s papers (CSV)`}
                        title="Download this person's papers (CSV)"
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <Download className="size-3.5" aria-hidden />
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </ScrollArea>
      )}
    </div>
  );
}

function CollabCancerRelevanceReport({ centerCode }: { centerCode: string }) {
  const [state, setState] = React.useState<LoadedState | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [collabMode, setCollabMode] = React.useState<Mode>("count");
  const [collabValue, setCollabValue] = React.useState<number>(ADD_THRESHOLD);
  const [relevanceMode, setRelevanceMode] = React.useState<Mode>("count");
  const [relevanceValue, setRelevanceValue] = React.useState(3); // MIN_PUBS precedent (disease-taxonomy script)

  React.useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/edit/center/${encodeURIComponent(centerCode)}/collab-report`);
        if (!res.ok) {
          setError(`Failed to load (${res.status}).`);
          return;
        }
        setState(await res.json());
      } catch {
        setError("Failed to load.");
      }
    })();
  }, [centerCode]);

  const maxCollab = Math.max(1, ...(state?.rows.map((r) => r.collaborationsWithCenter) ?? [1]));
  const maxRelevant = Math.max(1, ...(state?.rows.map((r) => r.cancerRelatedPapers) ?? [1]));

  const remove = React.useMemo(
    () => state?.rows.filter((r) => r.isCurrentMember && r.collaborationsWithCenter === 0) ?? [],
    [state],
  );
  const collaboratorAndRelevant = React.useMemo(
    () =>
      state?.rows.filter(
        (r) =>
          !r.isCurrentMember &&
          clears(r, r.collaborationsWithCenter, collabMode, collabValue) &&
          clears(r, r.cancerRelatedPapers, relevanceMode, relevanceValue),
      ) ?? [],
    [state, collabMode, collabValue, relevanceMode, relevanceValue],
  );
  const recruit = React.useMemo(
    () =>
      state?.rows.filter(
        (r) =>
          !r.isCurrentMember &&
          clears(r, r.cancerRelatedPapers, relevanceMode, relevanceValue) &&
          !clears(r, r.collaborationsWithCenter, collabMode, collabValue),
      ) ?? [],
    [state, relevanceMode, relevanceValue, collabMode, collabValue],
  );

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }
  if (!state) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (state.rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No data yet — the weekly report (<code>etl:cancer-center-collab-report</code>) hasn&apos;t run for this
        center.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          Last refreshed: {new Date(state.generatedAt!).toLocaleString()}
        </p>
        <div className="flex flex-wrap items-center gap-4">
          <MeshLogicModal />
          {/* Plain `<a download>` — no JS/blob dance, the browser handles the
              download off the route's `Content-Disposition` header. */}
          <a
            href={`/api/edit/center/${encodeURIComponent(centerCode)}/collab-report/export`}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            aria-label="Download full report (CSV)"
          >
            <Download className="size-3.5" aria-hidden />
            Download full report (CSV)
          </a>
        </div>
      </div>

      <section>
        <SectionHeading
          text="REMOVE — active member, zero collaboration"
          info="Full-time faculty who are currently active research members of this center but have zero PubMed co-authorship with any of this center's other active research members. Fixed at zero — not adjustable by the sliders below, unchanged from the standalone v1 report."
        />
        <RowTable rows={remove} centerCode={centerCode} extraCol={(r) => r.currentProgramCode ?? "—"} />
      </section>

      <section>
        <div className="mb-2 flex flex-wrap gap-4">
          <ThresholdControl
            label="Collaboration"
            info="How many (or what percent) of a person's papers were co-authored with an active research member of this center. Drives both ADD sections below."
            mode={collabMode}
            onModeChange={setCollabMode}
            value={collabValue}
            onValueChange={setCollabValue}
            max={maxCollab}
          />
          <ThresholdControl
            label="Cancer-relevance"
            info="How many (or what percent) of a person's papers carry a MeSH term under this center's cancer disease taxonomy — independent of collaboration."
            mode={relevanceMode}
            onModeChange={setRelevanceMode}
            value={relevanceValue}
            onValueChange={setRelevanceValue}
            max={maxRelevant}
          />
        </div>
        <SectionHeading
          text="ADD — collaborator + relevant"
          info="Full-time faculty who are NOT center members, already clear the Collaboration threshold above, AND clear the Cancer-relevance threshold — both bars must be cleared."
        />
        <RowTable rows={collaboratorAndRelevant} centerCode={centerCode} />
      </section>

      <section>
        <SectionHeading
          text="ADD — recruit (relevant, not yet connected)"
          info="Full-time faculty who are NOT center members and clear the Cancer-relevance threshold on their own body of work, but do NOT already clear the Collaboration threshold — prolific cancer researchers this center hasn't worked with yet. Excludes anyone already listed under &quot;collaborator + relevant&quot; above."
        />
        <RowTable rows={recruit} centerCode={centerCode} />
      </section>
    </div>
  );
}

type ReportDef = { key: string; label: string; description: string };

const REPORTS: readonly ReportDef[] = [
  {
    key: "collab-cancer-relevance",
    label: "Collaboration & Cancer-Relevance",
    description:
      "REMOVE / ADD membership recommendations from PubMed co-authorship and MeSH cancer-relevance signals.",
  },
];

export type CancerCenterCollabReportCardProps = { centerCode: string };

export function CancerCenterCollabReportCard({ centerCode }: CancerCenterCollabReportCardProps) {
  const [selectedKey, setSelectedKey] = React.useState<string | null>(null);
  const selected = REPORTS.find((r) => r.key === selectedKey) ?? null;

  return (
    <EditPanel
      heading="Reports"
      description="Advisory only — apply any recommendation through the roster editor. Nothing here writes to the roster."
    >
      {selected ? (
        <div>
          <button
            type="button"
            onClick={() => setSelectedKey(null)}
            className="mb-4 text-sm text-muted-foreground hover:text-foreground"
          >
            &larr; All reports
          </button>
          <h3 className="mb-4 text-base font-semibold">{selected.label}</h3>
          {selected.key === "collab-cancer-relevance" && <CollabCancerRelevanceReport centerCode={centerCode} />}
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {REPORTS.map((r) => (
            <li key={r.key}>
              <button
                type="button"
                onClick={() => setSelectedKey(r.key)}
                className="flex w-full flex-col items-start gap-0.5 py-3 text-left hover:bg-muted/50"
              >
                <span className="text-sm font-medium">{r.label}</span>
                <span className="text-xs text-muted-foreground">{r.description}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </EditPanel>
  );
}
