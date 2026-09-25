/**
 * CenterBasicsSection — the "Basics" block of the single-scroll center editor
 * (Edit Center mockup, 2026-09-25). One form for the fields that used to be five
 * separate rail tabs (Name, Description, Website, Profile URL, Center type),
 * with ONE save: a floating "Unsaved changes to Basics · Discard · Save" bar
 * that appears only while something is dirty.
 *
 * Every field still writes through the same endpoint + field name the old cards
 * used — `/api/edit/unit` op:"update" (a center edits in-row; no
 * `field_override`) — one POST per CHANGED field, in form order. A failure on
 * one field doesn't roll back the others: the saved fields settle, the failed
 * one stays dirty with its own inline error, and the bar stays up.
 *
 * Profile URL and Center type are Superuser-only (the route enforces it —
 * `not_superuser`); for anyone else they render read-only, LOCKED-style
 * (neutral lock + text), instead of disappearing.
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, Lock } from "lucide-react";

import { UnsavedChangesGuard } from "@/components/edit/unsaved-changes-guard";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { validateSlugFormat, validateUnitName } from "@/lib/edit/validators";

/** Matches `validateUnitFieldValue`'s description cap. */
const DESCRIPTION_MAX_CHARS = 4000;
/** Matches `validateUnitUrl`'s cap (the `@db.VarChar(512)` column). */
const URL_MAX_CHARS = 512;

type CenterType = "center" | "institute";
type FieldKey = "name" | "description" | "url" | "slug" | "centerType";
type Values = Record<FieldKey, string>;

const CENTER_TYPE_OPTIONS: ReadonlyArray<{ value: CenterType; label: string }> = [
  { value: "center", label: "Center" },
  { value: "institute", label: "Institute" },
];

export type CenterBasicsSectionProps = {
  code: string;
  name: string;
  description: string | null;
  url: string | null;
  slug: string;
  centerType: CenterType;
  /** Superuser-only fields (Profile URL, Center type). */
  canEditSuperuserFields: boolean;
  /** Section heading id (the page has several sections, each needs its own). */
  headingId?: string;
};

