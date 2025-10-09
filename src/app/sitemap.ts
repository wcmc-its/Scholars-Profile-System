// app/sitemap.ts
import type { MetadataRoute } from "next";

const BASE_URL = process.env.NEXT_PUBLIC_BASE_UR || "http://localhost:3000";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  // Fetch dynamic data from  OpenSearch
  const res = await fetch(`${BASE_URL}/api/pepolelist`, {
    cache: "no-store",
  });

  
  let identifiers: string[] = [];
  let data:any = [];
  try {
    data = await res.json();
  identifiers = data.identifiers || [];
  } catch (err) {
    console.error("Failed to parse API response for sitemap:", err);
  }

  const dynamicPages: MetadataRoute.Sitemap = identifiers.map((person: any) => ({
    url: `${BASE_URL}/display/${person}`,
    lastModified: new Date(),
    changeFrequency: "daily",
    priority: 1.0,
  }));

  const staticPages: MetadataRoute.Sitemap = [
    {
      url: `${BASE_URL}/`,
      lastModified: new Date(),
      changeFrequency: "daily",
      priority: 1.0,
    },
     {
      url: `${BASE_URL}/people`,
      lastModified: new Date(),
      changeFrequency: "daily",
      priority: 1.0,
    },
    {
      url: `${BASE_URL}/search`,
      lastModified: new Date(),
      changeFrequency: "daily",
      priority: 0.7,
    },
  ];

  return [...staticPages, ...dynamicPages];
}
