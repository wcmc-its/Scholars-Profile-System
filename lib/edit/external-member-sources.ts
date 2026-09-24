/**
 * Membership `source` values whose `cwid` column holds an `ExternalMember.cuid`
 * rather than a WCM CWID — a person with no `Scholar` row, rendered as a plain
 * (or externally linked) name. Client-safe: no db import.
 *
 * - `cornell-ithaca` (#2519): Cornell NetID, gated by CORNELL_DIRECTORY_MEMBERS.
 * - `ctsc-feed-external`: a CTSC feed person with no SPS profile, keyed
 *   `ctsc:<feed PrimaryKey>` by `etl/ctsc-roster`. Always on — the ETL step is
 *   the switch (no rows until it runs).
 *
 * A CTSC person who DOES resolve to a profiled scholar is an ordinary
 * `ctsc-feed` row keyed by CWID and goes down the Scholar path, so it is
 * deliberately NOT in this list.
 */
import { isCornellDirectoryMembersEnabled } from "@/lib/edit/cornell-directory-flag";

export const CORNELL_EXTERNAL_SOURCE = "cornell-ithaca";
export const CTSC_EXTERNAL_SOURCE = "ctsc-feed-external";

export function enabledExternalMemberSources(): string[] {
  return isCornellDirectoryMembersEnabled()
    ? [CTSC_EXTERNAL_SOURCE, CORNELL_EXTERNAL_SOURCE]
    : [CTSC_EXTERNAL_SOURCE];
}

/** Short label for the /edit roster pill. */
export function externalSourceLabel(source: string): string {
  return source === CTSC_EXTERNAL_SOURCE ? "CTSC feed" : "Cornell University";
}
