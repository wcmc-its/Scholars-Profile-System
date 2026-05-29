import { redirect } from "next/navigation";

// v0: the question-first sub-routes were folded into the single /docs page.
export default function Page() {
  redirect("/docs#who");
}
