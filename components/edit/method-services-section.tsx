"use client";

/**
 * MethodServicesSection — the "Method services" section of a department's and
 * a core's edit page: the services the unit offers for a research method
 * (name, https link, the method families it supports, an optional list of
 * supported PMIDs).
 *
 * One list of the unit's services with Edit and Remove, and ONE form beneath
 * it that adds a service or, after Edit, changes the one picked. Every write is
 * a POST to `/api/edit/method-service`; the list is kept from the write's own
 * response (the reader replica can lag a refresh), and the page is refreshed
 * so the section nav's count follows.
 *
 * Under each saved service: its collaboration numbers and a "Review
 * publications" panel with "Not ours" / "Undo" (`method-service-review.tsx`).
 *
 * Imports only types and pure validation from `lib/method-services/validation`
 * (no `@/lib/db`).
 */
import * as React from "react";
import { useRouter } from "next/navigation";

import { ConfirmDialog } from "@/components/edit/confirm-dialog";
import { MethodFamilyPicker } from "@/components/edit/method-family-picker";
import {
  ServiceReviewPanel,
  ServiceReviewSummary,
  useServiceReviews,
} from "@/components/edit/method-service-review";
import { SectionHeader } from "@/components/edit/unit-basics-section";
import { UnsavedChangesGuard } from "@/components/edit/unsaved-changes-guard";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { withArticle } from "@/lib/method-services/collaboration";
import {
  SERVICE_FAMILIES_MAX,
  SERVICE_NAME_MAX_LENGTH,
  SERVICE_PMIDS_MAX,
  defaultCountStaffPapers,
  methodFamilyKey,
  parsePmidBlock,
  validateServiceFamilies,
  validateServiceName,
  validateServiceUrl,
  type MethodServiceEntityType,
  type MethodServiceFamily,
  type MethodServiceView,
} from "@/lib/method-services/validation";
import { cn } from "@/lib/utils";

export type MethodServicesSectionProps = {
  entityType: MethodServiceEntityType;
  /** The department code, or the core id. */
  entityId: string;
  /** The unit's name as its edit page header shows it. */
  unitName: string;
  /** The unit's services as the server last rendered them. */
  services: ReadonlyArray<MethodServiceView>;
  headingId?: string;
};

type FieldKey = "name" | "url" | "families" | "pmids";
type Draft = {
  name: string;
  url: string;
  families: MethodServiceFamily[];
  pmidText: string;
  countStaffPapers: boolean;
};

/** Rejected tokens listed in full up to this many; the rest are counted. */
const INVALID_SHOWN = 12;
const FIELD_ORDER: ReadonlyArray<FieldKey> = ["name", "url", "families", "pmids"];
const LABEL_CLASS = "text-foreground mb-1.5 block text-sm font-medium";
const HINT_CLASS = "text-muted-foreground font-normal";
const NOTE_CLASS = "text-muted-foreground mt-1.5 text-[12.5px]";
const ERROR_CLASS = "text-destructive mt-1.5 text-[12.5px]";

const byName = (a: MethodServiceView, b: MethodServiceView) =>
  a.name.localeCompare(b.name) || a.id - b.id;

const plural = (n: number, one: string, many: string) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

const sameFamilies = (
  a: ReadonlyArray<MethodServiceFamily>,
  b: ReadonlyArray<MethodServiceFamily>,
) => a.length === b.length && a.every((f, i) => methodFamilyKey(f) === methodFamilyKey(b[i]));

const sameList = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

