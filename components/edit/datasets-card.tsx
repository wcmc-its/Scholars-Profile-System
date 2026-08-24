/**
 * The "Datasets" attribute panel (data-sharing spec, #2348) — the scholar's
 * dataset deposits with optimistic hide/show, closely mirroring the
 * Publications card's mechanism (`components/edit/publications-card.tsx`).
 *
 * Unlike Publications, there is no ReCiter-reject equivalent for a dataset
 * deposit, so "Hide" and "Not mine" are both direct one-click actions (no
 * interstitial) — mirrors `news-edit-card.tsx`'s Hide/Not-me pair, not
 * publications' richer reject flow. No first-hide-of-session notice, no
 * sole-displayed-author confirm guard, and no ReCiter pending hint. Both
 * buttons POST the same `/api/edit/suppress` with a different `reason`
 * string (no new AuditAction, no schema change — `reason` is a free-text
 * field the route already accepts) so the audit trail can tell "wrong
 * attribution" apart from "just don't want this shown" for whenever the
 * deferred regression-case work reads suppressions back into the extraction
 * classifier. Either removes this scholar's row from THIS profile only
 * (per-contributor, same suppress/revoke routes as publications); a
 * `removed_by_admin` row renders read-only with an inline explanation and no
 * controls.
 *
 * Rendered only when the loader populated `ctx.datasets` (DATA_SHARING_SECTION
 * on, or the scholar's own `showDatasets` opt-in, AND the scholar has ≥1
 * deposit), so an empty panel is never reached.
 *
 * Optimistic mechanism: `useOptimistic` over a local-state list that commits
 * on a successful POST. On a network/server failure the optimistic state
 * reverts when the transition ends and an inline destructive Alert renders
 * above the row.
 */
"use client";

import * as React from "react";
import { Eye, EyeOff } from "lucide-react";

import { EditPanel } from "@/components/edit/edit-panel";
import { resolveDatasetUrl } from "@/components/profile/datasets-section";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { EditContextDataset } from "@/lib/api/edit-context";

export type DatasetsCardProps = {
  cwid: string;
  /** `superuser` reframes the first-person copy to the scholar's name — a
   *  superuser managing another scholar's datasets on their behalf. The write
   *  paths already authorize a superuser (suppress / revoke). */
  mode?: "self" | "superuser";
  scholarName?: string;
  datasets: ReadonlyArray<EditContextDataset>;
};

type Row = EditContextDataset;

/** `provenance`'s raw enum ('databank' | 'fulltext-scan') → the label the
 *  mockup (s-index-ui-proposal.html §5) uses in the citation line below. */
const PROVENANCE_LABELS: Record<string, string> = {
  databank: "DataBankList",
  "fulltext-scan": "full-text scan",
};

/** "From PMID 36711842 (you are last author) · full-text scan, high
 *  confidence" (s-index-ui-proposal.html §5's edit-row `.m` line) — the
 *  context a scholar needs to judge a row in five seconds: which of their
 *  papers cited this, their role on it, how it was found, and how sure the
 *  extractor was. Deliberately not shown on the public profile
 *  (`datasets-section.tsx`) — that's a fact about the extraction, not the
 *  dataset, and only useful to the person deciding whether to hide it. */
function citationLine(d: Row): string {
  const from =
    d.pmids.length > 0
      ? `From PMID ${d.pmids[0]}${d.pmids.length > 1 ? ` (+${d.pmids.length - 1} more)` : ""} (you are ${d.authorPosition} author)`
      : `You are ${d.authorPosition} author`;
  const method = d.provenance ? PROVENANCE_LABELS[d.provenance] ?? d.provenance : null;
  const methodConfidence = [method, d.confidence ? `${d.confidence} confidence` : null]
    .filter(Boolean)
    .join(", ");
  return [from, methodConfidence].filter(Boolean).join(" · ");
}

/** "Aug 11" — matches s-index-ui-proposal.html §5's "Removed by you on Aug 3". */
function formatShortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

type OptimisticUpdate =
  | { kind: "hide"; datasetId: string }
  | { kind: "show"; datasetId: string };

function applyOptimistic(state: Row[], update: OptimisticUpdate): Row[] {
  return state.map((d) => {
    if (d.datasetId !== update.datasetId) return d;
    if (update.kind === "hide") {
      // No suppressionId yet (the POST hasn't resolved), but `hiddenAt` needs
      // no server round-trip to be accurate — the row genuinely is being
      // removed right now.
      return { ...d, state: "hidden_by_self", suppressionId: null, hiddenAt: new Date().toISOString() };
    }
    return { ...d, state: "shown", suppressionId: null, hiddenAt: null };
  });
}

