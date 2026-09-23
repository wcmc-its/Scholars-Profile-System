/**
 * TitleField — the display-title control on the `/edit` Name & title panel
 * (#2719). Renders inside the panel's Title row, so the rest of that panel
 * stays the read-only def-list it is today.
 *
 * TWO POSTURES, one component, because they share the option list and the
 * pending-request strip:
 *
 *   canSet  — superuser / comms_steward / unit admin. Picks a title outright.
 *             Also sees any pending request with Approve / Dismiss.
 *   else    — the scholar or their proxy. REQUESTS a title; sees their own
 *             pending request with Withdraw.
 *
 * Both post `/api/edit/field`; the field name is the only difference
 * (`primaryTitle` vs `primaryTitleRequest`). `value: ""` clears — that one
 * convention covers un-pin, Dismiss and Withdraw, so none of them needs a
 * second endpoint. Approve is an ordinary set of `primaryTitle`, which the
 * route makes clear the request as a side effect.
 *
 * The picker is a radio list (design handoff option 1a): every tier is a row —
 * title on line one, its source on line two, "Current" on the saved one. Tiers
 * that do not apply are omitted (Paul, 2026-09-23): the source line on each real
 * option already says where it comes from. After a save the
 * page refreshes so the identity header above picks up the new title.
 *
 * Imports ONLY `@/lib/scholar-title` (pure, import-free) — never
 * `@/lib/edit/title-picker`, which touches the database and would drag the
 * mariadb driver into the client bundle.
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Info } from "lucide-react";
import { RadioGroup as RadioGroupPrimitive } from "radix-ui";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { type TitleOption, type TitleTier } from "@/lib/scholar-title";
import { cn } from "@/lib/utils";

/** Line two of each row: where the tier's title comes from. */
/** What a working title is, shown on the working-title row only. The value
 *  arrives through the Enterprise Directory, but people set it in the Web
 *  Directory. */
const WORKING_TITLE_HELP =
  "Set in the Web Directory for everyday use. Shown instead of the primary title.";

const TIER_SOURCE: Record<TitleTier, string> = {
  working: "Working title · Web Directory",
  chief: "Division chief · Org unit leadership",
  centerHead: "Center head · Org unit leadership",
  primary: "Primary title · Enterprise Directory",
};

/** The tier a title string belongs to — the first match in precedence order. */
function tierOf(options: TitleOption[], title: string | null): TitleTier | "" {
  if (!title) return "";
  return options.find((o) => o.value === title)?.tier ?? "";
}

export type TitleFieldProps = {
  cwid: string;
  /** Every tier, in precedence order; `value: null` = does not apply. */
  options: TitleOption[];
  /** What is displayed today. */
  current: string | null;
  /** True when an operator has pinned a title. */
  hasOverride: boolean;
  /** A request awaiting a decision, if any. */
  pending: { value: string; requestedBy: string } | null;
  /** Operator posture (pick outright) vs scholar/proxy posture (request). */
  canSet: boolean;
};

