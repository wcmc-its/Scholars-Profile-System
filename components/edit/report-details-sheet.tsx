/**
 * "Edit details" — the right-hand sheet on a report page (`ReportHeader`) that
 * replaced the superuser pencil (`report-meta-editor.tsx`, deleted). One place
 * for everything an editor changes about a report:
 *
 *   - Name, Address (slug), Summary, About this report — `report_meta`,
 *     superuser only (`canEditMeta`), saved together by Save (PUT
 *     `/api/edit/report-meta/[n]`, then close + `router.refresh()`).
 *   - Request record — who asked, when, memo. Same row, same Save, same gate;
 *     shown to report editors only and never on the report.
 *   - Access — the default audience plus the grant rows with Remove and an
 *     add form, for a row-granted report whose viewer may manage it
 *     (`canManageReportAccess`: superusers and comms stewards). Each grant or
 *     revoke applies at once (POST `/api/edit/report-access`, the index
 *     popover's round-trip) and refreshes the page so the header badge
 *     re-reads the list; Save does not cover it. A unit report's access is
 *     its unit's Owner / Curator grants, so this section only links to the
 *     administrators page.
 *
 * A comms steward who is not a superuser sees only the Access section.
 * Opened by its own button or by the header badge's "Manage access"
 * (`REPORT_DETAILS_OPEN_EVENT`). Receives everything as props — never imports
 * the server-only loaders.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Lock, Pencil } from "lucide-react";

import { DirectoryPeopleTypeahead, type DirectoryValue } from "@/components/edit/directory-people-typeahead";
import { OverviewEditor } from "@/components/edit/overview-editor";
import {
  ADMIN_AUDIENCE,
  PERSON_AUDIENCE,
  REPORT_DETAILS_OPEN_EVENT,
  UNIT_AUDIENCE,
  useReportAccessRows,
  type ReportAccessPopoverPersonProps,
  type ReportAccessPopoverProps,
} from "@/components/edit/report-access-popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import type { ReportKey, ReportRequestRecord } from "@/lib/edit/report-meta";
import { isValidReportSlug } from "@/lib/edit/report-slug";

// The caps, restated: `report-meta.ts` is server-only (it reads `@/lib/db`).
const NAME_MAX = 120;
const SUMMARY_MAX = 500;
const REQUESTED_BY_MAX = 200;
const MEMO_MAX = 5000;

export type ReportDetailsSheetProps = {
  n: ReportKey;
  meta: { slug: string; name: string; summary: string; descriptionHtml: string | null };
  /** Superuser: may edit the meta and the request record. */
  canEditMeta: boolean;
  /** The request record; null unless `canEditMeta`. */
  request: ReportRequestRecord | null;
  /** The same props the header badge gets. */
  access: ReportAccessPopoverProps;
};

const GENERIC_ERROR = "That didn't save. Try again.";

function metaErrorMessage(code: string | undefined): string {
  switch (code) {
    case "invalid_slug":
      return "Address: lowercase letters, numbers and hyphens (e.g. mentored-publications), not just numbers.";
    case "slug_taken":
      return "Another report already uses that address.";
    case "invalid_name":
      return `Enter a name (up to ${NAME_MAX} characters).`;
    case "invalid_summary":
      return `Enter a one-line summary (up to ${SUMMARY_MAX} characters).`;
    case "invalid_description":
    case "description_too_long":
      return "The description is too long.";
    case "invalid_requested_by":
      return `Requested by: up to ${REQUESTED_BY_MAX} characters.`;
    case "invalid_requested_on":
      return "Date requested isn't a valid date.";
    case "invalid_request_memo":
      return `Memo: up to ${MEMO_MAX.toLocaleString()} characters.`;
    case "not_superuser":
      return "Only a superuser can edit report details.";
    case "unknown_report":
      return "This report is not editable.";
    default:
      return GENERIC_ERROR;
  }
}

function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

const LABEL = "text-sm font-medium";
const HELP = "text-muted-foreground text-xs";

