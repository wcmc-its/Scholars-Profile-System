import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    topic: { findMany: vi.fn().mockResolvedValue([]) },
    department: { findMany: vi.fn().mockResolvedValue([]) },
    center: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

import { GET } from "@/app/llms.txt/route";

describe("/llms.txt", () => {
  it("does not point automated clients at the robots-disallowed /search", async () => {
    const body = await (await GET()).text();
    expect(body).not.toMatch(/\/search\b/);
  });

  it("keeps the sitemap and browse entries and links automated-access guidance", async () => {
    const body = await (await GET()).text();
    expect(body).toContain("/sitemap.xml)");
    expect(body).toContain("/browse)");
    expect(body).toContain("/about#automated-access)");
  });
});
