import type { MetadataRoute } from "next";
import { prisma } from "@/lib/db";

// ISR — falls back to 24h revalidation if no on-demand revalidate fires.
// ETL orchestrator calls /api/revalidate?path=/sitemap.xml after each successful run.
export const revalidate = 86400;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const BASE =
    process.env.NEXT_PUBLIC_SITE_URL ?? "https://scholars.weill.cornell.edu";

  // Pre-render dynamic entries at build when the DB is reachable. In build
  // environments without a DB (CI on a fresh checkout), gracefully fall back
  // to the static entries — ISR will populate the full sitemap on first hit
  // in production. Mirrors the pattern in app/(public)/scholars/[slug]/page.tsx.
  let scholars: Array<{ slug: string; updatedAt: Date | null }> = [];
  let topics: Array<{ id: string; refreshedAt: Date | null }> = [];
  let departments: Array<{ slug: string; updatedAt: Date | null }> = [];
  let centers: Array<{ slug: string; updatedAt: Date | null }> = [];
  try {
    [scholars, topics, departments, centers] = await Promise.all([
      prisma.scholar.findMany({
        where: { deletedAt: null, status: "active" },
        select: { slug: true, updatedAt: true },
      }),
      prisma.topic.findMany({
        select: { id: true, refreshedAt: true },
      }),
      prisma.department.findMany({
        select: { slug: true, updatedAt: true },
      }),
      prisma.center.findMany({
        select: { slug: true, updatedAt: true },
      }),
    ]);
  } catch (err) {
    console.warn("[sitemap] Skipping dynamic entries (no DB):", err);
  }

  const now = new Date();

  const staticEntries: MetadataRoute.Sitemap = [
    { url: `${BASE}/`, lastModified: now, changeFrequency: "weekly" as const, priority: 1.0 },
    { url: `${BASE}/browse`, lastModified: now, changeFrequency: "monthly" as const, priority: 0.5 },
    { url: `${BASE}/about`, lastModified: now, changeFrequency: "monthly" as const, priority: 0.5 },
    { url: `${BASE}/about/methodology`, lastModified: now, changeFrequency: "monthly" as const, priority: 0.5 },
  ];

  const scholarEntries: MetadataRoute.Sitemap = scholars.map(
    (s: { slug: string; updatedAt: Date | null }) => ({
      url: `${BASE}/scholars/${s.slug}`,
      lastModified: s.updatedAt ?? now,
      changeFrequency: "weekly" as const,
      priority: 0.8,
    }),
  );

  const topicEntries: MetadataRoute.Sitemap = topics.map(
    (t: { id: string; refreshedAt: Date | null }) => ({
      url: `${BASE}/topics/${t.id}`,
      lastModified: t.refreshedAt ?? now,
      changeFrequency: "monthly" as const,
      priority: 0.6,
    }),
  );

  const deptEntries: MetadataRoute.Sitemap = departments.map(
    (d: { slug: string; updatedAt: Date | null }) => ({
      url: `${BASE}/departments/${d.slug}`,
      lastModified: d.updatedAt ?? now,
      changeFrequency: "monthly" as const,
      priority: 0.6,
    }),
  );

  const centerEntries: MetadataRoute.Sitemap = centers.map(
    (c: { slug: string; updatedAt: Date | null }) => ({
      url: `${BASE}/centers/${c.slug}`,
      lastModified: c.updatedAt ?? now,
      changeFrequency: "monthly" as const,
      priority: 0.6,
    }),
  );

  return [
    ...staticEntries,
    ...scholarEntries,
    ...topicEntries,
    ...deptEntries,
    ...centerEntries,
  ];
}
