"use client";

import { FundingResultRow } from "@/components/search/funding-result-row";
import type { FundingFilters, FundingHit } from "@/lib/api/search-funding";
import { useNihApplIdMap } from "@/lib/use-nih-resolve";

/**
 * Client wrapper around the funding result rows. Runs a single batched
 * `/api/nih-resolve` request covering every NIH award visible on the
 * current page so each row's serial in the right column can link out to
 * NIH RePORTER. Mirrors the profile Grants section's NIH-link behavior.
 */
export function FundingResultsList({
  hits,
  q,
  page,
  pageSize,
  total,
  filters,
}: {
  hits: FundingHit[];
  q: string;
  page: number;
  pageSize: number;
  total: number;
  filters: FundingFilters;
}) {
  const applIdByAward = useNihApplIdMap(hits.map((h) => h.awardNumber));

  return (
    <ul>
      {hits.map((hit, i) => (
        <li key={hit.projectId}>
          <FundingResultRow
            hit={hit}
            q={q}
            position={page * pageSize + i}
            total={total}
            filters={filters}
            applId={hit.awardNumber ? applIdByAward[hit.awardNumber] : undefined}
          />
        </li>
      ))}
    </ul>
  );
}
