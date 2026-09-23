/** `/edit/scholars` moved to `/edit/profiles`; keep old links and bookmarks working. */
import { permanentRedirect } from "next/navigation";

export default async function LegacyScholarsRoster({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries((await searchParams) ?? {})) {
    for (const one of Array.isArray(v) ? v : v === undefined ? [] : [v]) p.append(k, one);
  }
  const qs = p.toString();
  permanentRedirect(qs ? `/edit/profiles?${qs}` : "/edit/profiles");
}
