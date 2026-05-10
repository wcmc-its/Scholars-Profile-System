"use client";

import { useMemo, useState } from "react";
import { sanitizePubTitle } from "@/lib/utils";
import type { ProfilePayload } from "@/lib/api/profile";
import { HoverTooltip } from "@/components/ui/hover-tooltip";
import { SponsorAbbr } from "@/components/ui/sponsor-abbr";
import { FunderEyebrow } from "@/components/ui/funder-eyebrow";
import { MechanismAbbr } from "@/components/ui/mechanism-abbr";
import { useNihApplIdMap } from "@/lib/use-nih-resolve";
import { ExpandedGrant, expandLabel } from "@/components/funding/expanded-grant";

type RoleBucket = "all" | "PI" | "Co-PI" | "Co-I" | "PI-Subaward" | "Key Personnel";

const ROLE_BUCKET_ORDER: ReadonlyArray<{ key: RoleBucket; label: string }> = [
  { key: "all", label: "All" },
  { key: "PI", label: "PI" },
  { key: "Co-PI", label: "Co-PI" },
  { key: "Co-I", label: "Co-I" },
  { key: "PI-Subaward", label: "Sub-PI" },
  { key: "Key Personnel", label: "KP" },
];

/** Compact pill-friendly labels for the role column.
 *  DB values: PI | Co-PI | Co-I | PI-Subaward | Key Personnel.
 *  Mirrors the mockup's PI/MPI brevity so the 64px column stays tidy. */
const GRANT_ROLE_LABEL: Record<string, string> = {
  PI: "PI",
  "Co-PI": "Co-PI",
  "Co-I": "Co-I",
  "PI-Subaward": "Sub-PI",
  "Key Personnel": "KP",
};
const GRANT_ROLE_TITLE: Record<string, string> = {
  PI: "Principal Investigator",
  "Co-PI": "Co-Principal Investigator",
  "Co-I": "Co-Investigator",
  "PI-Subaward": "Principal Investigator (Subaward)",
  "Key Personnel": "Key Personnel",
};

/** Issue #78 — short labels for the inline Type pill that appears next to
 *  the eyebrow when programType isn't a plain Grant. */
const TYPE_PILL_LABEL: Record<string, string> = {
  "Contract with funding": "Contract",
  Fellowship: "Fellowship",
  Career: "Career",
  Training: "Training",
  "BioPharma Alliance Agreement": "BioPharma Alliance",
  Equipment: "Equipment",
};

function programTypeLabel(programType: string): string | null {
  if (!programType || programType === "Grant") return null;
  return TYPE_PILL_LABEL[programType] ?? programType;
}

/** Strip the optional NIH support-type flag + mechanism prefix from an
 *  award number so the MechanismAbbr renders separately from the
 *  IC+serial. e.g. "1R01CA245678-01A1" with mechanism "R01" → "CA245678-01A1". */
function awardSerial(awardNumber: string, mechanism: string): string {
  const re = new RegExp(`^\\s*[1-9]?\\s*${mechanism}\\s*`, "i");
  return awardNumber.replace(re, "").trim();
}

type Grant = ProfilePayload["grants"][number];
type GrantPublication = Grant["publications"][number];

/** A group of grant rows that share a coreProjectNum (NIH renewal years
 *  of the same award) collapsed into one displayed row. Non-NIH grants
 *  form a singleton group. The "primary" grant is the most recently
 *  ending one — its title, role, awardNumber, and applId represent the
 *  group. The publication list is shared (same coreProjectNum → same
 *  linkages in grant_provenance for this scholar).
 */
type GrantGroup = {
  primary: Grant;
  /** All grants in the group, sorted endDate desc. Used to render the
   *  combined year range and the renewal years inline. */
  members: Grant[];
  /** Earliest startDate across the group. */
  startDate: string;
  /** Latest endDate across the group. */
  endDate: string;
  isActive: boolean;
  /** Union of publications across the group, deduped by pmid. In practice
   *  all members share the same pmids; dedupe is defensive. */
  publications: GrantPublication[];
  /** Latest non-null abstract, or null if none populated. */
  abstract: string | null;
  /** Issue #92 — source slug attached to that abstract. */
  abstractSource: string | null;
  /** Most recent non-null applId. */
  applId: number | null;
};

