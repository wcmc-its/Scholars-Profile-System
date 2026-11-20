/**
 * ORCID queue client calls shared by the page and its Bulk review: the error
 * copy for each refusal code, and a POST helper for the per-item routes
 * (`undo`, `bulk-confirm`) that answer `{ results: [...] }`.
 */

export function errorMessage(status: number, code: string | undefined): string {
  if (code === "already_on_file") return "This iD is already on file for this scholar.";
  if (code === "on_file_differs")
    return "This scholar now has a different iD on file. Reload to see it as a possible error.";
  if (code === "on_file")
    return "This iD was confirmed by the scholar or a librarian. Remove it from the scholar's own editor.";
  if (code === "dismissed")
    return "This iD was removed by the scholar or marked Not this person, so it can't be confirmed here.";
  if (code === "state_changed")
    return "This scholar changed since the page loaded. Reload to see where they are now.";
  if (code === "held_by_other")
    return "Another scholar record already holds this iD. Remove it there first if it belongs here.";
  if (code === "on_linked_record")
    return "This person's record on the other campus already holds this iD, so it stays there.";
  if (code === "undo_expired")
    return "That decision is more than 15 minutes old. Change it from the scholar's own editor.";
  if (code === "not_bulk_eligible")
    return "This scholar no longer qualifies for bulk confirm. Review them one at a time.";
  if (code === "other_not_in_queue")
    return "One of this scholar's other iDs left the queue since the page loaded. Reload and try again.";
  if (status === 403) return "Only a superuser, signed in as themselves, can decide this queue.";
  return "We couldn't record that. Please try again.";
}

/** POST to an ORCID queue route that answers `{ results: [...] }` per item. */
export async function postBatch<R extends { ok: boolean; code?: string }>(
  path: string,
  body: Record<string, unknown>,
): Promise<{ ok: true; results: R[] } | { ok: false; message: string }> {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => null)) as { results?: R[]; error?: string } | null;
    if (res.ok && data?.results) return { ok: true, results: data.results };
    return { ok: false, message: errorMessage(res.status, data?.error) };
  } catch {
    return { ok: false, message: "We couldn't record that. Please try again." };
  }
}
