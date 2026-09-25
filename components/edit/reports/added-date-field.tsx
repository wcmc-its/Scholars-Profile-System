"use client";

/**
 * Report 8's date-added From / To (reports redesign). The body's
 * `AutoSubmitForm` submits on every bubbling `change`, and a date input fires
 * one for each keystroke that forms a valid date, so typing "2026-09-24"
 * would navigate mid-entry. Here the visible inputs are controlled and
 * unnamed, their `change` stops here, and the committed values ride hidden
 * `added_from` / `added_to` inputs. A commit happens on Enter, on the
 * explicit "Apply" button, or when focus leaves the whole field (moving From
 * → To → Apply does not commit), and only when a value changed. The submit
 * runs in the effect AFTER React wrote the new hidden values (like
 * `JifField`). The quick picks stay plain links in the body. Nothing here
 * reaches `@/lib/db`.
 */
import { useEffect, useRef, useState, type FocusEvent } from "react";

import { Button } from "@/components/ui/button";

type Range = { from: string; to: string };

const FIELD =
  "border-apollo-border-strong bg-apollo-surface h-[34px] w-full min-w-0 rounded-md border px-2 text-sm";

export function AddedDateField({ from, to, max }: Range & { max: string }) {
  const [committed, setCommitted] = useState<Range>({ from, to });
  const [draft, setDraft] = useState<Range>({ from, to });
  const [hydrated, setHydrated] = useState(false);
  const pending = useRef(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => setHydrated(true), []);

  useEffect(() => {
    if (!pending.current) return;
    pending.current = false;
    root.current?.closest("form")?.requestSubmit();
  }, [committed]);

  const commit = () => {
    if (draft.from === committed.from && draft.to === committed.to) return;
    pending.current = true;
    setCommitted(draft);
  };

  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    // Focus moving between From, To and Apply is still editing.
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
    commit();
  };

  const input = (key: keyof Range, label: string, extra: { max?: string }) => (
    <input
      type="date"
      // Before hydration (no JS) the visible inputs carry the names, so the
      // form's own Apply fallback still submits what was typed.
      name={hydrated ? undefined : `added_${key}`}
      value={draft[key]}
      {...extra}
      aria-label={label}
      onChange={(e) => {
        e.stopPropagation();
        const value = e.target.value;
        setDraft((d) => ({ ...d, [key]: value }));
      }}
      onKeyDown={(e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        commit();
      }}
      className={FIELD}
      data-testid={`added-${key}`}
    />
  );

  return (
    <div ref={root} onBlur={onBlur} className="flex flex-col gap-2" data-testid="added-date-field">
      {hydrated && (
        <>
          <input type="hidden" name="added_from" value={committed.from} />
          <input type="hidden" name="added_to" value={committed.to} />
        </>
      )}
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2">
        <span className="text-muted-foreground text-[13px]">From</span>
        {input("from", "Added to PubMed from", { max })}
        <span className="text-muted-foreground text-[13px]">To</span>
        {input("to", "Added to PubMed to", {})}
      </div>
      {hydrated && (
        <div>
          <Button type="button" variant="outline" size="xs" onClick={commit}>
            Apply dates
          </Button>
        </div>
      )}
    </div>
  );
}
