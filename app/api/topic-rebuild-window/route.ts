import { NextResponse } from "next/server";
import { isTopicRebuildWindowOpen } from "@/lib/etl-state";

/**
 * Reports whether the reciter → dynamodb topic-rebuild window is open
 * (#118 / B19). The profile Topics section fetches this client-side, because
 * the 30-minute window cannot be baked into the 24h-ISR profile page.
 *
 * The window is global (not per-scholar) and moves on a 30-minute scale, so
 * the response is shared-cached for 60s — roughly one DB read per minute
 * site-wide, with at most ~60s of lag at the window edges.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const open = await isTopicRebuildWindowOpen();
  return NextResponse.json(
    { open },
    {
      headers: {
        "Cache-Control": "public, s-maxage=60, stale-while-revalidate=30",
      },
    },
  );
}
