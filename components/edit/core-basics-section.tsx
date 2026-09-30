/**
 * CoreBasicsSection — the "Basics" block of the single-scroll core editor
 * (Edit Org Unit mockup, Core variant, 2026-09-28). Replaces the old
 * one-panel `CoreDetailsCard`: the same three `Core` columns, laid out like
 * `UnitBasicsSection`.
 *
 *   - **Name** is LOCKED for everyone, Superusers included — `CORE_CATALOG`
 *     seeds it, so a UI edit would be overwritten by the next ETL run.
 *   - **Description** and **Website** share ONE save: the floating "Unsaved
 *     changes to Basics · Discard · Save" bar, one `POST /api/edit/core`
 *     (`set_description` / `set_url`) per changed field. A failure on one field
 *     doesn't roll back the other.
 *   - **List on the public core-facilities pages** stays an immediate toggle
 *     (`set_visible`), then refreshes so the header's "Hidden" pill follows.
 *
 * Authz is enforced server-side (`authorizeCoreClaim`); this section is only
 * rendered for an actor who already passed that gate.
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";

import { UnsavedChangesGuard } from "@/components/edit/unsaved-changes-guard";
import { FieldNote, LockedValue, SectionHeader } from "@/components/edit/unit-basics-section";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/** Matches `validateUnitDescription`'s cap (manual-layer ≤ 4,000). */
const DESCRIPTION_MAX_CHARS = 4000;
/** Matches `validateUnitUrl`'s cap (the `Core.url @db.VarChar(512)` column). */
const URL_MAX_CHARS = 512;

type FieldKey = "description" | "url";
type Values = Record<FieldKey, string>;

const ACTION: Record<FieldKey, string> = { description: "set_description", url: "set_url" };

export type CoreBasicsSectionProps = {
  coreId: string;
  name: string;
  description: string | null;
  url: string | null;
  visible: boolean;
  headingId?: string;
};

async function postCore(
  coreId: string,
  action: string,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch("/api/edit/core", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ coreId, action, ...payload }),
    });
    // Status before body: a bodyless 401 / edge error page isn't JSON.
    const data = (await res.json().catch(() => ({ ok: false }))) as { ok: boolean; error?: string };
    return { ok: res.ok && data.ok === true, error: data.error };
  } catch {
    return { ok: false };
  }
}

export function CoreBasicsSection({
  coreId,
  name,
  description,
  url,
  visible,
  headingId = "basics-heading",
}: CoreBasicsSectionProps) {
  const router = useRouter();
  const initial: Values = { description: description ?? "", url: url ?? "" };
  const [saved, setSaved] = React.useState<Values>(initial);
  const [values, setValues] = React.useState<Values>(initial);
  const [errors, setErrors] = React.useState<Partial<Record<FieldKey, string>>>({});
  const [saving, setSaving] = React.useState(false);
  const [justSaved, setJustSaved] = React.useState(false);
  const [isVisible, setIsVisible] = React.useState(visible);
  const [toggling, setToggling] = React.useState(false);
  const [toggleError, setToggleError] = React.useState<string | null>(null);

  const dirtyKeys = (["description", "url"] as const).filter((k) => values[k] !== saved[k]);
  const dirty = dirtyKeys.length > 0;
  const descOver = values.description.length > DESCRIPTION_MAX_CHARS;
  const urlOver = values.url.length > URL_MAX_CHARS;
  const invalid = descOver || urlOver;

  function set(key: FieldKey, value: string) {
    setValues((v) => ({ ...v, [key]: value }));
    if (errors[key]) setErrors((e) => ({ ...e, [key]: undefined }));
    if (justSaved) setJustSaved(false);
  }

  async function save() {
    if (!dirty || invalid || saving) return;
    setSaving(true);
    setJustSaved(false);
    const nextSaved: Values = { ...saved };
    const nextErrors: Partial<Record<FieldKey, string>> = {};
    let anyOk = false;
    for (const key of dirtyKeys) {
      const res = await postCore(coreId, ACTION[key], { [key]: values[key] });
      if (res.ok) {
        nextSaved[key] = values[key];
        anyOk = true;
      } else {
        nextErrors[key] = errorMessage(res.error ?? "");
      }
    }
    setSaved(nextSaved);
    setErrors(nextErrors);
    setSaving(false);
    if (anyOk) {
      if (Object.keys(nextErrors).length === 0) setJustSaved(true);
      router.refresh();
    }
  }

  async function toggleVisible(next: boolean) {
    if (toggling) return;
    setToggling(true);
    setToggleError(null);
    const res = await postCore(coreId, "set_visible", { visible: next });
    if (res.ok) {
      setIsVisible(next);
      router.refresh();
    } else {
      setToggleError(errorMessage(res.error ?? ""));
    }
    setToggling(false);
  }

  const fieldClass = "bg-apollo-page border-apollo-border-strong";

  return (
    <div className="flex flex-col gap-[18px]" data-testid="core-basics-section">
      <UnsavedChangesGuard dirty={dirty} />
      <SectionHeader
        id={headingId}
        title="Basics"
        description="Shown on the core’s public page and on browse."
      />

      <div className="flex flex-col gap-1.5">
        <label htmlFor="basics-name" className="text-[13.5px] font-medium">
          Name
        </label>
        <LockedValue id="basics-name">{name}</LockedValue>
        <FieldNote>Set when the core was registered. Ask a superuser to rename it.</FieldNote>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between gap-3">
          <label htmlFor="basics-description" className="text-[13.5px] font-medium">
            Description
          </label>
          <span
            aria-live="polite"
            className={cn(
              "text-xs tabular-nums",
              descOver ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {values.description.length.toLocaleString("en-US")} /{" "}
            {DESCRIPTION_MAX_CHARS.toLocaleString("en-US")}
          </span>
        </div>
        <Textarea
          id="basics-description"
          value={values.description}
          rows={4}
          placeholder="What the core does, in two or three sentences."
          onChange={(e) => set("description", e.target.value)}
          className={fieldClass}
          data-testid="basics-description"
        />
        {errors.description && <FieldNote error={errors.description} />}
      </div>

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

      <div className="border-apollo-border flex items-center gap-4 border-t pt-4">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span id="core-listed-label" className="text-[13.5px] font-medium">
            List on the public core-facilities pages
          </span>
          <span className="text-muted-foreground text-[12.5px]">
            Off by default. The site’s core-facility pages must also be enabled for a visible core
            to show.
          </span>
        </div>
        <Switch
          checked={isVisible}
          disabled={toggling}
          onCheckedChange={(checked) => toggleVisible(checked)}
          aria-labelledby="core-listed-label"
          data-testid="core-visible-toggle"
        />
      </div>
      {toggleError && <FieldNote error={toggleError} />}

      {justSaved && !dirty && (
        <p
          role="status"
          aria-live="polite"
          className="text-apollo-green inline-flex items-center gap-1 text-sm"
          data-testid="basics-saved"
        >
          <Check className="size-4" aria-hidden />
          Saved. Live now.
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
            onClick={() => {
              setValues(saved);
              setErrors({});
            }}
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

function errorMessage(code: string): string {
  switch (code) {
    case "not_core_owner":
      return "You no longer have access to this core. Refresh the page and try again.";
    case "description_too_long":
      return "Use 4,000 characters or fewer.";
    case "url_too_long":
    case "invalid_url":
      return "That doesn’t look like a valid https:// web address.";
    default:
      return "We couldn’t save this. Please try again.";
  }
}
