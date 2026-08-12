/**
 * CenterRosterCard — the rich center roster table (#552 §6.1; the deferred
 * #540 PR-7b-roster). Columns: Member | [Type | Program] | [Diseases] | Start
 * | End | Status | Remove.
 *
 * Type + Program are surfaced **only when the center has a program taxonomy**
 * (`programs.length > 0`) — the data-driven "Cancer-Center-only" gate. Every
 * other center shows just Member / Start / End / Status. Start/End drive the
 * derived Active / Pending / Inactive status (the #552 §3.3 active filter,
 * inclusive boundaries, nulls open).
 *
 * ONE mutually-exclusive filter — All members (default) / Inactive members only
 * / Departed members only — so the roster opens on the whole thing and nothing
 * is ever silently hidden. Two independent "X only" checkboxes could not say
 * this honestly: both unchecked reads as no restriction, both checked as an
 * impossible intersection. (It was previously a restrictive, default-ON "show
 * active only" beside an additive "show departed", opposite polarities for the
 * same intent.)
 *
 * A row whose person has left WCM while the membership is still open is tinted
 * amber and its End field outlined, because that is the combination this card
 * exists to surface and the End date is what resolves it. The count of those
 * rows drives the nudge above the table — outstanding work, not hidden rows.
 *
 * Inline edits POST `/api/edit/roster` `action:"set"` one field at a time
 * (a field present as `null` clears it). Add → `action:"add"`, Remove →
 * `action:"remove"`. The list updates optimistically; a failed write reverts
 * and surfaces an error. A date edit that would make End < Start is blocked
 * client-side before the POST.
 *
 * Diseases (the `2026-08-12-cancer-center-disease-assignment-edit-ui-plan.md`
 * §5 redesign — this replaces the original per-member Dialog with an inline,
 * accordion-row expand): a "Diseases" column renders only for a center that
 * actually has assignment data at all (`hasDiseases` below). Each member's
 * LIVE (non-rejected) assignments render as confidence-tinted chips, capped at
 * `MAX_DISEASE_CHIPS` with a "+N more" overflow chip, plus an amber "N to
 * review" pill for any undecided rows. Clicking ANY chip/pill in a row toggles
 * an inline expanded region directly under that row (`DiseaseExpandedPanel`)
 * listing EVERY assignment — including rejected ones, de-emphasized rather
 * than hidden, so a curator can Undo. Confirm/Reject/Undo POST the exact same
 * `/api/edit/center/[code]/disease-assignments` route as before, via
 * `decideDisease` — same optimistic-update-with-revert convention as `patch()`
 * below, serialized per (cwid, diseaseCode) pair.
 *
 * A second filter-bar row narrows the visible member list — client-side, over
 * the already-loaded roster, AND-composed with each other and with the
 * existing All/Inactive/Departed radio: a free-text search (name or CWID), a
 * disease multi-select, a confidence tier, and a "needs review" toggle whose
 * count is the total pending assignments across the WHOLE roster (unaffected
 * by the other filters). "Clear all filters" resets all four at once.
 */
"use client";

import Link from "next/link";
import * as React from "react";
import { ChevronDown } from "lucide-react";

import { ConfirmDialog } from "@/components/edit/confirm-dialog";
import {
  DirectoryPeopleTypeahead,
  type DirectoryValue,
} from "@/components/edit/directory-people-typeahead";
import { EditPanel } from "@/components/edit/edit-panel";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import type { RosterDiseaseRow } from "@/lib/api/unit-edit-context";

export type RosterMember = {
  cwid: string;
  name: string;
  title: string | null;
  membershipType: "research" | "clinical" | null;
  programCode: string | null;
  startDate: string | null;
  endDate: string | null;
  /** Whether the PERSON is still at WCM. Orthogonal to the membership dates:
   *  a row can be membership-Active AND scholarState "departed" — someone who
   *  left WCM with nobody having closed out their center membership. That
   *  combination is the whole point of surfacing this. Optional so existing
   *  fixtures/callers that predate #2324 still type-check; absent → "active". */
  scholarState?: "active" | "departed" | "unknown";
  /** Disease-assignment plan §5/§6 — this member's ranked disease-expertise
   *  picture, `[]`/absent for a non-center roster or a member with none.
   *  Optional for the same reason `scholarState` is: existing fixtures/callers
   *  that predate this feature still type-check. Already server-sorted by
   *  rank (drift-only decision rows trailing by code) — see
   *  `loadUnitEditContext`. */
  diseases?: ReadonlyArray<RosterDiseaseRow>;
};

export type CenterProgramOption = { code: string; label: string; sortOrder: number };

export type CenterRosterCardProps = {
  unitCode: string;
  members: ReadonlyArray<RosterMember>;
  programs: ReadonlyArray<CenterProgramOption>;
  /** Injectable for tests; defaults to today (YYYY-MM-DD). */
  today?: string;
  /** #1102 — when true, render the "Export CSV" roster-download affordance
   *  (the `EDIT_UNIT_ROSTER_EXPORT` flag, resolved server-side). */
  exportEnabled?: boolean;
};

type Status = "active" | "pending" | "inactive";

/** The three mutually-exclusive roster views. `all` is the default. */
type RosterFilter = "all" | "inactive" | "departed";

type ConfidenceFilter = "any" | "high" | "medium" | "low";

/** Chips shown before the "+N more" overflow chip kicks in. */
const MAX_DISEASE_CHIPS = 3;