export function DatasetsCard({ cwid, mode = "self", scholarName = "", datasets }: DatasetsCardProps) {
  const su = mode === "superuser";
  const possessive = su ? `${scholarName}’s` : "your";
  const hideReason = su ? "Hidden by a superuser via /edit" : "Hidden by the author via /edit";
  const notMineReason = su
    ? "Marked not theirs by a superuser via /edit"
    : "Not mine — removed by the author via /edit";
  const [list, setList] = React.useState<Row[]>([...datasets]);
  const [, startTransition] = React.useTransition();
  const [optimistic, addOptimistic] = React.useOptimistic(list, applyOptimistic);
  const [errors, setErrors] = React.useState<Map<string, string>>(new Map());

  function setError(datasetId: string, msg: string | null) {
    setErrors((prev) => {
      const next = new Map(prev);
      if (msg === null) next.delete(datasetId);
      else next.set(datasetId, msg);
      return next;
    });
  }

  function commitLocal(updater: (state: Row[]) => Row[]) {
    setList((prev) => updater(prev));
  }

  // `/api/edit/suppress`'s self-hide reason default only covers
  // entityType === "publication" (route.ts's `isSelfAuthorHide`) — dataset_deposit
  // was never added to it, so an omitted reason 400s ("reason_required") in
  // every mode. Sending an explicit reason here fixes that AND gives Hide vs
  // Not mine distinct audit text.
  function suppress(datasetId: string, reason: string) {
    setError(datasetId, null);
    startTransition(async () => {
      addOptimistic({ kind: "hide", datasetId });
      try {
        const res = await fetch("/api/edit/suppress", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            entityType: "dataset_deposit",
            entityId: datasetId,
            contributorCwid: cwid,
            reason,
          }),
        });
        const data = (await res.json()) as
          | { ok: true; suppressionId: string }
          | { ok: false; error: string };
        if (!res.ok || data.ok !== true) {
          setError(datasetId, "We couldn't hide this dataset. Please try again.");
          return; // optimistic reverts when the transition ends
        }
        commitLocal((state) =>
          state.map((d) =>
            d.datasetId === datasetId
              ? { ...d, state: "hidden_by_self", suppressionId: data.suppressionId }
              : d,
          ),
        );
        // No router.refresh(): the optimistic→committed local list is
        // authoritative for this panel (mirrors publications-card, T3.7).
      } catch {
        setError(datasetId, "We couldn't hide this dataset. Please try again.");
      }
    });
  }

  function show(d: Row) {
    if (d.suppressionId === null) return; // defensive — only hidden_by_self rows have a button
    const suppressionId = d.suppressionId;
    setError(d.datasetId, null);
    startTransition(async () => {
      addOptimistic({ kind: "show", datasetId: d.datasetId });
      try {
        const res = await fetch("/api/edit/revoke", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ suppressionId }),
        });
        const data = (await res.json()) as
          | { ok: true; suppressionId: string }
          | { ok: false; error: string };
        if (!res.ok || data.ok !== true) {
          setError(d.datasetId, "We couldn't restore this dataset. Please try again.");
          return;
        }
        commitLocal((state) =>
          state.map((row) =>
            row.datasetId === d.datasetId ? { ...row, state: "shown", suppressionId: null } : row,
          ),
        );
      } catch {
        setError(d.datasetId, "We couldn't restore this dataset. Please try again.");
      }
    });
  }

  return (
    <EditPanel
      slot="datasets-card"
      heading={su ? "Datasets" : "My datasets"}
      description={`Dataset deposits ${su ? `attributed to ${scholarName}` : "you're listed on"}, sourced from public repositories. Hide one you'd rather not show on ${possessive} profile, or use "Not mine" if the attribution is wrong.`}
    >
      {optimistic.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No dataset deposits are currently associated with {possessive} profile.
        </p>
      ) : (
        <ul className="divide-apollo-border divide-y">
          {optimistic.map((d) => (
            <DatasetRow
              key={d.datasetId}
              dataset={d}
              error={errors.get(d.datasetId) ?? null}
              onHide={() => suppress(d.datasetId, hideReason)}
              onNotMine={() => suppress(d.datasetId, notMineReason)}
              onShow={() => show(d)}
            />
          ))}
        </ul>
      )}
    </EditPanel>
  );
}

function DatasetRow({
  dataset,
  error,
  onHide,
  onNotMine,
  onShow,
}: {
  dataset: Row;
  error: string | null;
  onHide: () => void;
  onNotMine: () => void;
  onShow: () => void;
}) {
  const url = resolveDatasetUrl(dataset);
  const hidden = dataset.state === "hidden_by_self";
  return (
    <li className="flex flex-col gap-2 px-1 py-4" data-testid={`dataset-row-${dataset.datasetId}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className={hidden ? "text-muted-foreground line-through" : "text-foreground font-medium"}>
            {dataset.repository}
            {" · "}
            {url ? (
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-sm underline-offset-4 hover:underline"
              >
                {dataset.accessionOrDoi}
              </a>
            ) : (
              <span className="font-mono text-sm">{dataset.accessionOrDoi}</span>
            )}
            {dataset.title ? ` — ${dataset.title}` : null}
          </p>
          <p className="text-sm text-muted-foreground">
            {dataset.dataType ?? "Data type unknown"} · {dataset.depositYear ?? "Year unknown"} ·{" "}
            {dataset.authorPosition} author
          </p>
          <p className="text-muted-foreground text-sm">{citationLine(dataset)}</p>
          {hidden && (
            <p className="text-muted-foreground text-sm">
              Removed by you{dataset.hiddenAt ? ` on ${formatShortDate(dataset.hiddenAt)}` : ""} ·
              kept out of your public profile
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {dataset.state === "shown" && (
            <>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="min-h-11 md:min-h-8"
                onClick={onHide}
                data-testid={`dataset-hide-${dataset.datasetId}`}
              >
                <EyeOff />
                Hide
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="min-h-11 md:min-h-8"
                onClick={onNotMine}
                data-testid={`dataset-notmine-${dataset.datasetId}`}
                title="This deposit isn't attributed to me correctly — remove it"
              >
                Not mine
              </Button>
            </>
          )}
          {hidden && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="min-h-11 md:min-h-8"
              onClick={onShow}
              data-testid={`dataset-show-${dataset.datasetId}`}
            >
              <Eye />
              Restore
            </Button>
          )}
          {dataset.state === "removed_by_admin" && (
            <div className="flex flex-col items-end gap-1">
              <Badge variant="destructive">Removed by an administrator</Badge>
              <span className="text-muted-foreground max-w-xs text-right text-sm">
                An administrator removed this dataset site-wide; hiding or showing it here has no
                effect.
              </span>
            </div>
          )}
        </div>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </li>
  );
}
