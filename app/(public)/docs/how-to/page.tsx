import { redirect } from "next/navigation";

// v0: how-to content lives in the single /docs page.
export default function Page() {
  redirect("/docs#correct");
}