export function ReportDetailsSheet({ n, meta, canEditMeta, request, access }: ReportDetailsSheetProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [slug, setSlug] = React.useState(meta.slug);
  const [name, setName] = React.useState(meta.name);
  const [summary, setSummary] = React.useState(meta.summary);
  const [html, setHtml] = React.useState(meta.descriptionHtml ?? "");
  const [requestedBy, setRequestedBy] = React.useState(request?.requestedBy ?? "");
  const [requestedOn, setRequestedOn] = React.useState(request?.requestedOn ?? "");
  const [memo, setMemo] = React.useState(request?.requestMemo ?? "");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const openSheet = React.useCallback(() => {
    // Every open starts from the stored values — Cancel discards edits.
    setSlug(meta.slug);
    setName(meta.name);
    setSummary(meta.summary);
    setHtml(meta.descriptionHtml ?? "");
    setRequestedBy(request?.requestedBy ?? "");
    setRequestedOn(request?.requestedOn ?? "");
    setMemo(request?.requestMemo ?? "");
    setError(null);
    setOpen(true);
  }, [meta, request]);

  React.useEffect(() => {
    window.addEventListener(REPORT_DETAILS_OPEN_EVENT, openSheet);
    return () => window.removeEventListener(REPORT_DETAILS_OPEN_EVENT, openSheet);
  }, [openSheet]);

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/edit/report-meta/${n}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: slug.trim(),
          name: name.trim(),
          summary: summary.trim(),
          descriptionHtml: html,
          requestedBy: requestedBy.trim(),
          requestedOn,
          requestMemo: memo.trim(),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || data.ok !== true) {
        setError(metaErrorMessage(data.error));
        return;
      }
      setOpen(false);
      router.refresh();
    } catch {
      setError(GENERIC_ERROR);
    } finally {
      setBusy(false);
    }
  }

  const invalid =
    !isValidReportSlug(slug.trim()) || name.trim() === "" || summary.trim() === "" || summary.length > SUMMARY_MAX;

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={openSheet}
        data-testid="report-details-edit"
      >
        <Pencil size={14} aria-hidden />
        {canEditMeta ? "Edit details" : "Manage access"}
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          className="bg-apollo-page w-full gap-0 p-0 sm:max-w-[520px]"
          data-testid="report-details-sheet"
        >
          <SheetHeader className="border-apollo-border border-b px-6 py-5">
            <SheetTitle>{canEditMeta ? "Edit report details" : "Manage access"}</SheetTitle>
            <SheetDescription>
              {canEditMeta
                ? "Changes apply to the reports index and this page."
                : "Who can open this report besides its default audience."}
            </SheetDescription>
          </SheetHeader>
          <form
            id="report-details-form"
            className="flex flex-1 flex-col gap-[18px] overflow-auto px-6 py-5"
            onSubmit={(e) => {
              e.preventDefault();
              if (canEditMeta) void save();
            }}
          >
            {canEditMeta && (
              <>
                <label className="flex flex-col gap-1.5">
                  <span className={LABEL}>Name</span>
                  <Input
                    value={name}
                    maxLength={NAME_MAX}
                    onChange={(e) => setName(e.target.value)}
                    className="bg-apollo-surface"
                    data-testid="report-details-name"
                  />
                </label>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="report-details-slug" className={LABEL}>
                    Address
                  </label>
                  <div className="border-apollo-border-strong bg-apollo-surface flex items-stretch overflow-hidden rounded-md border">
                    <span className="bg-apollo-surface-2 text-muted-foreground border-apollo-border-strong border-r px-2.5 py-2 font-mono text-[13px]">
                      /edit/reports/
                    </span>
                    <input
                      id="report-details-slug"
                      value={slug}
                      maxLength={64}
                      onChange={(e) => setSlug(e.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                      className="min-w-0 flex-1 bg-transparent px-2.5 py-2 font-mono text-[13px] outline-none"
                      data-testid="report-details-slug"
                    />
                  </div>
                  <span className={HELP}>Lowercase letters, numbers and hyphens.</span>
                </div>
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-baseline justify-between">
                    <label htmlFor="report-details-summary" className={LABEL}>
                      Summary
                    </label>
                    <span
                      className={`text-xs tabular-nums ${summary.length > SUMMARY_MAX ? "text-destructive" : "text-muted-foreground"}`}
                    >
                      {summary.length} / {SUMMARY_MAX}
                    </span>
                  </div>
                  <Textarea
                    id="report-details-summary"
                    value={summary}
                    rows={3}
                    onChange={(e) => setSummary(e.target.value)}
                    className="bg-apollo-surface"
                    data-testid="report-details-summary"
                  />
                  <span className={HELP}>One line, shown on the reports index.</span>
                </div>
                <div className="flex flex-col gap-1.5">
                  <span className={LABEL}>
                    About this report <span className="text-muted-foreground font-normal">(optional)</span>
                  </span>
                  <OverviewEditor initialHtml={meta.descriptionHtml ?? ""} onChange={setHtml} dense />
                </div>
              </>
            )}
            <AccessSection access={access} onChange={() => router.refresh()} />
            {canEditMeta && (
              <div
                className="bg-apollo-lock-bg border-apollo-border-strong flex flex-col gap-3.5 rounded-[10px] border p-4"
                data-testid="report-details-request"
              >
                <div>
                  <div className="flex items-center gap-1.5 text-sm font-semibold">
                    <Lock size={14} aria-hidden />
                    Request record
                  </div>
                  <div className={`${HELP} mt-0.5`}>Visible to report editors only. Not shown on the report.</div>
                </div>
                <div className="grid grid-cols-[minmax(0,1fr)_160px] gap-2.5">
                  <label className="flex flex-col gap-1.5">
                    <span className="text-[13px] font-medium">Requested by</span>
                    <Input
                      value={requestedBy}
                      maxLength={REQUESTED_BY_MAX}
                      placeholder="Name, department"
                      onChange={(e) => setRequestedBy(e.target.value)}
                      className="bg-apollo-surface border-apollo-border-strong"
                      data-testid="report-details-requested-by"
                    />
                  </label>
                  <label className="flex flex-col gap-1.5">
                    <span className="text-[13px] font-medium">Date requested</span>
                    <Input
                      type="date"
                      value={requestedOn}
                      onChange={(e) => setRequestedOn(e.target.value)}
                      className="bg-apollo-surface border-apollo-border-strong"
                      data-testid="report-details-requested-on"
                    />
                  </label>
                </div>
                <label className="flex flex-col gap-1.5">
                  <span className="text-[13px] font-medium">Memo</span>
                  <Textarea
                    value={memo}
                    maxLength={MEMO_MAX}
                    rows={4}
                    placeholder="What was asked for, why, and any decisions made (e.g. ticket number, scope changes)."
                    onChange={(e) => setMemo(e.target.value)}
                    className="bg-apollo-surface border-apollo-border-strong"
                    data-testid="report-details-memo"
                  />
                </label>
                <div className={HELP}>
                  Report {n}
                  {request?.updatedAt ? ` · Last edited ${formatDay(request.updatedAt)}` : ""}
                </div>
              </div>
            )}
          </form>
          <SheetFooter className="border-apollo-border flex-row items-center justify-end gap-2 border-t px-6 py-4">
            {error && (
              <p role="alert" className="text-destructive mr-auto text-xs" data-testid="report-details-error">
                {error}
              </p>
            )}
            {canEditMeta ? (
              <>
                <Button type="button" variant="outline" disabled={busy} onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" form="report-details-form" variant="apollo" disabled={busy || invalid}>
                  Save
                </Button>
              </>
            ) : (
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Done
              </Button>
            )}
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </>
  );
}

