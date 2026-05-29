import { redirect } from "next/navigation";

// v0: the glossary lives in the single /docs page.
export default function Page() {
  redirect("/docs#glossary");
}