function groupGrants(grants: Grant[]): GrantGroup[] {
  const buckets = new Map<string, Grant[]>();
  for (const g of grants) {
    // Singleton key for non-NIH grants (no coreProjectNum) so they don't
    // collapse with each other or with NIH grants.
    const key = g.coreProjectNum ?? `__singleton__${grants.indexOf(g)}`;
    const list = buckets.get(key);
    if (list) list.push(g);
    else buckets.set(key, [g]);
  }
  const groups: GrantGroup[] = [];
  for (const members of buckets.values()) {
    const sorted = [...members].sort((a, b) => b.endDate.localeCompare(a.endDate));
    const primary = sorted[0];
    const startDate = sorted.reduce((acc, g) => (g.startDate < acc ? g.startDate : acc), primary.startDate);
    const endDate = sorted.reduce((acc, g) => (g.endDate > acc ? g.endDate : acc), primary.endDate);
    const seen = new Set<string>();
    const publications: GrantPublication[] = [];
    for (const m of sorted) {
      for (const p of m.publications) {
        if (seen.has(p.pmid)) continue;
        seen.add(p.pmid);
        publications.push(p);
      }
    }
    publications.sort((a, b) => {
      if ((b.year ?? 0) !== (a.year ?? 0)) return (b.year ?? 0) - (a.year ?? 0);
      if (b.citationCount !== a.citationCount) return b.citationCount - a.citationCount;
      return a.pmid.localeCompare(b.pmid);
    });
    const abstractGrant = sorted.find((g) => g.abstract);
    const abstract = abstractGrant?.abstract ?? null;
    const abstractSource = abstractGrant?.abstractSource ?? null;
    const applId = sorted.find((g) => g.applId)?.applId ?? null;
    groups.push({
      primary,
      members: sorted,
      startDate,
      endDate,
      isActive: sorted.some((g) => g.isActive),
      publications,
      abstract,
      abstractSource,
      applId,
    });
  }
  // Order: active first by latest endDate, then completed by latest endDate.
  groups.sort((a, b) => {
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
    return b.endDate.localeCompare(a.endDate);
  });
  return groups;
}

