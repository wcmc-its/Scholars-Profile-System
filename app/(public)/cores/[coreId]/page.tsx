import { cache } from "react";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getCorePage } from "@/lib/api/cores";
import { isCorePagesEnabled } from "@/lib/profile/cores-flags";
import { corePath } from "@/lib/core-url";
import { CorePage } from "@/components/cores/core-page";

// force-dynamic: the page is gated by the per-request `CORE_PAGES` flag, so it
// must never be statically cached — exactly the posture the flag-gated Method
// pages use (#985). When the flag is off the route `notFound()`s.
export const dynamic = "force-dynamic";

// #1514 — dedupe the loader across generateMetadata + the page body within a
// single request. force-dynamic runs both every request, so without React
// `cache()` the getCorePage query executed twice per page view.
const loadCorePage = cache((coreId: string) => getCorePage(coreId));

export async function generateMetadata({
  params,
}: {
  params: Promise<{ coreId: string }>;
}): Promise<Metadata> {
  if (!isCorePagesEnabled()) return { title: "Core facility not found" };
  const { coreId } = await params;
  const data = await loadCorePage(coreId).catch(() => null);
  if (!data) return { title: "Core facility not found" };
  return {
    title: `${data.core.name} — Core Facility at WCM`,
    description: `Publications that used ${
      data.core.facility ?? data.core.name
    }, a Weill Cornell Medicine core facility.`,
    alternates: { canonical: corePath(coreId) },
  };
}

export default async function CoreRoute({
  params,
}: {
  params: Promise<{ coreId: string }>;
}) {
  if (!isCorePagesEnabled()) notFound();
  const { coreId } = await params;
  const data = await loadCorePage(coreId);
  if (!data) notFound();
  return <CorePage data={data} />;
}
