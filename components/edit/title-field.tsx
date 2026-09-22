/**
 * TitleField — the display-title control on the `/edit` Name & title panel
 * (#2720). Renders inside the panel's Title row, so the rest of that panel
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
 * Imports ONLY `@/lib/scholar-title` (pure, import-free) — never
 * `@/lib/edit/title-picker`, which touches the database and would drag the
 * mariadb driver into the client bundle.
 */
"use client";

import * as React from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { type TitleOption } from "@/lib/scholar-title";

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
  const [selected, setSelected] = React.useState(current ?? "");
  const [savedTitle, setSavedTitle] = React.useState(current);
  const [override, setOverride] = React.useState(hasOverride);
  const [request, setRequest] = React.useState(pending);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<string | null>(null);

  const available = options.filter((o) => o.value !== null);
  // Nothing to choose between: one option can't be picked wrongly, so the
  // control is just the value. Avoids a select with a single item.
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
        setSelected(body?.primaryTitle ?? "");
        setOverride(value !== "");
        // Setting the title answers any pending request, approved or not —
        // the route clears it, so the strip must go too.
        setRequest(null);
      } else {
        setRequest(value === "" ? null : { value, requestedBy: "you" });
      }
      setDone(successNote);
    } catch {
      setError("Could not save. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Display title"
          className="border-apollo-border bg-background rounded-md border px-2 py-1 text-sm"
          value={selected}
          disabled={busy}
          onChange={(e) => setSelected(e.target.value)}
        >
          {options.map((o) => (
            <option key={o.tier} value={o.value ?? ""} disabled={o.value === null}>
              {o.value === null ? `${o.label} — not applicable` : `${o.label}: ${o.value}`}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          disabled={busy || selected === (savedTitle ?? "")}
          onClick={() =>
            canSet
              ? post("primaryTitle", selected, "Title updated.")
              : post("primaryTitleRequest", selected, "Request sent for review.")
          }
        >
          {canSet ? "Save" : "Request"}
        </Button>
        {canSet && override && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => post("primaryTitle", "", "Reverted to the default title.")}
          >
            Use default
          </Button>
        )}
      </div>

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

      {done && <p className="text-muted-foreground text-xs">{done}</p>}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
