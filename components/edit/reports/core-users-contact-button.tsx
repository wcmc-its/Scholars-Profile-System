"use client";

/**
 * Report 11's "Email these users" button. On click it POSTs the page's query
 * string to `/api/edit/reports/core-users/contacts`, which returns the
 * addresses of the filtered people — they are never in the page HTML — and
 * copies them, semicolon-separated, for an Outlook Bcc. Nothing is sent.
 *
 * The clipboard write is handed a PROMISE (`ClipboardItem`) where supported, so
 * Safari keeps the click's user activation across the fetch; otherwise it
 * falls back to `writeText` after the fetch. If the clipboard refuses either
 * way, the addresses are shown selected in a box to copy by hand.
 *
 * Client bundle: imports nothing server-side (no `@/lib/db` reachability).
 */
import { useState } from "react";
import { Check, Mail } from "lucide-react";

import { Button } from "@/components/ui/button";

type State =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "copied"; count: number }
  | { kind: "manual"; text: string; count: number }
  | { kind: "error"; message: string };

const ERRORS: Record<string, string> = {
  over_core_contact_cap: "Too many people to email at once. Narrow the filters and try again.",
  not_core_owner: "Only this core's owners can email its users.",
  impersonation_readonly: "Emailing users is not available while viewing as someone else.",
};

async function fetchAddresses(query: string): Promise<{ text: string; count: number }> {
  const res = await fetch("/api/edit/reports/core-users/contacts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
    cache: "no-store",
  });
  const body = (await res.json().catch(() => null)) as {
    ok?: boolean;
    error?: string;
    emails?: string[];
  } | null;
  if (!res.ok || !body?.ok || !Array.isArray(body.emails)) {
    throw new Error(ERRORS[body?.error ?? ""] ?? "Couldn't load the addresses. Try again.");
  }
  return { text: body.emails.join("; "), count: body.emails.length };
}

export function CoreUsersContactButton({ query, count }: { query: string; count: number }) {
  const [state, setState] = useState<State>({ kind: "idle" });

  async function onClick() {
    setState({ kind: "busy" });
    const pending = fetchAddresses(query);
    try {
      if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/plain": pending.then((r) => new Blob([r.text], { type: "text/plain" })),
          }),
        ]);
      } else {
        await navigator.clipboard.writeText((await pending).text);
      }
      setState({ kind: "copied", count: (await pending).count });
    } catch (err) {
      // A fetch failure surfaces its message; a clipboard refusal falls back
      // to the addresses in a box, since they were already fetched.
      const got = await pending.catch(() => null);
      if (got) setState({ kind: "manual", ...got });
      else setState({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  return (
    <div className="flex flex-col items-start gap-2" data-testid="core-users-contact">
      <Button
        type="button"
        variant="outline"
        onClick={onClick}
        disabled={state.kind === "busy"}
        data-testid="core-users-contact-button"
      >
        <Mail className="size-4" aria-hidden />
        {state.kind === "busy" ? "Copying…" : "Email these users"}
      </Button>
      <p className="text-muted-foreground text-[13px]" role="status" aria-live="polite">
        {state.kind === "copied" ? (
          <span className="text-foreground inline-flex items-center gap-1">
            <Check className="size-3.5" aria-hidden />
            Copied {state.count.toLocaleString()} {state.count === 1 ? "address" : "addresses"} —
            paste into Bcc
          </span>
        ) : state.kind === "manual" ? (
          `Couldn't copy automatically. Select the ${state.count.toLocaleString()} addresses below and copy them into Bcc.`
        ) : state.kind === "error" ? (
          <span className="text-apollo-amber">{state.message}</span>
        ) : (
          `Copies the ${count.toLocaleString()} ${count === 1 ? "address" : "addresses"} of the people still at Weill Cornell, for Outlook Bcc.`
        )}
      </p>
      {state.kind === "manual" && (
        <textarea
          readOnly
          value={state.text}
          rows={3}
          className="border-apollo-border w-full max-w-[420px] rounded border p-2 text-xs"
          onFocus={(e) => e.currentTarget.select()}
          autoFocus
          data-testid="core-users-contact-manual"
        />
      )}
    </div>
  );
}
