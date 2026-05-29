import { redirect } from "next/navigation";

// v0: methodology content lives in the single /docs page (topics / impact / search).
export default function Page() {
  redirect("/docs#topics");
}
