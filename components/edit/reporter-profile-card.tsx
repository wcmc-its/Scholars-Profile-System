/**
 * Grant-matches review tab — the RePORTER PMID-overlap match card
 * (`REPORTER_MATCH_V2`, dormant). Surfaces NIH grants found under a same-named PI
 * whose grant publications overlap the scholar's OWN trusted PubMed set, so a
 * lateral recruit (no WCM grant yet) can claim their prior-institution federal
 * funding.
 *
 * Two sections, two DIFFERENT models (the seam is *consequence*, not subject):
 *   - PENDING ("Is this you?"): K=2 suggestions whose grants are NOT yet on the
 *     profile. OPT-IN — the scholar (or a genuine superuser on their behalf)
 *     confirms to attach them (they land on the profile + CV at the next nightly
 *     update) or declines with an enum reason (feeds matcher QA; never
 *     re-proposed). This tier drives the rail's review-queue badge
 *     (`reporterProfileCandidates.length`), so confirm/decline both clear it.
 *   - CONFIRMED / auto-locked: high-confidence matches ALREADY on the public
 *     profile. OPT-OUT — the only job is to catch the rare wrong one. "Not me —
 *     remove" revokes; the grants come off at the next nightly update (the publish
 *     layer can't purge a single record on demand — see the removal copy).
 *
 * Removal is batch-bound on purpose: `revoke` drops the `person_nih_profile` row,
 * and the materialized RePORTER grants are reconciled out on the next
 * `reporter-grants` ETL run. So the copy promises the nightly update, NOT
 * "instant" — the UI never claims a safety property the pipeline can't honor.
 *
 * GOVERNANCE (projection-starved — [[project_topic_score_is_internal]] + the
 * COI-gap rule): the numeric overlap K NEVER reaches this component, and no
 * scoring vocabulary ("confidence", "score", "overlap") renders — the scholar
 * recognizes their grants from the titles, not a number. The card receives only
 * human-recognizable fields (name, orgs, grant count, ≤3 sample grant titles).
 *
 * A (non-impersonating) superuser may act on the scholar's behalf, with a confirm
 * "nag" before any write (COI-gap convention). Who may load + act is enforced
 * upstream (`loadEditContext`) and again at the confirm/reject/revoke APIs; this
 * component renders only what it is handed.
 */
"use client";

import * as React from "react";
import { Building2, Database, EyeOff, Globe } from "lucide-react";

import { ConfirmDialog } from "@/components/edit/confirm-dialog";
import { EditPanel } from "@/components/edit/edit-panel";
import { Button } from "@/components/ui/button";
import { nihReporterPiUrl } from "@/lib/nih-reporter";
import { REJECT_REASONS, REJECT_REASON_LABEL, type RejectReason } from "@/lib/edit/reporter-profile";
import type {
  EditContextReporterProfileCandidate,
  EditContextReporterProfileConfirmed,
  EditContextReporterSampleGrant,
} from "@/lib/api/edit-context";

type CardAction = "confirm" | "reject" | "revoke";

export type ReporterProfileCardProps = {
  cwid: string;
  /** "superuser" reframes the copy + nags before each write. */
  mode?: "self" | "superuser";
  scholarName?: string;
  candidates?: ReadonlyArray<EditContextReporterProfileCandidate>;
  confirmed?: ReadonlyArray<EditContextReporterProfileConfirmed>;
};

/** "2018–2022", "2018–", or "" — year range for a sample grant (no amounts). */
function yearRange(g: EditContextReporterSampleGrant): string {
  if (g.startYear == null && g.endYear == null) return "";
  return `${g.startYear ?? ""}–${g.endYear ?? ""}`;
}

function SampleGrants({ grants }: { grants: ReadonlyArray<EditContextReporterSampleGrant> }) {
  if (grants.length === 0) return null;
  return (
    <ul className="mt-2 space-y-1 text-[13px]">
      {grants.map((g, i) => {
        const yrs = yearRange(g);
        return (
          <li key={i} className="text-foreground">
            {g.title}
            {yrs ? <span className="text-muted-foreground"> ({yrs})</span> : null}
          </li>
        );
      })}
    </ul>
  );
}