export function GrantsSection({ grants }: { grants: Grant[] }) {
  const [roleBucket, setRoleBucket] = useState<RoleBucket>("all");
  const [query, setQuery] = useState("");

  const roleCounts = useMemo(() => {
    const c: Record<RoleBucket, number> = {
      all: grants.length,
      PI: 0,
      "Co-PI": 0,
      "Co-I": 0,
      "PI-Subaward": 0,
      "Key Personnel": 0,
    };
    for (const g of grants) {
      if (g.role in c) c[g.role as RoleBucket] += 1;
    }
    return c;
  }, [grants]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return grants.filter((g) => {
      if (roleBucket !== "all" && g.role !== roleBucket) return false;
      if (q.length === 0) return true;
      const hay = `${g.title} ${g.funder} ${g.awardNumber ?? ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [grants, roleBucket, query]);

  const grouped = useMemo(() => groupGrants(filtered), [filtered]);
  const activeGroups = useMemo(() => grouped.filter((g) => g.isActive), [grouped]);
  const completedGroups = useMemo(() => grouped.filter((g) => !g.isActive), [grouped]);

  // applId map covering every NIH award on the page — single batched
  // POST to /api/nih-resolve, fired after first paint. Used as the
  // fallback when grant.applId from RePORTER ETL hasn't populated yet.
  const applIdByAward = useNihApplIdMap(grants.map((g) => g.awardNumber));

  return (
    <>
      {/* Toolbar: role chips + search */}
      <div className="mb-4 flex flex-wrap items-center gap-2 border-b border-border pb-4">
        {ROLE_BUCKET_ORDER.map(({ key, label }) => {
          if (key !== "all" && roleCounts[key] === 0) return null;
          const active = roleBucket === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setRoleBucket(key)}
              className={
                active
                  ? "inline-flex h-7 items-center gap-1.5 rounded-full bg-[var(--color-accent-slate)] px-3 text-sm text-white"
                  : "border-border-strong inline-flex h-7 items-center gap-1.5 rounded-full border bg-background px-3 text-sm text-zinc-700 hover:border-[var(--color-accent-slate)] hover:text-[var(--color-accent-slate)] dark:text-zinc-200"
              }
            >
              {label}
              <span className={active ? "text-[11px] opacity-90" : "text-[11px] opacity-70"}>
                {roleCounts[key]}
              </span>
            </button>
          );
        })}
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search this list…"
          className="border-border-strong ml-auto h-7 w-[220px] rounded-full border bg-muted px-3 text-sm focus:border-[var(--color-accent-slate)] focus:bg-background focus:outline-none"
        />
      </div>

      {filtered.length === 0 ? (
        <div className="text-muted-foreground py-8 text-center text-sm">
          No grants match this filter.
        </div>
      ) : null}

      {activeGroups.length > 0 ? (
        <>
          <div className="mt-2 mb-3 flex items-baseline gap-3">
            <h3 className="text-base font-semibold">Active</h3>
            <span className="text-muted-foreground text-sm">
              {activeGroups.length} {activeGroups.length === 1 ? "grant" : "grants"}
            </span>
          </div>
          <ul>
            {activeGroups.map((group, i) => (
              <li key={`a${i}`}>
                <GrantRow
                  group={group}
                  applIdFallback={
                    group.primary.awardNumber ? applIdByAward[group.primary.awardNumber] : undefined
                  }
                />
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {completedGroups.length > 0 ? (
        <details className="group mt-4 border-t border-border">
          <summary className="flex cursor-pointer list-none items-center gap-2 py-3 text-sm font-medium text-[var(--color-accent-slate)] [&::-webkit-details-marker]:hidden">
            <span className="text-muted-foreground inline-block w-3 text-[10px] transition-transform group-open:rotate-90">
              ▶
            </span>
            Completed grants ({completedGroups.length})
          </summary>
          <ul className="pb-3">
            {completedGroups.map((group, i) => (
              <li key={`c${i}`}>
                <GrantRow
                  group={group}
                  applIdFallback={
                    group.primary.awardNumber ? applIdByAward[group.primary.awardNumber] : undefined
                  }
                />
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </>
  );
}

function GrantRow({
  group,
  applIdFallback,
}: {
  group: GrantGroup;
  applIdFallback: number | undefined;
}) {
  const grant = group.primary;
  const label = GRANT_ROLE_LABEL[grant.role] ?? grant.role;
  const title = GRANT_ROLE_TITLE[grant.role] ?? grant.role;
  const startYear = group.startDate.slice(0, 4);
  const endYear = group.endDate.slice(0, 4);
  const [expanded, setExpanded] = useState(false);

  // Prefer the RePORTER-ETL applId; fall back to the resolver's lookup
  // for grants that haven't been reconciled yet.
  const applId = group.applId ?? applIdFallback;
  const pubCount = group.publications.length;
  const canExpand = pubCount > 0 || !!group.abstract;

  // Issue #78 F2/F6 — prefer canonical short, fall back to raw, fall back
  // again to legacy `funder` for rows where the new ETL hasn't run yet.
  const primeShort = grant.primeSponsor ?? grant.primeSponsorRaw;
  const directShort = grant.directSponsor ?? grant.directSponsorRaw;
  const showVia =
    grant.isSubaward && !!directShort && directShort !== primeShort;
  const typeLabel = programTypeLabel(grant.programType);

  return (
    <div className="border-t border-border first:border-t-0">
      <div className="grid grid-cols-[64px_1fr_auto] items-baseline gap-3 py-3">
        <HoverTooltip text={title}>
          <span
            className={
              group.isActive
                ? "inline-flex h-5 items-center justify-center rounded-sm bg-green-50 px-2 text-[10px] font-semibold uppercase tracking-wider text-green-700 dark:bg-green-950 dark:text-green-300"
                : "bg-muted text-muted-foreground inline-flex h-5 items-center justify-center rounded-sm px-2 text-[10px] font-semibold uppercase tracking-wider"
            }
          >
            {label}
          </span>
        </HoverTooltip>
        <div>
          <div
            className="text-base font-medium leading-snug"
            dangerouslySetInnerHTML={{ __html: sanitizePubTitle(grant.title) }}
          />
          <div className="text-muted-foreground mt-0.5 text-sm">
            {primeShort ? (
              <FunderEyebrow short={primeShort} />
            ) : (
              <span>{grant.funder}</span>
            )}
            {" · "}
            {startYear}
            {"–"}
            {endYear}
            {showVia ? (
              <>
                {" · via "}
                <SponsorAbbr short={directShort!} />
              </>
            ) : null}
            {typeLabel ? (
              <span className="border-border-strong text-muted-foreground ml-2 inline-flex h-4 items-center rounded-sm border px-1.5 text-[10px] font-medium uppercase tracking-wide">
                {typeLabel}
              </span>
            ) : null}
            {group.members.length > 1 ? (
              <span className="text-muted-foreground ml-2 text-xs">
                · {group.members.length} renewals
              </span>
            ) : null}
          </div>
          {canExpand ? (
            <button
              type="button"
              onClick={() => setExpanded((e) => !e)}
              className="group mt-1.5 inline-flex items-center gap-1 text-sm text-[var(--color-accent-slate)]"
              aria-expanded={expanded}
            >
              <span
                className={`text-muted-foreground inline-block w-3 text-[10px] transition-transform ${
                  expanded ? "rotate-90" : ""
                }`}
              >
                ▶
              </span>
              <span className="group-hover:underline">
                {expandLabel(pubCount, !!group.abstract)}
              </span>
            </button>
          ) : grant.coreProjectNum && pubCount === 0 && !group.abstract ? (
            // Only NIH-funded grants get the "No publications yet" affordance —
            // for non-NIH (industry, foundation, internal) we have no source
            // for pub-grant linkages, so absence isn't informative.
            <div className="text-muted-foreground mt-1.5 text-xs">No publications yet</div>
          ) : null}
        </div>
        <AwardNumberDisplay grant={grant} applId={applId} />
      </div>

      {expanded ? (
        <ExpandedGrant
          abstract={group.abstract}
          abstractSource={group.abstractSource}
          applId={applId ?? null}
          coreProjectNum={group.primary.coreProjectNum}
          publications={group.publications}
          indentClass="ml-[76px]"
        />
      ) : null}
    </div>
  );
}

/** Right column rendering for award number. NIH awards split the
 *  mechanism prefix into a tooltipped MechanismAbbr (e.g. "R01" with
 *  hover-expansion to "Research Project Grant (R01)") followed by the
 *  IC+serial portion linked to NIH RePORTER when an applId is known.
 *  Non-NIH awards render the unmodified award number, linked when an
 *  applId resolved. */
function AwardNumberDisplay({
  grant,
  applId,
}: {
  grant: Grant;
  applId: number | undefined;
}) {
  if (!grant.awardNumber) return <span />;
  const reporterUrl = applId
    ? `https://reporter.nih.gov/project-details/${applId}`
    : null;

  if (grant.mechanism) {
    const serial = awardSerial(grant.awardNumber, grant.mechanism);
    return (
      <span className="text-muted-foreground inline-flex items-baseline gap-1 whitespace-nowrap font-mono text-xs">
        <MechanismAbbr code={grant.mechanism} className="font-mono" />
        {reporterUrl ? (
          <a
            href={reporterUrl}
            target="_blank"
            rel="noopener noreferrer"
            title="View on NIH RePORTER"
            className="text-[var(--color-accent-slate)] underline-offset-4 hover:underline"
          >
            {serial}
          </a>
        ) : (
          <span>{serial}</span>
        )}
      </span>
    );
  }

  return reporterUrl ? (
    <a
      href={reporterUrl}
      target="_blank"
      rel="noopener noreferrer"
      title="View on NIH RePORTER"
      className="text-[var(--color-accent-slate)] whitespace-nowrap font-mono text-xs underline-offset-4 hover:underline"
    >
      {grant.awardNumber}
    </a>
  ) : (
    <span className="text-muted-foreground whitespace-nowrap font-mono text-xs">
      {grant.awardNumber}
    </span>
  );
}
