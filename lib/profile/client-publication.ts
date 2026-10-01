import type { ProfilePublication } from "@/lib/api/profile";

/** #2213 — the publication shape handed to the profile's client components
 *  (`ProfilePubsCluster` / `PublicationsSection`). The full list is serialized
 *  into the RSC payload, so fields only the server reads (ranking inputs and
 *  the score itself) are dropped. Typing the client props with this keeps a
 *  future client-side read of a dropped field a compile error. */
export type ProfileClientPublication = Omit<
  ProfilePublication,
  "dateAddedToEntrez" | "reciteraiImpact" | "isConfirmed" | "score"
>;

export function toClientPublication(p: ProfilePublication): ProfileClientPublication {
  const { dateAddedToEntrez: _d, reciteraiImpact: _r, isConfirmed: _c, score: _s, ...rest } = p;
  return rest;
}
