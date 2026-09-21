/**
 * The ORCID iD card on the Identifiers & Profiles tab. Three states, the same
 * three the home board's ORCID row shows, but with room to act:
 *
 *   on file    → the iD linked to orcid.org, "Change" reveals the input.
 *   suggested  → the inferred iD with its evidence ("on N of your accepted
 *                publications"), "Yes, this is mine" confirms it in one click,
 *                or enter a different one.
 *   none       → the input.
 *
 * Every write is `POST /api/edit/orcid`, which puts the iD in ReciterDB
 * `admin_orcid` (what ReCiter and the coverage dashboard read) and then on
 * `scholar.orcid`; `router.refresh()` reconciles the page. Off-campus friendly:
 * this replaces the "Confirm in ReCiter" hand-off, which only worked on the
 * campus network.
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { EditPanel } from "@/components/edit/edit-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { normalizeOrcid, ORCID_URL_PREFIX } from "@/lib/edit/orcid";

export type OrcidCardProps = {
  cwid: string;
  /** "self" → second person; "superuser" → third person with the scholar's name. */
  mode: "self" | "superuser";
  scholarName: string;
  onFile: string | null;
  suggested: { orcid: string; accepted: number } | null;
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

export function OrcidCard({ cwid, mode, scholarName, onFile, suggested }: OrcidCardProps) {
  const router = useRouter();
  const isAdmin = mode === "superuser";
  const whose = isAdmin ? "their" : "your";
  const [editing, setEditing] = React.useState(false);
  const [value, setValue] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState<string | null>(null);

  const save = async (orcid: string, confirmedSuggestion: boolean) => {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/edit/orcid", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwid, orcid, confirmedSuggestion }),
      });
      const data = (await res.json()) as { ok: true; orcid: string } | { ok: false; error: string };
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

  const current = saved ?? onFile;
  const link = (id: string) => (
    <a href={`${ORCID_URL_PREFIX}${id}`} target="_blank" rel="noreferrer" className="font-medium hover:underline">
      {id}
    </a>
  );
  const form = (
    <form onSubmit={submitTyped} className="flex flex-wrap items-center gap-2" data-testid="orcid-form">
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="0000-0000-0000-0000"
        aria-label="ORCID iD"
        className="w-56 font-mono"
        disabled={busy}
      />
      <Button type="submit" size="sm" disabled={busy || value.trim().length === 0} data-testid="orcid-save">
        Save
      </Button>
      {(current || suggested) && (
        <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={busy}>
          Cancel
        </Button>
      )}
    </form>
  );

  return (
    <EditPanel heading="ORCID iD" owned slot="orcid-card" description={WHY(whose)}>
      {current && (
        <div className="flex flex-wrap items-center gap-3" data-testid="orcid-on-file">
          <span>{link(current)}</span>
          {!editing && (
            <Button type="button" size="sm" variant="outline" onClick={() => setEditing(true)} data-testid="orcid-change">
              Change
            </Button>
          )}
        </div>
      )}
      {!current && suggested && !editing && (
        <div className="flex flex-col gap-3" data-testid="orcid-suggested">
          <p className="text-[15px]">
            {isAdmin ? `Is this ${scholarName}'s ORCID iD?` : "Is this your ORCID iD?"}{" "}
            {link(suggested.orcid)}
            <span className="text-muted-foreground block text-sm">
              {suggested.accepted > 0
                ? `On ${suggested.accepted} of ${whose} accepted publications.`
                : `Matches ${whose} record in the ORCID registry.`}
            </span>
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" onClick={() => void save(suggested.orcid, true)} disabled={busy} data-testid="orcid-confirm">
              {isAdmin ? "Yes, this is their iD" : "Yes, this is mine"}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(true)} disabled={busy} data-testid="orcid-enter-other">
              Enter a different iD
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