export function TitleField({
  cwid,
  options,
  current,
  hasOverride,
  pending,
  canSet,
}: TitleFieldProps) {
  const router = useRouter();
  const [savedTitle, setSavedTitle] = React.useState(current);
  const [selected, setSelected] = React.useState<TitleTier | "">(tierOf(options, current));
  const [override, setOverride] = React.useState(hasOverride);
  const [request, setRequest] = React.useState(pending);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<string | null>(null);

  const available = options.filter((o) => o.value !== null);
  // Nothing to choose between: one option can't be picked wrongly, so the
  // control is just the value. Avoids a list with a single choice.
  if (available.length <= 1 && request === null) {
    return <>{savedTitle ?? "—"}</>;
  }

  async function post(fieldName: string, value: string, successNote: string) {
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
          fieldName,
          value,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "Could not save. Try again.");
        return;
      }
      const body = (await res.json().catch(() => null)) as { primaryTitle?: string | null } | null;
      if (fieldName === "primaryTitle") {
        setSavedTitle(body?.primaryTitle ?? null);
        setSelected(tierOf(options, body?.primaryTitle ?? null));
        setOverride(value !== "");
        // Setting the title answers any pending request, approved or not —
        // the route clears it, so the strip must go too.
        setRequest(null);
        // The identity header above the panel reads the title server-side.
        router.refresh();
      } else {
        setRequest(value === "" ? null : { value, requestedBy: "you" });
        // The request strip now carries the ask; the list goes back to what is
        // displayed today, so it doesn't read as an unsaved change.
        setSelected(tierOf(options, savedTitle));
      }
      setDone(successNote);
    } catch {
      setError("Could not save. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const savedTier = tierOf(options, savedTitle);
  const selectedValue = options.find((o) => o.tier === selected)?.value ?? "";
  const dirty = selected !== "" && selected !== savedTier;

  return (
    <div className="flex flex-col gap-4">
      <TooltipProvider delayDuration={200}>
      <RadioGroupPrimitive.Root
        aria-label="Display title"
        value={selected}
        onValueChange={(v) => {
          setSelected(v as TitleTier);
          setDone(null);
        }}
        disabled={busy}
        className="border-apollo-border-strong flex flex-col overflow-hidden rounded-lg border"
      >
        {available.map((o, i) => {
          const on = selected === o.tier;
          return (
            <RadioGroupPrimitive.Item
              key={o.tier}
              value={o.tier}
              data-testid={`title-option-${o.tier}`}
              className={cn(
                "focus-visible:ring-ring/50 flex w-full items-center gap-3 px-3.5 py-3 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-inset",
                i > 0 && "border-apollo-border border-t",
                on ? "bg-apollo-surface-2" : "bg-apollo-surface",
                "cursor-pointer",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "flex size-[18px] shrink-0 items-center justify-center rounded-full border-[1.5px] bg-white",
                  on ? "border-apollo-bar" : "border-[#6f6a5e]",
                )}
              >
                {on && <span className="bg-apollo-bar size-2 rounded-full" />}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-sm font-medium text-[#1f1b19]">{o.value}</span>
                <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
                  {TIER_SOURCE[o.tier]}
                  {o.tier === "working" && (
                    <>
                      {/* A span, not a button: the row is already a button. Hover
                          shows the tooltip; screen readers get the sr-only text. */}
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span data-testid="working-title-help">
                            <Info aria-hidden className="size-3.5" />
                          </span>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs">{WORKING_TITLE_HELP}</TooltipContent>
                      </Tooltip>
                      <span className="sr-only">{WORKING_TITLE_HELP}</span>
                    </>
                  )}
                </span>
              </span>
              {o.tier === savedTier && (
                <span className="bg-apollo-surface border-apollo-border rounded-[10px] border px-2 py-px text-xs whitespace-nowrap text-[#5c574d]">
                  Displayed
                </span>
              )}
            </RadioGroupPrimitive.Item>
          );
        })}
      </RadioGroupPrimitive.Root>
      </TooltipProvider>

      {/* Nothing below the list until there is something to do: a pick to save,
          a pin to undo, or the result of the last action (locked-panels canvas). */}
      {(dirty || (canSet && override) || done) && (
        <div className="flex flex-wrap items-center gap-3">
          {dirty && (
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                canSet
                  ? post("primaryTitle", selectedValue, "Saved. The profile header now shows this title.")
                  : post("primaryTitleRequest", selectedValue, "Request sent for review.")
              }
            >
              {canSet ? "Save" : "Request"}
            </Button>
          )}
          {dirty && (
            <button
              type="button"
              className="text-[#5c574d] text-[13px] hover:underline"
              onClick={() => setSelected(savedTier)}
            >
              Cancel
            </button>
          )}
          {canSet && override && !dirty && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => post("primaryTitle", "", "Reverted to the default title.")}
            >
              Use default
            </Button>
          )}
          {!dirty && done && (
            <span role="status" className="text-muted-foreground text-[13px]">
              {done}
            </span>
          )}
        </div>
      )}
      <span className="sr-only" aria-live="polite">
        {dirty ? "Unsaved change" : ""}
      </span>

      {!canSet && (
        <p className="text-muted-foreground text-xs">
          Your request goes to a profile administrator. Nothing changes until they approve it.
        </p>
      )}

      {request !== null && (
        <div className="border-apollo-border flex flex-wrap items-center gap-2 rounded-md border p-2 text-xs">
          <span className="text-muted-foreground">
            {canSet ? `${request.requestedBy} requested:` : "Requested:"}
          </span>
          <span className="font-medium">{request.value}</span>
          {canSet ? (
            <>
              <Button
                size="sm"
                disabled={busy}
                onClick={() => post("primaryTitle", request.value, "Request approved.")}
              >
                Approve
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => post("primaryTitleRequest", "", "Request dismissed.")}
              >
                Dismiss
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => post("primaryTitleRequest", "", "Request withdrawn.")}
            >
              Withdraw
            </Button>
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
