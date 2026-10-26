/**
 * The ORCID iD card on the Identifiers & Profiles tab. Four states, the same
 * ones the home board's ORCID row shows, but with room to act:
 *
 *   suggested  → the inferred iD in a boxed row, pill "High confidence
 *                suggestion", its per-source evidence; "Confirm this iD"
 *                confirms it in one click, or enter a different one.
 *   confirmed  → (this session) the same row, pill "Confirmed", "Confirmed by
 *                you" above the evidence it was confirmed on; Change, Remove.
 *   on file    → the iD that was already there, pill "On file", WHY it is on
 *                file (the evidence persists); Change, Remove.
 *   conflict   → on file AND the inferred rows point at a DIFFERENT iD: both
 *                rows, each with its pill, and "Replace with the suggested iD"
 *                / "Keep the iD on file" / "Remove both". Keep confirms the
 *                on-file iD and Remove both clears it; both record the
 *                suggested iD as dismissed so it is not offered again.
 *   none       → the input.
 *
 * Second person is the EDITOR: an administrator reads the scholar's first name
 * where the scholar reads "your". Every write is `POST /api/edit/orcid`, which
 * puts the iD on `scholar.orcid` (stamped confirmed; the nightly
 * `etl:orcid-push` carries it to WCM Identity); Remove sends `orcid: null`,
 * clears it, and records the removed iD as dismissed so it does not come back.
 * `router.refresh()` reconciles the page. Off-campus friendly:
 * this replaces the "Confirm in ReCiter" hand-off, which only worked on the
 * campus network.
 *
 * `ORCID_CONNECT` on (#3115), scholar's own view only: "Connect your ORCID iD"
 * (a link to `/api/edit/orcid/connect`, ORCID's sign-in) replaces typing an iD,
 * per ORCID's rule that iDs are never typed in. An iD proved that way shows the
 * "Authenticated" pill. The callback lands back here with `?orcid=connected|
 * denied|failed`, read once on mount for the status line.
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowUpRight, Check, Lock, Sparkles } from "lucide-react";

import { EditPanel, OwnedBadge } from "@/components/edit/edit-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  firstName,
  normalizeOrcid,
  ORCID_URL_PREFIX,
  orcidEvidenceLine,
  type OrcidEvidence,
} from "@/lib/edit/orcid";

export type OrcidCardProps = {
  cwid: string;
  /** "self" → second person; "superuser" → the scholar's first name. */
  mode: "self" | "superuser";
  scholarName: string;
  onFile: string | null;
  onFileEvidence?: OrcidEvidence[];
  suggested: { orcid: string; accepted: number; evidence?: OrcidEvidence[] } | null;
  /** `onFile` was proved by an ORCID sign-in (#3115). */
  authenticated?: boolean;
  /** Offer "Connect your ORCID iD" — `ORCID_CONNECT` on and the scholar's own view. */
  connectEnabled?: boolean;
};

const CONNECT_OUTCOME: Record<string, { text: string; error: boolean }> = {
  connected: { text: "Your ORCID iD is connected.", error: false },
  denied: { text: "You didn't grant access on ORCID, so nothing changed.", error: false },
  failed: { text: "Couldn't connect your ORCID iD. Try again.", error: true },
};

/** ORCID's iD mark (brand asset), 16px. */
function OrcidIdIcon() {
  return (
    <svg viewBox="0 0 256 256" className="size-4 shrink-0" aria-hidden>
      <path fill="#A6CE39" d="M256 128c0 70.7-57.3 128-128 128S0 198.7 0 128 57.3 0 128 0s128 57.3 128 128z" />
      <path fill="#fff" d="M86.3 186.2H70.9V79.1h15.4v107.1z" />
      <path
        fill="#fff"
        d="M108.9 79.1h41.6c39.6 0 57 28.3 57 53.6 0 27.5-21.5 53.6-56.8 53.6h-41.8V79.1zm15.4 93.3h24.5c34.9 0 42.9-26.5 42.9-39.7 0-21.5-13.7-39.7-43.7-39.7h-23.7v79.4z"
      />
      <path fill="#fff" d="M88.7 56.8c0 5.5-4.5 10.1-10.1 10.1s-10.1-4.6-10.1-10.1 4.5-10.1 10.1-10.1 10.1 4.6 10.1 10.1z" />
    </svg>
  );
}

function errorMessage(code: string): string {
  switch (code) {
    case "invalid_orcid":
      return "That doesn't look like a valid ORCID iD — check the digits (the last one is a check digit).";
    case "not_self":
    case "proxy_conflict":
      return "You can't edit this scholar's ORCID iD.";
    default:
      return "Couldn't save the ORCID iD. Try again.";
  }
}

type Status = "suggested" | "on-file" | "confirmed" | "authenticated";

