import type { Metadata } from "next";
import { LATEST } from "@/lib/benchmark";
import { renderBenchmark } from "./render";

// ISR: the snapshot is static, but area/unit links are resolved against the DB.
export const revalidate = 3600;
export const dynamic = "error";

export const metadata: Metadata = {
  title: "Research areas compared",
  description:
    "How Scholars' research areas compare with Weill Cornell departments and divisions, the CARE Strategic Plan, and NIH Institutes, Centers and RCDC categories.",
  alternates: { canonical: "/about/research-areas" },
};

export default function ResearchAreasPage() {
  return renderBenchmark(LATEST.date);
}
