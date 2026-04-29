"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronUp } from "lucide-react";

export type PastAppointment = {
  title: string;
  organization: string;
  startDate: string | null;
  endDate: string | null;
};

export function PastAppointmentsExpander({ items }: { items: PastAppointment[] }) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;

  return (
    <div className="mt-4">
      <Button variant="ghost" size="sm" onClick={() => setOpen(!open)} className="-ml-3">
        {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        {open ? "Hide past appointments" : `Show past appointments (${items.length})`}
      </Button>
      {open ? (
        <ul className="mt-2 flex flex-col gap-3 border-l-2 border-zinc-200 pl-4 dark:border-zinc-700">
          {items.map((a, i) => (
            <li key={i} className="text-sm">
              <div className="font-medium">{a.title}</div>
              <div className="text-muted-foreground">{a.organization}</div>
              <div className="text-muted-foreground text-xs">
                {formatRange(a.startDate, a.endDate)}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function formatRange(start: string | null, end: string | null): string {
  const s = start ? start.slice(0, 4) : "";
  const e = end ? end.slice(0, 4) : "Present";
  if (!s) return e;
  return `${s} – ${e}`;
}