/** #552 §3.3 active filter, inclusive boundaries, nulls open. */
function statusOf(member: RosterMember, today: string): Status {
  if (member.startDate && member.startDate > today) return "pending";
  if (member.endDate && member.endDate < today) return "inactive";
  return "active";
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * `person_code` -> `display_label`, from `docs/cancer-center-person-rollup.csv`
 * (the same map `labelsOf()` in `scripts/cancer-center-disease-assignments.ts`
 * builds at ETL time). Hardcoded rather than read here at request time:
 * unlike `CancerTaxonomyDescriptor`, the rollup has no DB-backed lookup, and
 * the app's runtime image never ships `docs/` at all (`Dockerfile`'s runtime
 * stage copies only `.next/standalone` + `.next/static` + `prisma/`) — a
 * `readFileSync` here would ENOENT in every deployed environment. Same
 * reasoning `TOPIC_LABELS` in `cancer-center-collab-report-card.tsx` documents
 * for its own (unrelated) axis, including the fallback below for a rollup
 * code added after this map was last synced.
 */
const DISEASE_LABELS: Record<string, string> = {
  BREAST: "Breast Cancer",
  LUNG: "Lung & Thoracic Cancer",
  GI_COLORECTAL: "Colorectal & Anal Cancer",
  GI_PANCREAS: "Pancreatic Cancer",
  GI_LIVER: "Liver & Bile Duct Cancer",
  GI_UPPER: "Esophageal & Stomach Cancer",
  GU_PROSTATE: "Prostate Cancer",
  GU_OTHER: "Kidney, Bladder & Testicular Cancer",
  GYN: "Gynecologic Cancer",
  HEME_LEUK: "Leukemia",
  HEME_LYMPH: "Lymphoma",
  HEME_MYELOMA: "Multiple Myeloma",
  HEME_MDS_MPN: "Blood Cancers (MDS, MPN & Other)",
  NEURO: "Brain & Nervous System Cancer",
  HEAD_NECK: "Head & Neck Cancer",
  SKIN: "Melanoma & Skin Cancer",
  SARCOMA: "Sarcoma & Bone Cancer",
  ENDO: "Thyroid & Endocrine Cancer",
  HEREDITARY: "Hereditary Cancer & Genetics",
};

