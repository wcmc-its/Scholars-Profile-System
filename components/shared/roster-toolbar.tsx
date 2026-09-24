"use client";

import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ROSTER_SORT_OPTIONS, isRosterSort, type RosterSort } from "@/lib/roster-sort";

/**
 * Unit Page v2 roster toolbar — "Filter by name or title" + the sort menu,
 * one row above the Appointment pills on the department, division and center
 * rosters (flat and grouped). Purely presentational: the parent owns the query
 * and sort state and decides whether they filter server-side (paginated
 * rosters) or in the browser (the single-page grouped center roster).
 */
export function RosterToolbar({
  query,
  onQueryChange,
  sort,
  onSortChange,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  sort: RosterSort;
  onSortChange: (value: RosterSort) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="relative min-w-0 max-w-[320px] flex-[1_1_240px]">
        <Search
          aria-hidden="true"
          size={14}
          strokeWidth={2}
          className="pointer-events-none absolute top-1/2 left-2.5 z-[1] -translate-y-1/2 text-muted-foreground"
        />
        <Input
          type="search"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Filter by name or title"
          aria-label="Filter scholars by name or title"
          className="h-9 border-muted-foreground pl-8 text-base md:text-[13px]"
        />
      </div>
      <Select
        value={sort}
        onValueChange={(v) => {
          if (isRosterSort(v)) onSortChange(v);
        }}
      >
        <SelectTrigger
          aria-label="Sort"
          className="h-9 w-44 whitespace-nowrap border-muted-foreground text-[13px]"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ROSTER_SORT_OPTIONS.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
