import { redirect } from "next/navigation";

// v0: per-question pages were folded into the single /docs page.
export default function Page() {
  redirect("/docs");
}
