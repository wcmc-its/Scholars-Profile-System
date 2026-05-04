"use client";

import Link from "next/link";
import { HeadshotAvatar } from "@/components/scholar/headshot-avatar";
import { Badge } from "@/components/ui/badge";
import type { PeopleHit } from "@/lib/api/search";

/**
 * Phase 6 / ANALYTICS-02 (D-04, D-06) — people search result row with
 * onClick `navigator.sendBeacon` CTR telemetry. Fire-and-forget; navigation
 * is not blocked by the beacon.
 *
 * The Blob wrapper around JSON.stringify(payload) is REQUIRED — without
 * it, sendBeacon sets Content-Type: text/plain and the route handler's
 * request.json() throws (RESEARCH.md Pitfall 1).
 */
export type PeopleResultCardProps = {
  hit: PeopleHit;
  /** Zero-based position within the current page of results. */
  position: number;
  q: string;
  total: number;
  filters: {
    department?: string;
    personType?: string;
    hasActiveGrants?: boolean;
  };
};

export function PeopleResultCard({
  hit,
  position,
  q,
  total,
  filters,
}: PeopleResultCardProps) {
  function handleClick() {
    if (typeof navigator === "undefined" || !navigator.sendBeacon) return;
    const payload = {
      event: "search_click",
      q,
      position,
      cwid: hit.cwid,
      resultType: "people",
      resultCount: total,
      filters,
      ts: Date.now(),
    };
    navigator.sendBeacon(
      "/api/analytics",
      new Blob([JSON.stringify(payload)], { type: "application/json" }),
    );
  }

  return (
    <Link
      href={`/scholars/${hit.slug}`}
      onClick={handleClick}
      className="flex gap-4 py-4 hover:bg-zinc-50 dark:hover:bg-zinc-900/50"
    >
      <HeadshotAvatar
        size="md"
        cwid={hit.cwid}
        preferredName={hit.preferredName}
        identityImageEndpoint={hit.identityImageEndpoint}
      />
      <div className="flex flex-col gap-0.5">
        <div className="font-medium">{hit.preferredName}</div>
        {hit.primaryTitle ? (
          <div className="text-sm text-zinc-700 dark:text-zinc-300">
            {hit.primaryTitle}
          </div>
        ) : null}
        {hit.primaryDepartment ? (
          <div className="text-muted-foreground text-xs">
            {hit.primaryDepartment}
          </div>
        ) : null}
        {hit.highlight && hit.highlight.length > 0 ? (
          <div
            className="text-muted-foreground mt-1 text-xs"
            dangerouslySetInnerHTML={{ __html: hit.highlight[0] }}
          />
        ) : null}
      </div>
      {hit.hasActiveGrants ? (
        <Badge variant="secondary" className="ml-auto self-start">
          Active grants
        </Badge>
      ) : null}
    </Link>
  );
}