/** Status pill — mirrors the COI tab's `ReassureChip`. `warning` (amber) is the
 *  one emphasized tint: the public-consequence pill, the deliberate inverse of
 *  COI's reassuring "never here". */
function Pill({
  icon: Icon,
  label,
  tint = "neutral",
}: {
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  label: string;
  tint?: "neutral" | "warning";
}) {
  const tintCls =
    tint === "warning"
      ? "border-apollo-amber-tint-border bg-apollo-amber-tint text-apollo-amber"
      : "border-apollo-slate-tint-border bg-apollo-slate-tint text-apollo-slate";
  return (
    <li
      className={`${tintCls} inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium`}
    >
      <Icon className="size-3.5" aria-hidden />
      {label}
    </li>
  );
}

/** The investigator's institution — the disambiguator, on its own line (§3.4). */
function InstitutionLine({ orgs }: { orgs?: string }) {
  if (!orgs) return null;
  return (
    <p className="text-muted-foreground mt-1 flex items-center gap-1.5 text-[13px]">
      <Building2 className="size-3.5 shrink-0" aria-hidden />
      {orgs}
    </p>
  );
}

/** Deep-link to the matched investigator's portfolio on NIH RePORTER — keyed by
 *  the candidate's `externalProfileId` (the matched eRA profile), NOT the
 *  scholar's cwid: a lateral recruit has no resolved profile of their own yet,
 *  so the link must point at the candidate PI for the scholar to verify the
 *  match. `externalProfileId` is a public NIH id, not the internal overlap K. */
function ReporterPiLink({ profileId }: { profileId: number }) {
  return (
    <a
      href={nihReporterPiUrl({ profileId })}
      target="_blank"
      rel="noopener noreferrer"
      title="Opens NIH RePORTER (NIH funding only)"
      className="text-apollo-slate mt-2 inline-block text-[13px] underline-offset-2 hover:underline"
    >
      Check this investigator on NIH RePORTER ↗
    </a>
  );
}