/** The sheet's Access section. A unit report states its rule; a row-granted
 *  one lists the default audience and the grant rows, with Remove and an add
 *  form when the viewer may manage them. */
function AccessSection({ access, onChange }: { access: ReportAccessPopoverProps; onChange: () => void }) {
  return (
    <div className="flex flex-col gap-2" data-testid="report-details-access">
      <span className={LABEL}>Access</span>
      {access.mode === "person" ? (
        <PersonAccessList {...access} onChange={onChange} />
      ) : (
        <div className="border-apollo-border-strong bg-apollo-surface rounded-lg border px-3 py-2.5">
          <div className="text-sm">{access.mode === "admin" ? ADMIN_AUDIENCE : UNIT_AUDIENCE}</div>
          <div className={HELP}>
            {access.mode === "admin"
              ? "Any Owner or Curator of a unit, plus superusers and comms stewards."
              : "Owners and Curators of the unit this report is opened for, plus superusers and comms stewards."}{" "}
            <Link href="/edit/administrators" className="text-apollo-maroon underline-offset-2 hover:underline">
              Manage unit administrators
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

function PersonAccessList({
  reportKey,
  initialRows,
  scopeOptions,
  canManage,
  audience,
  note,
  onChange,
}: ReportAccessPopoverPersonProps & { onChange: () => void }) {
  const scoped = scopeOptions.length > 1;
  const labelFor = React.useMemo(() => new Map(scopeOptions), [scopeOptions]);
  const { rows, busy, error, post } = useReportAccessRows(reportKey, initialRows, onChange);
  const [person, setPerson] = React.useState<DirectoryValue | null>(null);
  const [scope, setScope] = React.useState(scopeOptions[0]?.[0] ?? "*");

  const row = "border-apollo-border flex items-center justify-between gap-2.5 border-b px-3 py-2.5 last:border-b-0";
  return (
    <>
      <ul className="border-apollo-border-strong bg-apollo-surface rounded-lg border">
        <li className={row}>
          <span className="min-w-0">
            <span className="block text-sm">{audience ?? PERSON_AUDIENCE}</span>
            {note && <span className={`${HELP} block`}>{note}</span>}
          </span>
          <span className={HELP}>Default</span>
        </li>
        {rows.map((r) => (
          <li key={`${r.scopeKey}:${r.cwid}`} className={row} data-testid={`report-details-grant-${r.scopeKey}-${r.cwid}`}>
            <span className="min-w-0">
              <span className="block text-sm">{r.name}</span>
              <span className={`${HELP} block`}>
                {scoped ? `${labelFor.get(r.scopeKey) ?? r.scopeKey} · ` : ""}
                {r.cwid}
              </span>
            </span>
            {canManage && (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={busy}
                onClick={() => void post("revoke", r.scopeKey, { cwid: r.cwid })}
              >
                Remove
              </Button>
            )}
          </li>
        ))}
      </ul>
      {canManage && (
        <div className="flex flex-wrap items-end gap-2" data-testid="report-details-add">
          <div className="min-w-[14rem] flex-1">
            <DirectoryPeopleTypeahead
              value={person}
              onChange={setPerson}
              placeholder="Add a person by name or CWID"
              disabled={busy}
              idPrefix="report-details-access"
            />
          </div>
          {scoped && (
            <label className="flex flex-col gap-1">
              <span className={HELP}>Program</span>
              <select
                value={scope}
                onChange={(e) => setScope(e.target.value)}
                className="border-apollo-border-strong bg-apollo-surface rounded-md border px-2 py-1.5 text-sm"
                data-testid="report-details-scope"
              >
                {scopeOptions.map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <Button
            type="button"
            variant="apollo"
            size="sm"
            disabled={busy || person === null}
            onClick={() => {
              if (!person) return;
              void post("grant", scope, { cwid: person.cwid, name: person.name }).then((ok) => {
                if (ok) setPerson(null);
              });
            }}
          >
            Add
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-destructive text-xs" data-testid="report-details-access-error">
          {error}
        </p>
      )}
      {canManage && <span className={HELP}>Access changes apply as soon as you add or remove someone.</span>}
    </>
  );
}
