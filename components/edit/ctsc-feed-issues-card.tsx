"use client";

/**
 * "Feed CWID issues" — the CTSC center's to-do list for its own system. Each row
 * is a CTSC feed record whose CWID should be fixed at the source; the nightly
 * `etl/ctsc-roster` sync rebuilds the list, so a record CTSC corrects drops off
 * the next day. Rows carry the exact change to make.
 */
import { useMemo, useState } from "react";
import { EditPanel } from "@/components/edit/edit-panel";
import { Badge } from "@/components/ui/badge";

export type CtscFeedIssueRow = {
  primaryKey: number;
  name: string;
  institution: string | null;
  feedCwid: string | null;
  reason: string;
  suggestedCwid: string | null;
  suggestedName: string | null;
  matchedEmail: string | null;
};

const REASONS: Record<string, { label: string; fix: (r: CtscFeedIssueRow) => string }> = {
  "blank-resolved": {
    label: "Blank CWID, found via email",
    fix: (r) => `Set CWID to ${r.suggestedCwid} (currently blank). Matched via ${r.matchedEmail}.`,
  },
  "not-in-ed": {
    label: "CWID not in the directory",
    fix: (r) =>
      r.suggestedCwid
        ? `Change CWID ${r.feedCwid} to ${r.suggestedCwid}. Matched via ${r.matchedEmail}.`
        : `CWID ${r.feedCwid} doesn't exist. Look the person up and correct it, or clear it.`,
  },
  "retired-cwid": {
    label: "Retired CWID",
    fix: (r) =>
      r.suggestedCwid
        ? `Change retired CWID ${r.feedCwid} to ${r.suggestedCwid}. Matched via ${r.matchedEmail}.`
        : `CWID ${r.feedCwid} is retired. Look up the person's current CWID.`,
  },
  "cwid-email-conflict": {
    label: "CWID and email disagree",
    fix: (r) =>
      `CWID ${r.feedCwid} is a different person from ${r.matchedEmail} (${r.suggestedCwid}, ${r.suggestedName}). Check which is right.`,
  },
  "email-match-name-differs": {
    label: "Email matches, name differs",
    fix: (r) =>
      `${r.matchedEmail} belongs to ${r.suggestedName} (${r.suggestedCwid}). If that's this person, set the CWID; otherwise fix the email.`,
  },
  "email-ambiguous": {
    label: "Email matches several people",
    fix: () => "The emails on this record belong to more than one person. Set the CWID by hand.",
  },
  "duplicate-record": {
    label: "Duplicate record",
    fix: (r) => `Same person as another record (CWID ${r.feedCwid ?? r.suggestedCwid}). Merge or remove one.`,
  },
};

export function CtscFeedIssuesCard({ issues, syncedAt }: { issues: CtscFeedIssueRow[]; syncedAt: string | null }) {
  const [reason, setReason] = useState<string>("all");
  const counts = useMemo(() => {
    const c = new Map<string, number>();
    for (const i of issues) c.set(i.reason, (c.get(i.reason) ?? 0) + 1);
    return c;
  }, [issues]);
  const shown = reason === "all" ? issues : issues.filter((i) => i.reason === reason);

  return (
    <EditPanel
      slot="ctsc-feed-issues-card"
      heading="Feed CWID issues"
      description={
        "Records in the CTSC feed whose CWID should be corrected in CTSC's system. " +
        "The list is rebuilt every night, so a fixed record disappears after the next sync." +
        (syncedAt ? ` Last sync: ${syncedAt}.` : "")
      }
    >
      {issues.length === 0 ? (
        <p className="text-muted-foreground text-sm">No issues. Every feed record has a usable CWID.</p>
      ) : (
        <div className="flex flex-col gap-3">
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Show</span>
            <select
              className="border-border rounded-md border bg-transparent px-2 py-1 text-sm"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              data-testid="ctsc-feed-issues-reason"
            >
              <option value="all">All issues ({issues.length})</option>
              {Object.entries(REASONS)
                .filter(([k]) => counts.has(k))
                .map(([k, v]) => (
                  <option key={k} value={k}>
                    {v.label} ({counts.get(k)})
                  </option>
                ))}
            </select>
          </label>
          <ul className="divide-border flex flex-col divide-y">
            {shown.map((r) => (
              <li key={r.primaryKey} className="flex flex-col gap-1 py-3" data-testid={`ctsc-feed-issue-${r.primaryKey}`}>
                <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  <span>{r.name}</span>
                  <span className="text-muted-foreground font-normal">CTSC record #{r.primaryKey}</span>
                  <Badge variant="outline" className="rounded-full font-normal">
                    {REASONS[r.reason]?.label ?? r.reason}
                  </Badge>
                </div>
                {r.institution && <div className="text-muted-foreground text-xs">{r.institution}</div>}
                <div className="text-sm">{REASONS[r.reason]?.fix(r) ?? ""}</div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </EditPanel>
  );
}
