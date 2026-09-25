"use client";

/**
 * Report 8's "CWID list" rail section (reports redesign): paste CWIDs with any
 * separator, see how many were read (and which entries are not CWIDs, which
 * are skipped), then "Apply" stores the list (`POST
 * /api/edit/reports/article-count/cwid-list`) and submits the form with
 * `list=<id>` — a long list does not fit in a URL, the id does. Once applied,
 * the section shows how many CWIDs matched an active scholar and lists the
 * ones that did not; "Replace list" pastes a new one, "Remove list" drops the
 * filter. The applied id rides a hidden `list` input, so every other filter
 * change keeps it.
 *
 * The textarea's `change` stops here (the body's `AutoSubmitForm` submits on
 * every bubbling change); the submit runs in the effect AFTER React wrote the
 * new hidden value. Parsing is `parseCwidText` (`lib/cwid-list-text.ts`), the
 * route's own rule. Nothing here reaches `@/lib/db`.
 */
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { CWID_LIST_MAX, parseCwidText } from "@/lib/cwid-list-text";

export type AppliedCwidList = { id: string; found: boolean; count: number; unmatched: string[] };

const API = "/api/edit/reports/article-count/cwid-list";

export function CwidListField({ applied }: { applied: AppliedCwidList | null }) {
  const [listId, setListId] = useState(applied?.id ?? "");
  const [editing, setEditing] = useState(applied === null);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pending.current) return;
    pending.current = false;
    root.current?.closest("form")?.requestSubmit();
  }, [listId]);

  const parsed = parseCwidText(text);
  const tooMany = parsed.cwids.length > CWID_LIST_MAX;

  const submitWith = (id: string) => {
    pending.current = true;
    setListId(id);
  };

  const apply = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(API, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: parsed.cwids.join(" ") }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; id?: string; error?: string };
      if (!res.ok || !body.ok || !body.id) {
        setError(
          res.status === 413
            ? "The list is too long to send. Split it into smaller lists."
            : "The list could not be saved. Try again.",
        );
        return;
      }
      if (body.id === listId) return;
      submitWith(body.id);
    } catch {
      setError("The list could not be saved. Try again.");
    } finally {
      setSaving(false);
    }
  };

  const matched = applied ? applied.count - applied.unmatched.length : 0;

  return (
    <div ref={root} className="flex flex-col gap-2.5 text-sm" data-testid="cwid-list-field">
      {listId && <input type="hidden" name="list" value={listId} />}

      {applied && !editing && (
        <>
          {applied.found ? (
            <p data-testid="cwid-list-counts">
              {applied.count.toLocaleString()} CWID{applied.count === 1 ? "" : "s"} ·{" "}
              {matched.toLocaleString()} matched
              {applied.unmatched.length > 0 && ` · ${applied.unmatched.length.toLocaleString()} not found`}
            </p>
          ) : (
            <p className="text-apollo-amber" data-testid="cwid-list-counts">
              This list was not found, so no one matches. Remove it or paste a new one.
            </p>
          )}
          {applied.unmatched.length > 0 && (
            <details className="text-muted-foreground text-[13px]">
              <summary className="cursor-pointer">
                Not found among active scholars ({applied.unmatched.length.toLocaleString()})
              </summary>
              <p className="mt-1 max-h-32 overflow-y-auto font-mono text-xs break-words" data-testid="cwid-list-unmatched">
                {applied.unmatched.join(", ")}
              </p>
            </details>
          )}
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="xs" onClick={() => setEditing(true)}>
              Replace list
            </Button>
            <Button type="button" variant="ghost" size="xs" onClick={() => submitWith("")}>
              Remove list
            </Button>
          </div>
        </>
      )}

      {editing && (
        <>
          <Textarea
            value={text}
            onChange={(e) => {
              e.stopPropagation();
              setText(e.target.value);
              setError(null);
            }}
            rows={4}
            placeholder="Paste CWIDs, separated by commas, spaces or new lines"
            aria-label="CWIDs"
            className="bg-apollo-surface border-apollo-border-strong max-h-48 text-sm md:text-sm"
          />
          {text.trim() && (
            <p className="text-muted-foreground text-[13px]" data-testid="cwid-list-parsed">
              {parsed.cwids.length.toLocaleString()} CWID{parsed.cwids.length === 1 ? "" : "s"}
              {parsed.invalid.length > 0 &&
                ` · ${parsed.invalid.length.toLocaleString()} skipped (not CWIDs): ${parsed.invalid.slice(0, 10).join(", ")}${parsed.invalid.length > 10 ? ", …" : ""}`}
            </p>
          )}
          {tooMany && (
            <p className="text-apollo-amber text-[13px]">
              A list can hold up to {CWID_LIST_MAX.toLocaleString()} CWIDs.
            </p>
          )}
          {error && (
            <p className="text-destructive text-[13px]" role="alert">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={saving || parsed.cwids.length === 0 || tooMany}
              onClick={apply}
            >
              {saving ? "Applying…" : "Apply list"}
            </Button>
            {applied && (
              <Button type="button" variant="ghost" size="xs" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            )}
          </div>
          <p className="text-muted-foreground text-xs">
            The list is saved so the link can be shared. Only people on the list who also match the other filters
            count.
          </p>
        </>
      )}
    </div>
  );
}
