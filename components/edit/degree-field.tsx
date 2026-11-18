/**
 * DegreeField — the Degrees row on the `/edit` Name & title panel.
 *
 * The default is the Enterprise Directory string. The scholar (or anyone who
 * may edit their bio) can instead tick degrees from their own ASMS education
 * record; the display order is fixed (medicine, PhD, other doctorates,
 * master's), so the preview is exactly what the profile will show. Saves
 * apply at once — no approval, every option is from ASMS.
 *
 * Imports ONLY the pure `@/lib/degree-picker` — never
 * `@/lib/edit/degree-picks.server`, which would drag the mariadb driver into
 * the client bundle.
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DEGREE_OVERRIDE_FIELD, normalizeDegree } from "@/lib/degree-picker";
import { cn } from "@/lib/utils";

export type DegreeFieldProps = {
  cwid: string;
  /** Selectable degrees, in display order. */
  options: string[];
  /** The scholar's saved pick, or null when the ED value shows. */
  selected: string[] | null;
  /** The Enterprise Directory value. */
  directory: string | null;
  /** What the profile shows today. */
  current: string | null;
};

export function DegreeField({ cwid, options, selected, directory, current }: DegreeFieldProps) {
  const router = useRouter();
  // Start from the saved pick, else the options the ED string already names,
  // so adding one missing degree is a single tick.
  const initial = React.useMemo(() => {
    if (selected) return selected;
    const named = new Set((directory ?? "").split(",").map((t) => normalizeDegree(t)));
    return options.filter((o) => named.has(o));
  }, [selected, directory, options]);
  const [checked, setChecked] = React.useState<Set<string>>(() => new Set(initial));
  const [shown, setShown] = React.useState(current);
  const [hasPick, setHasPick] = React.useState(selected !== null);
  const [touched, setTouched] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<string | null>(null);

  if (options.length === 0) return <>{current ?? "—"}</>;

  const preview = options.filter((o) => checked.has(o)).join(", ");
  const dirty = touched && checked.size > 0 && preview !== shown;

  async function post(value: string[] | "", note: string) {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const res = await fetch("/api/edit/field", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          op: "set",
          entityType: "scholar",
          entityId: cwid,
          fieldName: DEGREE_OVERRIDE_FIELD,
          value,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "Could not save. Try again.");
        return;
      }
      const body = (await res.json().catch(() => null)) as { postnominal?: string | null } | null;
      setShown(body?.postnominal ?? null);
      setHasPick(value !== "");
      if (value === "") {
        const named = new Set((directory ?? "").split(",").map((t) => normalizeDegree(t)));
        setChecked(new Set(options.filter((o) => named.has(o))));
      }
      setTouched(false);
      setDone(note);
      // The identity header above the panel reads the degrees server-side.
      router.refresh();
    } catch {
      setError("Could not save. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <fieldset disabled={busy} className="flex flex-col gap-2">
        <legend className="text-muted-foreground mb-1 text-xs">
          Choose which degrees from your education record to display.
        </legend>
        <ul className="border-apollo-border-strong flex flex-col overflow-hidden rounded-lg border">
          {options.map((o, i) => (
            <li
              key={o}
              className={cn("bg-apollo-surface", i > 0 && "border-apollo-border border-t")}
            >
              <label
                data-testid={`degree-option-${o}`}
                className="flex cursor-pointer items-center gap-3 px-3.5 py-3 text-sm font-medium text-[#1f1b19]"
              >
                <input
                  type="checkbox"
                  className="accent-apollo-bar size-4"
                  checked={checked.has(o)}
                  onChange={(e) => {
                    const next = new Set(checked);
                    if (e.target.checked) next.add(o);
                    else next.delete(o);
                    setChecked(next);
                    setTouched(true);
                    setDone(null);
                  }}
                />
                {o}
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
      <p className="text-muted-foreground text-xs" data-testid="degree-preview">
        {checked.size === 0 ? "Select at least one degree." : `Shown as: ${preview}`}
        {hasPick && directory ? ` · Directory default: ${directory}` : ""}
      </p>

      {(dirty || hasPick || done) && (
        <div className="flex flex-wrap items-center gap-3">
          {dirty && (
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                post(
                  options.filter((o) => checked.has(o)),
                  "Saved. The profile now shows these degrees.",
                )
              }
            >
              Save
            </Button>
          )}
          {dirty && (
            <button
              type="button"
              className="text-[13px] text-[#5c574d] hover:underline"
              onClick={() => {
                setChecked(new Set(initial));
                setTouched(false);
              }}
            >
              Cancel
            </button>
          )}
          {hasPick && !dirty && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => post("", "Reverted to the directory default.")}
            >
              Use directory default
            </Button>
          )}
          {!dirty && done && (
            <span role="status" className="text-muted-foreground text-[13px]">
              {done}
            </span>
          )}
        </div>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
