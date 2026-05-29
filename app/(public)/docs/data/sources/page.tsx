import { redirect } from "next/navigation";

// v0: the provenance map lives in the single /docs page.
export default function Page() {
  redirect("/docs#provenance");
}
