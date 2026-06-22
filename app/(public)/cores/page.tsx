import { notFound } from "next/navigation";
import type { Metadata } from "next";

import { CoresIndex } from "@/components/cores/cores-index";
import { getCoreList } from "@/lib/api/cores";
import { isCorePagesEnabled } from "@/lib/profile/cores-flags";

// force-dynamic: gated by the per-request `CORE_PAGES` flag (same posture as the
// per-core page), so it must never be statically cached. Off ⇒ `notFound()`.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  if (!isCorePagesEnabled()) return { title: "Core facilities not found" };
  return {
    title: "Core facilities — Weill Cornell Medicine",
    description:
      "Weill Cornell Medicine core facilities and the publications that used them.",
    alternates: { canonical: "/cores" },
  };
}

export default async function CoresIndexRoute() {
  if (!isCorePagesEnabled()) notFound();
  // Only cores with confirmed publications — empty cores (no staff feed yet) are
  // not advertised on the public index.
  const cores = (await getCoreList()).filter((c) => c.hasConfirmedPublications);
  return <CoresIndex cores={cores} />;
}
