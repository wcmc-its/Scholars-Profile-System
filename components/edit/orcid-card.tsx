/**
 * The ORCID iD card on the Identifiers & Profiles tab. Three states, the same
 * three the home board's ORCID row shows, but with room to act:
 *
 *   on file    → the iD linked to orcid.org, WHY it is on file (the per-source
 *                evidence, which persists after confirming), Change, Remove. If
 *                the inferred rows point at a DIFFERENT iD, a second block says
 *                so ("We also found …") with "Use this iD instead".
 *   suggested  → the inferred iD with its per-source evidence, "Yes, this is
 *                mine" confirms it in one click, or enter a different one.
 *   none       → the input.
 *
 * Every write is `POST /api/edit/orcid`, which puts the iD in ReciterDB
 * `admin_orcid` (what ReCiter and the coverage dashboard read) and then on
 * `scholar.orcid`; Remove sends `orcid: null` and clears both. `router.refresh()`
 * reconciles the page. Off-campus friendly: this replaces the "Confirm in
 * ReCiter" hand-off, which only worked on the campus network.
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { EditPanel } from "@/components/edit/edit-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  normalizeOrcid,
  ORCID_URL_PREFIX,
  orcidEvidenceLine,
  type OrcidEvidence,
} from "@/lib/edit/orcid";

export type OrcidCardProps = {
  cwid: string;
  /** "self" → second person; "superuser" → third person with the scholar's name. */
  mode: "self" | "superuser";
  scholarName: string;
  onFile: string | null;
  onFileEvidence?: OrcidEvidence[];
  suggested: { orcid: string; accepted: number; evidence?: OrcidEvidence[] } | null;
};

const WHY = (whose: string) =>
  `Needed for NIH SciENcv biosketches; also makes ${whose} publication matching more reliable.`;

function errorMessage(code: string): string {
  switch (code) {
    case "invalid_orcid":
      return "That doesn't look like a valid ORCID iD — check the digits (the last one is a check digit).";
    case "reciter_unavailable":
      return "ReCiter is unreachable right now, so nothing was saved. Try again in a few minutes.";
    case "not_self":
    case "proxy_conflict":
      return "You can't edit this scholar's ORCID iD.";
    default:
      return "Couldn't save the ORCID iD. Try again.";
  }
}

export function OrcidCard({
  cwid,
  mode,
  scholarName,
  onFile,
  onFileEvidence = [],
  suggested,
}: OrcidCardProps) {
  const router = useRouter();
  const isAdmin = mode === "superuser";
  const whose = isAdmin ? "their" : "your";
  const [editing, setEditing] = React.useState(false);
  const [value, setValue] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // `undefined` = nothing saved this session; `null` = removed this session.
  const [saved, setSaved] = React.useState<string | null | undefined>(undefined);

  const save = async (orcid: string | null, confirmedSuggestion: boolean) => {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/edit/orcid", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwid, orcid, confirmedSuggestion }),
      });
      const data = (await res.json()) as
        | { ok: true; orcid: string | null }
        | { ok: false; error: string };
      if (!res.ok || data.ok !== true) {
        setError(errorMessage("error" in data ? data.error : "unknown"));
        return;
      }
      setSaved(data.orcid);
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
  const alsoSuggested = suggested && suggested.orcid !== current ? suggested : null;

  const link = (id: string) => (
    <a
      href={`${ORCID_URL_PREFIX}${id}`}
      target="_blank"
      rel="noreferrer"
      className="text-apollo-maroon font-medium underline underline-offset-4"
    >
      {id}
    </a>
  );
  const evidenceList = (rows: OrcidEvidence[], testId: string) =>
    rows.length > 0 ? (
      <ul className="text-muted-foreground list-disc pl-5 text-sm" data-testid={testId}>
        {rows.map((e) => (
          <li key={e.source}>{orcidEvidenceLine(e, whose)}</li>
        ))}
      </ul>
    ) : null;

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
      {(current || suggested) && (
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

  return (
    <EditPanel heading="ORCID iD" owned slot="orcid-card" description={WHY(whose)}>
      {current && (
        <div className="flex flex-col gap-2" data-testid="orcid-on-file">
          <div className="flex flex-wrap items-center gap-3">
            <span>{link(current)}</span>
            {!editing && (
              <>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setEditing(true)}
                  data-testid="orcid-change"
                >
                  Change
                </Button>
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
          </div>
          {evidenceList(currentEvidence, "orcid-on-file-evidence")}
        </div>
      )}
      {!current && suggested && !editing && (
        <div className="flex flex-col gap-3" data-testid="orcid-suggested">
          <div className="flex flex-col gap-2">
            <p className="text-[15px]">
              {isAdmin ? `Is this ${scholarName}'s ORCID iD?` : "Is this your ORCID iD?"}{" "}
              {link(suggested.orcid)}
            </p>
            {evidenceList(suggested.evidence ?? [], "orcid-suggested-evidence")}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="apollo"
              size="sm"
              onClick={() => void save(suggested.orcid, true)}
              disabled={busy}
              data-testid="orcid-confirm"
            >
              {isAdmin ? "Yes, this is their iD" : "Yes, this is mine"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setEditing(true)}
              disabled={busy}
              data-testid="orcid-enter-other"
            >
              Enter a different iD
            </Button>
          </div>
        </div>
      )}
      {current && alsoSuggested && !editing && (
        <div className="flex flex-col gap-3 border-t pt-3" data-testid="orcid-also-suggested">
          <div className="flex flex-col gap-2">
            <p className="text-[15px]">
              {isAdmin
                ? `We also found a different iD for ${scholarName}:`
                : "We also found a different iD:"}{" "}
              {link(alsoSuggested.orcid)}
            </p>
            {evidenceList(alsoSuggested.evidence ?? [], "orcid-also-suggested-evidence")}
          </div>
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void save(alsoSuggested.orcid, true)}
              disabled={busy}
              data-testid="orcid-use-suggested"
            >
              Use this iD instead
            </Button>
          </div>
        </div>
      )}
      {(editing || (!current && !suggested)) && form}
      {error && (
        <p role="alert" className="text-destructive text-sm" data-testid="orcid-error">
          {error}
        </p>
      )}
    </EditPanel>
  );
}
