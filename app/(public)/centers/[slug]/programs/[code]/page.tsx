import type { Metadata } from "next";
import { CenterProgramPage } from "@/components/center-program/program-page";
import { getCenterProgram } from "@/lib/api/centers";
import { isCenterProgramPagesEnabled } from "@/lib/profile/methods-lens-flags";

export const revalidate = 21600;
export const dynamicParams = true;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string; code: string }>;
}): Promise<Metadata> {
  const { slug, code } = await params;
  if (!isCenterProgramPagesEnabled()) return { title: "Program not found" };
  const detail = await getCenterProgram(slug, code).catch(() => null);
  if (!detail) return { title: "Program not found" };
  return {
    title: `${detail.program.label} — ${detail.center.name} — Scholars at WCM`,
    description:
      detail.program.description ??
      `Scholars in the ${detail.program.label} program of ${detail.center.name} at Weill Cornell Medicine.`,
    alternates: {
      canonical: `/centers/${slug}/programs/${code}`,
    },
  };
}

export default async function CenterProgramRoute({
  params,
}: {
  params: Promise<{ slug: string; code: string }>;
}) {
  const { slug, code } = await params;
  return <CenterProgramPage centerSlug={slug} code={code} />;
}