export function MethodServicesSection({
  entityType,
  entityId,
  unitName,
  services: initialServices,
  headingId = "method-services-heading",
}: MethodServicesSectionProps) {
  const router = useRouter();
  const emptyDraft = React.useCallback(
    (): Draft => ({
      name: "",
      url: "",
      families: [],
      pmidText: "",
      countStaffPapers: defaultCountStaffPapers(entityType),
    }),
    [entityType],
  );

  const [services, setServices] = React.useState<MethodServiceView[]>(() =>
    [...initialServices].sort(byName),
  );
  const [editingId, setEditingId] = React.useState<number | null>(null);
  const [draft, setDraft] = React.useState<Draft>(emptyDraft);
  const [errors, setErrors] = React.useState<Partial<Record<FieldKey, string>>>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [status, setStatus] = React.useState("");
  const [removing, setRemoving] = React.useState<MethodServiceView | null>(null);
  /** The row whose Edit was pressed over unsaved changes, awaiting a confirm. */
  const [pendingEdit, setPendingEdit] = React.useState<MethodServiceView | null>(null);

  // "Review publications": the numbers under each service, which panel is
  // open, and where focus goes once a "Not ours" / "Undo" has been re-read.
  const { reviews } = useServiceReviews(services);
  const [reviewOpen, setReviewOpen] = React.useState<number | null>(null);
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const reviewToggles = React.useRef(new Map<number, HTMLButtonElement>());
  const reviewFocus = React.useRef<{ id: number; action: string; stale: unknown } | null>(null);
  React.useEffect(() => {
    const pending = reviewFocus.current;
    if (!pending || busy || reviews.get(pending.id) === pending.stale) return;
    reviewFocus.current = null;
    const target =
      rootRef.current?.querySelector<HTMLElement>(`[data-review-action="${pending.action}"]`) ??
      reviewToggles.current.get(pending.id);
    target?.focus();
  }, [reviews, busy]);

  const nameRef = React.useRef<HTMLInputElement | null>(null);
  const urlRef = React.useRef<HTMLInputElement | null>(null);
  const familiesRef = React.useRef<HTMLInputElement | null>(null);
  const pmidsRef = React.useRef<HTMLTextAreaElement | null>(null);
  const editButtons = React.useRef(new Map<number, HTMLButtonElement>());
  /** Where focus goes once the list has re-rendered after a write. */
  const [focusAfter, setFocusAfter] = React.useState<
    { row: number } | { field: FieldKey } | null
  >(null);

  // After the render, not during the handler: a control that was disabled
  // while the request ran cannot take the focus until it is enabled again.
  React.useEffect(() => {
    if (focusAfter === null) return;
    if ("field" in focusAfter) {
      const refs = { name: nameRef, url: urlRef, families: familiesRef, pmids: pmidsRef };
      refs[focusAfter.field].current?.focus();
    } else {
      (editButtons.current.get(focusAfter.row) ?? nameRef.current)?.focus();
    }
    setFocusAfter(null);
  }, [focusAfter]);

  const editing = editingId === null ? null : (services.find((s) => s.id === editingId) ?? null);
  const parsed = React.useMemo(() => parsePmidBlock(draft.pmidText), [draft.pmidText]);
  const tooManyPmids = parsed.pmids.length > SERVICE_PMIDS_MAX;
  // Unsaved work in the form: against the row being edited, or against an
  // untouched "Add a service" form. A save or Cancel resets the draft, so this
  // falls back to false; the form only ever refreshes in place (never pushes),
  // which is the case the guard is safe for.
  const baseline = editing
    ? {
        name: editing.name,
        url: editing.url,
        families: editing.families,
        pmidText: editing.supportedPmids.join("\n"),
        countStaffPapers: editing.countStaffPapers,
      }
    : emptyDraft();
  const dirty =
    draft.name !== baseline.name ||
    draft.url !== baseline.url ||
    draft.pmidText !== baseline.pmidText ||
    draft.countStaffPapers !== baseline.countStaffPapers ||
    !sameFamilies(draft.families, baseline.families);

  function patch(change: Partial<Draft>, cleared?: FieldKey) {
    setDraft((d) => ({ ...d, ...change }));
    if (cleared && errors[cleared]) setErrors((e) => ({ ...e, [cleared]: undefined }));
    if (formError) setFormError(null);
  }

  function resetForm() {
    setEditingId(null);
    setDraft(emptyDraft());
    setErrors({});
    setFormError(null);
  }

  function startEdit(service: MethodServiceView) {
    setEditingId(service.id);
    setDraft({
      name: service.name,
      url: service.url,
      families: [...service.families],
      pmidText: service.supportedPmids.join("\n"),
      countStaffPapers: service.countStaffPapers,
    });
    setErrors({});
    setFormError(null);
    setStatus("");
    // The form is always mounted, so the field can take the focus now.
    nameRef.current?.focus();
  }

  /** Edit pressed on a row: never over unsaved work without asking. */
  function requestEdit(service: MethodServiceView) {
    if (editingId === service.id) {
      // Already in the form; keep what has been typed.
      nameRef.current?.focus();
      return;
    }
    if (dirty) setPendingEdit(service);
    else startEdit(service);
  }

  function cancel() {
    const row = editingId;
    resetForm();
    setStatus("");
    if (row !== null) setFocusAfter({ row });
  }

  async function post(payload: Record<string, unknown>): Promise<{
    ok: boolean;
    error?: string;
    field?: string;
    service?: MethodServiceView;
  }> {
    try {
      const res = await fetch("/api/edit/method-service", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        field?: string;
        service?: MethodServiceView;
      };
      return res.ok && data.ok === true
        ? { ok: true, service: data.service }
        : { ok: false, error: data.error ?? "", field: data.field };
    } catch {
      return { ok: false, error: "" };
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;

    // The same validators the route runs.
    const name = validateServiceName(draft.name);
    const url = validateServiceUrl(draft.url);
    const families = validateServiceFamilies(draft.families);
    const found: Partial<Record<FieldKey, string>> = {};
    if (!name.ok) found.name = errorMessage(name.error);
    if (!url.ok) found.url = errorMessage(url.error);
    if (!families.ok) found.families = errorMessage(families.error);
    if (tooManyPmids) found.pmids = errorMessage("too_many_pmids");
    setErrors(found);
    setFormError(null);
    const firstInvalid = FIELD_ORDER.find((k) => found[k]);
    if (firstInvalid || !name.ok || !url.ok || !families.ok) {
      if (firstInvalid) setFocusAfter({ field: firstInvalid });
      return;
    }

    let payload: Record<string, unknown>;
    if (editing) {
      // Only what changed: an untouched field is not re-validated server-side.
      payload = { op: "update", id: editing.id };
      if (name.value !== editing.name) payload.name = name.value;
      if (url.value !== editing.url) payload.url = url.value;
      if (!sameFamilies(families.value, editing.families)) payload.families = families.value;
      if (!sameList(parsed.pmids, editing.supportedPmids)) payload.supportedPmids = parsed.pmids;
      if (draft.countStaffPapers !== editing.countStaffPapers) {
        payload.countStaffPapers = draft.countStaffPapers;
      }
    } else {
      payload = {
        op: "create",
        entityType,
        entityId,
        name: name.value,
        url: url.value,
        families: families.value,
        supportedPmids: parsed.pmids,
        countStaffPapers: draft.countStaffPapers,
      };
    }

    setBusy(true);
    setStatus("");
    const result = await post(payload);
    setBusy(false);
    if (result.ok && result.service) {
      const saved = result.service;
      setServices((prev) => [...prev.filter((s) => s.id !== saved.id), saved].sort(byName));
      setStatus(editing ? `Saved ${saved.name}.` : `Added ${saved.name}.`);
      resetForm();
      setFocusAfter({ row: saved.id });
      router.refresh();
      return;
    }
    const field = serverField(result.field);
    if (field) {
      setErrors({ [field]: errorMessage(result.error ?? "") });
      setFocusAfter({ field });
    } else {
      setFormError(errorMessage(result.error ?? ""));
    }
  }

  async function remove(service: MethodServiceView) {
    setBusy(true);
    setFormError(null);
    setStatus("");
    const result = await post({ op: "delete", id: service.id });
    setBusy(false);
    setRemoving(null);
    if (!result.ok) {
      setFormError(errorMessage(result.error ?? ""));
      return;
    }
    setServices((prev) => prev.filter((s) => s.id !== service.id));
    if (editingId === service.id) resetForm();
    setStatus(`Removed ${service.name}.`);
    // The row and its buttons are gone: the form is the next thing to act on.
    setFocusAfter({ field: "name" });
    router.refresh();
  }

  /** "Not ours" (exclude) or its undo (restore) for one publication. */
  async function movePmid(service: MethodServiceView, op: "exclude" | "restore", pmid: string) {
    if (busy) return;
    setBusy(true);
    setFormError(null);
    setStatus("");
    const result = await post({ op, id: service.id, pmid });
    setBusy(false);
    if (!result.ok || !result.service) {
      setFormError(errorMessage(result.error ?? ""));
      return;
    }
    const saved = result.service;
    // The button pressed is about to leave the list: once the numbers have
    // been re-read, focus its counterpart (Undo for Not ours, and back).
    reviewFocus.current = {
      id: service.id,
      action: `${op === "exclude" ? "restore" : "exclude"}-${service.id}-${pmid}`,
      stale: reviews.get(service.id),
    };
    // A new service object, so `useServiceReviews` re-reads its numbers.
    setServices((prev) => prev.map((s) => (s.id === saved.id ? saved : s)));
    setStatus(
      op === "exclude"
        ? `PMID ${pmid} no longer counts as a collaboration of ${unit}.`
        : `PMID ${pmid} counts again.`,
    );
  }

  const unit = withArticle(unitName);
  const previewName = draft.name.trim() || "Service name";
  const describe = (...ids: Array<string | false | undefined>) =>
    ids.filter(Boolean).join(" ") || undefined;

  return (
    <div ref={rootRef} className="flex flex-col gap-3.5" data-slot="method-services-section">
      <UnsavedChangesGuard dirty={dirty} />
      <SectionHeader
        id={headingId}
        title="Method services"
        description="Services your unit offers for a research method. Each one appears on that method’s public page, with a link to your service and a count of the publications your unit collaborated on."
      />

      {services.length === 0 ? (
        <p
          className="border-apollo-border text-muted-foreground rounded-[10px] border px-3.5 py-3 text-sm"
          data-testid="method-services-empty"
        >
          No services listed yet.
        </p>
      ) : (
        <ul
          className="border-apollo-border divide-apollo-border divide-y overflow-hidden rounded-[10px] border"
          data-testid="method-services-list"
        >
          {services.map((s) => {
            const review = reviews.get(s.id);
            const panelId = `method-service-review-${s.id}`;
            return (
            <li
              key={s.id}
              className="flex flex-col gap-2 px-3.5 py-3"
              data-testid={`method-service-${s.id}`}
            >
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
              <div className="flex min-w-0 flex-col gap-1">
                <span className="text-[15px] font-semibold">{s.name}</span>
                <a
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-apollo-slate text-[13px] break-all hover:underline"
                >
                  {s.url}
                </a>
                <ul className="mt-1 flex flex-wrap gap-1.5" aria-label={`Methods for ${s.name}`}>
                  {s.families.map((f) => (
                    <li
                      key={methodFamilyKey(f)}
                      className="bg-apollo-slate-tint border-apollo-slate-tint-border text-apollo-slate rounded-full border px-2.5 py-0.5 text-[12.5px]"
                    >
                      {f.familyLabel}
                    </li>
                  ))}
                </ul>
                <ServiceReviewSummary
                  service={s}
                  review={review}
                  open={reviewOpen === s.id}
                  onToggle={() => setReviewOpen((cur) => (cur === s.id ? null : s.id))}
                  panelId={panelId}
                  toggleRef={(node) => {
                    if (node) reviewToggles.current.set(s.id, node);
                    else reviewToggles.current.delete(s.id);
                  }}
                />
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  aria-label={`Edit ${s.name}`}
                  aria-pressed={editingId === s.id}
                  ref={(node) => {
                    if (node) editButtons.current.set(s.id, node);
                    else editButtons.current.delete(s.id);
                  }}
                  onClick={() => requestEdit(s)}
                >
                  Edit
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  aria-label={`Remove ${s.name}`}
                  onClick={() => setRemoving(s)}
                  className="text-destructive hover:text-destructive"
                >
                  Remove
                </Button>
              </div>
            </div>
            {reviewOpen === s.id && review && (
              <ServiceReviewPanel
                service={s}
                review={review}
                panelId={panelId}
                busy={busy}
                onExclude={(pmid) => void movePmid(s, "exclude", pmid)}
                onRestore={(pmid) => void movePmid(s, "restore", pmid)}
              />
            )}
            </li>
            );
          })}
        </ul>
      )}

      <p role="status" className={cn("text-muted-foreground text-[12.5px]", !status && "sr-only")}>
        {status}
      </p>

      <form
        noValidate
        onSubmit={submit}
        aria-labelledby="method-service-form-heading"
        className="bg-apollo-page border-apollo-border-strong flex flex-col gap-4 rounded-[10px] border border-dashed px-3.5 py-3.5"
        data-testid="method-service-form"
      >
        <h3 id="method-service-form-heading" className="text-sm font-semibold">
          {editing ? `Edit ${editing.name}` : "Add a service"}
        </h3>

        <div>
          <label htmlFor="method-service-name" className={LABEL_CLASS}>
            Service name
          </label>
          <Input
            ref={nameRef}
            id="method-service-name"
            type="text"
            value={draft.name}
            maxLength={SERVICE_NAME_MAX_LENGTH}
            disabled={busy}
            aria-invalid={errors.name ? true : undefined}
            aria-describedby={describe(errors.name && "method-service-name-error")}
            onChange={(e) => patch({ name: e.target.value }, "name")}
          />
          {errors.name && (
            <p id="method-service-name-error" role="alert" className={ERROR_CLASS}>
              {errors.name}
            </p>
          )}
        </div>

        <div>
          <label htmlFor="method-service-url" className={LABEL_CLASS}>
            Service page <span className={HINT_CLASS}>(must start with https://)</span>
          </label>
          <Input
            ref={urlRef}
            id="method-service-url"
            type="url"
            inputMode="url"
            autoCapitalize="none"
            spellCheck={false}
            value={draft.url}
            disabled={busy}
            placeholder="https://"
            aria-invalid={errors.url ? true : undefined}
            aria-describedby={describe(errors.url && "method-service-url-error")}
            onChange={(e) => patch({ url: e.target.value }, "url")}
          />
          {errors.url && (
            <p id="method-service-url-error" role="alert" className={ERROR_CLASS}>
              {errors.url}
            </p>
          )}
        </div>

        <div>
          <label htmlFor="method-service-families" className={LABEL_CLASS}>
            Methods this service supports{" "}
            <span className={HINT_CLASS}>(type to search, pick one or more)</span>
          </label>
          <MethodFamilyPicker
            inputId="method-service-families"
            inputRef={familiesRef}
            value={draft.families}
            disabled={busy}
            invalid={Boolean(errors.families)}
            describedBy={describe(errors.families && "method-service-families-error")}
            onChange={(families) => patch({ families }, "families")}
          />
          {errors.families && (
            <p id="method-service-families-error" role="alert" className={ERROR_CLASS}>
              {errors.families}
            </p>
          )}
        </div>

        <div>
          <label htmlFor="method-service-pmids" className={LABEL_CLASS}>
            Publications this service supported{" "}
            <span className={HINT_CLASS}>
              (optional; PMIDs, one per line or separated by commas)
            </span>
          </label>
          <textarea
            ref={pmidsRef}
            id="method-service-pmids"
            rows={4}
            value={draft.pmidText}
            disabled={busy}
            spellCheck={false}
            aria-invalid={errors.pmids || tooManyPmids ? true : undefined}
            aria-describedby={describe(
              "method-service-pmids-hint",
              "method-service-pmids-count",
              errors.pmids && "method-service-pmids-error",
            )}
            onChange={(e) => patch({ pmidText: e.target.value }, "pmids")}
            className="border-apollo-border-strong text-foreground bg-background focus-visible:ring-apollo-maroon w-full rounded-md border px-3 py-2 font-mono text-sm focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50"
          />
          <p id="method-service-pmids-hint" className={NOTE_CLASS}>
            Add PMIDs for work you supported without authorship, or by staff who have since left.
            Only publications already on the method page are marked.
          </p>
          <p
            id="method-service-pmids-count"
            aria-live="polite"
            className={cn(NOTE_CLASS, tooManyPmids && "text-destructive")}
            data-testid="method-service-pmids-count"
          >
            {draft.pmidText.trim().length === 0
              ? ""
              : `${plural(parsed.pmids.length, "PMID", "PMIDs")} recognised.` +
                (tooManyPmids
                  ? ` The limit is ${SERVICE_PMIDS_MAX.toLocaleString("en-US")}.`
                  : "") +
                (parsed.invalid.length > 0
                  ? ` Not a PMID, left out: ${parsed.invalid.slice(0, INVALID_SHOWN).join(", ")}` +
                    (parsed.invalid.length > INVALID_SHOWN
                      ? ` and ${(parsed.invalid.length - INVALID_SHOWN).toLocaleString("en-US")} more.`
                      : ".")
                  : "")}
          </p>
          {errors.pmids && (
            <p id="method-service-pmids-error" role="alert" className={ERROR_CLASS}>
              {errors.pmids}
            </p>
          )}
        </div>

        <div className="flex items-start gap-2.5">
          <Checkbox
            id="method-service-count-staff"
            checked={draft.countStaffPapers}
            disabled={busy}
            aria-describedby="method-service-count-staff-hint"
            onCheckedChange={(c) => patch({ countStaffPapers: c === true })}
            className="border-apollo-border-strong mt-0.5 size-[18px] bg-white"
          />
          <div className="flex min-w-0 flex-col gap-0.5">
            <label htmlFor="method-service-count-staff" className="text-sm font-medium">
              Also count publications co-authored by people in our unit
            </label>
            <span id="method-service-count-staff-hint" className="text-muted-foreground text-[12.5px]">
              Leave off if only some of your unit works on this service. You can remove individual
              publications after saving.
            </span>
          </div>
        </div>

        <div>
          <p className="text-muted-foreground mb-2 text-xs font-semibold tracking-wide uppercase">
            How it will appear on the method page
          </p>
          <div
            className="bg-apollo-slate-tint border-apollo-slate-tint-border text-apollo-slate rounded-[10px] border px-4 py-3.5"
            data-testid="method-service-preview"
          >
            <p className="text-[11px] font-semibold tracking-widest uppercase">
              WCM services for this method
            </p>
            <p className="mt-1.5 flex flex-wrap items-baseline gap-x-3.5 gap-y-1">
              <span className="text-base font-semibold break-words">
                {previewName} <span aria-hidden>↗</span>
              </span>
              <span className="text-[13.5px]">Offered by {unit}</span>
            </p>
            <p className="border-apollo-slate-tint-border mt-2.5 border-t pt-2.5 text-sm">
              {unit.charAt(0).toUpperCase() + unit.slice(1)} collaborated on{" "}
              <b className="font-semibold">N of the M</b> publications listed here.
            </p>
          </div>
          <p className={NOTE_CLASS}>
            The count is worked out from your unit’s people and your supported list, and is filled
            in on the public page.
          </p>
        </div>

        {formError && (
          <Alert variant="destructive">
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        )}

        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="apollo" disabled={busy}>
            {busy ? "Saving…" : editing ? "Save changes" : "Add service"}
          </Button>
          <Button type="button" variant="outline" disabled={busy} onClick={cancel}>
            Cancel
          </Button>
        </div>
      </form>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title="Remove this service?"
        description={
          removing
            ? `“${removing.name}” will no longer be listed as a service of ${unit}, along with its supported publications list.`
            : ""
        }
        reasonMode="none"
        confirmLabel="Remove"
        confirmVariant="destructive"
        onConfirm={async () => {
          if (removing) await remove(removing);
        }}
      />

      <ConfirmDialog
        open={pendingEdit !== null}
        onOpenChange={(open) => {
          if (!open) setPendingEdit(null);
        }}
        title="Discard your unsaved changes?"
        description={
          pendingEdit
            ? `What you have entered in the form has not been saved. Editing “${pendingEdit.name}” will replace it.`
            : ""
        }
        reasonMode="none"
        confirmLabel="Discard and edit"
        confirmVariant="destructive"
        onConfirm={() => {
          if (!pendingEdit) return;
          startEdit(pendingEdit);
          setPendingEdit(null);
          // The dialog still holds the focus here; move it once it has closed.
          setFocusAfter({ field: "name" });
        }}
      />
    </div>
  );
}

/** Which form field a route `field` belongs to. */
function serverField(field: string | undefined): FieldKey | null {
  switch (field) {
    case "name":
    case "url":
    case "families":
      return field;
    case "supportedPmids":
      return "pmids";
    default:
      return null;
  }
}

function errorMessage(code: string): string {
  switch (code) {
    case "name_required":
      return "Enter a name for the service.";
    case "name_too_long":
      return `Use ${SERVICE_NAME_MAX_LENGTH} characters or fewer.`;
    case "url_required":
      return "Enter the service’s web address.";
    case "url_too_long":
    case "invalid_url":
      return "That doesn’t look like a valid https:// web address.";
    case "families_required":
      return "Pick at least one method.";
    case "too_many_families":
      return `Pick ${SERVICE_FAMILIES_MAX} methods or fewer.`;
    case "unknown_family":
      return "One of these methods no longer has a public page. Remove it and try again.";
    case "invalid_pmids":
      return "Some of these are not PMIDs. Remove them and try again.";
    case "too_many_pmids":
      return `Use ${SERVICE_PMIDS_MAX.toLocaleString("en-US")} PMIDs or fewer.`;
    case "not_curator":
    case "not_core_owner":
    case "impersonation_readonly":
      return "You don’t have access to change this unit’s services. Refresh the page and try again.";
    case "service_not_found":
      return "That service no longer exists. Refresh the page and try again.";
    default:
      return "Something went wrong — your changes weren’t saved. Please try again.";
  }
}
