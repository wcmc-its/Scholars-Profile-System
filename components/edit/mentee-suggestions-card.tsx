/**
 * "Mentees › From your publications" — the #2634 sub-view
 * (`SELF_EDIT_MENTEE_SUGGESTIONS`) listing co-authors who hold a trainee-type
 * WCM appointment, for the mentor to ADD as a mentee (writes the #2011
 * `manualMentees` array through `/api/edit/field`, same as the "Added by you"
 * card) or DISMISS with a reason (`/api/edit/mentee-suggestions/[id]/dismiss`,
 * reversible via `/restore`).
 *
 * Mirrors the COI-gap sub-view's posture: a suggestion surface, never public
 * until the mentor adds someone; who may load it is enforced upstream
 * (`loadEditContext`) and again at the routes. This component renders what it is
 * handed. A superuser sees the same card with third-person copy.
 *
 * Default list = presumptive / ambiguous tier, ≥2 co-pubs, not dismissed.
 * Two collapsed footers hold the rest: 1-paper matches and dismissed rows
 * (with Restore). Unknown-tier co-authors never reach the table (builder).
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft } from "lucide-react";

import { EditPanel } from "@/components/edit/edit-panel";
import {
  MenteeForm,
  draftToEntry,
  mapErrorToMessage,
  type Draft,
} from "@/components/edit/manual-mentees-card";
import { Button } from "@/components/ui/button";
import type {
  EditContextMenteeSuggestion,
  EditContextMenteeSuggestionEvidence,
} from "@/lib/api/edit-context";
import { citationIdentifier } from "@/lib/citation";
import type { ManualMentee } from "@/lib/edit/manual-mentee";
import {
  DISMISS_REASONS,
  KIND_LABEL,
  programTypeForKind,
  type DismissReason,
  type MenteeKind,
} from "@/lib/mentee-suggestions/kind";

export type MenteeSuggestionsCardProps = {
  cwid: string;
  mode?: "self" | "superuser";
  scholarName?: string;
  suggestions: ReadonlyArray<EditContextMenteeSuggestion>;
  /** The mentor's stored hand-entered mentees; "Add as mentee" appends to this
   *  array and POSTs the WHOLE thing (the #2011 full-array contract). */
  manualMentees: ReadonlyArray<ManualMentee>;
};

/** Human labels for the three dismiss reasons (issue mockup wording). */
const REASON_LABEL: Record<DismissReason, string> = {
  colleague: "Colleague or collaborator",
  never_worked: "We never worked together",
  private: "Was my mentee, but I’d rather not list them",
};

const PUBS_SHOWN = 3;
const GENERIC_ERROR = "We couldn’t update this just now. Please try again.";

function lastNameOf(full: string): string {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : full.trim();
}

function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  const s = ["th", "st", "nd", "rd"][n % 10] ?? "th";
  return `${n}${s}`;
}

/** "Raman 1st of 9 · you last" — byline positions from the stored ranks. */
export function bylineOf(
  e: EditContextMenteeSuggestionEvidence,
  menteeSurname: string,
  you: string,
): string {
  const mentee = `${menteeSurname} ${ordinal(e.menteeRank)} of ${e.total}`;
  const mentor = e.mentorRank === e.total ? `${you} last` : `${you} ${ordinal(e.mentorRank)}`;
  return `${mentee} · ${mentor}`;
}

/** Default-list membership: a plausible trainee with ≥2 shared papers, not dismissed. */
function isDefault(s: EditContextMenteeSuggestion): boolean {
  return s.dismissedAt === null && s.tier !== "unknown" && s.nCoPubs >= 2;
}

/** Strong first, then most last-author co-pubs, then most co-pubs. */
function byStrength(a: EditContextMenteeSuggestion, b: EditContextMenteeSuggestion): number {
  return (
    Number(b.strong) - Number(a.strong) ||
    b.nMentorLastAuthor - a.nMentorLastAuthor ||
    b.nCoPubs - a.nCoPubs ||
    a.menteeName.localeCompare(b.menteeName)
  );
}

