"use client";

import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

/**
 * Generic "Show all" expander used by Publications and Grants sections.
 *
 * RSC-safe: the server pre-renders both `defaultItems` and `rest` as ReactNode
 * arrays; this client component only owns the toggle state. We can't accept a
 * `renderItem` function prop because functions don't serialize across the
 * server/client boundary.
 */
export function ShowMoreList({
  defaultItems,
  rest,
  showAllLabel = "Show all",
  showLessLabel = "Show fewer",
}: {
  defaultItems: ReactNode[];
  rest: ReactNode[];
  showAllLabel?: string;
  showLessLabel?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const totalCount = defaultItems.length + rest.length;
  const hasMore = rest.length > 0;

  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col gap-4">
        {defaultItems.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
        {expanded
          ? rest.map((item, i) => <li key={`rest-${i}`}>{item}</li>)
          : null}
      </ul>
      {hasMore ? (
        <div>
          <Button variant="outline" size="sm" onClick={() => setExpanded(!expanded)}>
            {expanded ? showLessLabel : `${showAllLabel} (${totalCount})`}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