export function ReporterProfileCard({
  cwid,
  mode = "self",
  scholarName,
  candidates = [],
  confirmed = [],
}: ReporterProfileCardProps) {
  void cwid; // the routes resolve the target from the candidate id + session
  const su = mode === "superuser";
  const who = su ? (scholarName ?? "this scholar") : "you";
  const whose = su ? `${scholarName ?? "this scholar"}’s` : "your";
  const theirs = su ? "theirs" : "yours";

  // Optimistic state — keyed by candidateId. A reload reconciles from the server.
  const [resolved, setResolved] = React.useState<Map<string, "confirmed" | "rejected">>(new Map());
  const [revoked, setRevoked] = React.useState<Set<string>>(new Set());
  const [busy, setBusy] = React.useState<Set<string>>(new Set());
  const [errors, setErrors] = React.useState<Map<string, string>>(new Map());
  const [rejectOpenFor, setRejectOpenFor] = React.useState<string | null>(null);
  const [dialog, setDialog] = React.useState<{
    id: string;
    action: CardAction;
    reason?: RejectReason;
  } | null>(null);

  const setBusyFor = (id: string, on: boolean) =>
    setBusy((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const setErrorFor = (id: string, msg: string | null) =>
    setErrors((prev) => {
      const next = new Map(prev);
      if (msg) next.set(id, msg);
      else next.delete(id);
      return next;
    });

  async function act(id: string, action: CardAction, reason?: RejectReason): Promise<void> {
    setBusyFor(id, true);
    setErrorFor(id, null);
    // optimistic flip
    if (action === "revoke") setRevoked((p) => new Set(p).add(id));
    else setResolved((p) => new Map(p).set(id, action === "confirm" ? "confirmed" : "rejected"));
    try {
      const res = await fetch(`/api/edit/reporter-profile/${encodeURIComponent(id)}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action === "reject" ? { reason } : {}),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || data.ok !== true) throw new Error(data.error ?? "request_failed");
    } catch {
      // rollback
      if (action === "revoke")
        setRevoked((p) => {
          const next = new Set(p);
          next.delete(id);
          return next;
        });
      else
        setResolved((p) => {
          const next = new Map(p);
          next.delete(id);
          return next;
        });
      setErrorFor(id, "Something went wrong. Please try again.");
    } finally {
      setBusyFor(id, false);
    }
  }

  // Self acts directly; a superuser confirms via the nag dialog first.
  function requestAct(id: string, action: CardAction, reason?: RejectReason): void {
    setRejectOpenFor(null);
    if (su) setDialog({ id, action, reason });
    else void act(id, action, reason);
  }

  const pending = candidates.filter((c) => !resolved.has(c.candidateId));
  const acted = candidates.filter((c) => resolved.has(c.candidateId));
  const history = confirmed.filter((c) => !revoked.has(c.candidateId));
  const revokedAcks = confirmed.filter((c) => revoked.has(c.candidateId));

  const dialogCopy = (): { title: string; description: string; confirmLabel: string } => {
    if (!dialog) return { title: "", description: "", confirmLabel: "" };
    if (dialog.action === "confirm") {
      return {
        title: "Confirm this match?",
        description: `This attaches these NIH grants to ${whose} profile and CV at the next nightly update.`,
        confirmLabel: "Yes, attach the grants",
      };
    }
    if (dialog.action === "revoke") {
      return {
        title: "Remove this match?",
        description: `These grants will come off ${whose} public profile at the next nightly update.`,
        confirmLabel: "Remove",
      };
    }
    return {
      title: "Mark as not a match?",
      description: "This won't be suggested again.",
      confirmLabel: "Mark not a match",
    };
  };

  return (
    <EditPanel
      slot="reporter-profile-panel"
      heading={
        su ? `NIH grants matched to ${scholarName ?? "this scholar"}` : "NIH grants matched to you"
      }
      description={
        `We match NIH grants to ${who} by name, ${su ? "their" : "your"} Weill Cornell affiliation, and ` +
        `shared co-authors. Matches on the public profile appear there and on any generated CV after ` +
        `the nightly update — remove anything that isn't ${theirs}.`
      }
    >
      <ul className="flex flex-wrap gap-2" data-testid="reporter-profile-pills">
        <Pill icon={EyeOff} label="Visible to administrators and the scholar" />
        <Pill icon={Globe} label="Included on the public profile" tint="warning" />
        <Pill icon={Database} label="Sourced from NIH RePORTER" />
      </ul>

      <p
        className="text-muted-foreground -mt-1 text-[13px]"
        data-testid="reporter-profile-cv-purpose"
      >
        Matched grants also appear on {whose} <strong>CV</strong> when you generate one.
      </p>

      {pending.length === 0 &&
      acted.length === 0 &&
      history.length === 0 &&
      revokedAcks.length === 0 ? (
        <p className="text-muted-foreground mt-3 text-sm">No matches to review.</p>
      ) : null}

      {/* Pending — "Is this you?" (OPT-IN: not on the profile until confirmed). */}
      {pending.length > 0 ? (
        <section className="mt-2">
          <p className="text-muted-foreground text-[13px]">
            These aren’t on {whose} profile yet — confirm the ones that are {theirs} to add them.
          </p>
          <ul className="mt-3 space-y-4" data-testid="reporter-profile-pending">
            {pending.map((c) => {
              const isBusy = busy.has(c.candidateId);
              const err = errors.get(c.candidateId);
              return (
                <li
                  key={c.candidateId}
                  className="rounded-md border p-3"
                  data-testid="reporter-profile-candidate"
                >
                  <p className="text-muted-foreground text-[13px] font-medium">Is this you?</p>
                  <p className="mt-1 text-sm">
                    <strong>{c.candidateName}</strong>
                    <span className="text-muted-foreground">
                      {" "}
                      · {c.grantCount} grant{c.grantCount === 1 ? "" : "s"}
                    </span>
                  </p>
                  <InstitutionLine orgs={c.candidateOrgs} />
                  <SampleGrants grants={c.sampleGrants} />
                  <ReporterPiLink profileId={c.externalProfileId} />

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      disabled={isBusy}
                      onClick={() => requestAct(c.candidateId, "confirm")}
                    >
                      {su ? "Yes, these are the scholar's" : "Yes, these are mine"}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={isBusy}
                      aria-expanded={rejectOpenFor === c.candidateId}
                      onClick={() =>
                        setRejectOpenFor((prev) => (prev === c.candidateId ? null : c.candidateId))
                      }
                    >
                      Not me
                    </Button>
                  </div>

                  {rejectOpenFor === c.candidateId ? (
                    <div
                      className="mt-2 flex flex-wrap gap-2"
                      data-testid="reporter-profile-reject-reasons"
                    >
                      {REJECT_REASONS.map((r) => (
                        <Button
                          key={r}
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={isBusy}
                          onClick={() => requestAct(c.candidateId, "reject", r)}
                        >
                          {REJECT_REASON_LABEL[r]}
                        </Button>
                      ))}
                    </div>
                  ) : null}

                  {err ? (
                    <p className="text-destructive mt-2 text-[13px]" role="alert">
                      {err}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {/* Optimistic acknowledgements for pending items just acted on this session.
          Both clauses are honest: confirm rides the overnight batch; both confirm
          and decline clear the rail's review-queue badge (it counts pending). */}
      {acted.length > 0 ? (
        <ul className="mt-4 space-y-1" aria-live="polite" data-testid="reporter-profile-acked">
          {acted.map((c) => (
            <li key={c.candidateId} className="text-muted-foreground text-[13px]">
              {resolved.get(c.candidateId) === "confirmed"
                ? `Added ${c.candidateName}’s grants — they’ll appear after tonight’s update. Cleared from ${whose} review queue.`
                : `Marked “${c.candidateName}” as not a match. Cleared from ${whose} review queue.`}
            </li>
          ))}
        </ul>
      ) : null}

      {/* Confirmed / auto-locked — OPT-OUT: already on the public profile. */}
      {history.length > 0 ? (
        <section className="mt-6" data-testid="reporter-profile-confirmed">
          <h3 className="text-sm font-medium">On the public profile</h3>
          <ul className="mt-2 space-y-3">
            {history.map((c) => {
              const isBusy = busy.has(c.candidateId);
              const err = errors.get(c.candidateId);
              return (
                <li key={c.candidateId} className="rounded-md border p-3">
                  <p className="text-sm">
                    <strong>{c.candidateName}</strong>
                    <span className="text-muted-foreground">
                      {" "}
                      · {c.grantCount} grant{c.grantCount === 1 ? "" : "s"}
                      {c.autolocked ? " · matched automatically" : ""}
                    </span>
                  </p>
                  <InstitutionLine orgs={c.candidateOrgs} />
                  <SampleGrants grants={c.sampleGrants} />
                  <ReporterPiLink profileId={c.externalProfileId} />
                  <div className="mt-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={isBusy}
                      onClick={() => requestAct(c.candidateId, "revoke")}
                    >
                      Not me — remove these
                    </Button>
                  </div>
                  {err ? (
                    <p className="text-destructive mt-2 text-[13px]" role="alert">
                      {err}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {/* Optimistic removal acks — honest timing: removal rides the nightly batch
          (the publish layer can't purge a single grant on demand). */}
      {revokedAcks.length > 0 ? (
        <ul className="mt-4 space-y-1" aria-live="polite" data-testid="reporter-profile-removed">
          {revokedAcks.map((c) => (
            <li key={c.candidateId} className="text-muted-foreground text-[13px]">
              Removed {c.candidateName}’s grants. They’ll come off the public profile at tonight’s
              update.
            </li>
          ))}
        </ul>
      ) : null}

      {su && dialog ? (
        <ConfirmDialog
          open={dialog !== null}
          onOpenChange={(open) => {
            if (!open) setDialog(null);
          }}
          title={dialogCopy().title}
          description={dialogCopy().description}
          reasonMode="none"
          confirmLabel={dialogCopy().confirmLabel}
          confirmVariant={dialog.action === "confirm" ? "default" : "destructive"}
          onConfirm={async () => {
            const d = dialog;
            setDialog(null);
            await act(d.id, d.action, d.reason);
          }}
        />
      ) : null}
    </EditPanel>
  );
}