const PILL: Record<Status, { label: string; icon: typeof Check; className: string }> = {
  suggested: {
    label: "High confidence suggestion",
    icon: Sparkles,
    className: "bg-apollo-slate-tint border-apollo-slate-tint-border text-apollo-slate",
  },
  "on-file": {
    label: "On file",
    icon: Lock,
    className: "bg-apollo-lock-bg border-apollo-border-strong text-foreground",
  },
  confirmed: {
    label: "Confirmed",
    icon: Check,
    className: "bg-apollo-green-tint border-apollo-green-tint-border text-apollo-green-foreground",
  },
  authenticated: {
    label: "Authenticated",
    icon: Check,
    className: "bg-apollo-green-tint border-apollo-green-tint-border text-apollo-green-foreground",
  },
};

export function OrcidCard({
  cwid,
  mode,
  scholarName,
  onFile,
  onFileEvidence = [],
  suggested,
  authenticated = false,
  connectEnabled = false,
}: OrcidCardProps) {
  const router = useRouter();
  const subject = mode === "superuser" ? firstName(scholarName) : null;
  const whose = subject ? `${subject}'s` : "your";
  const [editing, setEditing] = React.useState(false);
  const [value, setValue] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // `undefined` = nothing saved this session; `null` = removed this session.
  const [saved, setSaved] = React.useState<string | null | undefined>(undefined);
  // The competing suggestion hides once a write dismissing it lands; the route
  // records the dismissal, so it stays gone on the next load too.
  const [dismissed, setDismissed] = React.useState(false);
  const [outcome, setOutcome] = React.useState<string | null>(null);
  React.useEffect(() => {
    const o = new URLSearchParams(window.location.search).get("orcid");
    if (o && o in CONNECT_OUTCOME) setOutcome(o);
  }, []);

  const save = async (
    orcid: string | null,
    confirmedSuggestion: boolean,
    dismiss: string[] = [],
  ) => {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/edit/orcid", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwid,
          orcid,
          confirmedSuggestion,
          ...(dismiss.length > 0 ? { dismiss } : {}),
        }),
      });
      const data = (await res.json()) as
        | { ok: true; orcid: string | null }
        | { ok: false; error: string };
      if (!res.ok || data.ok !== true) {
        setError(errorMessage("error" in data ? data.error : "unknown"));
        return;
      }
      setSaved(data.orcid);
      if (dismiss.length > 0) setDismissed(true);
      setEditing(false);
      setValue("");
      router.refresh();
    } catch {
      setError(errorMessage("unknown"));
    } finally {
      setBusy(false);
    }
  };

  const submitTyped = (e: React.FormEvent) => {
    e.preventDefault();
    const normalized = normalizeOrcid(value);
    if (!normalized) {
      setError(errorMessage("invalid_orcid"));
      return;
    }
    void save(normalized, false);
  };

  const current = saved === undefined ? onFile : saved;
  // Evidence rides the server-rendered props; after a same-session confirm the
  // suggestion's evidence IS the on-file evidence until `router.refresh()` lands.
  const currentEvidence =
    saved !== undefined && saved === suggested?.orcid
      ? (suggested.evidence ?? [])
      : current === onFile
        ? onFileEvidence
        : [];
  // The inference still on offer (session dismissals hide it), and the one that
  // disagrees with what is on file.
  const offer = suggested && !dismissed ? suggested : null;
  const competing = offer && offer.orcid !== current ? offer : null;
  const status: Status =
    saved !== undefined ? "confirmed" : authenticated ? "authenticated" : "on-file";

  /** The boxed iD row: the linked iD, its evidence lines, a status pill. */
  const idRow = (
    id: string,
    evidence: OrcidEvidence[],
    rowStatus: Status,
    testId: string,
    lead?: string,
  ) => {
    const pill = PILL[rowStatus];
    return (
      <div
        className="bg-apollo-surface-2 border-apollo-border-strong flex flex-wrap items-start gap-4 rounded-lg border px-4 py-3.5"
        data-testid={testId}
      >
        <div className="min-w-0 flex-1">
          <a
            href={`${ORCID_URL_PREFIX}${id}`}
            target="_blank"
            rel="noreferrer"
            className="text-apollo-slate hover:text-apollo-maroon decoration-apollo-slate/40 hover:decoration-apollo-maroon inline-flex items-center gap-1.5 font-mono text-lg font-[600] tracking-[0.01em] underline underline-offset-4"
          >
            {id}
            <ArrowUpRight className="size-3.5 shrink-0" aria-hidden />
          </a>
          {(lead || evidence.length > 0) && (
            <ul className="text-muted-foreground mt-1 text-xs" data-testid={`${testId}-evidence`}>
              {lead && <li>{lead}</li>}
              {evidence.map((e) => (
                <li key={e.source}>{orcidEvidenceLine(e, subject)}</li>
              ))}
            </ul>
          )}
        </div>
        <span
          className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold tracking-wide uppercase ${pill.className}`}
          data-testid={`${testId}-status`}
        >
          <pill.icon className="size-3" aria-hidden />
          {pill.label}
        </span>
      </div>
    );
  };

  const form = (
    <form
      onSubmit={submitTyped}
      className="flex flex-wrap items-center gap-2"
      data-testid="orcid-form"
    >
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="0000-0000-0000-0000"
        aria-label="ORCID iD"
        className="w-56 font-mono"
        disabled={busy}
      />
      <Button
        type="submit"
        variant="apollo"
        size="sm"
        disabled={busy || value.trim().length === 0}
        data-testid="orcid-save"
      >
        Save
      </Button>
      {(current || offer) && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => setEditing(false)}
          disabled={busy}
        >
          Cancel
        </Button>
      )}
    </form>
  );

  const connect = (
    <div className="flex flex-col gap-2" data-testid="orcid-connect-block">
      {/* A full navigation, not <Link>: a prefetch would start the OAuth flow. */}
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
      <a
        href="/api/edit/orcid/connect"
        className="border-apollo-border-strong hover:bg-apollo-surface-2 inline-flex w-fit items-center gap-2 rounded-md border bg-white px-3 py-1.5 text-sm font-semibold text-foreground"
        data-testid="orcid-connect"
      >
        <OrcidIdIcon />
        {current ? "Connect a different ORCID iD" : "Connect your ORCID iD"}
      </a>
      <p className="text-muted-foreground text-xs">
        You’ll sign in at ORCID to prove the iD is yours. Weill Cornell records your iD and
        the name on it to match your publications and fill NIH biosketches. We never change
        your ORCID record.
      </p>
    </div>
  );

  return (
    <EditPanel
      heading="ORCID iD"
      headerAction={<OwnedBadge />}
      slot="orcid-card"
      description={`Needed for NIH SciENcv biosketches; also makes ${whose} publication matching more reliable.`}
    >
      {current &&
        idRow(
          current,
          currentEvidence,
          status,
          "orcid-on-file",
          status === "confirmed"
            ? "Confirmed by you"
            : status === "authenticated"
              ? "You signed in to ORCID to confirm this iD"
              : undefined,
        )}
      {current &&
        competing &&
        !editing &&
        idRow(competing.orcid, competing.evidence ?? [], "suggested", "orcid-also-suggested")}
      {!current &&
        offer &&
        !editing &&
        idRow(offer.orcid, offer.evidence ?? [], "suggested", "orcid-suggested")}
      {/* The actions for whichever rows are showing, or the input. */}
      <div className="flex flex-wrap items-center gap-2">
        {current && !editing && competing && (
          <>
            <Button
              type="button"
              variant="apollo"
              size="sm"
              onClick={() => void save(competing.orcid, true)}
              disabled={busy}
              data-testid="orcid-use-suggested"
            >
              Replace with the suggested iD
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void save(current, false, [competing.orcid])}
              disabled={busy}
              data-testid="orcid-keep-on-file"
            >
              Keep the iD on file
            </Button>
            <span className="flex-1" />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void save(null, false, [competing.orcid])}
              disabled={busy}
              data-testid="orcid-remove"
            >
              Remove both
            </Button>
          </>
        )}
        {current && !editing && !competing && (
          <>
            {!connectEnabled && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setEditing(true)}
                data-testid="orcid-change"
              >
                Change
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => void save(null, false)}
              disabled={busy}
              data-testid="orcid-remove"
            >
              Remove
            </Button>
          </>
        )}
        {!current && offer && !editing && (
          <>
            <Button
              type="button"
              variant="apollo"
              size="sm"
              onClick={() => void save(offer.orcid, true)}
              disabled={busy}
              data-testid="orcid-confirm"
            >
              Confirm this iD
            </Button>
            {!connectEnabled && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setEditing(true)}
                disabled={busy}
                data-testid="orcid-enter-other"
              >
                Enter a different iD
              </Button>
            )}
          </>
        )}
        {/* ORCID's rule: with sign-in available, the scholar never types an iD. */}
        {!connectEnabled && (editing || (!current && !offer)) && form}
      </div>
      {connectEnabled && !(authenticated && saved === undefined) && connect}
      {outcome && (
        <p
          role={CONNECT_OUTCOME[outcome].error ? "alert" : "status"}
          className={`text-sm ${CONNECT_OUTCOME[outcome].error ? "text-destructive" : "text-muted-foreground"}`}
          data-testid="orcid-connect-outcome"
        >
          {CONNECT_OUTCOME[outcome].text}
        </p>
      )}
      {error && (
        <p role="alert" className="text-destructive text-sm" data-testid="orcid-error">
          {error}
        </p>
      )}
    </EditPanel>
  );
}