export function MenteeSuggestionsCard({
  cwid,
  mode = "self",
  scholarName = "",
  suggestions,
  manualMentees,
}: MenteeSuggestionsCardProps) {
  const router = useRouter();
  const su = mode === "superuser";
  const backHref = su ? `/edit/scholar/${cwid}?attr=mentees` : "/edit?attr=mentees";
  const you = su ? lastNameOf(scholarName) || "the scholar" : "you";

  // Optimistic overlays keyed by suggestion id. The server is the source of
  // truth on reload (`router.refresh()` after an add re-renders from it).
  const [dismissed, setDismissed] = React.useState<Map<number, DismissReason | null>>(new Map());
  const [added, setAdded] = React.useState<Set<number>>(new Set());
  // Entries written this session. The prop goes stale until router.refresh()
  // re-renders, and a full-array write from the stale prop would drop the
  // previous add — so every POST merges these in (deduped by cwid once the
  // refreshed prop carries them).
  const [addedEntries, setAddedEntries] = React.useState<ManualMentee[]>([]);
  const [errors, setErrors] = React.useState<Map<number, string>>(new Map());
  const [busy, setBusy] = React.useState<Set<number>>(new Set());

  const view = React.useMemo(
    () =>
      suggestions
        .filter((s) => !added.has(s.id))
        .map((s) => {
          const local = dismissed.get(s.id);
          if (local === undefined) return s;
          // A local dismiss (reason) or restore (null) overrides the server row.
          return {
            ...s,
            dismissedAt: local === null ? null : new Date().toISOString(),
            dismissReason: local,
          };
        }),
    [suggestions, dismissed, added],
  );
  const main = view.filter(isDefault).sort(byStrength);
  const weak = view.filter(
    (s) => s.dismissedAt === null && s.tier !== "unknown" && s.nCoPubs === 1,
  );
  const gone = view.filter((s) => s.dismissedAt !== null);

  function setErr(id: number, msg: string | null) {
    setErrors((m) => {
      const next = new Map(m);
      if (msg === null) next.delete(id);
      else next.set(id, msg);
      return next;
    });
  }
  function setBusyFor(id: number, on: boolean) {
    setBusy((b) => {
      const next = new Set(b);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  /** POST dismiss (reason) or restore (null); optimistic, rolled back on error. */
  async function setDismissal(s: EditContextMenteeSuggestion, reason: DismissReason | null) {
    // `s` is the overlaid view row, so this is the state to roll back to.
    const previous: DismissReason | null = s.dismissedAt === null ? null : s.dismissReason;
    setDismissed((m) => new Map(m).set(s.id, reason));
    setErr(s.id, null);
    setBusyFor(s.id, true);
    try {
      const base = `/api/edit/mentee-suggestions/${s.id}`;
      const res = await fetch(reason === null ? `${base}/restore` : `${base}/dismiss`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: reason === null ? "{}" : JSON.stringify({ reason }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean };
      if (!res.ok || data.ok !== true) throw new Error("write_failed");
    } catch {
      setDismissed((m) => new Map(m).set(s.id, previous));
      setErr(s.id, GENERIC_ERROR);
    } finally {
      setBusyFor(s.id, false);
    }
  }

  /** The manual entry an accepted suggestion becomes: the form's fields plus
   *  the degree bucket its kind implies, so it files under Postdoc/PhD/MD on
   *  the public profile instead of "other". */
  function entryFor(s: EditContextMenteeSuggestion, draft: Draft): ManualMentee {
    const programType = programTypeForKind(s.kind as MenteeKind);
    return programType ? { ...draftToEntry(draft), programType } : draftToEntry(draft);
  }

  /** Append to the mentor's hand-entered list and POST the whole array. */
  async function addAsMentee(s: EditContextMenteeSuggestion, draft: Draft): Promise<boolean> {
    setErr(s.id, null);
    setBusyFor(s.id, true);
    try {
      const res = await fetch("/api/edit/field", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entityType: "scholar",
          entityId: cwid,
          fieldName: "manualMentees",
          value: [
            ...manualMentees,
            ...addedEntries.filter((a) => !manualMentees.some((m) => m.cwid === a.cwid)),
            entryFor(s, draft),
          ],
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || data.ok !== true) {
        setErr(s.id, mapErrorToMessage(data.error ?? ""));
        return false;
      }
      setAdded((a) => new Set(a).add(s.id));
      setAddedEntries((a) => [...a, entryFor(s, draft)]);
      router.refresh();
      return true;
    } catch {
      setErr(s.id, GENERIC_ERROR);
      return false;
    } finally {
      setBusyFor(s.id, false);
    }
  }

  const rowProps = (s: EditContextMenteeSuggestion) => ({
    s,
    you,
    su,
    scholarName,
    busy: busy.has(s.id),
    error: errors.get(s.id) ?? null,
    onAdd: (draft: Draft) => addAsMentee(s, draft),
    onDismiss: (reason: DismissReason) => setDismissal(s, reason),
  });

  return (
    <>
      <Link
        href={backHref}
        data-testid="mentee-suggestions-back"
        className="text-apollo-slate -mb-1 inline-flex w-fit items-center gap-1 text-sm font-medium hover:underline"
      >
        <ChevronLeft className="size-4" aria-hidden />
        Mentees
      </Link>

      <EditPanel
        slot="mentee-suggestions-panel"
        heading="From your publications"
        description={
          su
            ? `Co-authors of ${scholarName}’s who hold a trainee-type appointment at WCM. Adding one lists them on the public profile; nothing here is public until it is added. Refreshes nightly from curated publications.`
            : "Co-authors of yours who hold a trainee-type appointment at WCM. Adding one lists them on your public profile; nothing here is public until you do. Refreshes nightly from curated publications."
        }
      >
        {main.length === 0 ? (
          <p className="text-muted-foreground text-sm" data-testid="mentee-suggestions-empty">
            No suggestions yet. We look for co-authors who hold a trainee appointment; suggestions
            refresh nightly as publications are curated.
          </p>
        ) : (
          <ul
            className="border-apollo-border divide-apollo-border divide-y rounded-md border"
            data-testid="mentee-suggestions-list"
          >
            {main.map((s) => (
              <SuggestionRow key={s.id} {...rowProps(s)} />
            ))}
          </ul>
        )}

        {weak.length > 0 && (
          <details data-testid="mentee-suggestions-weak">
            <summary className="text-apollo-slate cursor-pointer text-sm font-medium">
              {weak.length} weaker {weak.length === 1 ? "match" : "matches"} (1 co-authored paper
              each)
            </summary>
            <ul className="border-apollo-border divide-apollo-border mt-2 divide-y rounded-md border">
              {weak.sort(byStrength).map((s) => (
                <SuggestionRow key={s.id} {...rowProps(s)} />
              ))}
            </ul>
          </details>
        )}

        {gone.length > 0 && (
          <details data-testid="mentee-suggestions-dismissed">
            <summary className="text-apollo-slate cursor-pointer text-sm font-medium">
              {gone.length} dismissed
            </summary>
            <ul className="mt-2 flex flex-col gap-2">
              {gone.map((s) => (
                <li
                  key={s.id}
                  className="text-muted-foreground flex flex-wrap items-center justify-between gap-2 text-sm"
                  data-testid={`mentee-suggestion-dismissed-${s.id}`}
                >
                  <span>
                    <span className="text-foreground">{s.menteeName}</span> {s.menteeCwid}
                    {s.dismissReason ? ` · ${REASON_LABEL[s.dismissReason]}` : null}
                    {errors.get(s.id) ? (
                      <span className="text-destructive"> · {errors.get(s.id)}</span>
                    ) : null}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy.has(s.id)}
                    onClick={() => setDismissal(s, null)}
                    data-testid={`mentee-suggestion-restore-${s.id}`}
                  >
                    Restore
                  </Button>
                </li>
              ))}
            </ul>
          </details>
        )}
      </EditPanel>
    </>
  );
}

function SuggestionRow({
  s,
  you,
  su,
  scholarName,
  busy,
  error,
  onAdd,
  onDismiss,
}: {
  s: EditContextMenteeSuggestion;
  you: string;
  su: boolean;
  scholarName: string;
  busy: boolean;
  error: string | null;
  onAdd: (draft: Draft) => Promise<unknown>;
  onDismiss: (reason: DismissReason) => void;
}) {
  const [panel, setPanel] = React.useState<"add" | "dismiss" | null>(null);
  const [reason, setReason] = React.useState<DismissReason | null>(null);
  const [showAll, setShowAll] = React.useState(false);
  const surname = lastNameOf(s.menteeName);
  const title = s.menteeTitle || KIND_LABEL[s.kind];
  const pubs = showAll ? s.evidence : s.evidence.slice(0, PUBS_SHOWN);
  const years =
    s.firstYear != null && s.lastYear != null
      ? s.firstYear === s.lastYear
        ? String(s.firstYear)
        : `${s.firstYear}–${s.lastYear}`
      : null;

  return (
    <li className="flex flex-col gap-2 p-4" data-testid={`mentee-suggestion-${s.id}`}>
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-[15px] font-medium">{s.menteeName}</span>
        <span className="text-muted-foreground text-xs">{s.menteeCwid}</span>
        {/* The role is the career-stage tell, so it sits with the name as a
            chip rather than as muted text at the far edge of the row. */}
        <span
          className="border-apollo-slate-tint-border bg-apollo-slate-tint text-apollo-slate rounded-full border px-2 py-0.5 text-[11px] font-medium"
          data-testid={`mentee-suggestion-title-${s.id}`}
        >
          {title}
        </span>
        {s.strong && (
          <span
            className="border-apollo-amber-tint-border bg-apollo-amber-tint text-apollo-amber rounded-full border px-2 py-0.5 text-[11px] font-medium"
            data-testid={`mentee-suggestion-strong-${s.id}`}
          >
            Strong match
          </span>
        )}
      </div>

      <p className="text-muted-foreground text-sm">
        {[
          s.menteeUnit,
          s.menteeFirstPublishedYear != null
            ? `first published ${s.menteeFirstPublishedYear}`
            : null,
        ]
          .filter(Boolean)
          .join(" · ")}
        {s.tier === "ambiguous" && (
          <span className="ml-2" data-testid={`mentee-suggestion-hint-${s.id}`}>
            ⓘ {s.kind === "alumni_md" ? "MD alum" : "staff role"} — may be a colleague rather than a
            trainee; check the title and first publication year
          </span>
        )}
      </p>

      <p className="text-sm" data-testid={`mentee-suggestion-evidence-${s.id}`}>
        {s.nCoPubs} co-authored · {s.nMentorLastAuthor} with {you} as last author
        {years ? ` · ${years}` : ""}
      </p>

      {s.evidence.length > 0 && (
        <details data-testid={`mentee-suggestion-pubs-${s.id}`}>
          <summary className="text-apollo-slate cursor-pointer text-sm font-medium">
            Co-authored publications ({s.nCoPubs})
            {s.nCoPubs > s.evidence.length && (
              <span className="text-muted-foreground text-xs font-normal">
                {" "}
                · {s.evidence.length} most recent shown; the full list appears on the profile once
                added
              </span>
            )}
          </summary>
          <ul className="mt-2 flex flex-col gap-2">
            {pubs.map((e) => (
              <PubRow key={e.id} e={e} surname={surname} you={you} />
            ))}
          </ul>
          {!showAll && s.evidence.length > PUBS_SHOWN && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="text-apollo-slate mt-2 text-sm font-medium hover:underline"
              data-testid={`mentee-suggestion-more-${s.id}`}
            >
              Show {s.evidence.length - PUBS_SHOWN} more
            </button>
          )}
        </details>
      )}

      {panel === "add" ? (
        <div data-testid={`mentee-suggestion-add-form-${s.id}`}>
          <p className="mb-2 text-sm font-medium">
            Add {s.menteeName} as a mentee{su ? ` of ${scholarName}` : ""}
          </p>
          <MenteeForm
            idPrefix={`sugg-${s.id}`}
            initial={{ cwid: s.menteeCwid, name: s.menteeName, programLabel: title, year: "" }}
            submitLabel="Save"
            busy={busy}
            onSubmit={(d) => void onAdd(d)}
            onCancel={() => setPanel(null)}
          />
        </div>
      ) : panel === "dismiss" ? (
        <fieldset
          className="border-apollo-border flex flex-col gap-2 rounded-md border p-3"
          data-testid={`mentee-suggestion-dismiss-form-${s.id}`}
        >
          <legend className="px-1 text-sm font-medium">Not a mentee because:</legend>
          {DISMISS_REASONS.map((r) => (
            <label key={r} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name={`dismiss-${s.id}`}
                value={r}
                checked={reason === r}
                onChange={() => setReason(r)}
                data-testid={`mentee-suggestion-reason-${r}-${s.id}`}
              />
              {REASON_LABEL[r]}
            </label>
          ))}
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => setPanel(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="apollo"
              size="sm"
              disabled={busy || reason === null}
              onClick={() => reason && onDismiss(reason)}
              data-testid={`mentee-suggestion-dismiss-${s.id}`}
            >
              Dismiss
            </Button>
          </div>
        </fieldset>
      ) : (
        <div className="flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="apollo"
            size="sm"
            disabled={busy}
            onClick={() => setPanel("add")}
            data-testid={`mentee-suggestion-add-${s.id}`}
          >
            {su ? `Add for ${scholarName}` : "Add as mentee"}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => setPanel("dismiss")}
            data-testid={`mentee-suggestion-not-${s.id}`}
          >
            Not a mentee
          </Button>
        </div>
      )}

      {error && (
        <p className="text-destructive text-sm" data-testid={`mentee-suggestion-error-${s.id}`}>
          {error}
        </p>
      )}
    </li>
  );
}

function PubRow({
  e,
  surname,
  you,
}: {
  e: EditContextMenteeSuggestionEvidence;
  surname: string;
  you: string;
}) {
  const [full, setFull] = React.useState(false);
  const title = e.title ?? "(title unavailable)";
  // Offer the toggle only when the clamped title really overflows — measured,
  // so a one-line title never carries a dead "[full ›]". Test environments
  // without layout (jsdom) fall back to a length guess.
  const titleRef = React.useRef<HTMLParagraphElement>(null);
  const [clampable, setClampable] = React.useState(title.length > 80);
  React.useLayoutEffect(() => {
    const el = titleRef.current;
    if (!el || full || el.clientHeight === 0) return;
    setClampable(el.scrollHeight > el.clientHeight);
  }, [title, full]);
  const cite = citationIdentifier(e.id);
  return (
    <li className="flex gap-3 text-sm" data-testid={`mentee-suggestion-pub-${e.id}`}>
      <span className="text-muted-foreground w-10 shrink-0">{e.year ?? ""}</span>
      <div className="min-w-0 flex-1">
        {/* The toggle sits OUTSIDE the clamped block: inside it, an overflowing
            title clips the button itself — exactly the case the toggle is for. */}
        <p
          ref={titleRef}
          className={full ? "" : "line-clamp-2"}
          data-testid={`mentee-suggestion-pub-title-${e.id}`}
        >
          {title}
        </p>
        {clampable && (
          <button
            type="button"
            onClick={() => setFull((v) => !v)}
            className="text-apollo-slate text-xs font-medium hover:underline"
            aria-expanded={full}
            data-testid={`mentee-suggestion-pub-toggle-${e.id}`}
          >
            {full ? "[less ‹]" : "[full ›]"}
          </button>
        )}
        <p className="text-muted-foreground text-xs">
          {e.journal ? `${e.journal} · ` : ""}
          {bylineOf(e, surname, you)} ·{" "}
          {cite.href ? (
            <a
              href={cite.href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-apollo-slate font-medium underline-offset-2 hover:underline"
              data-testid={`mentee-suggestion-pub-link-${e.id}`}
            >
              PMID {cite.value}
            </a>
          ) : (
            <span>
              {cite.label} {cite.value}
            </span>
          )}
        </p>
      </div>
    </li>
  );
}
