import { cache } from "react";
import { getMentorMenteePair } from "@/lib/api/mentoring";
import { resolveMentor } from "../resolve-mentor";

/**
 * #2963 — the (mentor, mentee) pair behind /scholars/[slug]/co-pubs/[menteeCwid].
 * Shared by the segment layout (the existence gate that runs outside the
 * loading.tsx Suspense boundary), `generateMetadata` and the page; React
 * `cache()` keeps it to one lookup per request/regeneration. Null when the
 * mentor doesn't resolve (or is role-carved) or the pair isn't recorded.
 */
export const resolvePair = cache(async (slug: string, menteeCwid: string) => {
  const mentor = await resolveMentor(slug);
  if (!mentor) return null;
  const pair = await getMentorMenteePair(mentor.cwid, menteeCwid);
  return pair ? { mentor, pair } : null;
});
