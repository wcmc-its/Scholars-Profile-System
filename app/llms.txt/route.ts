/**
 * /llms.txt — curated index for LLM/AI consumers per the Answer.AI standard
 * (https://llmstxt.org/). Issue #171.
 *
 * What this is: a stable, machine-readable map of the *navigable* surfaces
 * of the directory (about, browse, topics, departments, centers). It does
 * NOT enumerate every scholar — that's the sitemap's job. Crawlers and
 * humans curating context windows can use this file to discover the
 * taxonomy of the directory in one fetch.
 *
 * Format: H1 / blockquote summary / H2 sections of bullet links, per the
 * llms.txt spec. Served as text/plain with a 24h revalidate.
 */
import { prisma } from "@/lib/db";

export const revalidate = 86400;

const BASE =
  process.env.NEXT_PUBLIC_SITE_URL ?? "https://scholars.weill.cornell.edu";

export async function GET() {
  let topics: Array<{ id: string; label: string }> = [];
  let departments: Array<{ slug: string; name: string }> = [];
  let centers: Array<{ slug: string; name: string }> = [];
  try {
    [topics, departments, centers] = await Promise.all([
      prisma.topic.findMany({
        select: { id: true, label: true },
        orderBy: { label: "asc" },
      }),
      prisma.department.findMany({
        select: { slug: true, name: true },
        orderBy: { name: "asc" },
      }),
      prisma.center.findMany({
        select: { slug: true, name: true },
        orderBy: { name: "asc" },
      }),
    ]);
  } catch {
    // Without a DB the static sections still render — degraded but valid.
  }

  const sections: string[] = [];
  sections.push("# Weill Cornell Medicine Scholars");
  sections.push("");
  sections.push(
    "> Public directory of researchers, clinicians, and faculty at Weill Cornell Medicine. Each scholar profile aggregates appointments, publications, grants, MeSH-derived research topics, external relationships, and links to authoritative WCM and federal sources.",
  );
  sections.push("");

  sections.push("## About");
  sections.push("");
  sections.push(`- [About this directory](${BASE}/about): scope and intended audience.`);
  sections.push(
    `- [Methodology](${BASE}/about/methodology): data sources, refresh cadence, and how publication–scholar attributions are produced.`,
  );
  sections.push(
    `- [Sitemap](${BASE}/sitemap.xml): complete list of indexed URLs (every scholar, topic, department, and center).`,
  );
  sections.push("");

  sections.push("## Navigation");
  sections.push("");
  sections.push(`- [Home](${BASE}/): entry point.`);
  sections.push(`- [Search](${BASE}/search): full-text search across scholars and publications.`);
  sections.push(`- [Browse](${BASE}/browse): browse by surname, research area, or department.`);
  sections.push("");

  if (topics.length > 0) {
    sections.push("## Research areas");
    sections.push("");
    for (const t of topics) {
      sections.push(`- [${t.label}](${BASE}/topics/${t.id})`);
    }
    sections.push("");
  }

  if (departments.length > 0) {
    sections.push("## Departments");
    sections.push("");
    for (const d of departments) {
      sections.push(`- [${d.name}](${BASE}/departments/${d.slug})`);
    }
    sections.push("");
  }

  if (centers.length > 0) {
    sections.push("## Centers and institutes");
    sections.push("");
    for (const c of centers) {
      sections.push(`- [${c.name}](${BASE}/centers/${c.slug})`);
    }
    sections.push("");
  }

  const body = sections.join("\n");
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      // Cache aligns with the 24h revalidate above; on-demand revalidation
      // can be wired into the ETL orchestrator alongside /sitemap.xml.
      "cache-control": "public, max-age=0, s-maxage=86400, stale-while-revalidate=86400",
    },
  });
}