export function CenterBasicsSection({
  code,
  name,
  description,
  url,
  slug,
  centerType,
  canEditSuperuserFields,
  headingId = "basics-heading",
}: CenterBasicsSectionProps) {
  const router = useRouter();
  const initial: Values = {
    name,
    description: description ?? "",
    url: url ?? "",
    slug,
    centerType,
  };
  const [saved, setSaved] = React.useState<Values>(initial);
  const [values, setValues] = React.useState<Values>(initial);
  const [errors, setErrors] = React.useState<Partial<Record<FieldKey, string>>>({});
  const [saving, setSaving] = React.useState(false);
  const [justSaved, setJustSaved] = React.useState(false);

  const editable: FieldKey[] = canEditSuperuserFields
    ? ["name", "description", "url", "slug", "centerType"]
    : ["name", "description", "url"];
  const dirtyKeys = editable.filter((k) => values[k] !== saved[k]);
  const dirty = dirtyKeys.length > 0;

  // Client-side validation — the same validators the server runs.
  const nameResult = validateUnitName(values.name);
  const nameError = values.name !== saved.name && !nameResult.ok
    ? nameResult.error === "name_too_long"
      ? "Use 255 characters or fewer."
      : "Enter a name."
    : null;
  const slugResult = validateSlugFormat(values.slug);
  const slugError = values.slug !== saved.slug && !slugResult.ok ? slugFormatMessage(slugResult.error) : null;
  const descOver = values.description.length > DESCRIPTION_MAX_CHARS;
  const urlOver = values.url.length > URL_MAX_CHARS;
  const invalid = Boolean(nameError || slugError || descOver || urlOver);

  function set(key: FieldKey, value: string) {
    setValues((v) => ({ ...v, [key]: value }));
    if (errors[key]) setErrors((e) => ({ ...e, [key]: undefined }));
    if (justSaved) setJustSaved(false);
  }

  function discard() {
    setValues(saved);
    setErrors({});
  }

  function payloadValue(key: FieldKey): string {
    if (key === "name" && nameResult.ok) return nameResult.value;
    if (key === "slug" && slugResult.ok) return slugResult.value;
    return values[key];
  }

  async function save() {
    if (!dirty || invalid || saving) return;
    setSaving(true);
    setJustSaved(false);
    const nextSaved: Values = { ...saved };
    const nextValues: Values = { ...values };
    const nextErrors: Partial<Record<FieldKey, string>> = {};
    let anyOk = false;
    for (const key of dirtyKeys) {
      try {
        const res = await fetch("/api/edit/unit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            op: "update",
            entityType: "center",
            entityId: code,
            fieldName: key,
            value: payloadValue(key),
          }),
        });
        // Status before body: a bodyless 401 / edge error page isn't JSON.
        const data = res.ok
          ? ((await res.json()) as { ok: true; value: string } | { ok: false; error: string })
          : ((await res.json().catch(() => ({ ok: false, error: "" }))) as {
              ok: false;
              error: string;
            });
        if (!res.ok || data.ok !== true) {
          nextErrors[key] = saveErrorMessage(key, "error" in data ? data.error : "");
          continue;
        }
        const settled = typeof data.value === "string" ? data.value : payloadValue(key);
        nextSaved[key] = settled;
        nextValues[key] = settled;
        anyOk = true;
      } catch {
        nextErrors[key] = saveErrorMessage(key, "");
      }
    }
    setSaved(nextSaved);
    setValues(nextValues);
    setErrors(nextErrors);
    setSaving(false);
    if (anyOk) {
      setJustSaved(Object.keys(nextErrors).length === 0);
      router.refresh();
    }
  }

  const fieldClass = "bg-apollo-page border-apollo-border-strong";

  return (
    <div className="flex flex-col gap-[18px]" data-testid="center-basics-section">
      <UnsavedChangesGuard dirty={dirty} />
      <SectionHeader
        id={headingId}
        title="Basics"
        description="Shown on the center’s public page, in search and on browse."
      />

      <div className="flex flex-col gap-1.5">
        <label htmlFor="basics-name" className="text-[13.5px] font-medium">
          Name
        </label>
        <Input
          id="basics-name"
          value={values.name}
          onChange={(e) => set("name", e.target.value)}
          aria-invalid={Boolean(nameError || errors.name)}
          autoComplete="off"
          className={fieldClass}
          data-testid="basics-name"
        />
        <FieldNote error={nameError ?? errors.name}>
          Changing the name doesn’t change the profile URL.
        </FieldNote>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between gap-3">
          <label htmlFor="basics-description" className="text-[13.5px] font-medium">
            Description
          </label>
          <span
            aria-live="polite"
            className={cn("text-xs tabular-nums", descOver ? "text-destructive" : "text-muted-foreground")}
          >
            {values.description.length.toLocaleString("en-US")} /{" "}
            {DESCRIPTION_MAX_CHARS.toLocaleString("en-US")}
          </span>
        </div>
        <Textarea
          id="basics-description"
          value={values.description}
          rows={4}
          placeholder="What the center does, in two or three sentences."
          onChange={(e) => set("description", e.target.value)}
          className={fieldClass}
          data-testid="basics-description"
        />
        {errors.description && <FieldNote error={errors.description} />}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-[repeat(auto-fit,minmax(240px,1fr))]">
        <div className="flex min-w-0 flex-col gap-1.5">
          <label htmlFor="basics-url" className="text-[13.5px] font-medium">
            Website
          </label>
          <Input
            id="basics-url"
            type="url"
            inputMode="url"
            value={values.url}
            placeholder="https://"
            onChange={(e) => set("url", e.target.value)}
            aria-invalid={Boolean(urlOver || errors.url)}
            autoComplete="off"
            className={fieldClass}
            data-testid="basics-url"
          />
          {(urlOver || errors.url) && (
            <FieldNote error={urlOver ? "Use 512 characters or fewer." : errors.url} />
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-1.5">
          <label htmlFor="basics-slug" className="text-[13.5px] font-medium">
            Profile URL
          </label>
          {canEditSuperuserFields ? (
            <div
              className={cn(
                "border-apollo-border-strong flex h-9 overflow-hidden rounded-md border",
                slugError || errors.slug ? "border-destructive" : "",
              )}
            >
              <span className="bg-apollo-surface-2 text-muted-foreground flex items-center px-2 font-mono text-xs whitespace-nowrap">
                /centers/
              </span>
              <input
                id="basics-slug"
                value={values.slug}
                onChange={(e) => set("slug", e.target.value)}
                aria-invalid={Boolean(slugError || errors.slug)}
                autoComplete="off"
                spellCheck={false}
                className="bg-apollo-page min-w-0 flex-1 px-2 font-mono text-[13px] outline-none"
                data-testid="basics-slug"
              />
            </div>
          ) : (
            <LockedValue id="basics-slug" mono>
              /centers/{values.slug}
            </LockedValue>
          )}
          {canEditSuperuserFields ? (
            (slugError || errors.slug) && <FieldNote error={slugError ?? errors.slug} />
          ) : (
            <FieldNote>Only a superuser can change the profile URL.</FieldNote>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-1.5">
          <label htmlFor="basics-center-type" className="text-[13.5px] font-medium">
            Center type
          </label>
          {canEditSuperuserFields ? (
            <select
              id="basics-center-type"
              value={values.centerType}
              onChange={(e) => set("centerType", e.target.value)}
              className="bg-apollo-page border-apollo-border-strong h-9 rounded-md border px-2 text-sm"
              data-testid="basics-center-type"
            >
              {CENTER_TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          ) : (
            <LockedValue id="basics-center-type">
              {CENTER_TYPE_OPTIONS.find((o) => o.value === values.centerType)?.label ?? "Center"}
            </LockedValue>
          )}
          {errors.centerType && <FieldNote error={errors.centerType} />}
        </div>
      </div>

      {justSaved && !dirty && (
        <p
          role="status"
          aria-live="polite"
          className="text-apollo-green inline-flex items-center gap-1 text-sm"
          data-testid="basics-saved"
        >
          <Check className="size-4" aria-hidden />
          Saved. Live now; search updates on the next nightly index rebuild.
        </p>
      )}
      {Object.values(errors).some(Boolean) && (
        <Alert variant="destructive" data-testid="basics-error">
          <AlertDescription>
            Some changes weren’t saved. Fix the highlighted fields and save again.
          </AlertDescription>
        </Alert>
      )}

      {dirty && (
        <div
          role="region"
          aria-label="Unsaved changes"
          className="bg-apollo-bar fixed inset-x-0 bottom-[calc(18px+env(safe-area-inset-bottom,0px))] z-40 mx-auto flex w-fit max-w-[calc(100vw-32px)] flex-wrap items-center gap-3.5 rounded-xl py-2.5 pr-3 pl-[18px] text-sm text-white shadow-[0_8px_30px_rgba(34,30,28,0.25)]"
          data-testid="basics-save-bar"
        >
          <span>Unsaved changes to Basics</span>
          <button
            type="button"
            onClick={discard}
            disabled={saving}
            className="text-[13px] text-[#cfc8c2] hover:text-white"
            data-testid="basics-discard"
          >
            Discard
          </button>
          <Button
            type="button"
            size="sm"
            onClick={save}
            disabled={invalid || saving}
            className="text-apollo-bar bg-white hover:bg-white/90"
            data-testid="basics-save"
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      )}
    </div>
  );
}

/** The section title + one-line explainer every unit-editor section opens with. */
export function SectionHeader({
  id,
  title,
  description,
}: {
  id: string;
  title: string;
  description?: React.ReactNode;
}) {
  return (
    <header className="flex flex-col gap-0.5">
      <h2 id={id} className="text-[17px] font-[600] tracking-[-0.015em]">
        {title}
      </h2>
      {description && <p className="text-muted-foreground text-[13px]">{description}</p>}
    </header>
  );
}

function FieldNote({ error, children }: { error?: string | null; children?: React.ReactNode }) {
  if (error) {
    return (
      <p role="alert" className="text-destructive text-[12.5px]">
        {error}
      </p>
    );
  }
  return children ? <p className="text-muted-foreground text-[12.5px]">{children}</p> : null;
}

/** LOCKED house style: neutral fill + lock icon + text, never a hue. */
function LockedValue({
  id,
  mono = false,
  children,
}: {
  id: string;
  mono?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      id={id}
      className={cn(
        "bg-apollo-lock-bg flex h-9 min-w-0 items-center gap-2 rounded-md px-2.5 text-sm",
        mono && "font-mono text-[13px]",
      )}
      data-testid={`${id}-locked`}
    >
      <Lock className="text-muted-foreground size-3 shrink-0" aria-hidden />
      <span className="truncate">{children}</span>
    </div>
  );
}

function slugFormatMessage(error: "format" | "too_long" | "reserved"): string {
  switch (error) {
    case "too_long":
      return "Use 64 characters or fewer.";
    case "reserved":
      return "That URL segment is reserved. Choose another.";
    case "format":
      return "Use lowercase letters, numbers and single hyphens only.";
  }
}

function saveErrorMessage(key: FieldKey, code: string): string {
  switch (code) {
    case "not_curator":
    case "not_superuser":
    case "not_unit_owner":
      return "You no longer have access to change this. Refresh the page and try again.";
    case "slug_taken":
    case "collision":
      return "Another center already uses that URL. Choose another.";
    case "url_too_long":
    case "invalid_url":
      return "That doesn’t look like a valid https:// web address.";
    case "description_too_long":
      return "Use 4,000 characters or fewer.";
    case "name_too_long":
      return "Use 255 characters or fewer.";
  }
  if (key === "url" && code === "invalid_value") {
    return "That doesn’t look like a valid https:// web address.";
  }
  return "We couldn’t save this. Please try again.";
}