function diseaseLabel(code: string): string {
  const known = DISEASE_LABELS[code];
  if (known) return known;
  const spaced = code.replace(/_/g, " ").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const FOCUS_LABEL: Record<string, string> = {
  primary: "Primary",
  secondary: "Secondary",
  peripheral: "Peripheral",
};

/** Same tint convention as the roster Active/Inactive badge below. */
const CONFIDENCE_BADGE_CLASS: Record<string, string> = {
  high: "bg-apollo-green-tint text-apollo-green border-apollo-green-tint-border",
  medium: "bg-apollo-amber-tint text-apollo-amber border-apollo-amber-tint-border",
  low: "bg-apollo-slate-tint text-apollo-slate border-apollo-slate-tint-border",
};

/** Solid dot matching each confidence tier — the chip legend's color key. */
const CONFIDENCE_DOT_CLASS: Record<string, string> = {
  high: "bg-apollo-green-foreground",
  medium: "bg-apollo-amber",
  low: "bg-apollo-slate",
};

/** "the evidence counts already on the row" (plan §5), formatted as one
 *  compact line rather than a second mini-table. */
function evidenceLine(a: NonNullable<RosterDiseaseRow["assignment"]>): string {
  const years = a.firstYear && a.lastYear ? ` (${a.firstYear}–${a.lastYear})` : "";
  return [
    `${a.leadPubs} lead · ${a.secondPubs} second · ${a.middlePubs} middle`,
    `${a.recentPubs} recent pub${a.recentPubs === 1 ? "" : "s"}${years}`,
    `${a.grantsLed} grant${a.grantsLed === 1 ? "" : "s"} led · ${a.grantsSupport} supported`,
    `${a.trialsLed} trial${a.trialsLed === 1 ? "" : "s"} led · ${a.trialsSupport} supported`,
  ].join("  —  ");
}

/** A row's confidence for tinting/filtering purposes — the current assignment's
 *  if one still exists, else the snapshot the decision was made against. */
function confidenceOf(row: RosterDiseaseRow): string | null {
  return row.assignment?.confidence ?? row.decision?.confidenceAtDecision ?? null;
}

/** Non-rejected rows for a member — what the collapsed chips show, in the
 *  server-sent (rank) order. */
function liveDiseaseRows(member: RosterMember): RosterDiseaseRow[] {
  return (member.diseases ?? []).filter((d) => d.decision?.decision !== "rejected");
}

/** Assignment rows with no curator decision yet — the "N to review" count. */
function pendingDiseaseRows(member: RosterMember): RosterDiseaseRow[] {
  return (member.diseases ?? []).filter((d) => d.assignment !== null && d.decision === null);
}

function DiseaseDecisionBadge({ decision }: { decision: string }) {
  if (decision === "confirmed") {
    return (
      <Badge
        variant="outline"
        className="bg-apollo-green-tint text-apollo-green border-apollo-green-tint-border rounded-full"
      >
        ✓ Confirmed
      </Badge>
    );
  }
  if (decision === "rejected") {
    return (
      <Badge
        variant="outline"
        className="bg-apollo-red-tint text-apollo-maroon border-apollo-red-tint-border rounded-full"
      >
        Rejected
      </Badge>
    );
  }
  return null;
}

type DiseaseDecisionKind = "confirmed" | "rejected" | "clear";

/**
 * The collapsed-row summary (plan §5) — up to `MAX_DISEASE_CHIPS`
 * confidence-tinted chips (confirmed ones prefixed "✓ "), a "+N more"
 * overflow chip, and an amber "N to review" pill for undecided rows. Every
 * chip/pill shares one click handler: toggle the row's inline expand.
 */
function DiseaseChips({
  member,
  onToggleExpand,
}: {
  member: RosterMember;
  onToggleExpand: (cwid: string) => void;
}) {
  const diseases = member.diseases ?? [];
  if (diseases.length === 0) return null;

  const live = liveDiseaseRows(member);
  const pending = pendingDiseaseRows(member);

  if (live.length === 0 && pending.length === 0) {
    return (
      <span
        className="text-muted-foreground text-xs italic"
        data-testid={`roster-disease-empty-${member.cwid}`}
      >
        No disease assignments
      </span>
    );
  }

  const shown = live.slice(0, MAX_DISEASE_CHIPS);
  const overflow = live.length - shown.length;

  return (
    <div className="flex flex-wrap items-center gap-1" data-testid={`roster-disease-chips-${member.cwid}`}>
      {shown.map((d) => {
        const confidence = confidenceOf(d) ?? "low";
        const confirmed = d.decision?.decision === "confirmed";
        return (
          <button
            key={d.diseaseCode}
            type="button"
            onClick={() => onToggleExpand(member.cwid)}
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${
              CONFIDENCE_BADGE_CLASS[confidence] ?? ""
            }`}
            data-testid={`roster-disease-chip-${member.cwid}-${d.diseaseCode}`}
          >
            <span className={`size-1.5 rounded-full ${CONFIDENCE_DOT_CLASS[confidence] ?? ""}`} aria-hidden />
            {confirmed ? "✓ " : ""}
            {diseaseLabel(d.diseaseCode)}
          </button>
        );
      })}
      {overflow > 0 && (
        <button
          type="button"
          onClick={() => onToggleExpand(member.cwid)}
          className="border-apollo-border text-apollo-slate rounded-full border px-2 py-0.5 text-xs font-medium"
          data-testid={`roster-disease-chip-more-${member.cwid}`}
        >
          +{overflow} more
        </button>
      )}
      {pending.length > 0 && (
        <button
          type="button"
          onClick={() => onToggleExpand(member.cwid)}
          className="bg-apollo-amber-tint text-apollo-amber border-apollo-amber-tint-border rounded-full border px-2 py-0.5 text-xs font-medium"
          data-testid={`roster-disease-pending-${member.cwid}`}
        >
          {pending.length} to review
        </button>
      )}
    </div>
  );
}

/**
 * The inline expanded region (plan §5) — replaces the old per-member Dialog.
 * Renders ALL of a member's disease rows (not just the live ones), ranked by
 * evidence, so a curator can Undo a rejection that the collapsed chips hide.
 * Rejected cards are de-emphasized (dimmed), not hidden.
 */
function DiseaseExpandedPanel({
  member,
  onDecide,
  onCollapse,
}: {
  member: RosterMember;
  onDecide: (cwid: string, diseaseCode: string, decision: DiseaseDecisionKind) => Promise<void>;
  onCollapse: () => void;
}) {
  const diseases = member.diseases ?? [];
  const [busyCode, setBusyCode] = React.useState<string | null>(null);

  async function act(diseaseCode: string, decision: DiseaseDecisionKind) {
    setBusyCode(diseaseCode);
    try {
      await onDecide(member.cwid, diseaseCode, decision);
    } finally {
      setBusyCode(null);
    }
  }

  return (
    <div className="flex flex-col gap-3" data-testid={`disease-expand-${member.cwid}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium">Disease assignments — ranked by evidence</p>
          <p className="text-muted-foreground text-xs">
            Confirming or rejecting records your call — a later reseed of the underlying evidence
            never silently erases it.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={onCollapse}
          data-testid={`disease-expand-collapse-${member.cwid}`}
        >
          Collapse
        </Button>
      </div>
      <ul className="flex flex-col gap-2">
        {diseases.map((d) => {
          const busy = busyCode === d.diseaseCode;
          const rejected = d.decision?.decision === "rejected";
          return (
            <li
              key={d.diseaseCode}
              className={`border-apollo-border rounded-md border p-3 ${rejected ? "opacity-50" : ""}`}
              data-testid={`disease-card-${member.cwid}-${d.diseaseCode}`}
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-medium">{diseaseLabel(d.diseaseCode)}</span>
                <span className="text-muted-foreground text-xs">{d.diseaseCode}</span>
                {d.assignment ? (
                  <>
                    <Badge variant="outline" className="rounded-full">
                      Rank {d.assignment.rank}
                    </Badge>
                    <Badge variant="outline" className="rounded-full">
                      {FOCUS_LABEL[d.assignment.focus] ?? d.assignment.focus}
                    </Badge>
                    <Badge
                      variant="outline"
                      className={`rounded-full ${CONFIDENCE_BADGE_CLASS[d.assignment.confidence] ?? ""}`}
                    >
                      {d.assignment.confidence} confidence
                    </Badge>
                  </>
                ) : (
                  <Badge
                    variant="outline"
                    className="bg-apollo-slate-tint text-apollo-slate border-apollo-slate-tint-border rounded-full"
                  >
                    No longer suggested
                  </Badge>
                )}
                {d.drifted && (
                  <Badge
                    variant="outline"
                    className="bg-apollo-amber-tint text-apollo-amber border-apollo-amber-tint-border rounded-full"
                    title="The evidence behind this decision has changed since it was made."
                    data-testid={`disease-drift-${member.cwid}-${d.diseaseCode}`}
                  >
                    Review — evidence changed
                  </Badge>
                )}
              </div>
              {d.assignment && (
                <p className="text-muted-foreground mt-1 text-xs">{evidenceLine(d.assignment)}</p>
              )}
              <div className="mt-2 flex items-center gap-2">
                {!d.decision ? (
                  <>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy || !d.assignment}
                      onClick={() => act(d.diseaseCode, "confirmed")}
                      data-testid={`disease-confirm-${member.cwid}-${d.diseaseCode}`}
                    >
                      Confirm
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy || !d.assignment}
                      onClick={() => act(d.diseaseCode, "rejected")}
                      data-testid={`disease-reject-${member.cwid}-${d.diseaseCode}`}
                    >
                      Reject
                    </Button>
                  </>
                ) : (
                  <>
                    <DiseaseDecisionBadge decision={d.decision.decision} />
                    <button
                      type="button"
                      disabled={busy}
                      className="text-apollo-slate text-xs hover:underline disabled:opacity-50"
                      onClick={() => act(d.diseaseCode, "clear")}
                      data-testid={`disease-undo-${member.cwid}-${d.diseaseCode}`}
                    >
                      Undo
                    </button>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function CenterRosterCard({
  unitCode,
  members: initial,
  programs,
  today,
  exportEnabled = false,
}: CenterRosterCardProps) {
  const now = today ?? todayIso();
  const hasPrograms = programs.length > 0;

  const [members, setMembers] = React.useState<RosterMember[]>(() => [...initial]);
  // One mutually-exclusive filter, defaulting to the WHOLE roster. Two
  // checkboxes could not express "only" honestly: two independent "X only"
  // boxes both unchecked means no restriction, and both checked means an
  // impossible intersection. A radio makes the three states the curator
  // actually wants explicit, and nothing is ever silently hidden.
  const [filter, setFilter] = React.useState<RosterFilter>("all");
  const [addValue, setAddValue] = React.useState<DirectoryValue | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [removeTarget, setRemoveTarget] = React.useState<RosterMember | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  // Disease-column state: which rows are expanded, plus the new filter bar.
  const [expandedCwids, setExpandedCwids] = React.useState<Set<string>>(() => new Set());
  const [selectedDiseaseCodes, setSelectedDiseaseCodes] = React.useState<Set<string>>(() => new Set());
  const [diseaseSearch, setDiseaseSearch] = React.useState("");
  const [confidenceFilter, setConfidenceFilter] = React.useState<ConfidenceFilter>("any");
  const [needsReviewOnly, setNeedsReviewOnly] = React.useState(false);
  // Free-text search — case-insensitive substring match against name OR cwid.
  const [freeText, setFreeText] = React.useState("");

  function toggleExpand(cwid: string) {
    setExpandedCwids((prev) => {
      const next = new Set(prev);
      if (next.has(cwid)) next.delete(cwid);
      else next.add(cwid);
      return next;
    });
  }

  function toggleDiseaseCode(code: string) {
    setSelectedDiseaseCodes((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  function clearAllFilters() {
    setSelectedDiseaseCodes(new Set());
    setDiseaseSearch("");
    setConfidenceFilter("any");
    setNeedsReviewOnly(false);
    setFreeText("");
  }

  async function post(body: Record<string, unknown>): Promise<boolean> {
    let res: Response;
    try {
      res = await fetch("/api/edit/roster", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ unitType: "center", unitCode, ...body }),
      });
    } catch {
      // Network failure — surface it and let callers roll back the optimistic write.
      setError(mapErrorToMessage(""));
      return false;
    }
    // A failed response may carry no JSON body (e.g. a bodyless 401 from auth
    // middleware); check res.ok and parse defensively so a phantom row can't
    // linger with no error shown.
    const data = (await res.json().catch(() => null)) as { ok: boolean; error?: string } | null;
    if (!res.ok || data?.ok !== true) {
      setError(mapErrorToMessage(data?.error ?? ""));
      return false;
    }
    return true;
  }

  /** Per-cwid write chain so two quick edits to the SAME row don't race. The
   *  API guards against concurrent modification ("record has changed since last
   *  read"); a second field edit fired before the first POST returns would 500
   *  and revert (e.g. setting Start then End in quick succession). */
  const writeQueue = React.useRef<Map<string, Promise<unknown>>>(new Map());

  /** Inline one-field set; optimistic with revert on failure, serialized per row. */
  async function patch(cwid: string, field: Partial<RosterMember>) {
    setError(null);
    const prev = members.find((m) => m.cwid === cwid);
    if (!prev) return;
    const next = { ...prev, ...field };
    setMembers((ms) => ms.map((m) => (m.cwid === cwid ? next : m)));
    const prior = writeQueue.current.get(cwid) ?? Promise.resolve();
    const run = prior
      .catch(() => {})
      .then(async () => {
        const ok = await post({ cwid, action: "set", ...field });
        if (!ok) setMembers((ms) => ms.map((m) => (m.cwid === cwid ? prev : m)));
      });
    writeQueue.current.set(cwid, run);
    await run;
  }

  /** Per-(cwid, diseaseCode) write chain — same reason `writeQueue` above
   *  exists: two quick decisions on the SAME pair (e.g. Reject then Clear)
   *  shouldn't race. */
  const diseaseWriteQueue = React.useRef<Map<string, Promise<unknown>>>(new Map());

  function replaceDiseaseRow(
    cwid: string,
    diseaseCode: string,
    updater: (row: RosterDiseaseRow) => RosterDiseaseRow,
  ) {
    setMembers((ms) =>
      ms.map((m) => {
        if (m.cwid !== cwid || !m.diseases) return m;
        return {
          ...m,
          diseases: m.diseases.map((d) => (d.diseaseCode === diseaseCode ? updater(d) : d)),
        };
      }),
    );
  }

  /** Confirm / Reject / Clear one (cwid, diseaseCode) decision — optimistic
   *  with revert on failure, serialized per pair, mirroring `patch()` above.
   *  Unlike `patch()`, the route's success response carries the server's
   *  authoritative `scoreAtDecision`/`confidenceAtDecision` snapshot, so a
   *  successful confirm/reject reconciles onto that instead of trusting the
   *  client's guess (which assumed the row's CURRENT assignment hadn't
   *  changed since page load). */
  async function decideDisease(cwid: string, diseaseCode: string, decision: DiseaseDecisionKind) {
    setError(null);
    const member = members.find((m) => m.cwid === cwid);
    const prevRow = member?.diseases?.find((d) => d.diseaseCode === diseaseCode);
    if (!prevRow) return;

    const optimistic: RosterDiseaseRow =
      decision === "clear"
        ? { ...prevRow, decision: null, drifted: false }
        : {
            ...prevRow,
            decision: {
              decision,
              decidedBy: prevRow.decision?.decidedBy ?? "",
              decidedAt: new Date(),
              scoreAtDecision: prevRow.assignment?.score ?? prevRow.decision?.scoreAtDecision ?? 0,
              confidenceAtDecision:
                prevRow.assignment?.confidence ?? prevRow.decision?.confidenceAtDecision ?? "low",
            },
            drifted: false,
          };
    replaceDiseaseRow(cwid, diseaseCode, () => optimistic);

    const key = `${cwid}::${diseaseCode}`;
    const prior = diseaseWriteQueue.current.get(key) ?? Promise.resolve();
    const run = prior
      .catch(() => {})
      .then(async () => {
        let res: Response;
        try {
          res = await fetch(`/api/edit/center/${encodeURIComponent(unitCode)}/disease-assignments`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cwid, diseaseCode, decision }),
          });
        } catch {
          setError(mapErrorToMessage(""));
          replaceDiseaseRow(cwid, diseaseCode, () => prevRow);
          return;
        }
        const data = (await res.json().catch(() => null)) as
          | { ok: boolean; error?: string; scoreAtDecision?: number; confidenceAtDecision?: string }
          | null;
        if (!res.ok || data?.ok !== true) {
          setError(mapErrorToMessage(data?.error ?? ""));
          replaceDiseaseRow(cwid, diseaseCode, () => prevRow);
          return;
        }
        if (decision !== "clear" && data.scoreAtDecision !== undefined && data.confidenceAtDecision !== undefined) {
          const scoreAtDecision = data.scoreAtDecision;
          const confidenceAtDecision = data.confidenceAtDecision;
          replaceDiseaseRow(cwid, diseaseCode, (row) =>
            row.decision ? { ...row, decision: { ...row.decision, scoreAtDecision, confidenceAtDecision } } : row,
          );
        }
      });
    diseaseWriteQueue.current.set(key, run);
    await run;
  }

  async function add() {
    if (!addValue || adding) return;
    const picked = addValue;
    if (members.some((m) => m.cwid === picked.cwid)) {
      setAddValue(null);
      return;
    }
    setError(null);
    setAdding(true);
    const member: RosterMember = {
      cwid: picked.cwid,
      name: picked.name,
      title: picked.title,
      membershipType: null,
      programCode: null,
      startDate: null,
      endDate: null,
    };
    setMembers((ms) => [member, ...ms]);
    setAddValue(null);
    const ok = await post({ cwid: picked.cwid, action: "add" });
    if (!ok) setMembers((ms) => ms.filter((m) => m.cwid !== picked.cwid));
    setAdding(false);
  }

  async function confirmRemove() {
    if (!removeTarget) return;
    setError(null);
    const ok = await post({ cwid: removeTarget.cwid, action: "remove" });
    if (!ok) throw new Error("remove_failed");
    setMembers((ms) => ms.filter((m) => m.cwid !== removeTarget.cwid));
    setRemoveTarget(null);
  }

  function onStartChange(m: RosterMember, value: string) {
    const startDate = value || null;
    if (startDate && m.endDate && m.endDate < startDate) {
      setError("Start date can't be after the end date.");
      return;
    }
    void patch(m.cwid, { startDate });
  }

  function onEndChange(m: RosterMember, value: string) {
    const endDate = value || null;
    if (endDate && m.startDate && endDate < m.startDate) {
      setError("End date can't be before the start date.");
      return;
    }
    void patch(m.cwid, { endDate });
  }

  const needsCloseOutOf = (m: RosterMember) =>
    m.scholarState === "departed" && statusOf(m, now) !== "inactive";

  const hasDiseases = members.some((m) => (m.diseases ?? []).length > 0);

  const rosterFiltered =
    filter === "inactive"
      ? members.filter((m) => statusOf(m, now) === "inactive")
      : filter === "departed"
        ? members.filter((m) => m.scholarState === "departed")
        : members;

  // The new filter-bar controls, AND-composed on top of the radio filter
  // above. `preDiseaseFiltered` excludes the disease multi-select itself so
  // the multi-select's OWN option counts stay meaningful as more codes are
  // checked (an OR-widening selection, not a further narrowing one).
  const preDiseaseFiltered = rosterFiltered.filter((m) => {
    if (confidenceFilter !== "any") {
      const hasTier = liveDiseaseRows(m).some((d) => confidenceOf(d) === confidenceFilter);
      if (!hasTier) return false;
    }
    if (needsReviewOnly && pendingDiseaseRows(m).length === 0) return false;
    const q = freeText.trim().toLowerCase();
    if (q && !m.name.toLowerCase().includes(q) && !m.cwid.toLowerCase().includes(q)) return false;
    return true;
  });

  // Disease multi-select options: every code that appears anywhere on the
  // roster, with a count of currently-visible (pre-disease-filter) members
  // holding a live assignment to it.
  const diseaseCodeCounts = new Map<string, number>();
  const diseaseCodes = new Set<string>();
  for (const m of members) for (const d of m.diseases ?? []) diseaseCodes.add(d.diseaseCode);
  for (const m of preDiseaseFiltered) {
    const seen = new Set<string>();
    for (const d of liveDiseaseRows(m)) {
      if (seen.has(d.diseaseCode)) continue;
      seen.add(d.diseaseCode);
      diseaseCodeCounts.set(d.diseaseCode, (diseaseCodeCounts.get(d.diseaseCode) ?? 0) + 1);
    }
  }
  const diseaseOptions = [...diseaseCodes]
    .map((code) => ({ code, count: diseaseCodeCounts.get(code) ?? 0 }))
    .sort((a, b) => diseaseLabel(a.code).localeCompare(diseaseLabel(b.code)));
  const diseaseOptionsShown = diseaseOptions.filter((o) => {
    const q = diseaseSearch.trim().toLowerCase();
    return !q || diseaseLabel(o.code).toLowerCase().includes(q) || o.code.toLowerCase().includes(q);
  });

  const visible =
    selectedDiseaseCodes.size === 0
      ? preDiseaseFiltered
      : preDiseaseFiltered.filter((m) =>
          liveDiseaseRows(m).some((d) => selectedDiseaseCodes.has(d.diseaseCode)),
        );

  // The total pending count across the WHOLE roster — unaffected by any
  // active filter, so the "Needs review" pill's badge is a stable total.
  const pendingTotal = members.reduce((sum, m) => sum + pendingDiseaseRows(m).length, 0);

  const filtersActive =
    selectedDiseaseCodes.size > 0 || confidenceFilter !== "any" || needsReviewOnly || freeText.trim() !== "";

  // The nudge is about WORK OUTSTANDING, not about what the filter is hiding —
  // "all" hides nothing now. These are the people who left WCM while their
  // membership stayed open, which is the only state here needing a curator.
  const needsCloseOut = members.filter(needsCloseOutOf).length;
  const colCount = (hasPrograms ? 6 : 4) + (hasDiseases ? 1 : 0);

  return (
    <EditPanel
      slot="center-roster-card"
      heading="Members"
      description="The people listed on this center. Listing a member does not grant them edit access."
    >
      <div className="flex flex-col gap-4">
        <div className="border-apollo-border flex flex-col gap-3 rounded-md border p-4" data-slot="center-roster-add">
          <p className="text-sm font-medium">Add member</p>
          <DirectoryPeopleTypeahead idPrefix="roster" value={addValue} onChange={setAddValue} />
          <div className="flex justify-end">
            <Button type="button" variant="apollo" onClick={add} disabled={!addValue || adding} data-testid="center-roster-add">
              {adding ? "Adding…" : "Add"}
            </Button>
          </div>
        </div>

        <div className="flex items-center justify-between gap-4">
          {exportEnabled ? (
            <a
              // No `?activeOnly=1`: "active only" stopped being one of the views,
              // so the export is the whole roster and its `status` column (which
              // matches the badge exactly — see the export route's docblock) is
              // what distinguishes the rows.
              href={`/edit/center/${encodeURIComponent(unitCode)}/export`}
              className="text-apollo-slate text-sm hover:underline"
              data-testid="center-roster-export-link"
            >
              Export CSV
            </a>
          ) : (
            <span />
          )}
          <RadioGroup
            className="flex items-center gap-4"
            value={filter}
            onValueChange={(v) => setFilter(v as RosterFilter)}
            aria-label="Filter members"
          >
            {(
              [
                ["all", "All members"],
                ["inactive", "Inactive members only"],
                ["departed", "Departed members only"],
              ] as ReadonlyArray<readonly [RosterFilter, string]>
            ).map(([value, label]) => (
              <label key={value} className="flex items-center gap-2 text-sm">
                <RadioGroupItem value={value} data-testid={`roster-filter-${value}`} />
                {label}
              </label>
            ))}
          </RadioGroup>
        </div>

        {/* The new filter bar — free-text search always available; the
            disease/confidence/needs-review controls only when this center
            actually has assignment data. AND-composed with each other and
            with the radio filter above. */}
        <div className="flex flex-wrap items-end gap-3" data-testid="center-roster-filter-bar">
          <div className="flex flex-col gap-1">
            <label htmlFor="roster-search-input" className="text-muted-foreground text-xs font-medium">
              Search
            </label>
            <Input
              id="roster-search-input"
              type="text"
              placeholder="Name or CWID"
              className="h-8 w-48"
              value={freeText}
              onChange={(e) => setFreeText(e.target.value)}
              data-testid="roster-search-input"
            />
          </div>

          {hasDiseases && (
            <>
              <div className="flex flex-col gap-1">
                <span className="text-muted-foreground text-xs font-medium">Disease</span>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="outline" size="sm" className="h-8 gap-1.5" data-testid="roster-disease-filter-trigger">
                      {selectedDiseaseCodes.size === 0
                        ? "Any disease"
                        : `${selectedDiseaseCodes.size} selected`}
                      <ChevronDown className="size-3.5 opacity-60" aria-hidden />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="start" className="w-72 p-2" data-testid="roster-disease-filter-menu">
                    <Input
                      type="text"
                      placeholder="Filter diseases…"
                      className="mb-2 h-8"
                      value={diseaseSearch}
                      onChange={(e) => setDiseaseSearch(e.target.value)}
                      data-testid="roster-disease-filter-search"
                    />
                    <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
                      {diseaseOptionsShown.length === 0 ? (
                        <p className="text-muted-foreground px-1.5 py-1 text-xs">No diseases match.</p>
                      ) : (
                        diseaseOptionsShown.map((opt) => (
                          <label
                            key={opt.code}
                            className="hover:bg-accent flex cursor-pointer items-center gap-2 rounded px-1.5 py-1.5 text-sm"
                            data-testid={`roster-disease-filter-option-${opt.code}`}
                          >
                            <Checkbox
                              checked={selectedDiseaseCodes.has(opt.code)}
                              onCheckedChange={() => toggleDiseaseCode(opt.code)}
                            />
                            <span className="truncate">{diseaseLabel(opt.code)}</span>
                            <span className="text-muted-foreground ml-auto text-xs tabular-nums">{opt.count}</span>
                          </label>
                        ))
                      )}
                    </div>
                  </PopoverContent>
                </Popover>
              </div>

              <div className="flex flex-col gap-1">
                <label htmlFor="roster-confidence-filter" className="text-muted-foreground text-xs font-medium">
                  Confidence
                </label>
                <select
                  id="roster-confidence-filter"
                  className="border-apollo-border-strong h-8 rounded-md border bg-apollo-surface px-2 text-sm"
                  value={confidenceFilter}
                  onChange={(e) => setConfidenceFilter(e.target.value as ConfidenceFilter)}
                  data-testid="roster-confidence-filter"
                >
                  <option value="any">Any</option>
                  <option value="high">High</option>
                  <option value="medium">Medium</option>
                  <option value="low">Low</option>
                </select>
              </div>

              <button
                type="button"
                onClick={() => setNeedsReviewOnly((v) => !v)}
                aria-pressed={needsReviewOnly}
                className={`inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors ${
                  needsReviewOnly
                    ? "border-apollo-amber bg-apollo-amber text-white"
                    : "border-apollo-amber-tint-border bg-apollo-amber-tint text-apollo-amber"
                }`}
                data-testid="roster-needs-review-toggle"
              >
                Needs review
                <span
                  className={`inline-flex min-w-4 items-center justify-center rounded-full px-1 text-[0.65rem] tabular-nums ${
                    needsReviewOnly ? "bg-white/25 text-white" : "bg-white/60 text-apollo-amber"
                  }`}
                >
                  {pendingTotal}
                </span>
              </button>
            </>
          )}
        </div>

        {filtersActive && (
          <div className="flex items-center justify-between gap-4 text-sm">
            <span className="text-muted-foreground" data-testid="roster-filter-result-line">
              Showing {visible.length} of {rosterFiltered.length} members
            </span>
            <button
              type="button"
              className="text-apollo-slate text-xs hover:underline"
              onClick={clearAllFilters}
              data-testid="roster-filter-clear-all"
            >
              Clear all filters
            </button>
          </div>
        )}

        {needsCloseOut > 0 && filter !== "departed" && (
          <p className="text-muted-foreground text-sm" data-testid="roster-needs-close-out">
            {needsCloseOut === 1
              ? "1 member has left WCM with their membership still open."
              : `${needsCloseOut} members have left WCM with their membership still open.`}{" "}
            <button
              type="button"
              className="text-apollo-slate underline"
              onClick={() => setFilter("departed")}
              data-testid="roster-needs-close-out-jump"
            >
              Show them
            </button>{" "}
            to set an end date.
          </p>
        )}

        {members.length === 0 ? (
          <p className="text-muted-foreground text-sm" data-testid="center-roster-empty">
            This roster is empty. Add the first member to populate this center.
          </p>
        ) : (
          <div className="overflow-x-auto">
          <table className="[&_td]:align-middle w-full min-w-[880px] text-sm" data-testid="center-roster-table">
            <thead className="bg-apollo-surface-2 text-muted-foreground text-left">
              <tr className="border-apollo-border border-b">
                <th className="px-3 py-2 font-medium">Member</th>
                {hasPrograms && <th className="px-3 py-2 font-medium">Type</th>}
                {hasPrograms && <th className="px-3 py-2 font-medium">Program</th>}
                {hasDiseases && <th className="px-3 py-2 font-medium">Diseases</th>}
                <th className="px-3 py-2 font-medium">Start</th>
                <th className="px-3 py-2 font-medium">End</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 ? (
                <tr>
                  <td colSpan={colCount + 1} className="text-muted-foreground px-3 py-3">
                    {rosterFiltered.length === 0 ? (
                      <>
                        No members match this filter. Choose &ldquo;All members&rdquo; to see the whole
                        roster.
                      </>
                    ) : (
                      <>
                        No members match the current filters.{" "}
                        <button
                          type="button"
                          className="text-apollo-slate underline"
                          onClick={clearAllFilters}
                          data-testid="roster-filter-clear-all-inline"
                        >
                          Clear all filters
                        </button>{" "}
                        to see more.
                      </>
                    )}
                  </td>
                </tr>
              ) : (
                visible.map((m) => {
                  const status = statusOf(m, now);
                  // The case this card exists to surface (see the type docblock):
                  // the person left WCM but nobody closed out their membership, so
                  // it still reads Active. Amber is this UI's "needs attention"
                  // (honors-queue contested groups, all-units-directory), not red —
                  // it is a data-quality gap to fix, not a failure. Mutually
                  // exclusive with the `opacity-50` inactive dimming by
                  // construction, so the two never compose.
                  const rowNeedsCloseOut = needsCloseOutOf(m);
                  const expanded = expandedCwids.has(m.cwid);
                  return (
                    <React.Fragment key={m.cwid}>
                    <tr
                      className={`border-apollo-border border-b ${
                        status === "inactive" ? "opacity-50" : ""
                      } ${rowNeedsCloseOut ? "bg-apollo-amber-tint" : ""}`}
                      data-testid={`center-roster-row-${m.cwid}`}
                      data-needs-close-out={rowNeedsCloseOut ? "true" : undefined}
                    >
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-medium">{m.name}</span>
                          {m.title && <span className="text-muted-foreground">· {m.title}</span>}
                          {m.scholarState === "departed" && (
                            <Badge
                              variant="outline"
                              className="bg-apollo-amber-tint text-apollo-amber border-apollo-amber-tint-border rounded-full"
                              data-testid={`roster-scholar-state-${m.cwid}`}
                            >
                              Left WCM
                            </Badge>
                          )}
                          {m.scholarState === "unknown" && (
                            <Badge
                              variant="outline"
                              className="border-apollo-border rounded-full"
                              data-testid={`roster-scholar-state-${m.cwid}`}
                              title="No directory record matches this CWID, so we can't show a name."
                            >
                              Not in directory
                            </Badge>
                          )}
                        </div>
                        <div className="text-muted-foreground text-xs" data-testid={`roster-cwid-${m.cwid}`}>
                          CWID: {m.cwid}
                        </div>
                      </td>
                      {hasPrograms && (
                        <td className="px-3 py-2">
                          <select
                            className="border-apollo-border-strong h-8 rounded-md border bg-apollo-surface px-2 text-sm"
                            value={m.membershipType ?? ""}
                            onChange={(e) =>
                              patch(m.cwid, {
                                membershipType: (e.target.value || null) as RosterMember["membershipType"],
                              })
                            }
                            data-testid={`roster-type-${m.cwid}`}
                          >
                            <option value="">—</option>
                            <option value="research">Research</option>
                            <option value="clinical">Clinical</option>
                          </select>
                        </td>
                      )}
                      {hasPrograms && (
                        <td className="px-3 py-2">
                          <select
                            className="border-apollo-border-strong h-8 rounded-md border bg-apollo-surface px-2 text-sm"
                            value={m.programCode ?? ""}
                            onChange={(e) => patch(m.cwid, { programCode: e.target.value || null })}
                            data-testid={`roster-program-${m.cwid}`}
                          >
                            <option value="">—</option>
                            {programs.map((p) => (
                              <option key={p.code} value={p.code}>
                                {p.label}
                              </option>
                            ))}
                          </select>
                        </td>
                      )}
                      {hasDiseases && (
                        <td className="px-3 py-2">
                          <DiseaseChips member={m} onToggleExpand={toggleExpand} />
                        </td>
                      )}
                      <td className="px-3 py-2">
                        <Input
                          type="date"
                          className="h-8 w-36"
                          value={m.startDate ?? ""}
                          onChange={(e) => onStartChange(m, e.target.value)}
                          data-testid={`roster-start-${m.cwid}`}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <Input
                          type="date"
                          className={`h-8 w-36 ${
                            rowNeedsCloseOut ? "border-apollo-amber focus-visible:ring-apollo-amber" : ""
                          }`}
                          value={m.endDate ?? ""}
                          onChange={(e) => onEndChange(m, e.target.value)}
                          data-testid={`roster-end-${m.cwid}`}
                          aria-describedby={rowNeedsCloseOut ? `roster-end-hint-${m.cwid}` : undefined}
                        />
                        {rowNeedsCloseOut && (
                          <span id={`roster-end-hint-${m.cwid}`} className="sr-only">
                            This person has left WCM. Set an end date to close out their
                            membership.
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <Badge
                          variant="outline"
                          className={`rounded-full ${
                            status === "active"
                              ? "bg-apollo-green-tint text-apollo-green border-apollo-green-tint-border"
                              : "bg-apollo-slate-tint text-apollo-slate border-apollo-slate-tint-border"
                          }`}
                          data-testid={`roster-status-${m.cwid}`}
                        >
                          {status === "active" ? "Active" : status === "pending" ? "Pending" : "Inactive"}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setRemoveTarget(m)}
                          data-testid={`roster-remove-${m.cwid}`}
                        >
                          Remove
                        </Button>
                      </td>
                    </tr>
                    {hasDiseases && expanded && (m.diseases ?? []).length > 0 && (
                      <tr className="border-apollo-border bg-apollo-surface-2 border-b" data-testid={`disease-expand-row-${m.cwid}`}>
                        <td colSpan={colCount + 1} className="px-3 py-3">
                          <DiseaseExpandedPanel
                            member={m}
                            onDecide={decideDisease}
                            onCollapse={() => toggleExpand(m.cwid)}
                          />
                        </td>
                      </tr>
                    )}
                    </React.Fragment>
                  );
                })
              )}
            </tbody>
          </table>
          </div>
        )}

        {hasDiseases && (
          <div
            className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs"
            data-testid="roster-disease-legend"
          >
            <span className="text-foreground font-medium">Confidence</span>
            <span className="inline-flex items-center gap-1.5">
              <span className="bg-apollo-green-foreground size-2.5 rounded-full" aria-hidden />
              High
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="bg-apollo-amber size-2.5 rounded-full" aria-hidden />
              Medium
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="bg-apollo-slate size-2.5 rounded-full" aria-hidden />
              Low
            </span>
            <span>✓ = confirmed by an editor · rejected assignments are hidden from chips</span>
          </div>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <p className="text-sm">
          <Link
            href={`/edit/center/${encodeURIComponent(unitCode)}/history`}
            className="text-apollo-slate hover:underline"
            data-testid="center-roster-history-link"
          >
            View change history
          </Link>
        </p>
      </div>

      <ConfirmDialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
        title={removeTarget ? `Remove ${removeTarget.name} from this center?` : ""}
        // Steers to the End date. The previous copy ("You can add them back at
        // any time") framed removal as cheap and reversible, which is how a
        // roster loses its history: a member who LEFT and a member added in
        // ERROR are different facts, and only the second one should be erased.
        description={
          removeTarget && removeTarget.endDate
            ? "This erases the membership from the roster, including the end date already recorded. Remove only if this person was added in error — otherwise the end date alone is the correct record."
            : "This erases the membership from the roster entirely, and the center loses any record that they were ever a member. If they have LEFT the center, close the row out with an End date instead — that keeps the history. Remove only if this person was added in error."
        }
        reasonMode="none"
        confirmLabel="Remove anyway"
        confirmVariant="destructive"
        onConfirm={confirmRemove}
      />
    </EditPanel>
  );
}

function mapErrorToMessage(code: string): string {
  switch (code) {
    case "not_curator":
    case "not_superuser":
    case "not_unit_owner":
      return "You no longer have access to this center. Refresh the page and try again.";
    case "invalid_date_range":
      return "The end date can't be before the start date.";
    case "no_taxonomy":
    case "invalid_program_code":
      return "That program isn't available for this center.";
    case "assignment_not_found":
      return "This disease is no longer in the current assignment list. Refresh the page to see what changed.";
    default:
      return "Something went wrong — the change wasn't saved. Please try again.";
  }
}
