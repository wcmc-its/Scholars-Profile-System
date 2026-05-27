/**
 * The superuser Profile-URL approval queue list (#497 PR-3c, U3,
 * `slug-personalization-ui-spec.md` § 3). The client island inside
 * `/edit/slug-requests`: it owns the visible row set so a decided request
 * (approved or declined) drops out immediately, and calls `router.refresh()`
 * to reconcile the server view (pending-count pill, any newly-filed requests).
 *
 * The row interactivity lives in `slug-request-row.tsx`; this component is the
 * list + empty state.
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { SlugRequestRow } from "@/components/edit/slug-request-row";
import type { SlugRequestQueueRow } from "@/lib/edit/slug-request";

export function SlugRequestQueue({
  initialRequests,
}: {
  initialRequests: SlugRequestQueueRow[];
}) {
  const router = useRouter();
  const [rows, setRows] = React.useState<SlugRequestQueueRow[]>(initialRequests);

  function handleDecided(id: string) {
    setRows((rs) => rs.filter((r) => r.id !== id));
    router.refresh();
  }

  if (rows.length === 0) {
    return (
      <div
        className="border-border text-muted-foreground rounded-md border border-dashed px-4 py-12 text-center text-sm"
        data-testid="slug-request-queue-empty"
      >
        No pending URL requests.
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-3" data-testid="slug-request-queue">
      {rows.map((r) => (
        <li key={r.id}>
          <SlugRequestRow request={r} onDecided={handleDecided} />
        </li>
      ))}
    </ul>
  );
}
