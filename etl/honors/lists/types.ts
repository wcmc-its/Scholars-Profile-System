import type { Fetcher } from "./html";
import type { RosterEntry } from "./match";

/** What one list scrape read. */
export type RosterScrape = {
  entries: RosterEntry[];
  /** False when part of the roster could not be read (a page failed mid-walk).
   *  The run is then recorded `partial`, and its counts are a floor. */
  complete: boolean;
  /** Why it is incomplete, for the Sources tab. */
  warning: string | null;
};

export type ListScraper = (fetcher: Fetcher) => Promise<RosterScrape>;
